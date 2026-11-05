import { homedir } from "node:os";
import { join } from "node:path";
import type { WorktreeConfig } from "./charter.ts";
import { segmentMatches, tokenize, writeTargets } from "./command.ts";
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

/**
 * Read-only in the primary checkout: every pipeline segment matches
 * `primary_read_only_commands`, none redirects or passes a write path into the
 * repository (an allowed `paths.external` target is fine), and no segment asks
 * for an output file (`--output`). The glob alone would allow `cat a > b`.
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
    if (segment.argv.length === 0) {
      continue;
    }
    if (
      !config.primary_read_only_commands.some((pattern) =>
        segmentMatches(pattern, segment),
      )
    ) {
      return false;
    }
    if (segment.argv.some((word) => /^--output(?:=|$)/.test(word))) {
      return false;
    }
    for (const target of writeTargets(segment)) {
      const path = expandHome(target, home);
      const resolved = resolveRepoPath(path, ctx.event.cwd, ctx.root);
      if (resolved.ok) {
        return false;
      }
      if (
        resolved.reason !== "escape" ||
        externalAllows(
          ctx.charter.paths.external,
          "write",
          path,
          ctx.event.cwd,
          home,
        ) === null
      ) {
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
