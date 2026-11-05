import type { Charter } from "./charter.ts";
import type { NormalizedEvent } from "./event.ts";
import {
  commandGuard,
  generatedFilesGuard,
  protectedPaths,
  scopeGuard,
  secretReadGuard,
} from "./guards.ts";
import type { TaskState } from "./task.ts";
import type { Decision } from "./verdict.ts";

export type RuleContext = {
  event: NormalizedEvent;
  charter: Charter;
  task: TaskState;
  root: string;
};

export type Objection = {
  rule: string;
  decision: Exclude<Decision, "allow">;
  message: string;
  replacement: string | null;
};

export type Rule = (ctx: RuleContext) => Objection | null;

export const RULE_IDS = [
  "protected-paths",
  "secret-read-guard",
  "generated-files-guard",
  "command-guard",
  "scope-guard",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const RULES: Record<RuleId, Rule> = {
  "protected-paths": protectedPaths,
  "secret-read-guard": secretReadGuard,
  "generated-files-guard": generatedFilesGuard,
  "command-guard": commandGuard,
  "scope-guard": scopeGuard,
};

export function isRuleId(rule: string): rule is RuleId {
  return (RULE_IDS as readonly string[]).includes(rule);
}
