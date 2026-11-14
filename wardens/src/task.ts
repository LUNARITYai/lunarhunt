import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type Integrity, integrityOf } from "./task-integrity.ts";

const taskSchema = z
  .strictObject({
    issue: z.int().min(1),
    allowed_paths: z.array(z.string().min(1)).min(1),
    branch: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    for (const pattern of value.allowed_paths) {
      if (pattern.startsWith("!")) {
        ctx.addIssue({
          code: "custom",
          message: "task globs cannot start with !",
        });
      }
    }
  });

export type TaskFile = z.infer<typeof taskSchema>;

export type TaskState =
  | { kind: "missing" }
  | { kind: "invalid" }
  /** task.json is present but does not match the hash recorded by `wardens worktree setup`, or none was recorded. */
  | { kind: "unverified"; reason: "mismatch" | "unrecorded" | "deleted" }
  | ({ kind: "ok" } & TaskFile);

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

/**
 * With `integrity`, a present task.json must match the hash recorded for this
 * worktree, and a missing one is `missing` (Charter scope alone) only if no
 * record exists: a recorded worktree that lost its file is `unverified`.
 */
export function loadTask(toplevel: string, integrity?: Integrity): TaskState {
  const file = join(toplevel, ".panopticon", "task.json");
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (err) {
    if (!isMissing(err)) {
      return { kind: "invalid" };
    }
    return integrity !== undefined &&
      integrityOf(null, toplevel, integrity) === "deleted"
      ? { kind: "unverified", reason: "deleted" }
      : { kind: "missing" };
  }
  if (integrity !== undefined) {
    const state = integrityOf(raw, toplevel, integrity);
    if (state === "mismatch" || state === "unrecorded") {
      return { kind: "unverified", reason: state };
    }
  }
  const text = raw.toString("utf8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const parsed = taskSchema.safeParse(data);
  if (!parsed.success) {
    return { kind: "invalid" };
  }
  return { kind: "ok", ...parsed.data };
}
