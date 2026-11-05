const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMBINED_SHORT = /^-[a-zA-Z]{2,}$/;

export type ArgToken = { text: string; value: boolean };

export type Segment = {
  env: Record<string, string>;
  argv: string[];
  tokens: ArgToken[];
  /** Indexes into `argv` of words that held an unquoted `<`, `>`, `(` or `)`: redirects, process substitution, fd forms. */
  meta: number[];
  /**
   * Indexes into `argv` of words the shell may rewrite after we have read them:
   * an unquoted `$`, `{`, `}`, `*`, `?`, `[`, a `~user` tilde, or a `$` inside
   * double quotes. Single-quoted and backslash-escaped text is literal.
   */
  expand: number[];
};

export type Pipeline =
  | {
      ok: true;
      segments: Segment[];
      pipes: boolean[];
      /** The command held a shell comment (an unquoted `#` at the start of a word). */
      comment: boolean;
      /** The command held an unquoted newline outside a heredoc body, followed by more text. */
      newline: boolean;
    }
  | { ok: false };

type RawSegment = {
  words: string[];
  pipeAfter: boolean;
  heredoc: boolean;
  meta: number[];
  expand: number[];
};

/**
 * A quoted heredoc body is data only for a command that treats stdin as text.
 * Consumer allowlist: the command word that receives the heredoc must be one
 * of these. Interpreters and exec wrappers would execute the body, so a
 * pipeline with a heredoc is unparseable (denied) when any word of any other
 * segment, or any later word of the receiver, names one of them (also by
 * path, e.g. `/bin/sh`).
 */
const HEREDOC_CONSUMERS = new Set(["git", "gh", "cat", "tee"]);
const EXECUTORS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "awk",
  "gawk",
  "eval",
  "source",
  ".",
  "exec",
  "xargs",
  "env",
  "sudo",
  "doas",
  "nohup",
  "time",
  "timeout",
  "nice",
  "command",
  "builtin",
  "busybox",
  "ssh",
]);

function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function isExecutor(word: string): boolean {
  const name = commandName(word);
  return EXECUTORS.has(name) || /^(python|ruby|perl|php)[\d.]*$/.test(name);
}

function heredocSafe(raw: RawSegment[], prepared: Segment[]): boolean {
  if (!raw.some((segment) => segment.heredoc)) {
    return true;
  }
  return prepared.every((segment, index) => {
    const head = segment.argv[0] ?? "";
    if (raw[index]?.heredoc && !HEREDOC_CONSUMERS.has(head)) {
      return false;
    }
    return !segment.argv.slice(raw[index]?.heredoc ? 1 : 0).some(isExecutor);
  });
}

export function tokenize(command: string): Pipeline {
  const scanned = scan(command);
  if (!scanned) {
    return { ok: false };
  }
  const raw = scanned.segments;
  const segments = raw.map((segment) =>
    prepare(segment.words, segment.meta, segment.expand),
  );
  if (!heredocSafe(raw, segments)) {
    return { ok: false };
  }
  const pipes = raw.slice(0, -1).map((segment) => segment.pipeAfter);
  return {
    ok: true,
    segments,
    pipes,
    comment: scanned.comment,
    newline: scanned.newline,
  };
}

type Heredoc = { delimiter: string; stripTabs: boolean };

/**
 * Parse the delimiter of a heredoc whose `<<` starts at `at`. Only a fully
 * quoted delimiter (`<<'X'`, `<<"X"`, `<<-'X'`) is accepted: its body is not
 * expanded, so it is data. An unquoted or oddly quoted delimiter returns null,
 * because the body would expand `$(...)` and backticks.
 */
function parseHeredocStart(
  command: string,
  at: number,
): { heredoc: Heredoc; next: number } | null {
  let index = at + 2;
  const stripTabs = command[index] === "-";
  if (stripTabs) {
    index += 1;
  }
  while (command[index] === " " || command[index] === "\t") {
    index += 1;
  }
  const quote = command[index];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  const close = command.indexOf(quote, index + 1);
  if (close === -1) {
    return null;
  }
  const delimiter = command.slice(index + 1, close);
  if (delimiter.length === 0 || /[\n\\`$'"]/.test(delimiter)) {
    return null;
  }
  const after = command[close + 1];
  if (after !== undefined && !/[ \t\n;|&]/.test(after)) {
    return null;
  }
  return { heredoc: { delimiter, stripTabs }, next: close };
}

/** Index of the newline that ends the body of `heredoc` (or the command end); null when it is not terminated. */
function skipHeredocBody(
  command: string,
  from: number,
  heredoc: Heredoc,
): number | null {
  let lineStart = from;
  while (lineStart <= command.length) {
    const newline = command.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? command.length : newline;
    const raw = command.slice(lineStart, lineEnd);
    const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
    if (line === heredoc.delimiter) {
      return lineEnd;
    }
    if (newline === -1) {
      return null;
    }
    lineStart = newline + 1;
  }
  return null;
}

function scan(command: string): {
  segments: RawSegment[];
  comment: boolean;
  newline: boolean;
} | null {
  const segments: RawSegment[] = [];
  let comment = false;
  let newline = false;
  const pending: Heredoc[] = [];
  let heredoc = false;
  let words: string[] = [];
  let metas: number[] = [];
  let expands: number[] = [];
  let buf = "";
  let wordStarted = false;
  let wordMeta = false;
  let wordExpand = false;
  let lastGt = false;
  let quote: "single" | "double" | null = null;

  const flushWord = (): void => {
    if (!wordStarted) {
      return;
    }
    if (wordMeta) {
      metas.push(words.length);
    }
    if (wordExpand) {
      expands.push(words.length);
    }
    words.push(buf);
    buf = "";
    wordStarted = false;
    wordMeta = false;
    wordExpand = false;
  };

  const endSegment = (pipeAfter: boolean): void => {
    flushWord();
    segments.push({ words, pipeAfter, heredoc, meta: metas, expand: expands });
    words = [];
    metas = [];
    expands = [];
    heredoc = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    const afterGt = lastGt;
    lastGt = false;
    if (quote === "single") {
      if (ch === "'") {
        quote = null;
      } else {
        buf += ch;
        wordStarted = true;
      }
      continue;
    }
    if (quote === "double") {
      if (ch === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          return null;
        }
        if (next === "\n") {
          // Line continuation: the shell deletes both characters.
          index += 1;
          continue;
        }
        if (next === "\\" || next === '"') {
          buf += next;
          wordStarted = true;
          index += 1;
          continue;
        }
        buf += ch;
        wordStarted = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        wordStarted = true;
        continue;
      }
      // Double quotes still expand command substitution.
      if (ch === "`" || (ch === "$" && command[index + 1] === "(")) {
        return null;
      }
      if (ch === "$") {
        wordExpand = true;
      }
      buf += ch;
      wordStarted = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return null;
      }
      if (next === "\n") {
        // Line continuation: the shell deletes both characters and the word stays open.
        index += 1;
        continue;
      }
      buf += next;
      wordStarted = true;
      index += 1;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      wordStarted = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      wordStarted = true;
      continue;
    }
    if (ch === "#" && !wordStarted) {
      // A comment runs to the next newline (not consumed). Nothing inside it is
      // parsed: no quotes, continuation or heredoc, as the shell does.
      comment = true;
      const end = command.indexOf("\n", index);
      index = (end === -1 ? command.length : end) - 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      continue;
    }
    if (ch === "<" && command[index + 1] === "<") {
      if (command[index + 2] === "<") {
        buf += "<<<";
        wordStarted = true;
        wordMeta = true;
        index += 2;
        continue;
      }
      const start = parseHeredocStart(command, index);
      if (!start) {
        return null;
      }
      flushWord();
      pending.push(start.heredoc);
      heredoc = true;
      index = start.next;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      endSegment(false);
      let end = index;
      for (const heredoc of pending.splice(0)) {
        const found = skipHeredocBody(command, end + 1, heredoc);
        if (found === null) {
          return null;
        }
        end = found;
      }
      index = end;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      if (ch === "\n" && command.slice(index + 1).trim() !== "") {
        newline = true;
      }
      endSegment(false);
      continue;
    }
    if (ch === "|" && command[index + 1] === "|") {
      endSegment(false);
      index += 1;
      continue;
    }
    if (ch === "|") {
      endSegment(true);
      continue;
    }
    if (ch === "&" && command[index + 1] === "&") {
      endSegment(false);
      index += 1;
      continue;
    }
    if (ch === "&") {
      // `&>`, `&>>` and `>&` are redirects; any other lone `&` backgrounds the
      // command before it, so what follows is a new segment.
      if (command[index + 1] === ">" || afterGt) {
        buf += ch;
        wordStarted = true;
        wordMeta = true;
        continue;
      }
      endSegment(false);
      continue;
    }
    if (ch === "`" || (ch === "$" && command[index + 1] === "(")) {
      return null;
    }
    if (
      /[$}{*?[]/.test(ch) ||
      // A tilde expands only at the start of a word, and only `~` alone or `~/`
      // is safe: `~user`, `~+` and `~-` name other directories.
      (ch === "~" &&
        !wordStarted &&
        !/^[\s/;|&<>]?$/.test(command[index + 1] ?? ""))
    ) {
      wordExpand = true;
    }
    buf += ch;
    wordStarted = true;
    if (ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      wordMeta = true;
      lastGt = ch === ">";
    }
  }

  if (quote !== null || pending.length > 0) {
    return null;
  }
  flushWord();
  segments.push({
    words,
    pipeAfter: false,
    heredoc,
    meta: metas,
    expand: expands,
  });
  return { segments, comment, newline };
}

function prepare(
  words: string[],
  metaWords: number[],
  expandWords: number[],
): Segment {
  const env: Record<string, string> = {};
  const argv: string[] = [];
  const meta: number[] = [];
  const expand: number[] = [];
  let assigning = true;
  for (const [position, word] of words.entries()) {
    if (assigning && ENV_ASSIGNMENT.test(word)) {
      const eq = word.indexOf("=");
      env[word.slice(0, eq)] = word.slice(eq + 1);
      continue;
    }
    assigning = false;
    if (metaWords.includes(position)) {
      meta.push(argv.length);
    }
    if (expandWords.includes(position)) {
      expand.push(argv.length);
    }
    argv.push(word);
  }
  return { env, argv, tokens: annotate(argv), meta, expand };
}

function consumesValue(flag: string, subcommand: string | null): boolean {
  if (flag === "-c" || flag === "--config" || flag === "-C") {
    return true;
  }
  return (
    subcommand === "commit" &&
    (flag === "-m" ||
      flag === "--message" ||
      flag === "-F" ||
      flag === "--file")
  );
}

function annotate(argv: string[]): ArgToken[] {
  if (argv[0] !== "git") {
    return argv.map((text) => ({ text, value: false }));
  }
  const valueIndexes = new Set<number>();
  let subcommand: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (valueIndexes.has(index)) {
      continue;
    }
    const token = argv[index] ?? "";
    if (COMBINED_SHORT.test(token)) {
      const consumes = [...token.slice(1)].some((letter) =>
        consumesValue(`-${letter}`, subcommand),
      );
      if (consumes && index + 1 < argv.length) {
        valueIndexes.add(index + 1);
      }
      continue;
    }
    if (consumesValue(token, subcommand)) {
      if (index + 1 < argv.length) {
        valueIndexes.add(index + 1);
      }
      continue;
    }
    if (!token.startsWith("-") && subcommand === null) {
      subcommand = token;
    }
  }

  const tokens: ArgToken[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (valueIndexes.has(index)) {
      tokens.push({ text: token, value: true });
      continue;
    }
    if (index > 0 && COMBINED_SHORT.test(token)) {
      for (const letter of token.slice(1)) {
        tokens.push({ text: `-${letter}`, value: false });
      }
      continue;
    }
    tokens.push({ text: token, value: false });
  }
  return tokens;
}

function isEnvToken(token: string): boolean {
  return ENV_ASSIGNMENT.test(token);
}

function isFlagPattern(token: string): boolean {
  return token.startsWith("-");
}

function globToken(pattern: string, text: string): boolean {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${body}$`).test(text);
}

function tokenMatches(pattern: string, token: ArgToken): boolean {
  if (isFlagPattern(pattern) && token.value) {
    return false;
  }
  if (!pattern.includes("*")) {
    return pattern === token.text;
  }
  return globToken(pattern, token.text);
}

function matchRest(
  parts: string[],
  partIndex: number,
  tokens: ArgToken[],
  argIndex: number,
): boolean {
  if (partIndex >= parts.length) {
    return true;
  }
  const part = parts[partIndex] ?? "";
  const last = partIndex === parts.length - 1;
  if (part === "*") {
    if (last) {
      const head = parts[0];
      if ((head === "curl" || head === "wget") && parts.length === 2) {
        return argIndex < tokens.length;
      }
      return true;
    }
    for (let take = 1; argIndex + take <= tokens.length; take += 1) {
      if (matchRest(parts, partIndex + 1, tokens, argIndex + take)) {
        return true;
      }
    }
    return false;
  }
  for (let index = argIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (
      tokenMatches(part, token) &&
      matchRest(parts, partIndex + 1, tokens, index + 1)
    ) {
      return true;
    }
  }
  return false;
}

export function segmentMatches(pattern: string, segment: Segment): boolean {
  const parts = pattern
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const head = parts[0] ?? "";
  if (isEnvToken(head)) {
    const eq = head.indexOf("=");
    if (segment.env[head.slice(0, eq)] !== head.slice(eq + 1)) {
      return false;
    }
    return matchRest(parts, 1, segment.tokens, 0);
  }
  const first = segment.tokens[0];
  if (!first || !tokenMatches(head, first)) {
    return false;
  }
  return matchRest(parts, 1, segment.tokens, 1);
}

function rightSideMatches(pattern: string, segment: Segment): boolean {
  const parts = pattern
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 1) {
    return segment.argv[0] === parts[0];
  }
  if (parts.length === 2) {
    return segment.argv[0] === parts[0] && segment.argv[1] === parts[1];
  }
  return false;
}

export function pipelineMatches(
  pattern: string,
  pipeline: Extract<Pipeline, { ok: true }>,
): boolean {
  const pipeAt = pattern.indexOf(" | ");
  if (pipeAt !== -1) {
    const left = pattern.slice(0, pipeAt);
    const right = pattern.slice(pipeAt + 3);
    for (let index = 0; index < pipeline.segments.length - 1; index += 1) {
      const leftSegment = pipeline.segments[index];
      const rightSegment = pipeline.segments[index + 1];
      if (!pipeline.pipes[index] || !leftSegment || !rightSegment) {
        continue;
      }
      if (
        segmentMatches(left, leftSegment) &&
        rightSideMatches(right, rightSegment)
      ) {
        return true;
      }
    }
    return false;
  }
  return pipeline.segments.some((segment) => segmentMatches(pattern, segment));
}

export function firstDeny(
  patterns: readonly string[],
  pipeline: Extract<Pipeline, { ok: true }>,
): string | null {
  for (const pattern of patterns) {
    if (pipelineMatches(pattern, pipeline)) {
      return pattern;
    }
  }
  return null;
}

export function rewriteCommand(
  rewrite: Record<string, string>,
  pipeline: Extract<Pipeline, { ok: true }>,
): string | null {
  if (pipeline.segments.length !== 1) {
    return null;
  }
  const segment = pipeline.segments[0];
  if (!segment || Object.keys(segment.env).length > 0) {
    return null;
  }
  for (const [from, to] of Object.entries(rewrite)) {
    const parts = from
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    if (
      parts.length === segment.argv.length &&
      parts.every((part, index) => part === segment.argv[index])
    ) {
      return to;
    }
  }
  return null;
}

export type PathCandidate = { path: string; write: boolean };

/**
 * Options whose value is message-like text, never a path. Long options are
 * unambiguous for every command. Short ones depend on the command, because
 * `ls -m` or `cp -t` take no message: `-m` for git; `-b`, `-t`, `-n` for gh
 * (body, title, notes). Combined short flags (`git commit -am msg`) count for git.
 * `-F -` and `--body-file -` need no entry: `-` is never a path candidate.
 */
const MESSAGE_LONG = new Set([
  "--message",
  "--body",
  "--title",
  "--notes",
  "--subject",
  "--description",
]);
const MESSAGE_SHORT: Record<string, ReadonlySet<string>> = {
  git: new Set(["-m"]),
  gh: new Set(["-b", "-t", "-n"]),
};

/** Commands that only read their path arguments. Any other command's paths count as writes (strict). */
const READ_ONLY = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "grep",
  "rg",
  "wc",
  "file",
  "stat",
  "diff",
  "jq",
  "bat",
  "tree",
  "du",
  "sha256sum",
  "md5sum",
  "source",
  ".",
]);

/** Commands whose every path argument is written. */
const WRITE_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "tee", "truncate"]);
const REDIRECT = /^(?:\d*|&)(>>|>\||>)(.*)$/;

function isMessageFlag(word: string, command: string): boolean {
  if (MESSAGE_LONG.has(word) || MESSAGE_SHORT[command]?.has(word)) {
    return true;
  }
  return command === "git" && /^-[a-zA-Z]+m$/.test(word);
}

/**
 * Paths a shell segment might touch, each classified as read or write.
 * Best effort: no variable expansion and no `sh -c`. Values of message-like
 * options and quoted heredoc bodies are not candidates. When unsure, a word
 * stays a candidate and counts as a write.
 */
export function secretCandidates(segment: Segment): PathCandidate[] {
  return collectCandidates(segment)
    .filter((candidate) => !isDevicePath(candidate.path))
    .map(({ path, write }) => ({ path, write }));
}

/**
 * Paths a segment writes by its own syntax: redirect targets for any command,
 * plus every path argument of a command that is a writer by definition
 * (rm, mkdir, touch, tee, cp, mv...). Positional arguments of other commands
 * are not listed: `gh pr view 12` or `git log origin/main` write nothing.
 * The command word and device paths are never targets.
 */
export function writeTargets(segment: Segment): string[] {
  const command = segment.argv[0] ?? "";
  const writer =
    WRITE_ALL.has(command) ||
    command === "cp" ||
    command === "mv" ||
    command === "ln";
  return collectCandidates(segment)
    .filter(
      (candidate) =>
        candidate.write &&
        !isDevicePath(candidate.path) &&
        (candidate.origin === "redirect" ||
          (writer && candidate.origin === "arg")),
    )
    .map((candidate) => candidate.path);
}

/** Standard streams and descriptors: exact match only, so `/dev/../etc` and `/dev/sda` stay candidates. */
const DEVICE_PATH = /^\/dev\/(?:null|stdout|stderr|stdin|fd\/[0-9]+)$/;

export function isDevicePath(path: string): boolean {
  return DEVICE_PATH.test(path);
}

type Origin = "head" | "redirect" | "arg";

function collectCandidates(
  segment: Segment,
): Array<PathCandidate & { origin: Origin }> {
  const found: Array<PathCandidate & { origin: Origin }> = [];
  const argv = segment.argv;
  const command = argv[0] ?? "";
  const readOnly = READ_ONLY.has(command);
  const writeAll = WRITE_ALL.has(command);
  const copyLike = command === "cp" || command === "mv" || command === "ln";
  let lastPositional = -1;
  for (let index = 1; index < argv.length; index += 1) {
    if (!(argv[index] ?? "").startsWith("-")) {
      lastPositional = index;
    }
  }
  const hasTarget = argv.some(
    (word) => word === "-t" || word.startsWith("--target-directory"),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (index > 0 && isMessageFlag(word, command)) {
      index += 1;
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) {
      const eq = word.indexOf("=");
      if (MESSAGE_LONG.has(word.slice(0, eq))) {
        continue;
      }
      const value = word.slice(eq + 1);
      if (value.length > 0) {
        found.push({ path: value, write: !readOnly, origin: "arg" });
      }
    }
    const redirect = REDIRECT.exec(word);
    if (redirect) {
      const target = redirect[2] ?? "";
      if (target === "") {
        const next = argv[index + 1];
        if (next && next.length > 0) {
          found.push({ path: next, write: true, origin: "redirect" });
          index += 1;
        }
      } else if (!target.startsWith("&")) {
        found.push({ path: target, write: true, origin: "redirect" });
      }
      continue;
    }
    if (word === "<") {
      const next = argv[index + 1];
      if (next && next.length > 0) {
        found.push({ path: next, write: false, origin: "arg" });
      }
      continue;
    }
    if (word.startsWith("<") && word.length > 1) {
      found.push({ path: word.slice(1), write: false, origin: "arg" });
      continue;
    }
    if (!word.startsWith("-")) {
      const write =
        index === 0 ||
        writeAll ||
        (!readOnly && (!copyLike || hasTarget || index === lastPositional));
      found.push({ path: word, write, origin: index === 0 ? "head" : "arg" });
    }
  }
  return found;
}
