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
  /** Directories whose existing contents are removed or moved. */
  trees: Array<{ path: string }>;
  /** Files only read (a copy source, a pattern): judged by `protected-paths` and `generated-files-guard`, not by `scope-guard`. */
  reads: string[];
  /** A writer whose destination the command line does not name, or one with a hidden effect: denied. */
  unknown: boolean;
  /** Directory entries listed so far for this command: one budget for all of its globs. */
  listed: number;
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
/** `sed` long options that take no value. */
const SED_PLAIN = [
  "quiet",
  "silent",
  "regexp-extended",
  "separate",
  "null-data",
  "posix",
  "debug",
  "sandbox",
  "follow-symlinks",
  "unbuffered",
  "binary",
  "zero-terminated",
  "help",
  "version",
];
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const EDITORS = new Set(["vi", "vim", "nvim", "view"]);
const NUMBER = /^[+-]?\d+(?:\.\d+)?[kKmMgGsSdDhH]?$/;
const MODE =
  /^(?:[0-7]{3,4}|[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*)$/;
/** More operands than this: not worth judging pair by pair. */
const OPERAND_LIMIT = 64;
/** A word this long is a glob that costs too much to intersect. */
const WORD_LIMIT = 1024;
/** All glob words of one command together: more costs too much to intersect. */
const GLOB_LIMIT = 4096;
/** Directory entries listed for the globs of one command. */
const LISTING_LIMIT = 20000;
/** Commands whose `-o` and `-O` are no output file. */
const NO_OUTPUT_SHORT = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "ls",
  "ps",
  "ssh",
  "scp",
  "sftp",
  "tar",
  "find",
  "rsync",
  "install",
  "xargs",
  "sed",
  "gsed",
  "perl",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "python",
  "python3",
  "node",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
]);
/** Short options of the copy tools that take no value: any other letter may take the next word. */
const FLAGS_NO_VALUE: Record<string, string> = {
  cp: "RrafinpvulsLPHdxbTUZ",
  mv: "fivnuTbUZ",
  ln: "sfinvrLPTbdF",
  install: "bCcdDpsvTU",
  rsync: "avzrtplgoDHLKkRPhincuWxqSXAUEyOJ",
  ditto: "",
};
/** Long options of the copy tools that take no value (a prefix of one counts). Any other option without `=` may take the next word. */
const LONG_NO_VALUE = [
  "archive",
  "recursive",
  "force",
  "interactive",
  "verbose",
  "update",
  "preserve",
  "parents",
  "no-clobber",
  "no-dereference",
  "no-target-directory",
  "no-whole-file",
  "dereference",
  "link",
  "symbolic-link",
  "symbolic",
  "remove-destination",
  "backup",
  "strip-trailing-slashes",
  "copy-contents",
  "one-file-system",
  "times",
  "perms",
  "owner",
  "group",
  "links",
  "hard-links",
  "compress",
  "human-readable",
  "progress",
  "partial",
  "dry-run",
  "delete",
  "delete-before",
  "delete-during",
  "delete-delay",
  "delete-after",
  "delete-excluded",
  "stats",
  "itemize-changes",
  "checksum",
  "whole-file",
  "inplace",
  "relative",
  "prune-empty-dirs",
  "remove-source-files",
  "cvs-exclude",
  "existing",
  "ignore-existing",
  "size-only",
  "quiet",
  "help",
  "version",
];
/** Long options whose `=` value is a directory or file the tool writes. */
const LONG_WRITES = /^--(?:backup-dir|partial-dir|temp-dir|log-file|out)/;

/**
 * GNU getopt takes any prefix of a long option that names only one: `--par` is
 * `--parents`. A word matches when it is a prefix of one of the `names`; an
 * ambiguous prefix (an error in the tool) matches too.
 */
function isLong(word: string, ...names: string[]): boolean {
  const name = word.split("=", 1)[0] ?? "";
  return (
    name.length > 2 &&
    name.startsWith("--") &&
    names.some((full) => `--${full}`.startsWith(name))
  );
}

type Operands = { strong: string[]; lenient: string[]; weak: string[] };

/**
 * The words of `argv` that can be a path. No option removes a word from
 * judgement: operands, the values of `--opt=X` and `--opt X`, tails glued to a
 * short option (`-tX`) and, for an all-letter cluster (`-rtX`), the suffixes
 * after its first letters are all paths. Only `-` is none. `lenient` are
 * values of pattern options (`--exclude X`) and of the short options in
 * `valueLetters` (`zip -x X`, `perl -e X`): judged for `protected-paths` and
 * `generated-files-guard`, not for scope.
 */
function operandsOf(argv: readonly string[], valueLetters = ""): Operands {
  const out: Operands = { strong: [], lenient: [], weak: [] };
  let literal = false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (!literal && word === "--") {
      literal = true;
    } else if (literal || !word.startsWith("-") || word === "-") {
      if (word !== "" && word !== "-") {
        out.strong.push(word);
      }
    } else if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      if (/^--(?:exclude|include|filter)$/.test(name)) {
        out.lenient.push(eq < 0 ? (argv[index + 1] ?? "") : word.slice(eq + 1));
        index += eq < 0 ? 1 : 0;
      } else if (eq > 0 && word.length > eq + 1) {
        out.strong.push(word.slice(eq + 1));
      }
    } else {
      const glued = /^-([A-Za-z]+)(.*)$/.exec(word);
      const tail = (glued?.[2] ?? "").replace(/^=/, "");
      if (
        glued &&
        valueLetters.includes(glued[1]?.at(-1) ?? "-") &&
        tail === ""
      ) {
        out.lenient.push(argv[index + 1] ?? "");
        index += 1;
      } else if (tail !== "") {
        (valueLetters.includes(glued?.[1]?.at(-1) ?? "-")
          ? out.lenient
          : out.strong
        ).push(tail);
      } else if (glued) {
        const letters = glued[1] ?? "";
        for (let at = 1; at + 3 <= letters.length; at += 1) {
          out.weak.push(letters.slice(at));
        }
      }
    }
  }
  return out;
}

type CopyWords = {
  /** Where files land: the `-t` directory, or the last word, and any word that may be one. */
  dests: string[];
  sources: string[];
  patterns: string[];
  targets: string[];
};

/**
 * The words of a copy tool (`cp`, `mv`, `ln`, `install`, `rsync`) by role. The
 * destination is the `-t`/`--target-directory` value if there is one, else the
 * last word; a word that follows an option of unknown arity may be the last
 * operand, so it is a destination too, and so is the word before it.
 */
function copyWords(name: string, rest: readonly string[]): CopyWords {
  const flags = FLAGS_NO_VALUE[name] ?? "";
  const targetFlag = name !== "rsync" && name !== "ditto";
  const words: Array<{ word: string; loose: boolean }> = [];
  const targets: string[] = [];
  const patterns: string[] = [];
  let literal = false;
  let loose = false;
  const add = (word: string | undefined, isLoose: boolean): void => {
    if (word !== undefined && word !== "" && word !== "-") {
      words.push({ word, loose: isLoose });
    }
  };
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    if (!literal && word === "--") {
      literal = true;
      loose = false;
    } else if (literal || !word.startsWith("-") || word === "-") {
      add(word, loose);
      loose = false;
    } else if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const value = eq < 0 ? null : word.slice(eq + 1);
      const long = eq < 0 ? word : word.slice(0, eq);
      loose = false;
      if (targetFlag && isLong(word, "target-directory")) {
        targets.push(value ?? rest[index + 1] ?? "");
        index += value === null ? 1 : 0;
      } else if (/^--(?:exclude|include|filter)$/.test(long)) {
        patterns.push(value ?? rest[index + 1] ?? "");
        index += value === null ? 1 : 0;
      } else if (value !== null) {
        // An `=` value is a path only for the options that write one.
        if (LONG_WRITES.test(long)) {
          add(value, true);
        } else {
          patterns.push(value);
        }
      } else {
        loose = !isLong(word, ...LONG_NO_VALUE);
      }
    } else {
      loose = false;
      const letters = word.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const letter = letters[at] ?? "";
        const tail = letters.slice(at + 1).replace(/^=/, "");
        if (targetFlag && letter === "t") {
          targets.push(tail !== "" ? tail : (rest[index + 1] ?? ""));
          index += tail === "" ? 1 : 0;
          break;
        }
        if (flags.includes(letter) || !/[A-Za-z]/.test(letter)) {
          continue;
        }
        if (name === "rsync" && letter === "f") {
          patterns.push(tail !== "" ? tail : (rest[index + 1] ?? ""));
          index += tail === "" ? 1 : 0;
        } else if (tail !== "") {
          add(tail, true);
        } else {
          loose = true;
        }
        break;
      }
    }
  }
  const dests = new Set<string>();
  for (const entry of words) {
    if (entry.loose || (name === "ln" && words.length >= 3)) {
      dests.add(entry.word);
    }
  }
  for (const target of targets) {
    dests.add(target);
  }
  if (targets.length === 0) {
    // The last word, and the word before it while the last may be an option value.
    for (let last = words.length - 1; last >= 0; last -= 1) {
      dests.add(words[last]?.word ?? "");
      if (!words[last]?.loose) {
        break;
      }
    }
  }
  return {
    dests: [...dests],
    sources: words.map((e) => e.word).filter((w) => !dests.has(w)),
    patterns,
    targets,
  };
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
  out: WriteSet,
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
    out.listed += names.length;
    if (out.listed > LISTING_LIMIT) {
      // The cost of all globs of one command is capped: denied, not guessed.
      out.unknown = true;
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
function sedFiles(
  rest: readonly string[],
): { files: string[]; operands: string[]; inPlace: boolean } | null {
  const scripts: string[] = [];
  const operands: string[] = [];
  let explicit = false;
  let inPlace = false;
  let literal = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    if (literal || word === "-" || !word.startsWith("-")) {
      operands.push(word);
    } else if (word === "--") {
      literal = true;
    } else if (word.startsWith("--")) {
      const value = word.includes("=")
        ? word.slice(word.indexOf("=") + 1)
        : null;
      if (isLong(word, "expression")) {
        scripts.push(value ?? rest[index + 1] ?? "");
        explicit = true;
        index += value === null ? 1 : 0;
      } else if (isLong(word, "in-place")) {
        inPlace = true;
      } else if (isLong(word, "line-length")) {
        index += value === null ? 1 : 0;
      } else if (!isLong(word, ...SED_PLAIN)) {
        // `--file` and any option we do not know.
        return null;
      }
    } else {
      // A cluster: `e` and `l` take the rest of the word or the next word, `i` a glued suffix.
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at] ?? "";
        const glued = word.slice(at + 1);
        if (!/[A-Za-z]/.test(letter)) {
          break;
        }
        if (letter === "f") {
          return null;
        }
        if (letter === "e") {
          scripts.push(glued !== "" ? glued : (rest[index + 1] ?? ""));
          explicit = true;
          index += glued === "" ? 1 : 0;
          break;
        }
        if (letter === "l") {
          index += glued === "" ? 1 : 0;
          break;
        }
        if (letter === "i") {
          inPlace = true;
          break;
        }
      }
    }
  }
  if (!explicit) {
    // The script is the first operand, and no path.
    scripts.push(operands.shift() ?? "");
  }
  const files: string[] = [];
  for (const script of scripts) {
    const found = sedScriptFiles(script);
    if (found === null) {
      return null;
    }
    files.push(...found);
  }
  return { files, operands, inPlace };
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

/** A `tar` option that runs a program or writes a file the command line does not name. */
function hiddenTar(word: string): boolean {
  if (word.startsWith("--")) {
    return (
      word.split("=", 1)[0] !== "--checkpoint" &&
      isLong(
        word,
        "checkpoint-action",
        "use-compress-program",
        "to-command",
        "remove-files",
        "listed-incremental",
        "index-file",
        "info-script",
        "new-volume-script",
        "rmt-command",
        "rsh-command",
      )
    );
  }
  // Every letter of a cluster, up to the first one that takes the rest as its value.
  for (const letter of word.slice(1)) {
    if ("IgF".includes(letter)) {
      return true;
    }
    if ("fCbNTXLVKR".includes(letter)) {
      return false;
    }
  }
  return false;
}

/** An `rsync` option that reads a list from, or writes a batch to, a file we cannot see, or runs a program. */
function hiddenRsync(word: string): boolean {
  if (word.startsWith("--")) {
    return (
      !/^--(?:exclude|include)(?:=|$)/.test(word) &&
      isLong(
        word,
        "files-from",
        "include-from",
        "exclude-from",
        "write-batch",
        "only-write-batch",
        "rsh",
        "read-batch",
      )
    );
  }
  return /^-[A-Za-z]*e/.test(word);
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
    out.unknown ||= hiddenTar(word);
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
  out.unknown ||= writes && args.some((w) => isLong(w, "pathspec-from-file"));
  const dashes = args.indexOf("--");
  const after = dashes < 0 ? [] : args.slice(dashes + 1);
  // `--source X` and `--source=X` name a revision, not a path.
  const options = args
    .slice(0, dashes < 0 ? undefined : dashes)
    .filter((w, i, all) => {
      const before = all[i - 1] ?? "";
      return (
        !isLong(w, "source") &&
        !(isLong(before, "source") && !before.includes("="))
      );
    });
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
    const paths =
      flag(/^-[A-Za-z]*[mp]/) ||
      args.some((w) =>
        isLong(w, "ours", "theirs", "merge", "conflict", "patch"),
      );
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
    const staged =
      flag(/^-[A-Za-z]*S[A-Za-z]*$/) || args.some((w) => isLong(w, "staged"));
    const tree =
      flag(/^-[A-Za-z]*W[A-Za-z]*$/) || args.some((w) => isLong(w, "worktree"));
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

/** The URL's last path segment, which `curl -O` and `wget` name the file after; null when there is none. */
function urlFile(url: string): string | null {
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*$/.test(path)) {
    return null;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "" ? null : name;
}

/**
 * Output options of any command: `dd of=`, `-o`/`-O` and `--out*`/`--log-file`
 * values (separate or glued), and the file `curl -O` and `wget` name after the
 * URL.
 */
function outputsOf(name: string, rest: readonly string[], out: WriteSet): void {
  const letters = name === "curl" ? "o" : "oO";
  const shortOutput = !NO_OUTPUT_SHORT.has(name);
  let remote = name === "wget";
  let prefix = "";
  for (const [index, word] of rest.entries()) {
    const next = rest[index + 1] ?? "";
    const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : next;
    if (name === "dd" && word.startsWith("of=")) {
      out.paths.push(word.slice(3));
    } else if (
      /^--out/.test(word) ||
      isLong(word, "output", "log-file") ||
      /^--(?:destination|dest|to)=/.test(word)
    ) {
      out.paths.push(value);
      remote &&= !isLong(word, "output-document");
    } else if (word.startsWith("--")) {
      remote ||=
        name === "curl" && isLong(word, "remote-name", "remote-name-all");
      if (name === "wget" && isLong(word, "directory-prefix")) {
        prefix = value;
      }
    } else if (/^-[A-Za-z]/.test(word)) {
      if (shortOutput && new RegExp(`^-[A-Za-z]*[${letters}]$`).test(word)) {
        out.paths.push(next);
      } else if (shortOutput && new RegExp(`^-[${letters}].`).test(word)) {
        out.paths.push(word.slice(2));
      }
      remote ||= name === "curl" && /^-[A-Za-z]*O/.test(word);
      remote &&= !(name === "wget" && /^-[A-Za-z]*O/.test(word));
      if (name === "wget" && /^-[A-Za-z]*P$/.test(word)) {
        prefix = next;
      } else if (name === "wget" && /^-P./.test(word)) {
        prefix = word.slice(2);
      }
    }
  }
  if (remote) {
    for (const word of rest.filter((w) => w.includes("://"))) {
      const file = urlFile(word);
      if (file !== null) {
        out.paths.push(prefix === "" ? file : under(prefix, file));
      }
    }
  }
}

/** What a copy tool (`cp`, `mv`, `ln`, `install`, `rsync`) writes. */
function copyWrites(
  name: string,
  rest: readonly string[],
  out: WriteSet,
  cwd: string,
): void {
  const { dests, sources, patterns, targets } = copyWords(name, rest);
  out.reads.push(...patterns);
  // `-rtsecrets`: the value glued to a cluster is no word of its own.
  out.weak.push(...operandsOf(["", ...rest]).weak);
  const symbolic =
    name === "ln" &&
    (rest.some((w) => /^-[A-Za-z]*s/.test(w)) ||
      rest.some((w) => isLong(w, "symbolic")));
  const relative =
    name === "cp"
      ? rest.some((w) => isLong(w, "parents"))
      : name === "rsync" &&
        rest.some((w) => isLong(w, "relative") || /^-[A-Za-z]*R/.test(w));
  const copying = sources.length > 0;
  // A directory that receives files is not written itself: the files it
  // receives are, listed by `copied`.
  const isDir = (word: string): boolean =>
    targets.includes(word) || word.endsWith("/") || isDirectory(cwd, word);
  out.paths.push(...dests.filter((dest) => !(copying && isDir(dest))));
  if (dests.length + sources.length > OPERAND_LIMIT) {
    out.unknown = true;
  }
  for (const dir of dests.slice(0, OPERAND_LIMIT)) {
    if (copying && isDir(dir)) {
      for (const source of sources.slice(0, OPERAND_LIMIT)) {
        out.paths.push(
          ...copied(dir, source, name === "rsync", relative, cwd, out),
        );
        if (symbolic && !source.startsWith("/")) {
          out.reads.push(under(dir, source));
        }
      }
    }
  }
  if (symbolic) {
    // A link reads its target from the link's directory.
    for (const link of dests) {
      out.reads.push(
        ...sources
          .filter((source) => !source.startsWith("/"))
          .map((source) => under(dirOf(link), source)),
      );
    }
  }
  out.unknown ||= name === "rsync" && rest.some(hiddenRsync);
  const deleting =
    name === "rsync" &&
    rest.some((w) =>
      isLong(
        w,
        "delete",
        "delete-before",
        "delete-during",
        "delete-delay",
        "delete-after",
        "delete-excluded",
        "remove-source-files",
      ),
    );
  if (name === "mv" || deleting) {
    // The sources of a move are removed; so is what `--delete` finds in the destination.
    const removed = deleting ? [...sources, ...dests] : sources;
    out.paths.push(...removed);
    out.trees.push(...removed.map((path) => ({ path })));
  } else {
    // A copy source is read: only the policy of its content applies.
    out.reads.push(...sources.filter((source) => !/[*?[{$`]/.test(source)));
  }
}

/** `awk`: hidden-write options, in-place editing and the files the program writes. */
function awkWrites(argv: readonly string[], out: WriteSet): void {
  const rest = argv.slice(1);
  let inPlace = false;
  let hidden = false;
  for (const [index, word] of rest.entries()) {
    const next = rest[index + 1] ?? "";
    if (word.startsWith("--")) {
      if (isLong(word, "include")) {
        const value = word.includes("=")
          ? word.slice(word.indexOf("=") + 1)
          : next;
        inPlace ||= value === "inplace";
        hidden ||= value !== "inplace";
      } else if (
        isLong(
          word,
          "file",
          "source",
          "exec",
          "load",
          "profile",
          "dump-variables",
          "pretty-print",
          "debug",
        )
      ) {
        hidden = true;
      }
    } else if (/^-[A-Za-z]/.test(word)) {
      // Every letter of a cluster, up to the first one that takes the rest as its value.
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at] ?? "";
        const glued = word.slice(at + 1);
        if (letter === "v" || letter === "F") {
          break;
        }
        if (letter === "i") {
          const value = glued !== "" ? glued : next;
          inPlace ||= value === "inplace";
          hidden ||= value !== "inplace";
          break;
        }
        if ("feEloLpdD".includes(letter)) {
          hidden = true;
          break;
        }
      }
    }
  }
  // A program from a file, a library, an include or a dump can write anywhere.
  out.unknown ||= hidden;
  for (const word of rest.filter((w) => !w.startsWith("-"))) {
    awkFiles(word, out);
  }
  if (inPlace) {
    out.paths.push(
      ...operandsOf(argv, "vF").strong.filter(
        (w) => w !== "inplace" && !/[\s{$'"=]/.test(w),
      ),
    );
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
  const recursive = rest.some(
    (word) => word === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(word),
  );
  outputsOf(name, rest, out);
  if (DEST_LAST.has(name)) {
    copyWrites(name, rest, out, cwd);
    return true;
  }
  if (OPERAND_WRITERS.has(name)) {
    const { strong, lenient, weak } = operandsOf(
      argv,
      name === "zip" ? "xi" : "",
    );
    const reference = rest.some((w) => isLong(w, "reference"));
    // `chown owner file`, `chmod mode file`: the owner and the mode are no path.
    const files =
      name === "chown" || name === "chgrp"
        ? strong.slice(reference ? 0 : 1)
        : name === "chmod" && !reference && MODE.test(strong[0] ?? "")
          ? strong.slice(1)
          : strong;
    out.paths.push(...files);
    out.reads.push(...lenient);
    out.weak.push(...weak);
    if (files.length > OPERAND_LIMIT) {
      out.unknown = true;
    }
    if (
      name === "rm" ||
      name === "rmdir" ||
      name === "shred" ||
      name === "unlink"
    ) {
      if (recursive || rest.some((w) => isLong(w, "recursive"))) {
        out.trees.push(...files.map((path) => ({ path })));
      }
    } else if (name === "zip") {
      // `-m` deletes the sources, `-T`/`-TT` runs a program.
      out.unknown ||= rest.some((w) =>
        w.startsWith("--")
          ? isLong(w, "move", "test", "unzip")
          : /^-[A-Za-z0-9]*[mT]/.test(w),
      );
    } else if (
      name === "split" &&
      files.filter((f) => !NUMBER.test(f)).length < 2
    ) {
      out.paths.push("x*");
    }
    return true;
  }
  if (name === "perl") {
    const scripted = rest.some((w) => /^-[A-Za-z]*[eEf]$/.test(w));
    const inPlace = rest.some((w) => /^-[a-zA-Z0-9]*i/.test(w));
    if (inPlace) {
      const { strong, lenient } = operandsOf(argv, "eEI");
      out.paths.push(...(scripted ? strong : strong.slice(1)));
      out.reads.push(...lenient);
    }
    return inPlace;
  }
  if (name === "sed" || name === "gsed") {
    const parsed = sedFiles(rest);
    out.unknown ||= parsed === null;
    out.paths.push(...(parsed?.files ?? []));
    if (parsed?.inPlace) {
      out.paths.push(...parsed.operands);
    }
    return parsed?.inPlace ?? false;
  }
  if (AWKS.has(name)) {
    awkWrites(argv, out);
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
      // A filter (`-name`, `!`, `-o`, `-path`) never narrows what a remover
      // may reach: each start directory is judged as removed.
      const removing =
        rest.includes("-delete") ||
        rest.some(
          (w, i) =>
            /^-(?:exec|execdir|ok|okdir)$/.test(w) &&
            ["rm", "rmdir", "unlink", "shred"].includes(
              commandName(rest[i + 1] ?? ""),
            ),
        );
      if (removing) {
        const list = roots.length > 0 ? roots : ["."];
        out.paths.push(...list);
        out.trees.push(...list.map((path) => ({ path })));
      }
      for (const [index, word] of rest.entries()) {
        if (/^-(?:fprint0?|fls|fprintf)$/.test(word)) {
          out.paths.push(rest[index + 1] ?? "");
        }
      }
      return removing;
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
    reads: [],
    unknown: false,
    listed: 0,
  };
  const plain = withoutRedirects(segment.argv);
  const reached = [...walkCommands(plain).at].sort((a, b) => a - b);
  for (const index of reached) {
    const exec = /^-(?:exec|execdir|ok|okdir)$/.test(plain[index - 1] ?? "");
    const stop = plain.findIndex(
      (w, i) => i > index && (w === ";" || w === "+"),
    );
    const here: WriteSet = {
      paths: [],
      weak: [],
      trees: [],
      reads: [],
      unknown: false,
      listed: out.listed,
    };
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
    out.reads.push(...here.reads);
    out.unknown ||= here.unknown;
    out.listed = here.listed;
  }
  const keep = (path: string): boolean =>
    path.length > 0 && path !== "-" && !isDevicePath(path);
  out.paths = out.paths.filter(keep);
  out.reads = out.reads.filter(keep);
  // The glob words of one command are capped together, not word by word.
  const globs = out.paths.filter((path) => /[*?[]/.test(path));
  out.unknown ||=
    out.paths.some((path) => path.length > WORD_LIMIT) ||
    globs.reduce((total, path) => total + path.length, 0) > GLOB_LIMIT;
  return out;
}
