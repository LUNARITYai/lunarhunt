import { homedir } from "node:os";
import { join } from "node:path";
import type { Charter } from "./charter.ts";
import {
  firstDeny,
  rewriteCommand,
  secretCandidates,
  tokenizeAll,
} from "./command.ts";
import { externalAllows } from "./external.ts";
import { EngineFailure } from "./failures.ts";
import { anyGlob, basename, denyListMatches } from "./globs.ts";
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

/** The deny side of `protected-paths`. The post-edit audit uses it alone, because a human may have approved an ask path. */
export function protectedDeny(ctx: RuleContext): Objection | null {
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
  if (denyListMatches(ctx.charter.paths.protected.deny, ctx.event.path)) {
    return block(
      "protected-paths",
      "deny",
      `${ctx.event.path} is deny for agents`,
      "A human must change it in a reviewed PR",
    );
  }
  return null;
}

export function generatedFilesGuard(ctx: RuleContext): Objection | null {
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "generated-files-guard",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  if (anyGlob(ctx.charter.paths.generated, ctx.event.path)) {
    return block(
      "generated-files-guard",
      "deny",
      `${ctx.event.path} is generated`,
      "Run uv run export-openapi to regenerate it",
    );
  }
  return null;
}

export function protectedPaths(ctx: RuleContext): Objection | null {
  // `ask` guards edits only: agents must read the Covenant files (#46).
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  const denied = protectedDeny(ctx);
  if (denied || ctx.event.path === null) {
    return denied;
  }
  const path = ctx.event.path;
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
  const pipelines = tokenizeAll(ctx.event.command);
  const parsed = pipelines.filter((pipeline) => pipeline.ok);
  if (parsed.length !== pipelines.length) {
    return block(
      "command-guard",
      "deny",
      "the command could not be parsed safely",
      "Retry with a simpler command",
    );
  }
  for (const pipeline of parsed) {
    const denied = firstDeny(ctx.charter.commands.deny, pipeline);
    if (denied) {
      return commandDeny(denied);
    }
  }
  const replacement = parsed
    .map((pipeline) => rewriteCommand(ctx.charter.commands.rewrite, pipeline))
    .find((candidate) => candidate);
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

/** The shell expands a leading `~`; the tokenizer does not. */
function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
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
    // An external path is absolute: only its basename can match a secret pattern.
    const target = ctx.event.external
      ? basename(ctx.event.path)
      : ctx.event.path;
    return denyListMatches(secrets, target) ? secretDeny(ctx.event.path) : null;
  }
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  const segments = tokenizeAll(ctx.event.command).flatMap((pipeline) =>
    pipeline.ok ? pipeline.segments : [],
  );
  const home = ctx.home ?? homedir();
  for (const segment of segments) {
    for (const candidate of secretCandidates(segment)) {
      const path = expandHome(candidate.path, home);
      const resolved = resolveRepoPath(path, ctx.event.cwd, ctx.root);
      if (!resolved.ok) {
        // Same treatment as the Read and Write tools: an outside path must match
        // `paths.external` for this read or write, and only its basename is checked.
        const allowed =
          resolved.reason === "escape"
            ? externalAllows(
                ctx.charter.paths.external,
                candidate.write ? "write" : "read",
                path,
                ctx.event.cwd,
                home,
              )
            : null;
        if (allowed === null) {
          throw new EngineFailure("path escapes the worktree");
        }
        if (denyListMatches(secrets, basename(allowed))) {
          return secretDeny(allowed);
        }
        continue;
      }
      if (denyListMatches(secrets, resolved.path)) {
        return secretDeny(resolved.path);
      }
    }
  }
  return null;
}
