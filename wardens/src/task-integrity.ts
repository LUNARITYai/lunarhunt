import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Where the SHA-256 of each task worktree's `.panopticon/task.json` is kept,
 * next to the launcher anchor. Written only by `wardens worktree new|setup`.
 * Against an agent with the human's UID this is advisory until the sandbox
 * `denyWrite` covers `~/.config/panopticon/` (#70).
 */
export const TASKS_REL = ".config/panopticon/tasks";

/** The trusted primary and home that locate a worktree's recorded hash. */
export type Integrity = { primary: string; home: string };

export type IntegrityState = "verified" | "mismatch" | "unrecorded";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Stable id of a task worktree: the physical path of the trusted primary
 * (the anchor entry) and of the worktree. Nothing inside the worktree takes
 * part, so the agent cannot steer which record applies to it.
 */
export function taskId(primary: string, worktree: string): string {
  return sha256(`${real(primary)}\n${real(worktree)}`).slice(0, 32);
}

function hashFile(home: string, id: string): string {
  return join(home, TASKS_REL, `${id}.sha256`);
}

/** Compares `sha256(raw)` with the record of this worktree; a missing or unreadable record is `unrecorded`. */
export function checkIntegrity(
  raw: Buffer,
  worktree: string,
  { primary, home }: Integrity,
): IntegrityState {
  let recorded: string;
  try {
    recorded = readFileSync(
      hashFile(home, taskId(primary, worktree)),
      "utf8",
    ).trim();
  } catch {
    return "unrecorded";
  }
  return recorded === sha256(raw) ? "verified" : "mismatch";
}

/** Writes the record of `worktree` atomically; throws when the home is not absolute or the write fails. */
export function recordTaskHash(
  home: string,
  primary: string,
  worktree: string,
  text: string,
): void {
  if (!isAbsolute(home)) {
    throw new Error("the home directory is not an absolute path");
  }
  const file = hashFile(home, taskId(primary, worktree));
  mkdirSync(join(home, TASKS_REL), { recursive: true, mode: 0o700 });
  chmodSync(join(home, TASKS_REL), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${sha256(text)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Drops the record of a removed worktree. */
export function forgetTaskHash(home: string, id: string): void {
  rmSync(hashFile(home, id), { force: true });
}
