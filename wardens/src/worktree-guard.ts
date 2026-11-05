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

const GIT_FETCH_DENIED =
  /^(?:--upload-pack|--receive-pack|--exec|--update-head-ok|--recurse-submodules|-u$)/;

/**
 * Per-command flag rules applied after the pattern matched. An allowlisted
 * command must not execute code or write refs or files through its flags.
 * `argv` has its redirect words removed.
 */
function flagsAllowed(argv: string[]): boolean {
  const [command, first, second] = argv;
  const args = argv.slice(1);
  if (args.some((word) => /^--output(?:=|$)/.test(word))) {
    return false;
  }
  switch (command) {
    case "git": {
      // A global option (-c, -C, --git-dir, --exec-path, --work-tree,
      // --config-env, --namespace) can run code or retarget the repository.
      if (first === undefined || first.startsWith("-")) {
        return false;
      }
      const rest = argv.slice(2);
      if (first === "fetch") {
        return !rest.some(
          (word) => word.includes(":") || GIT_FETCH_DENIED.test(word),
        );
      }
      if (first === "log" || first === "diff" || first === "show") {
        return !rest.some(
          (word) => word === "--ext-diff" || word === "--textconv",
        );
      }
      return true;
    }
    case "rg":
      return !args.some(
        (word) =>
          word.startsWith("--pre") ||
          word.startsWith("--hostname-bin") ||
          word === "--search-zip" ||
          /^-[A-Za-z]*z[A-Za-z]*$/.test(word),
      );
    case "claude":
    case "agent":
      return (
        argv.length === 3 &&
        (first === "-w" || first === "--worktree") &&
        second !== undefined &&
        !second.startsWith("-")
      );
    case "wardens":
      return (first === "worktree" && second === "list") || first === "doctor";
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

/**
 * Checks the words the tokenizer flagged (unquoted `<`, `>`, `(`, `)`). Allowed:
 * here-strings, reads (`< file`), `N>&M` and `>&-`, device paths (#55) and
 * `paths.external` write targets. Denied: any other write target, `<>`, process
 * substitution, and glued forms the tokenizer cannot split (`a>out`).
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
      if (word === "<<<") {
        skip.add(index + 1);
      }
      continue;
    }
    if (/[()]/.test(word)) {
      return null;
    }
    const match = REDIRECT_WORD.exec(word);
    if (!match) {
      return null;
    }
    const op = match[2] ?? "";
    const attached = match[3] ?? "";
    if (op === "<>") {
      return null;
    }
    if (op === "<" || op === "<&") {
      if (attached === "") {
        skip.add(index + 1);
      }
      continue;
    }
    const target = attached === "" ? (segment.argv[index + 1] ?? "") : attached;
    if (attached === "") {
      skip.add(index + 1);
    }
    if (op === ">&" && /^(?:\d+|-)$/.test(target)) {
      continue;
    }
    if (target === "") {
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
 * Read-only in the primary checkout: every pipeline segment has no environment
 * assignment, passes the redirect check, matches `primary_read_only_commands`
 * (anchored, see `allowlistMatches`) and the per-command flag rules, and writes
 * no path into the repository. Ring 0 is a guard rail, not a sandbox.
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
  for (const segment of pipeline.segments) {
    // The tokenizer leaves an empty segment after a quoted heredoc body.
    if (segment.argv.length === 0 && segment.meta.length === 0) {
      continue;
    }
    if (Object.keys(segment.env).length > 0) {
      return false;
    }
    const skip = redirectsAllowed(ctx, segment, home);
    if (skip === null) {
      return false;
    }
    const argv = segment.argv.filter((_, index) => !skip.has(index));
    if (
      argv.length === 0 ||
      !config.primary_read_only_commands.some((pattern) =>
        allowlistMatches(pattern, argv),
      ) ||
      !flagsAllowed(argv)
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
