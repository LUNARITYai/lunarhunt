import type { Charter } from "./charter.ts";
import {
  firstDeny,
  rewriteCommand,
  secretCandidates,
  tokenize,
} from "./command.ts";
import { EngineFailure } from "./failures.ts";
import { anyGlob, denyListMatches } from "./globs.ts";
import { wardenMessage } from "./messages.ts";
import { resolveRepoPath } from "./paths.ts";
import type { Objection, RuleContext } from "./rules.ts";
import type { TaskState } from "./task.ts";

function block(
  rule: string,
  decision: Objection["decision"],
  what: string,
  next: string,
  replacement: string | null = null,
): Objection {
  return {
    rule,
    decision,
    message: wardenMessage(rule, what, next),
    replacement,
  };
}

export function pathInScope(
  path: string,
  charter: Charter,
  task: TaskState,
): boolean {
  if (!anyGlob(charter.paths.allowed_paths, path)) {
    return false;
  }
  if (task.kind === "missing") {
    return true;
  }
  if (task.kind === "invalid") {
    return false;
  }
  return anyGlob(task.allowed_paths, path);
}

function isMutation(action: string): boolean {
  return action === "edit" || action === "write" || action === "delete";
}

export function scopeGuard(ctx: RuleContext): Objection | null {
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "scope-guard",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  if (ctx.task.kind === "invalid") {
    return block(
      "scope-guard",
      "deny",
      ".panopticon/task.json is invalid for this task",
      "Ask for needs:human",
    );
  }
  if (!pathInScope(ctx.event.path, ctx.charter, ctx.task)) {
    return block(
      "scope-guard",
      "deny",
      `path ${ctx.event.path} not in allowed_paths for this task`,
      "Ask for needs:human",
    );
  }
  return null;
}

export function protectedPaths(ctx: RuleContext): Objection | null {
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "protected-paths",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  const path = ctx.event.path;
  if (denyListMatches(ctx.charter.paths.protected.deny, path)) {
    return block(
      "protected-paths",
      "deny",
      `${path} is deny for agents`,
      "A human must change it in a reviewed PR",
    );
  }
  if (!pathInScope(path, ctx.charter, ctx.task)) {
    return null;
  }
  if (!anyGlob(ctx.charter.paths.protected.ask, path)) {
    return null;
  }
  if (!ctx.event.interactive) {
    return block(
      "protected-paths",
      "deny",
      `${path} requires ask and this session is non-interactive`,
      "Label the issue needs:human",
    );
  }
  return block(
    "protected-paths",
    "ask",
    `${path} requires approval`,
    "Ask Krzysztof to approve this edit in the session",
  );
}

function commandDeny(pattern: string): Objection {
  if (
    pattern.includes("no-verify") ||
    pattern === "git commit -n*" ||
    pattern.startsWith("LEFTHOOK=") ||
    pattern.includes("hooksPath")
  ) {
    return block(
      "command-guard",
      "deny",
      "git commit --no-verify is denied",
      "Remove --no-verify and retry",
    );
  }
  if (pattern.includes(" | ")) {
    return block(
      "command-guard",
      "deny",
      "piping a download into a shell is denied",
      "Do not pipe a download into a shell",
    );
  }
  if (pattern.startsWith("git push")) {
    return block(
      "command-guard",
      "deny",
      "git push --force is denied",
      "Push without rewriting history",
    );
  }
  return block(
    "command-guard",
    "deny",
    `${pattern} is denied`,
    "Choose a command The Charter allows",
  );
}

export function commandGuard(ctx: RuleContext): Objection | null {
  if (ctx.event.action !== "shell") {
    return null;
  }
  if (ctx.event.command === null) {
    return block(
      "command-guard",
      "deny",
      "the command is missing",
      "Retry with an explicit command",
    );
  }
  const pipeline = tokenize(ctx.event.command);
  if (!pipeline.ok) {
    return block(
      "command-guard",
      "deny",
      "the command could not be parsed safely",
      "Retry with a simpler command",
    );
  }
  const denied = firstDeny(ctx.charter.commands.deny, pipeline);
  if (denied) {
    return commandDeny(denied);
  }
  const replacement = rewriteCommand(ctx.charter.commands.rewrite, pipeline);
  if (replacement) {
    return block(
      "command-guard",
      "rewrite",
      `npm install is rewritten to ${replacement}`,
      `Run ${replacement}`,
      replacement,
    );
  }
  return null;
}

function secretDeny(path: string): Objection {
  return block(
    "secret-read-guard",
    "deny",
    `reading ${path} is denied`,
    "Use .env.example for non-secret templates",
  );
}

export function secretReadGuard(ctx: RuleContext): Objection | null {
  const secrets = ctx.charter.paths.secrets_deny_read;
  if (ctx.event.action === "read") {
    if (ctx.event.path === null) {
      return secretDeny("an unknown path");
    }
    return denyListMatches(secrets, ctx.event.path)
      ? secretDeny(ctx.event.path)
      : null;
  }
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  const pipeline = tokenize(ctx.event.command);
  if (!pipeline.ok) {
    return null;
  }
  for (const segment of pipeline.segments) {
    for (const candidate of secretCandidates(segment)) {
      const resolved = resolveRepoPath(candidate, ctx.event.cwd, ctx.root);
      if (!resolved.ok) {
        throw new EngineFailure("path escapes the worktree");
      }
      if (denyListMatches(secrets, resolved.path)) {
        return secretDeny(resolved.path);
      }
    }
  }
  return null;
}
