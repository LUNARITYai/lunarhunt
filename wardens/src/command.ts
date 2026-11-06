const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMBINED_SHORT = /^-[a-zA-Z]{2,}$/;

/**
 * Brace expansion in unquoted text (`{a,b}`, `{1..3}`), matched against a word
 * whose quoted characters are NUL. It needs a top-level `,` or `..`; a bare
 * `{u}` (`git log @{u}`) or `{}` (`xargs -I{}`) is literal. It is unparseable
 * in ANY position, not just the command word: `git push --forc{e,}` builds
 * the denied `--force`, and `{git,push,--force}` builds the whole command. So
 * the deny side cannot read either form from the text. The cost is that
 * `cp a{,.bak}` is denied too; spell it out.
 */
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * Shell reserved words (bash and zsh) that start a compound command, plus the
 * zsh precommand modifiers. In command position each one makes the real
 * command start later in the segment, where a deny pattern anchored on the
 * first word does not see it. A bare `{` or `}` is a group. Quoting is not
 * tracked: a quoted `'if'` in command position is denied too, which is fine.
 */
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "time",
  "!",
  "[[",
  "]]",
  "{",
  "}",
  "repeat",
  "foreach",
  "nocorrect",
  "noglob",
]);

/** `>x`, `2>x`, `&>x`, `>>`, `<`, `<<<`, `>&2`, `>|`: the part after the operator is the target, possibly the next word. */
const REDIRECT_WORD =
  /^(?:\d+|&|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:>>|>\||>&|>|<<<|<&|<>|<)(.*)$/;

/**
 * Index of the command word: the first word that is not an environment
 * assignment or a redirect (with its target).
 */
function commandWordIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1;
      continue;
    }
    const redirect = REDIRECT_WORD.exec(word);
    if (!redirect) {
      break;
    }
    index += redirect[1] === "" ? 2 : 1;
  }
  return index;
}

/**
 * Commands that run their remaining arguments as another command. A deny
 * pattern for the inner command must still match (`env git push --force`).
 * Not a list of interpreters: `python -c` and friends are out of reach of a
 * text match. `find` is here for `-exec`.
 */
const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  // The bare word `time` is reserved (unparseable); only `/usr/bin/time`, which
  // `commandName` reduces to `time`, reaches this entry.
  "time",
  "nice",
  "ionice",
  "timeout",
  "sudo",
  "doas",
  "xargs",
  "stdbuf",
  "setsid",
  "busybox",
  "watch",
  "unbuffer",
  "caffeinate",
  "chroot",
  "flock",
  "parallel",
  "find",
]);

/** Shells whose `-c` argument (and `eval`'s arguments) is a command line we do not parse. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const COMMAND_STRING_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

function isWrapper(word: string): boolean {
  return WRAPPERS.has(commandName(word));
}

/**
 * Per-wrapper option arity, used to find the command a wrapper runs. `short`
 * letters and `long` names take a value (`-u root`, `-uroot`, `--user root`,
 * `--user=root`); any other short flag is boolean. `operand` is one positional
 * before the command (`timeout 5`, `chroot jail`, `flock file`). `string` /
 * `stringLong` flag a wrapper option that makes the rest ONE command string
 * (`sudo -s`, `sudo --login`).
 */
type Arity = {
  short: string;
  long: string[];
  operand?: "duration" | "any";
  string?: string;
  stringLong?: RegExp;
};

const NONE: Arity = { short: "", long: [] };
const ARITY: Record<string, Arity> = {
  sudo: {
    short: "ugChprtTDUR",
    long: [
      "user",
      "group",
      "close-from",
      "host",
      "prompt",
      "role",
      "type",
      "command-timeout",
      "chdir",
      "other-user",
    ],
    string: "si",
    stringLong: /^--(?:sh|lo)/,
  },
  timeout: { short: "sk", long: ["signal", "kill-after"], operand: "duration" },
  env: { short: "u", long: ["unset"] },
  xargs: {
    short: "ILnPsdaE",
    long: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars"],
  },
  nice: { short: "n", long: ["adjustment"] },
  ionice: {
    short: "cnpPu",
    long: ["class", "classdata", "pid", "pgid", "uid"],
  },
  stdbuf: { short: "ioe", long: ["input", "output", "error"] },
  chroot: { short: "", long: ["userspec", "groups"], operand: "any" },
  flock: {
    short: "wE",
    long: ["timeout", "conflict-exit-code"],
    operand: "any",
  },
  exec: { short: "a", long: [] },
  doas: { short: "uC", long: [] },
  caffeinate: { short: "tw", long: [] },
  command: NONE,
  builtin: NONE,
  nohup: NONE,
  time: NONE,
  setsid: NONE,
  busybox: NONE,
  unbuffer: NONE,
  watch: NONE,
  parallel: NONE,
};
const DURATION = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e\d+)?[smhd]?$|^infinity$/;
/** More words than this behind a wrapper: unparseable (matching is cubic in them). */
const WRAPPER_WORD_LIMIT = 64;

/**
 * Walks `argv` from its first word through the wrappers to every word that can
 * be the command they run. An option of unknown arity (a long option without
 * `=` that the table does not list) is read BOTH ways, as a flag and as taking
 * the next word, so a bypass needs both readings to miss. `stringFlag` is set
 * when a wrapper option turns the rest into one command string.
 */
function walkCommands(argv: readonly string[]): {
  at: Set<number>;
  stringFlag: boolean;
} {
  const at = new Set<number>();
  const seen = new Set<string>();
  let stringFlag = false;
  const visit = (index: number): void => {
    if (index >= argv.length || at.has(index)) {
      return;
    }
    at.add(index);
    const name = commandName(argv[index] ?? "");
    if (name === "find") {
      for (let next = index + 1; next < argv.length; next += 1) {
        if (/^-(?:exec|execdir|ok|okdir)$/.test(argv[next - 1] ?? "")) {
          visit(next);
        }
      }
    } else if (Object.hasOwn(ARITY, name)) {
      options(
        index,
        index + 1,
        ARITY[name] ?? NONE,
        ARITY[name]?.operand ? 1 : 0,
      );
    }
  };
  const options = (
    start: number,
    from: number,
    spec: Arity,
    operands: number,
  ): void => {
    const key = `${start}:${from}:${operands}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    let index = from;
    while (index < argv.length) {
      const word = argv[index] ?? "";
      if (word === "--") {
        // The operands (`timeout -- 5 cmd`) still precede the command; read it
        // both ways: with them consumed, and as if they were absent.
        visit(index + 1);
        visit(index + 1 + operands);
        return;
      }
      if (word.startsWith("--")) {
        const eq = word.indexOf("=");
        stringFlag ||= spec.stringLong?.test(word) ?? false;
        if (eq < 0 && !spec.long.includes(word.slice(2))) {
          options(start, index + 2, spec, operands);
        }
        index += eq < 0 && spec.long.includes(word.slice(2)) ? 2 : 1;
      } else if (word.length > 1 && word.startsWith("-")) {
        let used = 1;
        for (const [pos, letter] of [...word].slice(1).entries()) {
          if (spec.short.includes(letter)) {
            used = pos + 2 === word.length ? 2 : 1;
            break;
          }
          stringFlag ||= spec.string?.includes(letter) ?? false;
        }
        index += used;
      } else if (ENV_ASSIGNMENT.test(word)) {
        index += 1;
      } else if (
        operands > 0 &&
        (spec.operand === "any" || DURATION.test(word))
      ) {
        operands -= 1;
        index += 1;
      } else {
        visit(index);
        return;
      }
    }
  };
  visit(0);
  return { at, stringFlag };
}

/** Shell options that take the next word as a value, so it is not the script operand. */
const SHELL_VALUE_OPTION = /^(?:[-+][A-Za-z]*[oO]|--rcfile|--init-file)$/;

/** `-c` among the options before the first operand: `bash script.sh -vc` is not it. */
function shellCommandFlag(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    if (COMMAND_STRING_FLAG.test(word)) {
      return true;
    }
    if (SHELL_VALUE_OPTION.test(word)) {
      at += 1;
    } else if (!/^[-+]/.test(word)) {
      return false;
    }
  }
  return false;
}

/**
 * Commands that take another command line as ONE string: `sh -c`, `eval`,
 * `watch` and `parallel` (always), `flock -c`, and `sudo -s` / `-i`. Re-parsing
 * it is open-ended (nested quoting, nested wrappers), so the command is
 * unparseable instead; run the inner command directly. Only the effective
 * command word counts, so `xargs grep eval` and `find . -name eval` pass.
 */
function runsCommandString(argv: readonly string[]): boolean {
  const { at, stringFlag } = walkCommands(argv);
  if (stringFlag) {
    return true;
  }
  for (const index of at) {
    const name = commandName(argv[index] ?? "");
    const rest = argv.slice(index + 1);
    if (
      name === "eval" ||
      name === "watch" ||
      name === "parallel" ||
      (SHELLS.has(name) && shellCommandFlag(rest)) ||
      (name === "flock" &&
        rest.some((w) => COMMAND_STRING_FLAG.test(w) || w.startsWith("--com")))
    ) {
      return true;
    }
  }
  return false;
}

/** The words without redirects and their targets (`2>&1`, `> x`, `{fd}>x`). */
function withoutRedirects(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const redirect = REDIRECT_WORD.exec(argv[at] ?? "");
    if (redirect) {
      at += redirect[1] === "" ? 1 : 0;
    } else {
      out.push(argv[at] ?? "");
    }
  }
  return out;
}

function inner(base: Segment, words: string[]): Segment {
  const next = prepare(words, [], []);
  return { ...next, env: { ...base.env, ...next.env } };
}

/**
 * The segment itself, the segment from its real command word (behind
 * redirects: `2>&1 git push --force`), and, when that word is a wrapper, the
 * segment from each later word (`sudo -u x env A=1 git push --force` also reads
 * as `git push --force`). Over-broad on purpose, and only on the deny side:
 * `nice echo git push --force` is denied too.
 */
export function segmentVariants(segment: Segment): Segment[] {
  const plain = withoutRedirects(segment.argv);
  const base =
    plain.length === segment.argv.length ? segment : inner(segment, plain);
  const out = base === segment ? [segment] : [segment, base];
  if (isWrapper(base.argv[0] ?? "")) {
    for (let next = 1; next < base.argv.length; next += 1) {
      out.push(inner(base, base.argv.slice(next)));
    }
  }
  return out;
}

/**
 * Both readings of a command: comment-aware, and `#` as an ordinary character.
 * Every deny-side consumer must hold for BOTH (deny if either matches, yields a
 * candidate, or is unparseable), so a `#` the shell reads differently from us
 * cannot hide a command.
 *
 * The union is not enough when a real comment and a literal `#` are mixed
 * (`echo a # it's` then `echo ${x:- #}; git push --force`): neither reading
 * sees the push. So a command with an unquoted `#` anywhere (`hash`: at a word
 * start or inside a word) AND shell syntax able to change what `#` means (see
 * `special`) is
 * treated as unparseable. Both flags are taken from either reading. This is
 * intentionally conservative; false positives are accepted. Two more classes are
 * closed rather than chased one by one: any unquoted `#` together with a
 * backslash-newline continuation, and a `#` right after an operator character
 * (`&`, `!`, `|`, `;`, `<`, `>`, `{`), as in zsh `&!#`. Parentheses cannot
 * precede a `#` here: an unquoted one is unparseable.
 *
 * Also unparseable (#63), because a deny pattern only matches the first word of
 * a segment and these hide the real command behind other syntax: any unquoted
 * `(` or `)` (subshell, function definition, `case` pattern, `<(`, `>(`); a
 * reserved word or a bare `{` / `}` in command position (`if`, `then`, `do`,
 * `!`, `time`, ...); unquoted brace expansion (`{a,b}`, `{1..3}`) in any
 * position; and `sh -c` / `eval`. Transparent wrappers (`env`, `sudo`,
 * `timeout`, ...) are not unparseable: `segmentVariants` lets the patterns see
 * through them.
 */
export function tokenizeAll(command: string): Pipeline[] {
  const aware = tokenize(command, true);
  const plain = tokenize(command, false);
  const hash = aware.ok && (aware.hash || (plain.ok && plain.hash));
  const special = aware.ok && (aware.special || (plain.ok && plain.special));
  const continued =
    aware.ok && (aware.continuation || (plain.ok && plain.continuation));
  const adjacent = aware.ok && (aware.adjacent || (plain.ok && plain.adjacent));
  if ((hash && (special || continued)) || adjacent) {
    return [{ ok: false }, { ok: false }];
  }
  return [aware, plain];
}

export type ArgToken = { text: string; value: boolean };

export type Segment = {
  env: Record<string, string>;
  argv: string[];
  tokens: ArgToken[];
  /** Indexes into `argv` of words that held an unquoted `<` or `>`: redirects and fd forms. */
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
      /** Shell syntax that can change what a `#` means: `$`, `{`, `}`, `[`, `]` outside single quotes, or a `case` word. */
      special: boolean;
      /** The command held an unquoted `#` anywhere in a word, at its start or inside it. */
      hash: boolean;
      /** The command held an unquoted or double-quoted backslash-newline continuation. */
      continuation: boolean;
      /** An unquoted `#` followed one of `& ! | ; < > {`. */
      adjacent: boolean;
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

/**
 * `comments: false` reads `#` as an ordinary character. A comment is not always
 * a comment to the shell (`${x:- #}`, `$[1 #]`), so deny-side checks must use
 * `tokenizeAll`, never a single reading.
 */
export function tokenize(command: string, comments = true): Pipeline {
  const scanned = scan(command, comments);
  if (!scanned) {
    return { ok: false };
  }
  const raw = scanned.segments;
  if (
    raw.some((segment) =>
      RESERVED_WORDS.has(segment.words[commandWordIndex(segment.words)] ?? ""),
    )
  ) {
    return { ok: false };
  }
  const segments = raw.map((segment) =>
    prepare(segment.words, segment.meta, segment.expand),
  );
  if (
    segments.some((segment) => {
      const argv = segment.argv.slice(commandWordIndex(segment.argv));
      // Denied, never truncated: a long wrapped command costs too much to match.
      return (
        (argv.length > WRAPPER_WORD_LIMIT && isWrapper(argv[0] ?? "")) ||
        runsCommandString(argv)
      );
    }) ||
    !heredocSafe(raw, segments)
  ) {
    return { ok: false };
  }
  const pipes = raw.slice(0, -1).map((segment) => segment.pipeAfter);
  return {
    ok: true,
    segments,
    pipes,
    comment: scanned.comment,
    newline: scanned.newline,
    special: scanned.special,
    hash: scanned.hash,
    continuation: scanned.continuation,
    adjacent: scanned.adjacent,
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

function scan(
  command: string,
  comments: boolean,
): {
  segments: RawSegment[];
  comment: boolean;
  newline: boolean;
  special: boolean;
  hash: boolean;
  continuation: boolean;
  adjacent: boolean;
} | null {
  const segments: RawSegment[] = [];
  let comment = false;
  let newline = false;
  let special = false;
  let hash = false;
  let continuation = false;
  let adjacent = false;
  const pending: Heredoc[] = [];
  let heredoc = false;
  let words: string[] = [];
  let metas: number[] = [];
  let expands: number[] = [];
  let buf = "";
  // The current word with every quoted or escaped character replaced by NUL,
  // so brace expansion is looked for in unquoted text only.
  let bare = "";
  let unsafe = false;
  let wordStarted = false;
  let wordMeta = false;
  let wordExpand = false;
  let lastGt = false;
  let quote: "single" | "double" | null = null;

  const flushWord = (): void => {
    if (!wordStarted) {
      return;
    }
    if (buf === "case") {
      special = true;
    }
    if (BRACE_EXPANSION.test(bare)) {
      unsafe = true;
    }
    // The command word must be a plain literal, or a deny pattern cannot see
    // it: `=git` (zsh), `-` (zsh precommand), `gi[t]`, `g?t`, `*`, `A+=1`.
    if (
      commandWordIndex(words) === words.length &&
      !ENV_ASSIGNMENT.test(buf) &&
      !REDIRECT_WORD.test(buf) &&
      (buf.startsWith("=") ||
        buf === "-" ||
        /^[A-Za-z_]\w*\+=/.test(buf) ||
        /[*?]|\[[^\]]*\]/.test(bare))
    ) {
      unsafe = true;
    }
    bare = "";
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

  // After `|`, the command to the right must follow in the same segment: an
  // empty one (`a | & b`, `a |; b`) would desync the pipe from its right side.
  let afterPipe = false;
  const endSegment = (pipeAfter: boolean): void => {
    flushWord();
    if (afterPipe && words.length === 0) {
      unsafe = true;
    }
    afterPipe = pipeAfter;
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
        bare += "\0";
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
          continuation = true;
          index += 1;
          continue;
        }
        if (next === "\\" || next === '"') {
          buf += next;
          bare += "\0";
          wordStarted = true;
          index += 1;
          continue;
        }
        buf += ch;
        bare += "\0";
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
        special = true;
      }
      buf += ch;
      bare += "\0";
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
        continuation = true;
        index += 1;
        continue;
      }
      buf += next;
      bare += "\0";
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
    if (ch === "#" && /[&!|;<>{]/.test(command[index - 1] ?? "")) {
      adjacent = true;
    }
    if (comments && ch === "#" && !wordStarted) {
      // A comment runs to the next newline (not consumed). Nothing inside it is
      // parsed: no quotes, continuation or heredoc, as the shell does.
      comment = true;
      hash = true;
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
        bare += "<<<";
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
      // A newline right after `|` continues the pipe on the next line.
      if (ch === "\n" && afterPipe && words.length === 0 && !wordStarted) {
        continue;
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
      // `|&` pipes stderr too.
      if (command[index + 1] === "&") {
        index += 1;
      }
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
        bare += ch;
        wordStarted = true;
        wordMeta = true;
        continue;
      }
      // zsh `&!` and `&|` background and disown: also a separator, two characters.
      if (command[index + 1] === "!" || command[index + 1] === "|") {
        index += 1;
      }
      endSegment(false);
      continue;
    }
    // `$'...'` and `$"..."` quote and decode escapes the text reader never sees.
    if (ch === "`" || (ch === "$" && /[('"]/.test(command[index + 1] ?? ""))) {
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
    if (ch === "#") {
      hash = true;
    }
    if (/[${}[\]]/.test(ch)) {
      special = true;
    }
    // Every unquoted parenthesis is unparseable: a subshell, a group, a
    // function definition, a `case` pattern, an array, an extended glob or
    // process substitution (`<(`, `>(`), each able to hide a command from the
    // deny patterns. No legitimate agent command needs one outside quotes.
    if (ch === "(" || ch === ")") {
      return null;
    }
    buf += ch;
    bare += ch;
    wordStarted = true;
    if (ch === "<" || ch === ">") {
      wordMeta = true;
      lastGt = true;
    }
  }

  flushWord();
  if (quote !== null || pending.length > 0 || unsafe) {
    return null;
  }
  segments.push({
    words,
    pipeAfter: false,
    heredoc,
    meta: metas,
    expand: expands,
  });
  return {
    segments,
    comment,
    newline,
    special,
    hash,
    continuation,
    adjacent,
  };
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

const GLOBS = new Map<string, RegExp>();

function globToken(pattern: string, text: string): boolean {
  let regex = GLOBS.get(pattern);
  if (!regex) {
    const body = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    regex = new RegExp(`^${body}$`);
    GLOBS.set(pattern, regex);
  }
  return regex.test(text);
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

/**
 * `failed` memoizes the (part, token) states that did not match, so the search
 * is O(parts * tokens^2) instead of exponential-ish: `segmentVariants` runs it
 * once per word of a wrapped command.
 */
function matchRest(
  parts: string[],
  partIndex: number,
  tokens: ArgToken[],
  argIndex: number,
  failed: Set<number> = new Set(),
): boolean {
  if (partIndex >= parts.length) {
    return true;
  }
  const state = partIndex * (tokens.length + 1) + argIndex;
  if (failed.has(state)) {
    return false;
  }
  const matched = matchFrom(parts, partIndex, tokens, argIndex, failed);
  if (!matched) {
    failed.add(state);
  }
  return matched;
}

function matchFrom(
  parts: string[],
  partIndex: number,
  tokens: ArgToken[],
  argIndex: number,
  failed: Set<number>,
): boolean {
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
      if (matchRest(parts, partIndex + 1, tokens, argIndex + take, failed)) {
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
      matchRest(parts, partIndex + 1, tokens, index + 1, failed)
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
  // `/usr/bin/git push --force` is `git push --force`.
  if (
    !first ||
    !tokenMatches(head, { ...first, text: commandName(first.text) })
  ) {
    return false;
  }
  return matchRest(parts, 1, segment.tokens, 1);
}

function rightSideMatches(pattern: string, segment: Segment): boolean {
  const parts = pattern
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const head = commandName(segment.argv[0] ?? "");
  if (parts.length === 1) {
    return head === parts[0];
  }
  if (parts.length === 2) {
    return head === parts[0] && segment.argv[1] === parts[1];
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
        segmentVariants(leftSegment).some((v) => segmentMatches(left, v)) &&
        segmentVariants(rightSegment).some((v) => rightSideMatches(right, v))
      ) {
        return true;
      }
    }
    return false;
  }
  return pipeline.segments.some((segment) =>
    segmentVariants(segment).some((v) => segmentMatches(pattern, v)),
  );
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

export type PathCandidate = {
  path: string;
  write: boolean;
  /** Checked against the secret patterns only: never an escape or a write. */
  secretOnly?: boolean;
};

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
    .map(({ path, write, origin }) =>
      origin === "glued" ? { path, write, secretOnly: true } : { path, write },
    );
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
          (writer &&
            (candidate.origin === "arg" || candidate.origin === "opt"))),
    )
    .map((candidate) => candidate.path);
}

/**
 * Values of `key=value` and `--opt=value` words of a command that is not
 * read-only (#75). Which option names a path is the command's own grammar
 * (`dd of=`, `sort --output=`, `foo --log-file=`), so every value counts and the
 * guards decide by what it resolves to: outside the worktree, a protected or
 * generated path, a secret. Leading environment assignments are not words, and
 * neither are the assignments a wrapper takes before its command
 * (`env A=/tmp/x pnpm check`).
 */
export function valueTargets(segment: Segment): ValueTarget[] {
  return collectCandidates(segment)
    .filter(
      (candidate) =>
        candidate.write &&
        (candidate.origin === "kv" || candidate.origin === "opt") &&
        !isDevicePath(candidate.path),
    )
    .map((candidate) => ({
      path: candidate.path,
      expanding:
        segment.expand.includes(candidate.index ?? -1) ||
        /[$`]/.test(candidate.path) ||
        /^~(?!\/|$)/.test(candidate.path),
      pattern: candidate.pattern === true,
    }));
}

export type ValueTarget = {
  path: string;
  /** The shell may rewrite the value (a variable, a glob, `~user`): it must be proven inside the worktree. */
  expanding: boolean;
  /** Names a pattern or a git option, not a file written: skipped by the write checks. */
  pattern: boolean;
};

/**
 * `dd` takes its files from `of=` operands, and a variable can be the whole
 * operand (`dd $X`, `dd "$K"=/abs`). Any expanding operand of a `dd` that a
 * wrapper may run is a possible `of=` target that cannot be read from the text.
 */
export function expandsDdOperand(segment: Segment): boolean {
  const argv = segment.argv;
  const runsDd = [...walkCommands(argv).at].some(
    (index) => commandName(argv[index] ?? "") === "dd",
  );
  return (
    runsDd &&
    segment.expand.some((index) => index > 0 && !segment.meta.includes(index))
  );
}

/** `--opt=value` options whose value is a file the command writes. */
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
const PATH_MUTATORS = new Set(["chmod", "chown", "chgrp", "unlink", "shred"]);
const IN_PLACE_EDITORS = new Set(["sed", "gsed", "perl"]);
/** `rsync` options that take the next word as a value, never a path. */
const RSYNC_VALUE_OPTIONS = new Set([
  "--exclude",
  "--include",
  "--filter",
  "-f",
  "-e",
  "--rsh",
  "--exclude-from",
  "--include-from",
  "--files-from",
]);

function positionals(
  argv: readonly string[],
  skipValueOf: ReadonlySet<string>,
) {
  const out: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (skipValueOf.has(word)) {
      index += 1;
    } else if (!word.startsWith("-") && word.length > 0) {
      out.push(word);
    }
  }
  return out;
}

const NO_SKIP: ReadonlySet<string> = new Set();

/**
 * Everything `writeTargets` lists, plus the writes that need a command's own
 * grammar: in-place editors (`sed -i`, `perl -i`), `dd of=`, the destination of
 * `install` and `rsync`, owners and modes, `curl -o`, and the value of an
 * `--output=file` style option. Words that merely name a path (`find -name`,
 * `tar --exclude=...`, `git --git-dir=...`) are not targets.
 */
export function shellWriteTargets(segment: Segment): string[] {
  const out = [...writeTargets(segment)];
  const argv = segment.argv;
  const command = commandName(argv[0] ?? "");
  const rest = argv.slice(1);
  if (
    IN_PLACE_EDITORS.has(command) &&
    rest.some(
      (word) => word.startsWith("--in-place") || /^-[a-zA-Z0-9]*i/.test(word),
    )
  ) {
    out.push(...positionals(argv, NO_SKIP));
  }
  if (command === "dd") {
    out.push(
      ...rest.filter((word) => word.startsWith("of=")).map((w) => w.slice(3)),
    );
  }
  if (command === "install" || command === "rsync") {
    const last = positionals(
      argv,
      command === "rsync" ? RSYNC_VALUE_OPTIONS : NO_SKIP,
    ).at(-1);
    if (last !== undefined) {
      out.push(last);
    }
    for (let index = 1; index < argv.length - 1; index += 1) {
      if (argv[index] === "-t") {
        out.push(argv[index + 1] ?? "");
      }
    }
  }
  if (PATH_MUTATORS.has(command)) {
    out.push(...positionals(argv, NO_SKIP));
  }
  if (command === "curl" || command === "wget") {
    for (let index = 1; index < argv.length - 1; index += 1) {
      if (
        ["-o", "-O", "--output", "--output-document"].includes(
          argv[index] ?? "",
        )
      ) {
        out.push(argv[index + 1] ?? "");
      }
    }
  }
  for (const word of rest) {
    const eq = word.indexOf("=");
    if (
      word.startsWith("--") &&
      eq > 0 &&
      OUTPUT_OPTIONS.has(word.slice(0, eq))
    ) {
      out.push(word.slice(eq + 1));
    }
  }
  return out.filter((path) => path.length > 0 && !isDevicePath(path));
}

/**
 * The directory change a segment makes, or null when it makes none. The path
 * is null when the tracker cannot follow the change: `cd` without an
 * argument, `pushd` and `popd` (any form). `cd -` and `cd ""` return their
 * literal word. Redirect words and `cd` options are not arguments.
 */
export function directoryChange(
  segment: Segment,
): { path: string | null } | null {
  const command = segment.argv[0] ?? "";
  if (command === "pushd" || command === "popd") {
    return { path: null };
  }
  if (command !== "cd") {
    return null;
  }
  const args = segment.argv
    .slice(1)
    .filter(
      (word) =>
        !/^\d*[<>&]/.test(word) &&
        word !== "--" &&
        !(word.startsWith("-") && word.length > 1),
    );
  return { path: args[0] ?? null };
}

/** Standard streams and descriptors: exact match only, so `/dev/../etc` and `/dev/sda` stay candidates. */
const DEVICE_PATH = /^\/dev\/(?:null|stdout|stderr|stdin|fd\/[0-9]+)$/;

export function isDevicePath(path: string): boolean {
  return DEVICE_PATH.test(path);
}

type Origin = "head" | "redirect" | "arg" | "glued" | "opt" | "kv";
type Candidate = PathCandidate & {
  origin: Origin;
  /** Word index of an `opt` or `kv` candidate. */
  index?: number;
  pattern?: boolean;
};

/** A word `key=value`: a `dd` operand, `make VAR=x`, `-c a.b=c`. The key is a plain name, so URLs and paths are not matched. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Byte sources and sinks `dd` is made for (`if=/dev/zero`, `of=/dev/tty`). Only
 * a `key=value` value is excused: `cat /dev/zero` stays an escape, as on `main`.
 */
const KEY_VALUE_DEVICE = /^\/dev\/(?:zero|random|urandom|full|tty)$/;

/** Builtins that only assign or print: their `a=b` words are data, not paths. Their redirects still count. */
const ASSIGNING_BUILTINS = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "set",
  "echo",
  "printf",
]);

/** Options that take a pattern or a path to read, never a file to write: not write targets for the protected-path checks. */
const PATTERN_OPTIONS = new Set([
  "--exclude",
  "--include",
  "--exclude-from",
  "--include-from",
  "--files-from",
  "--filter",
  "--glob",
  "--iglob",
  "--grep",
  "--pattern",
  "--ignore",
]);

/**
 * Index of the first word a wrapper runs as its command (`env A=1 pnpm check`
 * gives 2), or `argv.length` when it runs none. Of the readings `walkCommands`
 * allows, the earliest wins, so a word is called an assignment only when it
 * precedes the command under every reading.
 */
function wrappedCommandIndex(argv: readonly string[]): number {
  if (!isWrapper(argv[0] ?? "")) {
    return 0;
  }
  const later = [...walkCommands(argv).at].filter((index) => index > 0);
  return later.length > 0 ? Math.min(...later) : argv.length;
}

function collectCandidates(segment: Segment): Candidate[] {
  const found: Candidate[] = [];
  const argv = segment.argv;
  const command = argv[0] ?? "";
  const assignmentsEnd = wrappedCommandIndex(argv);
  const keyless = ASSIGNING_BUILTINS.has(commandName(command));
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
      if (value.length > 0 && !keyless) {
        found.push({
          path: value,
          write: !readOnly,
          origin: "opt",
          index,
          pattern: command === "git" || PATTERN_OPTIONS.has(word.slice(0, eq)),
        });
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
    // A short option with its value glued on (`gh issue comment 1 -F.env`,
    // `curl -K.env`). All-letter rests are combined flags (`-am`), not values.
    // Only a secret-read candidate: `cut -d/`, `sed -n'/x/p'` are delimiters and
    // patterns, so it is never a write target and never an escape.
    const glued = index > 0 ? /^-[A-Za-z](.+)$/.exec(word) : null;
    if (glued && !/^[A-Za-z]+$/.test(glued[1] ?? "")) {
      found.push({ path: glued[1] ?? "", write: false, origin: "glued" });
    }
    if (!word.startsWith("-")) {
      const eq = index > 0 && !keyless ? word.indexOf("=") : -1;
      const value = eq > 0 ? word.slice(eq + 1) : "";
      // A key the shell fills in (`$K=/abs`, `"$K"=/abs`) is a key we cannot read.
      const keyed =
        eq > 0 &&
        (KEY_NAME.test(word.slice(0, eq)) || /[$`]/.test(word.slice(0, eq)));
      if (
        keyed &&
        value.length > 0 &&
        !(index < assignmentsEnd && ENV_ASSIGNMENT.test(word)) &&
        !KEY_VALUE_DEVICE.test(value)
      ) {
        // `dd of=/abs/x` and its kind: the value is a path argument (#75).
        // The whole word stays a candidate below, for a file named `a=b`.
        found.push({
          path: value,
          write: !readOnly,
          origin: "kv",
          index,
        });
      }
      const write =
        index === 0 ||
        writeAll ||
        (!readOnly && (!copyLike || hasTarget || index === lastPositional));
      found.push({ path: word, write, origin: index === 0 ? "head" : "arg" });
    }
  }
  return found;
}
