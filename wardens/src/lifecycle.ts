import { defaultRunCheck, definitionOfDone } from "./dod.ts";
import { gitTracked } from "./git.ts";
import { generatedFilesGuard, protectedDeny, scopeGuard } from "./guards.ts";
import { wardenMessage } from "./messages.ts";
import type { Objection, RuleContext } from "./rules.ts";
import type { Verdict } from "./verdict.ts";

const AUDIT_WHAT: Record<string, (path: string) => string> = {
  "protected-paths": (path) => `${path} was edited but is deny for agents`,
  "scope-guard": (path) =>
    `${path} was edited outside allowed_paths for this task`,
  "generated-files-guard": (path) =>
    `${path} is generated and was edited by hand`,
};

/**
 * Post-edit audit (PostToolUse, afterFileEdit). It catches an edit the pre-hook
 * should have denied. Only deny-side rules run; an `ask` path may be approved.
 */
export function postEditAudit(ctx: RuleContext): Objection | null {
  for (const rule of [protectedDeny, generatedFilesGuard, scopeGuard]) {
    const objection = rule(ctx);
    if (!objection) {
      continue;
    }
    const path = ctx.event.path;
    const what = AUDIT_WHAT[objection.rule];
    if (path === null || what === undefined) {
      return objection;
    }
    return {
      ...objection,
      message: wardenMessage(
        objection.rule,
        what(path),
        gitTracked(ctx.root, path)
          ? `Revert ${path} with git checkout -- ${path}`
          : `Delete ${path}`,
      ),
    };
  }
  return null;
}

/** `definition-of-done`: keeps the agent working while `pnpm check` is red. */
export function evaluateStop(ctx: RuleContext): Verdict {
  return definitionOfDone(ctx, ctx.dod ?? { runCheck: defaultRunCheck });
}
