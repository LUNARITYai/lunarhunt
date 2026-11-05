import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WorktreeConfig } from "../charter.ts";
import { engineMessage, wardenMessage } from "../messages.ts";
import { loadTask } from "../task.ts";
import { listWorktrees } from "./git.ts";
import { parseBranch } from "./issue.ts";
import { type Deps, fail, ok, type Result } from "./types.ts";

export type TaskInfo = {
  issue: number;
  branch: string;
  slug: string;
  allowedPaths: string[];
};

/** The other open task worktree with the same `issue % 1000`, as a failure message, or null. */
export function portCollision(
  anyWorktree: string,
  issue: number,
  selfPath: string | null,
  selfName: string,
): string | null {
  for (const entry of listWorktrees(anyWorktree)) {
    if (entry.primary || entry.path === selfPath) {
      continue;
    }
    const task = loadTask(entry.path);
    const otherIssue =
      task.kind === "ok" ? task.issue : parseBranch(entry.branch)?.issue;
    if (otherIssue !== undefined && otherIssue % 1000 === issue % 1000) {
      return wardenMessage(
        "engine",
        `worktrees ${selfName} (issue ${issue}) and ${basename(entry.path)} (issue ${otherIssue}) share ports because issue % 1000 is equal`,
        "Remove one of them with wardens worktree remove or ask Krzysztof",
      );
    }
  }
  return null;
}

function setValue(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = text.split("\n").map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    const value = key === undefined ? undefined : pending.get(key);
    if (key === undefined || value === undefined) {
      return line;
    }
    pending.delete(key);
    return `${key}=${value}`;
  });
  const missing = [...pending].map(([k, v]) => `${k}=${v}`);
  const body = lines.join("\n");
  return missing.length === 0
    ? body
    : `${body}${body.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`;
}

/**
 * Setup inside `wt`: task.json, `setup.steps`, `.env`, `setup.ok` (last).
 * Reads no file from the primary checkout; `.env` comes from the template
 * tracked in the worktree itself.
 */
export function setupWorktree(
  wt: string,
  cfg: WorktreeConfig,
  task: TaskInfo,
  deps: Deps,
): Result {
  if (cfg.resources.database !== undefined) {
    return fail(
      engineMessage(
        "the task database is not implemented in phase 0, unset worktree.resources.database",
      ),
    );
  }
  const name = basename(wt);
  const collision = portCollision(wt, task.issue, wt, name);
  if (collision !== null) {
    return fail(collision);
  }
  const marker = join(wt, ".panopticon", "setup.ok");
  rmSync(marker, { force: true });
  mkdirSync(join(wt, ".panopticon"), { recursive: true });
  const taskJson = {
    issue: task.issue,
    branch: task.branch,
    slug: task.slug,
    allowed_paths: task.allowedPaths,
  };
  writeFileSync(
    join(wt, ".panopticon", "task.json"),
    `${JSON.stringify(taskJson, null, 2)}\n`,
  );
  if (loadTask(wt).kind !== "ok") {
    return fail(
      engineMessage("the issue's Allowed paths do not make a valid task.json"),
    );
  }
  for (const step of cfg.setup.steps) {
    if (deps.step(step, wt) !== 0) {
      return fail(
        wardenMessage(
          "engine",
          `setup step failed: ${step}`,
          "Fix the cause and run wardens worktree setup again",
        ),
      );
    }
  }
  let template: string;
  try {
    template = readFileSync(join(wt, cfg.setup.env_template), "utf8");
  } catch {
    return fail(
      engineMessage(`the env template ${cfg.setup.env_template} is unreadable`),
    );
  }
  const offset = task.issue % 1000;
  writeFileSync(
    join(wt, ".env"),
    setValue(template, {
      TASK_ISSUE: String(task.issue),
      WEB_PORT: String(cfg.resources.ports.web + offset),
      API_PORT: String(cfg.resources.ports.api + offset),
    }),
  );
  writeFileSync(marker, "");
  return ok();
}
