import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import {
  commandName,
  isDevicePath,
  redirectTargets,
  type Segment,
  walkCommands,
  withoutRedirects,
} from "./command.ts";

/**
 * What a shell segment writes (#83), for every command it can run: its own
 * command word and each command a see-through wrapper reaches (`env`, `sudo`,
 * `timeout`, `xargs`, `find -exec`, ...). A command word with a directory part
 * (`./cp`, `bin/tee`) is the tool it names.
 */
export type WriteSet = {
  /** Files written. A word with `*`, `?` or `[` names every match; `dir/**` names whatever a command creates in `dir`. */
  paths: string[];
  /** Directories whose existing contents are removed or moved. */
  trees: string[];
  /** A writer whose destination the command line does not name: denied. */
  unknown: boolean;
};

const DEST_LAST = new Set(["cp", "mv", "ln", "install", "rsync", "ditto"]);
const WRITE_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "tee", "truncate"]);
const MODE_FIRST = new Set(["chmod", "chown", "chgrp"]);
const PATH_MUTATORS = new Set([
  "unlink",
  "shred",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "zstd",
]);
const IN_PLACE = new Set(["sed", "gsed", "perl"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const EDITORS = new Set(["vi", "vim", "nvim", "view"]);
/** Options that take the next word as a value, so it is not a path. */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  cp: ["-S"],
  mv: ["-S"],
  ln: ["-S"],
  install: ["-m", "-o", "-g", "-S"],
  rsync: ["--exclude", "--include", "--filter", "-f", "-e", "--rsh"],
  mkdir: ["-m"],
  touch: ["-d", "-t", "-r"],
  truncate: ["-s", "-r"],
  split: ["-a", "-b", "-l", "-n", "-C"],
  awk: ["-v", "-F", "-i"],
  sed: ["-e", "-l"],
  perl: ["-e", "-E", "-I"],
};
/** `--opt value` and `--opt=value` options whose value is a file the command writes. */
const OUTPUT_OPTIONS = new Set([
  "--output",
  "--out",
  "--outfile",
  "--output-file",
  "--output-document",
  "--target-directory",
  "--file",
  "--log-file",
  "--destination",
  "--dest",
  "--to",
]);

/** The short flag whose next word is the file a command writes. */
const OUTPUT_FLAG: Record<string, string> = {
  curl: "-o",
  wget: "-O",
  sort: "-o",
};

/** The words that are paths, and the `-t`/`--target-directory` value; `--` ends the options. */
function splitArgs(
  argv: readonly string[],
  values: readonly string[],
  targetDir: boolean,
): { positional: string[]; target: string | null } {
  const positional: string[] = [];
  let target: string | null = null;
  let literal = false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (!literal && word === "--") {
      literal = true;
    } else if (literal || !word.startsWith("-") || word === "-") {
      if (word.length > 0) {
        positional.push(word);
      }
    } else if (targetDir && word.startsWith("--target-directory")) {
      const eq = word.indexOf("=");
      target = eq < 0 ? (argv[index + 1] ?? "") : word.slice(eq + 1);
      index += eq < 0 ? 1 : 0;
    } else if (targetDir && /^-[A-Za-z]*t$/.test(word)) {
      target = argv[index + 1] ?? "";
      index += 1;
    } else if (targetDir && /^-t[^A-Za-z]/.test(word)) {
      target = word.slice(2);
    } else if (
      values.includes(word) ||
      (/^-[A-Za-z]+$/.test(word) && values.includes(`-${word.at(-1)}`))
    ) {
      index += 1;
    }
  }
  return { positional, target };
}

/** `dir` and `name` as one path (`dir/` and `/` both work). */
function under(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function dirOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  if (at < 0) {
    return ".";
  }
  return at === 0 ? "/" : trimmed.slice(0, at);
}

/**
 * The paths a copied source takes inside the destination directory `dest`: its
 * basename, or for a glob, `.`, `..` or rsync's `dir/` the names found now in
 * the directory it lists (`cwd` is where the shell is). A source the shell
 * rewrites, or a directory that cannot be listed, is `dest/*`.
 */
function copied(
  dest: string,
  source: string,
  contents: boolean,
  cwd: string,
): string[] {
  const trimmed = source.replace(/\/+$/, "").replace(/^[^/]*:(?=.)/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const all = (contents && source.endsWith("/")) || /^\.{0,2}$/.test(last);
  if (!all && !/[*?[{$`]/.test(last)) {
    return [under(dest, last)];
  }
  try {
    if (/[{$`]/.test(trimmed)) {
      throw new Error("unknown");
    }
    const names = readdirSync(resolve(cwd, all ? trimmed : dirOf(trimmed)));
    return names
      .filter((name) => all || picomatch.isMatch(name, last, DOT_NAMES(last)))
      .map((name) => under(dest, name));
  } catch {
    return [under(dest, "*")];
  }
}

function isDirectory(cwd: string, path: string): boolean {
  try {
    return statSync(resolve(cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

const DOT_NAMES = (pattern: string) => ({ dot: pattern.startsWith(".") });

/** `sed` commands that write: `w file`, `W file` and the `w` flag of `s`. Null when the script is in a file we cannot read. */
function sedFiles(rest: readonly string[]): string[] | null {
  const scripts: string[] = [];
  let explicit = false;
  for (const [index, word] of rest.entries()) {
    if (/^-[A-Za-z]*f$|^-f.|^--file/.test(word)) {
      return null;
    }
    if (word === "--expression" || /^-[A-Za-z]*e$/.test(word)) {
      scripts.push(rest[index + 1] ?? "");
      explicit = true;
    } else if (word.startsWith("--expression=")) {
      scripts.push(word.slice(13));
      explicit = true;
    } else if (/^-e./.test(word)) {
      scripts.push(word.slice(2));
      explicit = true;
    }
  }
  if (!explicit) {
    scripts.push(rest.find((word) => !word.startsWith("-")) ?? "");
  }
  return scripts.flatMap(sedScriptFiles);
}

/** The files one `sed` script writes: a small lexer, so a pattern like `/world/p` is not a `w` command. */
function sedScriptFiles(script: string): string[] {
  const files: string[] = [];
  const after = (from: number, delimiter: string): number => {
    let at = from;
    while (at < script.length && script[at] !== delimiter) {
      at += script[at] === "\\" ? 2 : 1;
    }
    return at + 1;
  };
  const lineEnd = (from: number): number => {
    const newline = script.indexOf("\n", from);
    return newline < 0 ? script.length : newline;
  };
  const target = (from: number): number => {
    files.push(script.slice(from, lineEnd(from)).trim());
    return lineEnd(from);
  };
  let at = 0;
  while (at < script.length) {
    const ch = script[at] ?? "";
    if (ch === "/") {
      at = after(at + 1, "/");
    } else if (ch === "\\") {
      at = after(at + 2, script[at + 1] ?? "/");
    } else if (ch === "s" || ch === "y") {
      const delimiter = script[at + 1] ?? "/";
      at = after(after(at + 2, delimiter), delimiter);
      while (/[gpiImMe\d]/.test(script[at] ?? "")) {
        at += 1;
      }
      at = ch === "s" && script[at] === "w" ? target(at + 1) : at;
    } else if (ch === "w" || ch === "W") {
      at = target(at + 1);
    } else if (/[aicrRe:]/.test(ch)) {
      at = lineEnd(at);
    } else if (/[btT]/.test(ch)) {
      const end = script.slice(at).search(/[;\n]/);
      at = end < 0 ? script.length : at + end;
    } else {
      at += 1;
    }
  }
  return files.filter((file) => file !== "");
}

function closingQuote(text: string, open: number): number {
  for (let at = open + 1; at < text.length; at += 1) {
    if (text[at] === "\\") {
      at += 1;
    } else if (text[at] === '"') {
      return at;
    }
  }
  return text.length;
}

/** Files an awk program writes with `print > "file"`; any other target, or a pipe, is unknown. */
function awkFiles(program: string, out: WriteSet): void {
  out.unknown ||= /\bsystem\s*\(/.test(program);
  let depth = 0;
  let printing = false;
  for (let at = 0; at < program.length; at += 1) {
    const ch = program[at] ?? "";
    if (ch === '"') {
      at = closingQuote(program, at);
    } else if (!printing) {
      const word = /^printf?(?![\w])/.exec(program.slice(at));
      if (word && !/\w/.test(program[at - 1] ?? "")) {
        printing = true;
        depth = 0;
        at += word[0].length - 1;
      }
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (depth <= 0 && /[;}\n]/.test(ch)) {
      printing = false;
    } else if (depth <= 0 && (ch === ">" || ch === "|")) {
      printing = false;
      let from = at + 1 + (program[at + 1] === ">" ? 1 : 0);
      while (/[ \t]/.test(program[from] ?? "")) {
        from += 1;
      }
      const end = closingQuote(program, from);
      const after = /^[ \t]*(.?)/.exec(program.slice(end + 1))?.[1] ?? "";
      if (ch === "|" || program[from] !== '"' || !/^[;}\n]?$/.test(after)) {
        out.unknown = true;
      } else {
        out.paths.push(program.slice(from + 1, end));
      }
      at = end;
    }
  }
}

function tarWrites(rest: readonly string[], out: WriteSet): void {
  const words =
    rest[0]?.startsWith("-") === false
      ? [`-${rest[0]}`, ...rest.slice(1)]
      : rest;
  let extract = false;
  let create = false;
  let stdout = false;
  let file: string | null = null;
  let dir: string | null = null;
  const pending: Array<"f" | "C"> = [];
  for (const word of words) {
    if (word === "--extract" || word === "--get") {
      extract = true;
    } else if (/^--(?:create|append|update|delete)$/.test(word)) {
      create = true;
    } else if (word === "--to-stdout") {
      stdout = true;
    } else if (word.startsWith("--file=") || word.startsWith("--directory=")) {
      const value = word.slice(word.indexOf("=") + 1);
      if (word.startsWith("--file")) {
        file = value;
      } else {
        dir = value;
      }
    } else if (word === "--file" || word === "--directory") {
      pending.push(word === "--file" ? "f" : "C");
    } else if (/^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) {
        extract ||= letter === "x";
        create ||= "cru".includes(letter);
        stdout ||= letter === "O";
        if (letter === "f" || letter === "C") {
          pending.push(letter);
        }
      }
    } else if (/^-C./.test(word)) {
      dir = word.slice(2);
    } else if (!word.startsWith("-")) {
      const kind = pending.shift();
      file = kind === "f" ? word : file;
      dir = kind === "C" ? word : dir;
    }
  }
  if (create && file !== null && file !== "-") {
    out.paths.push(file);
  }
  if (extract && !stdout) {
    out.paths.push(under(dir ?? ".", "**"));
  }
}

/** Git subcommands that write the working tree from a pathspec. */
function gitWrites(rest: readonly string[], out: WriteSet, cwd: string): void {
  let at = 0;
  let base = "";
  for (; at < rest.length; at += 1) {
    const word = rest[at] ?? "";
    if (word === "-C") {
      base =
        base === "" ? (rest[at + 1] ?? "") : under(base, rest[at + 1] ?? "");
      at += 1;
    } else if (/^--(?:git-dir|work-tree)/.test(word)) {
      // Another tree: `gitRewriteDeny` denies it before a pathspec matters.
      return;
    } else if (word === "-c" || word === "--namespace") {
      at += 1;
    } else if (!word.startsWith("-")) {
      break;
    }
  }
  const sub = rest[at] ?? "";
  const args = rest.slice(at + 1);
  const rooted = (path: string): string =>
    base === "" || path.startsWith("/") ? path : under(base, path);
  const flag = (pattern: RegExp): boolean => args.some((w) => pattern.test(w));
  const dashes = args.indexOf("--");
  const before = dashes < 0 ? args : args.slice(0, dashes);
  const after = dashes < 0 ? [] : args.slice(dashes + 1);
  const specs = (valued: readonly string[]): string[] => [
    ...splitArgs(["git", ...before], valued, false).positional,
    ...after,
  ];
  const pathspecs = (list: readonly string[]): void => {
    out.unknown ||= list.some((spec) => spec.startsWith(":"));
    for (const spec of list.map(rooted)) {
      out.paths.push(spec);
      out.trees.push(spec);
    }
  };
  if (sub === "checkout") {
    const named = specs(["-b", "-B", "--orphan"]);
    pathspecs(
      dashes >= 0
        ? after
        : named.length >= 2
          ? named.slice(1)
          : named[0] === "."
            ? ["."]
            : [],
    );
  } else if (sub === "restore") {
    const indexOnly = flag(/^(?:--staged|-[A-Za-z]*S)$/);
    const tree = flag(/^(?:--worktree|-[A-Za-z]*W)$/);
    out.unknown ||= flag(/^--pathspec-from-file/);
    pathspecs(indexOnly && !tree ? [] : specs(["-s", "--source"]));
  } else if (sub === "mv" || (sub === "rm" && !flag(/^--cached$/))) {
    const words = args.map((w) => (w.startsWith("-") ? w : rooted(w)));
    writesOf([sub === "mv" ? "mv" : "rm", ...words], out, cwd);
  } else if (sub === "am") {
    out.unknown = true;
  } else if (sub === "apply") {
    out.unknown ||= !flag(/^--(?:check|stat|numstat|summary)$/);
  }
}

/** Adds what the command `argv` writes to `out`; true when it is a writer. */
function writesOf(
  argv: readonly string[],
  out: WriteSet,
  cwd: string,
): boolean {
  const name = commandName(argv[0] ?? "");
  const rest = argv.slice(1);
  const valued = VALUE_OPTIONS[name] ?? [];
  const recursive = rest.some(
    (word) => word === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(word),
  );
  for (const [index, word] of rest.entries()) {
    const eq = word.indexOf("=");
    if (
      word.startsWith("--") &&
      eq > 0 &&
      OUTPUT_OPTIONS.has(word.slice(0, eq))
    ) {
      out.paths.push(word.slice(eq + 1));
    } else if (OUTPUT_OPTIONS.has(word) || word === OUTPUT_FLAG[name]) {
      out.paths.push(rest[index + 1] ?? "");
    } else if (name === "sort" && /^-o./.test(word)) {
      out.paths.push(word.slice(2));
    } else if (name === "dd" && word.startsWith("of=")) {
      out.paths.push(word.slice(3));
    }
  }
  if (DEST_LAST.has(name)) {
    const { positional, target } = splitArgs(argv, valued, name !== "rsync");
    const dest = target ?? positional.at(-1);
    const sources = target === null ? positional.slice(0, -1) : positional;
    const symbolic = rest.some(
      (w) => w === "--symbolic" || /^-[A-Za-z]*s/.test(w),
    );
    // A directory is not written itself: the files it receives are. Several
    // sources, `-t`, a trailing slash or rsync of a tree make `dest` one.
    const directory =
      dest !== undefined &&
      sources.length > 0 &&
      (target !== null ||
        sources.length > 1 ||
        dest.endsWith("/") ||
        (name === "rsync" &&
          (recursive ||
            rest.some((w) => /^-[A-Za-z]*a/.test(w)) ||
            sources[0]?.endsWith("/"))) ||
        isDirectory(cwd, dest));
    if (dest !== undefined && !directory) {
      out.paths.push(dest);
    }
    for (const source of directory ? sources : []) {
      out.paths.push(...copied(dest ?? "", source, name === "rsync", cwd));
    }
    for (const source of sources) {
      if (name === "mv") {
        out.paths.push(source);
        out.trees.push(source);
      } else if (name === "ln" && symbolic && !source.startsWith("/")) {
        out.paths.push(under(dirOf(dest ?? "."), source));
        if (directory) {
          out.paths.push(under(dest ?? ".", source));
        }
      } else if (name === "ln") {
        out.paths.push(source);
      }
    }
    if (
      name === "rsync" &&
      rest.some((w) => /^--(?:delete|remove-source)/.test(w))
    ) {
      out.trees.push(...positional);
    }
    return true;
  }
  if (WRITE_ALL.has(name) || MODE_FIRST.has(name)) {
    const { positional } = splitArgs(argv, valued, false);
    const files =
      MODE_FIRST.has(name) && !rest.some((w) => w.startsWith("--reference"))
        ? positional.slice(1)
        : positional;
    out.paths.push(...files);
    if (recursive && name !== "mkdir" && name !== "touch" && name !== "tee") {
      out.trees.push(...files);
    }
    return true;
  }
  if (PATH_MUTATORS.has(name)) {
    if (
      !rest.some((w) => /^-[A-Za-z]*[ctl]|^--(?:stdout|to-stdout)$/.test(w))
    ) {
      out.paths.push(...splitArgs(argv, valued, false).positional);
    }
    return true;
  }
  if (IN_PLACE.has(name)) {
    const inPlace = rest.some(
      (w) => w.startsWith("--in-place") || /^-[a-zA-Z0-9]*i/.test(w),
    );
    const { positional } = splitArgs(argv, valued, false);
    const scripted = rest.some((w) =>
      /^-[A-Za-z]*[eEf]$|^--(?:expression|file)/.test(w),
    );
    if (inPlace) {
      out.paths.push(...(scripted ? positional : positional.slice(1)));
    }
    if (name !== "perl") {
      const files = sedFiles(rest);
      out.unknown ||= files === null;
      out.paths.push(...(files ?? []));
    }
    return inPlace;
  }
  if (AWKS.has(name)) {
    const { positional } = splitArgs(argv, valued, false);
    out.unknown ||= rest.some((w) => /^(?:-f|-e|--file|--source)/.test(w));
    awkFiles(positional[0] ?? "", out);
    if (
      rest.some(
        (w, i) =>
          (/^(?:-i|--include)$/.test(w) && rest[i + 1] === "inplace") ||
          /^(?:-iinplace|--include=inplace)$/.test(w),
      )
    ) {
      out.paths.push(...positional.slice(1).filter((w) => !/^\w+=/.test(w)));
    }
    return true;
  }
  switch (name) {
    case "split":
      out.paths.push(`${splitArgs(argv, valued, false).positional[1] ?? "x"}*`);
      return true;
    case "tar":
      tarWrites(rest, out);
      return true;
    case "unzip": {
      const at = rest.indexOf("-d");
      const dir =
        at >= 0 ? rest[at + 1] : rest.find((w) => /^-d./.test(w))?.slice(2);
      if (!rest.some((w) => /^-[A-Za-z]*[lptvZ]/.test(w))) {
        out.paths.push(under(dir ?? ".", "**"));
      }
      return true;
    }
    case "zip":
      out.paths.push(splitArgs(argv, valued, false).positional[0] ?? "");
      return true;
    case "patch":
      out.unknown ||= !rest.some(
        (w) => w === "--dry-run" || w === "--check" || /^-[A-Za-z]*C$/.test(w),
      );
      return true;
    case "ex":
    case "ed":
      out.unknown = true;
      return true;
    case "find": {
      const start = rest.findIndex(
        (w) => w.startsWith("-") || w === "(" || w === "!",
      );
      const roots = start < 0 ? rest : rest.slice(0, start);
      if (rest.includes("-delete")) {
        out.paths.push(...(roots.length > 0 ? roots : ["."]));
        out.trees.push(...(roots.length > 0 ? roots : ["."]));
      }
      for (const [index, word] of rest.entries()) {
        if (/^-(?:fprint0?|fls|fprintf)$/.test(word)) {
          out.paths.push(rest[index + 1] ?? "");
        }
      }
      return rest.includes("-delete");
    }
    case "git":
      gitWrites(rest, out, cwd);
      return false;
    case "dd":
    case "curl":
    case "wget":
    case "sort":
      return false;
    default:
      if (
        EDITORS.has(name) &&
        rest.some((w) => /^(?:-[A-Za-z]*[sSc]|--cmd|\+.+)$/.test(w))
      ) {
        out.unknown = true;
      }
      return false;
  }
}

/** Everything the segment writes, wrappers and redirects included. */
export function shellWriteSet(segment: Segment, cwd: string): WriteSet {
  const out: WriteSet = {
    paths: redirectTargets(segment),
    trees: [],
    unknown: false,
  };
  const plain = withoutRedirects(segment.argv);
  const reached = [...walkCommands(plain).at].sort((a, b) => a - b);
  for (const index of reached) {
    const exec = /^-(?:exec|execdir|ok|okdir)$/.test(plain[index - 1] ?? "");
    const stop = plain.findIndex(
      (w, i) => i > index && (w === ";" || w === "+"),
    );
    const here: WriteSet = { paths: [], trees: [], unknown: false };
    const writer = writesOf(
      plain.slice(index, exec && stop >= 0 ? stop : undefined),
      here,
      cwd,
    );
    const piped = reached.some(
      (i) => i < index && commandName(plain[i] ?? "") === "xargs",
    );
    // Arguments come from standard input (xargs) or from `find` (`{}`).
    here.unknown ||=
      (piped && (writer || here.paths.length + here.trees.length > 0)) ||
      (exec && here.paths.some((path) => path.includes("{}")));
    out.paths.push(...here.paths);
    out.trees.push(...here.trees);
    out.unknown ||= here.unknown;
  }
  out.paths = out.paths.filter(
    (path) => path.length > 0 && !isDevicePath(path),
  );
  return out;
}
