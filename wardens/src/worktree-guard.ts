import { homedir } from "node:os";
import { join } from "node:path";
import type { WorktreeConfig } from "./charter.ts";
import {
  isDevicePath,
  type Segment,
  tokenize,
  writeTargets,
} from "./command.ts";
import { externalAllows } from "./external.ts";
import { EngineFailure } from "./failures.ts";
import { classifyCwd } from "./git.ts";
import { wardenMessage } from "./messages.ts";
import { resolveRepoPath } from "./paths.ts";
import type { Objection, RuleContext } from "./rules.ts";

const RULE = "worktree-guard";
const NEW_WORKTREE =
  'Create a task worktree with "wardens worktree new <issue>"';

function deny(what: string, next: string): Objection {
  return {
    rule: RULE,
    decision: "deny",
    message: wardenMessage(RULE, what, next),
    replacement: null,
  };
}

/** Message for an edit whose target is in the primary checkout or in another worktree. */
export function crossWorktreeDeny(target: string): Objection {
  return deny(
    `${target} is in another worktree or in the primary checkout`,
    "Edit only files inside the worktree of your task",
  );
}

function isMutation(action: string): boolean {
  return action === "edit" || action === "write" || action === "delete";
}

function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function globToken(pattern: string, text: string): boolean {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^]*");
  return new RegExp(`^${body}$`).test(text);
}

/**
 * Anchored allowlist matching for `primary_read_only_commands` (the deny-side
 * `segmentMatches` is an unanchored subsequence match and must not be used here).
 * The pattern is split on spaces into tokens p1..pn. argv[i] must glob-match p_i
 * for every i in 1..n, token by token (a `*` never crosses a token). When the
 * pattern ends with `*`, any further argv tokens are allowed; otherwise argv must
 * have exactly n tokens. So `ls` matches only `ls`, `ls *` needs one argument,
 * and `git status*` matches `git status` and `git status -s`, never `git reset status`.
 */
export function allowlistMatches(pattern: string, argv: string[]): boolean {
  const trimmed = pattern.trim();
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const open = trimmed.endsWith("*");
  if (open ? argv.length < parts.length : argv.length !== parts.length) {
    return false;
  }
  return parts.every((part, index) => globToken(part, argv[index] ?? ""));
}

const DIGITS = /^\d+$/;

/**
 * Read-only flag sets per git subcommand. Anything else that starts with `-` is
 * denied: git accepts any unambiguous prefix of a long option, so a denylist of
 * full spellings (`--upload-pack`) cannot be trusted. A flag set entry ending in
 * `*` is a prefix (`--format=*`). `--` is allowed where a path list follows.
 */
const GIT_FLAGS: Record<string, readonly string[]> = {
  fetch: [
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-p",
    "--prune",
    "-t",
    "--tags",
    "-n",
    "--no-tags",
    "--all",
    "--dry-run",
  ],
  log: [
    "--oneline",
    "-n",
    "--stat",
    "--format=*",
    "--pretty=*",
    "--graph",
    "--decorate",
    "--name-only",
    "--name-status",
    "--reverse",
    "--no-merges",
    "--max-count=*",
    "-p",
    "--patch",
    "-w",
    "--no-color",
    "--color=*",
    "--all",
    "--since=*",
    "--until=*",
    "--author=*",
    "--grep=*",
    "--decorate=*",
    "--abbrev-commit",
    "--date=*",
    "--follow",
    "--first-parent",
    "-S*",
    "-G*",
    "--",
  ],
  diff: [
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--cached",
    "--staged",
    "--quiet",
    "--exit-code",
    "-p",
    "--patch",
    "-w",
    "--ignore-all-space",
    "--no-color",
    "--color=*",
    "--word-diff",
    "--",
  ],
  show: [
    "--stat",
    "--name-only",
    "--name-status",
    "--format=*",
    "--pretty=*",
    "-s",
    "--no-patch",
    "-p",
    "--patch",
    "--no-color",
    "--color=*",
    "--decorate",
    "--",
  ],
  status: ["-s", "--short", "-b", "--branch", "-sb", "--porcelain*"],
  "rev-parse": [
    "--show-toplevel",
    "--abbrev-ref",
    "--verify",
    "--short*",
    "--git-dir",
    "--git-common-dir",
    "--path-format=absolute",
    "--is-inside-work-tree",
  ],
  "ls-files": [
    "-c",
    "--cached",
    "-o",
    "--others",
    "-m",
    "--modified",
    "-d",
    "--deleted",
    "--exclude-standard",
    "--",
  ],
  branch: ["--show-current"],
  worktree: ["--porcelain", "-v"],
};

function flagInSet(word: string, set: readonly string[]): boolean {
  return set.some((entry) =>
    entry.endsWith("*") ? word.startsWith(entry.slice(0, -1)) : word === entry,
  );
}

/** `-<digits>`, `-n<digits>` and `-U<digits>` count flags for log and diff. */
function numericFlag(subcommand: string, word: string): boolean {
  if (subcommand === "log") {
    return /^-(?:n)?\d+$/.test(word);
  }
  return subcommand === "diff" && /^-U\d+$/.test(word);
}

function gitAllowed(argv: string[]): boolean {
  // A global option (-c, -C, --git-dir, --exec-path, --work-tree, --config-env,
  // --namespace) can run code or retarget the repository.
  const sub = argv[1];
  if (sub === undefined || sub.startsWith("-")) {
    return false;
  }
  const rest = argv.slice(2);
  // The only mutating form: move HEAD of the primary checkout to origin/main.
  if (sub === "switch") {
    return (
      rest.length === 2 && rest[0] === "--detach" && rest[1] === "origin/main"
    );
  }
  // Exact subcommand name (`fetch-pack`, `diff-tree`, `log-x` are different
  // commands) and default deny: no flag set means not read-only.
  const set = Object.hasOwn(GIT_FLAGS, sub) ? GIT_FLAGS[sub] : undefined;
  if (set === undefined) {
    return false;
  }
  if (sub === "worktree" && rest[0] !== "list") {
    return false;
  }
  const args = sub === "worktree" ? rest.slice(1) : rest;
  for (const word of args) {
    if (word.startsWith("-") && word !== "-") {
      if (!flagInSet(word, set) && !numericFlag(sub, word)) {
        return false;
      }
    } else if (sub === "fetch" && word.includes(":")) {
      return false;
    } else if (sub === "branch") {
      return false;
    }
  }
  return true;
}

/**
 * ripgrep flags an OVERSEER uses to read. Everything else is denied, so
 * `--pre`, `--hostname-bin`, `--search-zip` and abbreviations never pass.
 * `RG_VALUE` flags take the next word as their value.
 */
const RG_FLAGS = new Set([
  "-i",
  "--ignore-case",
  "-S",
  "--smart-case",
  "-s",
  "--case-sensitive",
  "-n",
  "--line-number",
  "-N",
  "-l",
  "--files-with-matches",
  "-c",
  "--count",
  "-w",
  "--word-regexp",
  "-F",
  "--fixed-strings",
  "-v",
  "--invert-match",
  "-o",
  "--only-matching",
  "--hidden",
  "-u",
  "-uu",
  "--no-ignore",
  "--files",
  "--json",
  "--no-heading",
  "--heading",
  "-U",
  "--multiline",
  "-P",
  "--pcre2",
]);
const RG_VALUE = new Set(["-g", "-t", "-T", "-e"]);
const RG_PREFIX = [
  "--glob=",
  "--iglob=",
  "--type=",
  "--type-not=",
  "--regexp=",
  "--context=",
  "--after-context=",
  "--before-context=",
  "--color=",
  "--sort=",
  "--max-depth=",
  "--max-count=",
];

function rgAllowed(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (word === "--") {
      return true;
    }
    if (!word.startsWith("-") || word === "-") {
      continue;
    }
    if (RG_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (
      RG_FLAGS.has(word) ||
      RG_PREFIX.some((prefix) => word.startsWith(prefix)) ||
      /^-[ABCm]\d+$/.test(word)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Per-command flag rules applied after the pattern matched. An allowlisted
 * command must not execute code or write refs or files through its flags.
 * `argv` has its redirect words removed; `piped` tells whether the segment
 * reads a pipe, `redirected` whether it had a redirect.
 */
function flagsAllowed(
  argv: string[],
  piped: boolean,
  redirected: boolean,
): boolean {
  const [command, first, second] = argv;
  const args = argv.slice(1);
  if (args.some((word) => /^--output(?:=|$)/.test(word))) {
    return false;
  }
  switch (command) {
    case "git":
      return gitAllowed(argv);
    case "rg":
      return rgAllowed(args);
    case "claude":
    case "agent":
      return (
        !piped &&
        !redirected &&
        argv.length === 3 &&
        (first === "-w" || first === "--worktree") &&
        second !== undefined &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(second) &&
        !second.includes("..")
      );
    case "wardens":
      if (first === "doctor") {
        return args
          .slice(1)
          .every((word) => word === "--ci" || word === "--json");
      }
      return first === "worktree" && second === "list" && argv.length === 3;
    default:
      return true;
  }
}

/** A write target is fine only outside the repository and when `paths.external` allows writing it. */
function externalWriteOk(
  ctx: RuleContext,
  target: string,
  home: string,
): boolean {
  const path = expandHome(target, home);
  const resolved = resolveRepoPath(path, ctx.event.cwd, ctx.root);
  if (resolved.ok || resolved.reason !== "escape") {
    return false;
  }
  return (
    externalAllows(
      ctx.charter.paths.external,
      "write",
      path,
      ctx.event.cwd,
      home,
    ) !== null
  );
}

const REDIRECT_WORD =
  /^(\{[A-Za-z_][A-Za-z0-9_]*\}|\d*|&)?(<>|<&|<|>>|>\||>&|>)(.*)$/;
const REDIRECT_META = /[<>&()]/;

/**
 * Checks the words the tokenizer flagged (unquoted `<`, `>`, `(`, `)`). The
 * operator and fd prefix are stripped; what remains must hold none of `<`, `>`,
 * `&`, `(`, `)`, so a glued second redirect (`<a>out`) never hides. Allowed:
 * here-strings, reads (`< file`), exactly `N>&M`, `>&N`, `>&-`, `<&N`, device
 * targets (#55) and `paths.external` write targets. Denied: every other write
 * target, `<>`, `>&file`, process substitution, glued forms (`a>out`).
 * Returns the argv indexes to ignore (redirect words and their targets), or null.
 */
function redirectsAllowed(
  ctx: RuleContext,
  segment: Segment,
  home: string,
): Set<number> | null {
  const skip = new Set<number>();
  for (const index of segment.meta) {
    const word = segment.argv[index] ?? "";
    skip.add(index);
    if (word.startsWith("<<<")) {
      const rest = word.slice(3);
      if (REDIRECT_META.test(rest)) {
        return null;
      }
      if (rest === "") {
        skip.add(index + 1);
      }
      continue;
    }
    const match = REDIRECT_WORD.exec(word);
    if (!match) {
      return null;
    }
    const prefix = match[1] ?? "";
    const op = match[2] ?? "";
    const attached = match[3] ?? "";
    if (op === "<>" || (prefix === "&" && op !== ">" && op !== ">>")) {
      return null;
    }
    if (op === "<&" || op === ">&") {
      if (!(DIGITS.test(attached) || attached === "-")) {
        return null;
      }
      if (op === ">&" && prefix === "&") {
        return null;
      }
      continue;
    }
    if (REDIRECT_META.test(attached)) {
      return null;
    }
    if (attached === "") {
      skip.add(index + 1);
    }
    if (op === "<") {
      continue;
    }
    const target = attached === "" ? (segment.argv[index + 1] ?? "") : attached;
    if (target === "" || REDIRECT_META.test(target)) {
      return null;
    }
    if (isDevicePath(target) || externalWriteOk(ctx, target, home)) {
      continue;
    }
    return null;
  }
  return skip;
}

/**
 * Read-only in the primary checkout. Default deny for anything the shell may
 * transform after these checks. Every pipeline segment must: have no
 * environment assignment and no expanding word (`$`, braces, globs, `~user`);
 * pass the redirect check; match `primary_read_only_commands` (anchored, see
 * `allowlistMatches`); pass the per-command flag rules; and write no path into
 * the repository. Ring 0 is a guard rail, not a sandbox.
 */
function readOnlyCommand(ctx: RuleContext, config: WorktreeConfig): boolean {
  if (ctx.event.command === null) {
    return false;
  }
  const pipeline = tokenize(ctx.event.command);
  if (!pipeline.ok) {
    return false;
  }
  const home = ctx.home ?? homedir();
  for (const [position, segment] of pipeline.segments.entries()) {
    if (Object.keys(segment.env).length > 0 || segment.expand.length > 0) {
      return false;
    }
    // The tokenizer leaves an empty segment after a quoted heredoc body.
    if (segment.argv.length === 0 && segment.meta.length === 0) {
      continue;
    }
    // A raw newline or carriage return in a word is never data we can vouch for.
    if (segment.argv.some((word) => /[\n\r]/.test(word))) {
      return false;
    }
    const skip = redirectsAllowed(ctx, segment, home);
    if (skip === null) {
      return false;
    }
    const argv = segment.argv.filter((_, index) => !skip.has(index));
    const piped = position > 0 && pipeline.pipes[position - 1] === true;
    if (
      argv.length === 0 ||
      !config.primary_read_only_commands.some((pattern) =>
        allowlistMatches(pattern, argv),
      ) ||
      !flagsAllowed(argv, piped, segment.meta.length > 0)
    ) {
      return false;
    }
    for (const target of writeTargets(segment)) {
      if (!externalWriteOk(ctx, target, home)) {
        return false;
      }
    }
  }
  return true;
}

/** ADR-0012: agents never edit the primary checkout or a protected branch, and never reach into another worktree. */
export function worktreeGuard(ctx: RuleContext): Objection | null {
  const config = ctx.charter.worktree;
  if (!config?.required_for_agents) {
    return null;
  }
  const action = ctx.event.action;
  const mutation = isMutation(action);
  if (!mutation && action !== "shell") {
    return null;
  }
  const where = classifyCwd(ctx.event.cwd);
  if (where === null) {
    throw new EngineFailure("the git worktree state could not be resolved");
  }
  const next = NEW_WORKTREE;
  let blocked: Objection | null = null;
  if (where.kind === "primary") {
    blocked = deny(
      mutation
        ? "edits in the primary checkout are not allowed for agents"
        : "this command is not read-only and the primary checkout is not a task worktree",
      'Run "wardens worktree new <issue>" and continue in .claude/worktrees/<issue>-<slug>',
    );
  } else if (where.branch === null) {
    blocked = deny("HEAD is detached", next);
  } else if (config.protected_branches.includes(where.branch)) {
    blocked = deny(`branch ${where.branch} is protected`, next);
  }
  if (blocked === null) {
    return null;
  }
  if (action === "shell" && readOnlyCommand(ctx, config)) {
    return null;
  }
  return blocked;
}
