import { createHash } from "node:crypto";
import { z } from "zod";

/** Ledger v0 event record (spec "Event record"). Nothing here reads a payload or writes a file. */

export const LEDGER_VERSION = 1;
export const MAX_LINE_BYTES = 4096;
export const UNKNOWN_PROJECT = "_unknown";
export const MAX_ISSUE = 2147483647;

export const ROLES = [
  "overseer",
  "spec-writer",
  "implementer",
  "reviewer",
  "sentinel",
  "debugger",
] as const;

/** `usage_limit` is reserved for #99 and is not written in v0. */
export const STOP_OUTCOMES = [
  "dod_green",
  "dod_red",
  "loop_limit",
  "not_run",
  "engine",
] as const;

const IDENTIFIER = /^[A-Za-z0-9._:/@-]{1,128}$/;
const MODEL = /^[A-Za-z0-9._:/@[\]-]{1,64}$/;
/** A token prefix that starts a word, then at least 16 more characters. Best effort. */
const TOKEN_SHAPE =
  /(?<![A-Za-z0-9])(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-|xox)[\s\S]{16}/i;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function matching(value: unknown, rule: RegExp): string | null {
  return typeof value === "string" &&
    rule.test(value) &&
    !TOKEN_SHAPE.test(value)
    ? value
    : null;
}

/** `session_id`, `agent_type`, `branch`, `worktree`: the value, or null when it fails the field rule. */
export function identifierOrNull(value: unknown): string | null {
  return matching(value, IDENTIFIER);
}

export function modelOrNull(value: unknown): string | null {
  return matching(value, MODEL);
}

/** Null for a missing or non-string name, `"other"` for a string that fails the field rule. */
export function toolNameOrOther(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return identifierOrNull(value) ?? "other";
}

/** An integer from 1 to 2147483647, or a digit run that converts exactly; else null. */
export function issueOrNull(value: unknown): number | null {
  const number =
    typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > MAX_ISSUE ||
    (typeof value === "string" && String(number) !== value)
  ) {
    return null;
  }
  return number;
}

/** The number in a branch such as `feat/42-offer-crud`; null when the branch has none or it is too large. */
export function issueFromBranch(branch: string | null): number | null {
  const match =
    branch === null ? null : /^[a-z]+\/([1-9][0-9]{0,9})-/.exec(branch);
  return match?.[1] === undefined ? null : issueOrNull(match[1]);
}

/** First 16 bytes of SHA-256 of `<tool>:<session_id>`, lowercase hex; null when either part is null. */
export function runIdOf(
  tool: string | null,
  sessionId: string | null,
): string | null {
  if (tool === null || sessionId === null) {
    return null;
  }
  return createHash("sha256")
    .update(`${tool}:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

const identifier = z.string().refine((v) => identifierOrNull(v) === v);
const decision = z.enum(["allow", "deny", "ask", "rewrite"]);

export const ledgerRecordSchema = z
  .strictObject({
    v: z.literal(LEDGER_VERSION),
    record: z.enum(["run_start", "event", "run_end"]),
    ts: z
      .string()
      .regex(TIMESTAMP)
      .refine((v) => new Date(v).toISOString() === v),
    project: z.union([z.literal(UNKNOWN_PROJECT), z.string().regex(PROJECT)]),
    session_id: identifier.nullable(),
    run_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    tool: z.enum(["claude", "cursor"]).nullable(),
    role: z.enum(ROLES).nullable(),
    model: z
      .string()
      .refine((v) => modelOrNull(v) === v)
      .nullable(),
    agent_type: identifier.nullable(),
    event: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)
      .nullable(),
    tool_name: identifier.nullable(),
    action: z
      .enum([
        "shell",
        "read",
        "edit",
        "write",
        "delete",
        "mcp",
        "stop",
        "session_start",
      ])
      .nullable(),
    decision,
    rendered: decision,
    warden_rule_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .nullable(),
    outcome: z.enum(STOP_OUTCOMES).nullable(),
    interactive: z.boolean(),
    worktree: identifier.nullable(),
    primary: z.boolean(),
    branch: identifier.nullable(),
    issue: z.number().int().min(1).max(MAX_ISSUE).nullable(),
    duration_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((record, ctx) => {
    if ((record.outcome !== null) !== (record.record === "run_end")) {
      ctx.addIssue({ code: "custom", message: "outcome is for run_end only" });
    }
    if (record.run_id !== runIdOf(record.tool, record.session_id)) {
      ctx.addIssue({ code: "custom", message: "run_id does not match" });
    }
  });

export type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
