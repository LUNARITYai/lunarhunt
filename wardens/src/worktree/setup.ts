import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import type { WorktreeConfig } from "../charter.ts";
import { trustedHome } from "../home.ts";
import { loadTask } from "../task.ts";
import { recordTaskHash } from "../task-integrity.ts";
import { listWorktrees } from "./git.ts";
import { parseBranch } from "./issue.ts";
import { type Deps, fail, msg, ok, type Result } from "./types.ts";

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
      return msg(
        `worktrees ${selfName} (issue ${issue}) and ${basename(entry.path)} (issue ${otherIssue}) would share ports because issue % 1000 is equal`,
        `Remove one of them with wardens worktree remove ${basename(entry.path)} or pick another issue`,
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

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Replaces `path` with a new regular file; refuses to follow a symlink there. */
function writeFresh(path: string, text: string, mode: number): void {
  if (isSymlink(path)) {
    throw new Error(`${path} is a symlink`);
  }
  rmSync(path, { force: true });
  writeFileSync(path, text, { flag: "wx", mode });
}

/** Template text, read only when it resolves to a regular file inside `wt`. */
function readTemplate(wt: string, template: string): string | null {
  try {
    const real = realpathSync(join(wt, template));
    if (!real.startsWith(realpathSync(wt) + sep)) {
      return null;
    }
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

/**
 * Setup inside `wt`: task.json, `setup.steps`, `.env`, `setup.ok` (last).
 * Reads no file from the primary checkout; `.env` comes from the template
 * tracked in the worktree itself.
 */
export function setupWorktree(
  wt: string,
  primary: string,
  cfg: WorktreeConfig,
  task: TaskInfo,
  deps: Deps,
): Result {
  if (cfg.resources.database !== undefined) {
    return fail(
      msg(
        "the task database is not implemented in phase 0",
        "Unset worktree.resources.database in the Charter",
      ),
    );
  }
  const name = basename(wt);
  const collision = portCollision(wt, task.issue, wt, name);
  if (collision !== null) {
    return fail(collision);
  }
  const template = readTemplate(wt, cfg.setup.env_template);
  if (template === null) {
    return fail(
      msg(
        `the env template ${cfg.setup.env_template} is missing, unreadable or outside the worktree`,
        "Restore the template file and run wardens worktree setup again",
      ),
    );
  }
  const home = trustedHome(deps.env);
  if (home === null) {
    return fail(
      msg(
        "cannot resolve HOME, so the task.json hash cannot be recorded",
        "Set HOME to an absolute path of an existing directory and run wardens worktree setup again",
      ),
    );
  }
  const taskText = `${JSON.stringify(
    {
      issue: task.issue,
      branch: task.branch,
      slug: task.slug,
      allowed_paths: task.allowedPaths,
    },
    null,
    2,
  )}\n`;
  const dir = join(wt, ".panopticon");
  try {
    if (isSymlink(dir)) {
      throw new Error(`${dir} is a symlink`);
    }
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "setup.ok"), { force: true });
    writeFresh(join(dir, "task.json"), taskText, 0o644);
  } catch {
    return fail(
      msg(
        "task.json could not be written safely (symlink or write error)",
        "Remove the .panopticon entry in the worktree and run wardens worktree setup again",
      ),
    );
  }
  if (loadTask(wt).kind !== "ok") {
    return fail(
      msg(
        "the issue's Allowed paths do not make a valid task.json",
        "Fix the Allowed paths section of the issue and run wardens worktree setup --refresh",
      ),
    );
  }
  try {
    recordTaskHash(home, primary, wt, taskText);
  } catch {
    return fail(
      msg(
        "the task.json hash could not be recorded under ~/.config/panopticon/tasks",
        "Fix the permissions of that directory and run wardens worktree setup again",
      ),
    );
  }
  for (const step of cfg.setup.steps) {
    if (deps.step(step, wt) !== 0) {
      return fail(
        msg(
          `setup step failed: ${step}`,
          "Fix the cause and run wardens worktree setup again",
        ),
      );
    }
  }
  const offset = task.issue % 1000;
  try {
    writeFresh(
      join(wt, ".env"),
      setValue(template, {
        TASK_ISSUE: String(task.issue),
        WEB_PORT: String(cfg.resources.ports.web + offset),
        API_PORT: String(cfg.resources.ports.api + offset),
      }),
      0o600,
    );
    writeFresh(join(dir, "setup.ok"), "", 0o644);
  } catch {
    return fail(
      msg(
        ".env or setup.ok could not be written safely (symlink or write error)",
        "Remove the .env entry in the worktree and run wardens worktree setup again",
      ),
    );
  }
  return ok();
}
