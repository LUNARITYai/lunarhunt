import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
  | ({ kind: "ok" } & TaskFile);

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

export function loadTask(toplevel: string): TaskState {
  const file = join(toplevel, ".panopticon", "task.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return isMissing(err) ? { kind: "missing" } : { kind: "invalid" };
  }
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
