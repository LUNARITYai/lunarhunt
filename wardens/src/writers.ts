import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import {
  commandName,
  isDevicePath,
  redirectTargets,
  type Segment,
  WRITE_ALL,
  walkCommands,
  withoutRedirects,
} from "./command.ts";

/**
 * What a shell segment writes (#83), for every command it can run: its own
 * command word and each command a see-through wrapper reaches (`env`, `sudo`,
 * `timeout`, `xargs`, `find -exec`, ...). A command word with a directory part
 * (`./cp`, `bin/tee`) is the tool it names.
 *
 * The model is conservative, not a grammar per tool: for a writer, EVERY
 * operand and EVERY option value (`-tX`, `-t X`, `--opt=X`, `--opt X`) that can
 * be a path is a write target, so an option the table does not know cannot hide
 * a destination. A tool with a feature that runs a program or writes a file we
 * cannot read from the text is `unknown`, and denied.
 */
export type WriteSet = {
  /** Files written. A word with `*`, `?` or `[` names every match. */
  paths: string[];
  /** Glued short-option tails that may be a path (`-rtsecrets`): judged only when they exist or name a protected file. */
  weak: string[];
  /** Directories whose existing contents are removed or moved; `names` limits them to matching basenames. */
  trees: Array<{ path: string; names?: string[] | undefined }>;
  /** A writer whose destination the command line does not name, or one with a hidden effect: denied. */
  unknown: boolean;
};

const DEST_LAST = new Set(["cp", "mv", "ln", "install", "rsync", "ditto"]);
const MODE_FIRST = new Set(["chmod", "chown", "chgrp"]);
/** Tools whose every operand is a file they write or change. */
const OPERAND_WRITERS = new Set([
  ...WRITE_ALL,
  ...DEST_LAST,
  ...MODE_FIRST,
  "unlink",
  "shred",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "zstd",
  "zip",
  "split",
]);
const IN_PLACE = new Set(["sed", "gsed", "perl"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const EDITORS = new Set(["vi", "vim", "nvim", "view"]);
/** Options whose value is a pattern, not a file. */
const PATTERNS = new Set(["--exclude", "--include", "--filter", "-f"]);
/** rsync and tar options that read a list from, or write a batch to, a file we cannot see, or run a program. */
const HIDDEN_RSYNC =
  /^(?:--(?:files-from|include-from|exclude-from|write-batch|only-write-batch|rsh|read-batch)(?:=|$)|-[A-Za-z]*e$|-e.)/;
const HIDDEN_TAR =
  /^(?:--(?:checkpoint-action|use-compress-program|to-command|remove-files|listed-incremental|index-file|info-script|new-volume-script|rmt-command|rsh-command)(?:=|$)|-[A-Za-z]*[IgFH]$|-[IgF].)/;
const NUMBER = /^[+-]?\d+(?:\.\d+)?[kKmMgGsSdDhH]?$/;
const MODE =
  /^(?:[0-7]{3,4}|[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*)$/;
/** More operands than this: not worth judging pair by pair. */
const OPERAND_LIMIT = 64;
/** A word this long is a glob that costs too much to intersect. */
const WORD_LIMIT = 1024;
/** A directory this large is not listed for a glob. */
const LISTING_LIMIT = 20000;

type Operands = { strong: string[]; weak: string[] };

/**
 * The words of `argv` that can be a path: operands, values of `--opt=X`, tails
 * glued to a short option (`-tX`) and, for an all-letter cluster (`-rtX`), the
 * suffixes after its first letters. Numbers, `-` and the values of pattern
 * options are not paths. `valueLetters` are short options whose next word is
 * not a path (`sed -l 5`, `perl -e script`).
 */
function operandsOf(argv: readonly string[], valueLetters = ""): Operands {
  const out: Operands = { strong: [], weak: [] };
  let literal = false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (!literal && word === "--") {
      literal = true;
    } else if (literal || !word.startsWith("-") || word === "-") {
      if (word !== "" && word !== "-" && !NUMBER.test(word)) {
        out.strong.push(word);
      }
    } else if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      if (PATTERNS.has(name)) {
        index += eq < 0 ? 1 : 0;
      } else if (eq > 0 && word.length > eq + 1) {
        out.strong.push(word.slice(eq + 1));
      }
    } else if (PATTERNS.has(word)) {
      index += 1;
    } else {
      const glued = /^-([A-Za-z]+)(.*)$/.exec(word);
      const tail = (glued?.[2] ?? "").replace(/^=/, "");
      if (
        glued &&
        valueLetters.includes(glued[1]?.at(-1) ?? "-") &&
        tail === ""
      ) {
        index += 1;
      } else if (tail !== "" && !NUMBER.test(tail)) {
        out.strong.push(tail);
      } else if (glued && tail === "") {
        const letters = glued[1] ?? "";
        for (let at = 1; at + 3 <= letters.length; at += 1) {
          out.weak.push(letters.slice(at));
        }
      }
    }
  }
  return out;
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

function isDirectory(cwd: string, path: string): boolean {
  try {
    return statSync(resolve(cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The paths a copied source takes inside the directory `dest`: its basename,
 * or for a glob, `.`, `..` or rsync's `dir/` the names found now in the
 * directory it lists (`cwd` is where the shell is). With `relative`
 * (`cp --parents`, `rsync -R`) it is the whole source path, or what follows
 * `/./`. A source the shell rewrites, or a directory that cannot be listed or
 * is too large, is `dest/*`.
 */
function copied(
  dest: string,
  source: string,
  contents: boolean,
  relative: boolean,
  cwd: string,
): string[] {
  const trimmed = source.replace(/\/+$/, "").replace(/^[^/]*:(?=.)/, "");
  if (relative) {
    const marker = trimmed.indexOf("/./");
    return [
      under(
        dest,
        marker >= 0 ? trimmed.slice(marker + 3) : trimmed.replace(/^\/+/, ""),
      ),
    ];
  }
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
    if (names.length > LISTING_LIMIT) {
      throw new Error("large");
    }
    const dot = { dot: last.startsWith(".") };
    return names
      .filter((name) => all || picomatch.isMatch(name, last, dot))
      .map((name) => under(dest, name));
  } catch {
    return [under(dest, "*")];
  }
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

/** The files `sed` scripts write, or null when a construct can run a program or hide a file (the `e` command and flag, `-f`). */
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
    } else if (word.startsWith("--expression=") || /^-e./.test(word)) {
      scripts.push(word.slice(word.startsWith("--") ? 13 : 2));
      explicit = true;
    } else if (
      /^--(?!in-place|quiet|silent|regexp-extended|separate|null-data|posix|debug|sandbox|follow-symlinks|unbuffered|binary|zero-terminated|line-length=)/.test(
        word,
      )
    ) {
      return null;
    }
  }
  if (!explicit) {
    const skip = rest.findIndex((w) => /^-[A-Za-z]*l$|^--line-length$/.test(w));
    const first = rest.findIndex(
      (w, i) => !w.startsWith("-") && (skip < 0 || i !== skip + 1),
    );
    scripts.push(rest[first] ?? "");
  }
  const files: string[] = [];
  for (const script of scripts) {
    const found = sedScriptFiles(script);
    if (found === null) {
      return null;
    }
    files.push(...found);
  }
  return files;
}

/** The files one `sed` script writes (a small lexer: `/world/p` is not a `w` command); null when it cannot say. */
function sedScriptFiles(script: string): string[] | null {
  const files: string[] = [];
  let unsure = false;
  const after = (from: number, delimiter: string): number => {
    let at = from;
    while (at < script.length && script[at] !== delimiter) {
      at += script[at] === "\\" ? 2 : 1;
    }
    unsure ||= at >= script.length;
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
      while (/[gpiImM\d]/.test(script[at] ?? "")) {
        at += 1;
      }
      unsure ||= script[at] === "e";
      at = ch === "s" && script[at] === "w" ? target(at + 1) : at;
    } else if (ch === "w" || ch === "W") {
      at = target(at + 1);
    } else if (ch === "e") {
      unsure = true;
      at += 1;
    } else if (/[aicrR]/.test(ch)) {
      at = lineEnd(at);
    } else if (/[:btT]/.test(ch)) {
      const end = script.slice(at).search(/[;\n\s]/);
      at = end < 0 ? script.length : at + end + 1;
    } else {
      at += 1;
    }
  }
  return unsure ? null : files;
}

/**
 * Files an awk program writes with `print > "file"`. Any other redirect target,
 * a pipe, `system()`, `getline` from a command or `@include` is unknown.
 */
function awkFiles(program: string, out: WriteSet): void {
  out.unknown ||= /\bsystem\s*\(|\bgetline\b|@include|@load/.test(program);
  let depth = 0;
  let printing = false;
  let previous = ";";
  for (let at = 0; at < program.length; at += 1) {
    const ch = program[at] ?? "";
    if (ch === '"') {
      at = closingQuote(program, at);
    } else if (ch === "/" && /[(,;{}~!&|=<>+\-*%^\n]/.test(previous)) {
      // A regular expression literal: its quotes and `>` are not syntax.
      for (at += 1; at < program.length && program[at] !== "/"; at += 1) {
        at += program[at] === "\\" ? 1 : 0;
      }
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
    previous = /\s/.test(ch) && ch !== "\n" ? previous : ch;
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
  const pending: Array<"f" | "C"> = [];
  for (const word of words) {
    out.unknown ||= HIDDEN_TAR.test(word);
    if (word === "--extract" || word === "--get") {
      extract = true;
    } else if (/^--(?:create|append|update|delete)$/.test(word)) {
      create = true;
    } else if (word === "--to-stdout") {
      stdout = true;
    } else if (word.startsWith("--file=")) {
      file = word.slice(7);
    } else if (word === "--file") {
      pending.push("f");
    } else if (/^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) {
        extract ||= letter === "x";
        create ||= "cru".includes(letter);
        stdout ||= letter === "O";
        if (letter === "f" || letter === "C") {
          pending.push(letter);
        }
      }
    } else if (!word.startsWith("-") && pending.length > 0) {
      file = pending.shift() === "f" ? word : file;
    }
  }
  if (create && file !== null && file !== "-") {
    out.paths.push(file);
  }
  // The names an archive creates are its own: unknown, so denied.
  out.unknown ||= extract && !stdout;
}

/** Git subcommands that write the working tree from a pathspec; true when `sub` is one. */
function gitWrites(
  rest: readonly string[],
  out: WriteSet,
  cwd: string,
): boolean {
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
      return false;
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
  const writes = ["checkout", "restore", "mv", "rm", "apply", "am"].includes(
    sub,
  );
  out.unknown ||= writes && flag(/^--pathspec-from-file/);
  const dashes = args.indexOf("--");
  const after = dashes < 0 ? [] : args.slice(dashes + 1);
  // `--source X` and `--source=X` name a revision, not a path.
  const options = args
    .slice(0, dashes < 0 ? undefined : dashes)
    .filter((w, i, all) => !/^--source/.test(w) && all[i - 1] !== "--source");
  const named = operandsOf(
    ["git", ...options],
    sub === "restore" ? "s" : "bB",
  ).strong;
  const pathspecs = (list: readonly string[]): void => {
    out.unknown ||= list.some((spec) => spec.startsWith(":"));
    for (const spec of list.map(rooted)) {
      out.paths.push(spec);
      out.trees.push({ path: spec });
    }
  };
  if (sub === "checkout") {
    // After `--`, with `--ours`/`--theirs`, or after a revision: paths. A lone
    // name is a path when it exists, a branch otherwise.
    const paths = flag(/^(?:--ours|--theirs|--merge|-m|--conflict|-p|--patch)/);
    const lone = existsSync(resolve(cwd, rooted(named[0] ?? "-")));
    pathspecs(
      dashes >= 0
        ? after
        : paths
          ? named
          : named.length >= 2
            ? named.slice(1)
            : lone || named[0] === "."
              ? named
              : [],
    );
  } else if (sub === "restore") {
    const staged = flag(/^(?:--staged|-[A-Za-z]*S[A-Za-z]*)$/);
    const tree = flag(/^(?:--worktree|-[A-Za-z]*W[A-Za-z]*)$/);
    pathspecs(staged && !tree ? [] : [...named, ...after]);
  } else if (sub === "mv" || (sub === "rm" && !flag(/^--cached$/))) {
    writesOf(
      [sub, ...args.map((w) => (w.startsWith("-") ? w : rooted(w)))],
      out,
      cwd,
    );
  } else if (sub === "am") {
    out.unknown = true;
  } else if (sub === "apply") {
    out.unknown ||= !flag(/^--(?:check|stat|numstat|summary)$/);
  }
  return writes;
}

/** Adds what the command `argv` writes to `out`; true when it is a writer. */
function writesOf(
  argv: readonly string[],
  out: WriteSet,
  cwd: string,
): boolean {
  const name = commandName(argv[0] ?? "");
  const rest = argv.slice(1);
  const recursive = rest.some(
    (word) => word === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(word),
  );
  for (const [index, word] of rest.entries()) {
    if (name === "dd" && word.startsWith("of=")) {
      out.paths.push(word.slice(3));
    } else if (
      (name === "curl" && word === "-o") ||
      (name === "wget" && word === "-O") ||
      (name === "sort" && /^-[A-Za-z]*o$|^--output$/.test(word))
    ) {
      out.paths.push(rest[index + 1] ?? "-");
    } else if (
      name === "sort" &&
      (/^-o./.test(word) || word.startsWith("--output="))
    ) {
      out.paths.push(word.slice(word.startsWith("--") ? 9 : 2));
    } else if (
      /^--(?:output|out|outfile|output-file|output-document|log-file|destination|dest|to)=/.test(
        word,
      )
    ) {
      out.paths.push(word.slice(word.indexOf("=") + 1));
    }
  }
  if (OPERAND_WRITERS.has(name)) {
    const { strong, weak } = operandsOf(argv, name === "zip" ? "xi" : "");
    // `chown owner file`: the owner is no path.
    const files =
      name === "chown" || name === "chgrp"
        ? strong.slice(rest.some((w) => w.startsWith("--reference")) ? 0 : 1)
        : strong.filter((w) => !(name === "chmod" && MODE.test(w)));
    const copying = DEST_LAST.has(name) && files.length > 1;
    const targeted = rest.some((w) =>
      /^-[A-Za-z]*t|^--target-directory/.test(w),
    );
    // A directory that receives files is not written itself: the files it
    // receives are, and a glob next to one is a source, listed by `copied`.
    const isDir = (f: string): boolean =>
      targeted || f.endsWith("/") || isDirectory(cwd, f);
    const hasDir = copying && files.some(isDir);
    // The target of a symbolic link is read from the link's directory, below.
    const symbolic =
      name === "ln" &&
      rest.some((w) => w === "--symbolic" || /^-[A-Za-z]*s/.test(w));
    out.paths.push(
      ...files.filter(
        (f, at) =>
          !(copying && isDir(f)) &&
          !(hasDir && /[*?[]/.test(f)) &&
          !(symbolic && at < files.length - 1 && !f.startsWith("/")),
      ),
    );
    out.weak.push(...weak);
    if (files.length > OPERAND_LIMIT) {
      out.unknown = true;
    }
    if (DEST_LAST.has(name)) {
      const relative =
        name === "cp"
          ? rest.includes("--parents")
          : name === "rsync" &&
            rest.some((w) => w === "--relative" || /^-[A-Za-z]*R/.test(w));
      for (const dir of files.slice(0, OPERAND_LIMIT)) {
        if (targeted || dir.endsWith("/") || isDirectory(cwd, dir)) {
          for (const source of files.filter((w) => w !== dir)) {
            out.paths.push(
              ...copied(dir, source, name === "rsync", relative, cwd),
            );
            if (name === "ln" && symbolic && !source.startsWith("/")) {
              out.paths.push(under(dir, source));
            }
          }
        }
      }
      if (name === "ln" && symbolic) {
        for (const file of targeted ? files : files.slice(-1)) {
          out.paths.push(
            ...files
              .filter((w) => !w.startsWith("/") && w !== file)
              .map((w) => under(dirOf(file), w)),
          );
        }
      }
      out.unknown ||=
        name === "rsync" && rest.some((w) => HIDDEN_RSYNC.test(w));
      const deleting =
        name === "rsync" &&
        rest.some((w) => /^--(?:delete|remove-source)/.test(w));
      if (name === "mv" || deleting) {
        // The sources of a move (all words after `-t`) are removed.
        const removed = targeted || deleting ? files : files.slice(0, -1);
        out.paths.push(...removed);
        out.trees.push(...removed.map((path) => ({ path })));
      }
    } else if (
      name === "rm" ||
      name === "rmdir" ||
      name === "shred" ||
      name === "unlink"
    ) {
      if (recursive) {
        out.trees.push(...files.map((path) => ({ path })));
      }
    } else if (name === "zip") {
      // `-m` deletes the sources, `-T`/`-TT` runs a program.
      out.unknown ||= rest.some((w) =>
        /^-[A-Za-z]*[mT][A-Za-z]*$|^--(?:move|test|unzip)/.test(w),
      );
    } else if (name === "split" && files.length < 2) {
      out.paths.push("x*");
    }
    return true;
  }
  if (IN_PLACE.has(name)) {
    const inPlace = rest.some(
      (w) => w.startsWith("--in-place") || /^-[a-zA-Z0-9]*i/.test(w),
    );
    const scripted = rest.some((w) =>
      /^-[A-Za-z]*[eEf]$|^--(?:expression|file)/.test(w),
    );
    if (inPlace) {
      const { strong } = operandsOf(argv, name === "perl" ? "eEI" : "el");
      out.paths.push(...(scripted ? strong : strong.slice(1)));
    }
    if (name !== "perl") {
      const files = sedFiles(rest);
      out.unknown ||= files === null;
      out.paths.push(...(files ?? []));
    }
    return inPlace;
  }
  if (AWKS.has(name)) {
    const inPlace = rest.some(
      (w, i) =>
        (/^(?:-i|--include)$/.test(w) && rest[i + 1] === "inplace") ||
        /^(?:-iinplace|--include=inplace)$/.test(w),
    );
    // A program from a file, a library, or an include can write anywhere.
    out.unknown ||=
      rest.some((w) =>
        /^(?:-f|-e|-E|-l|--file|--source|--exec|--load)/.test(w),
      ) ||
      (!inPlace && rest.some((w) => /^(?:-i|--include)/.test(w)));
    for (const word of rest.filter((w) => !w.startsWith("-"))) {
      awkFiles(word, out);
    }
    if (inPlace) {
      out.paths.push(
        ...operandsOf(argv, "vF").strong.filter((w) => !/[\s{$'"=]/.test(w)),
      );
    }
    return true;
  }
  switch (name) {
    case "tar":
      tarWrites(rest, out);
      return true;
    case "unzip":
      // Extraction creates files named by the archive; only a listing is read-only.
      out.unknown ||= !rest.some((w) =>
        /^-(?=[lptvZq]*[lptvZ])[lptvZq]+$/.test(w),
      );
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
      const names = rest.flatMap((w, i) =>
        /^-i?name$/.test(w) && rest[i + 1] !== undefined
          ? [rest[i + 1] ?? ""]
          : [],
      );
      const filtered =
        rest.some((w) =>
          /^-(?:path|ipath|regex|iregex|wholename|newer)/.test(w),
        ) || rest.includes("-o");
      if (rest.includes("-delete")) {
        const list = roots.length > 0 ? roots : ["."];
        out.paths.push(...list);
        out.trees.push(
          ...list.map((path) => ({
            path,
            names: names.length > 0 && !filtered ? names : undefined,
          })),
        );
      }
      for (const [index, word] of rest.entries()) {
        if (/^-(?:fprint0?|fls|fprintf)$/.test(word)) {
          out.paths.push(rest[index + 1] ?? "");
        }
      }
      return rest.includes("-delete");
    }
    case "git":
      return gitWrites(rest, out, cwd);
    default:
      out.unknown ||=
        EDITORS.has(name) &&
        rest.some((w) => /^(?:-[A-Za-z]*[sSc]|--cmd|\+.+)$/.test(w));
      return (
        name === "dd" || name === "curl" || name === "wget" || name === "sort"
      );
  }
}

/** Everything the segment writes, wrappers and redirects included. `cwd` is where the shell is. */
export function shellWriteSet(segment: Segment, cwd: string): WriteSet {
  const out: WriteSet = {
    paths: redirectTargets(segment),
    weak: [],
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
    const here: WriteSet = { paths: [], weak: [], trees: [], unknown: false };
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
    out.weak.push(...here.weak);
    out.trees.push(...here.trees);
    out.unknown ||= here.unknown;
  }
  out.paths = out.paths.filter(
    (path) => path.length > 0 && path !== "-" && !isDevicePath(path),
  );
  out.unknown ||= out.paths.some((path) => path.length > WORD_LIMIT);
  return out;
}
