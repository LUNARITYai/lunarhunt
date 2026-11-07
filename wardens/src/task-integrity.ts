import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Where the record of each task worktree's `.panopticon/task.json` is kept,
 * next to the launcher anchor: three lines, the SHA-256, the primary and the
 * worktree (physical paths). Written only by `wardens worktree new|setup`.
 * Against an agent with the human's UID this is advisory until the sandbox
 * `denyWrite` covers `~/.config/panopticon/` (#70).
 */
export const TASKS_REL = ".config/panopticon/tasks";

/** The trusted primary and home that locate a worktree's record. */
export type Integrity = { primary: string; home: string };

/**
 * - `verified`: the file matches its record;
 * - `mismatch`: the file differs from its record;
 * - `unrecorded`: a file, but no record;
 * - `deleted`: a record, but no file;
 * - `none`: neither (a worktree that never had a task).
 */
export type IntegrityState =
  | "verified"
  | "mismatch"
  | "unrecorded"
  | "deleted"
  | "none";

export type TaskRecord = { id: string; primary: string; worktree: string };

/** The on-disk spelling (`.native`): on a case-insensitive file system it also folds the case of the given path. */
export function real(path: string): string {
  try {
    return realpathSync.native(path);
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

function tasksDir(home: string): string {
  return join(home, TASKS_REL);
}

function recordFile(home: string, id: string): string {
  return join(tasksDir(home), `${id}.sha256`);
}

/** The recorded hash of a worktree, or null when there is no readable record. */
function recordedHash(
  worktree: string,
  { primary, home }: Integrity,
): string | null {
  try {
    const first = readFileSync(
      recordFile(home, taskId(primary, worktree)),
      "utf8",
    ).split("\n")[0];
    return first === undefined || first.length === 0 ? null : first.trim();
  } catch {
    return null;
  }
}

/** `raw` is the task.json bytes, or null when the file is missing. */
export function integrityOf(
  raw: Buffer | null,
  worktree: string,
  integrity: Integrity,
): IntegrityState {
  const recorded = recordedHash(worktree, integrity);
  if (raw === null) {
    return recorded === null ? "none" : "deleted";
  }
  if (recorded === null) {
    return "unrecorded";
  }
  return recorded === sha256(raw) ? "verified" : "mismatch";
}

/** Every record in the directory; unreadable or malformed ones are skipped. */
export function listRecords(home: string): TaskRecord[] {
  let names: string[];
  try {
    names = readdirSync(tasksDir(home));
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".sha256"))) {
    try {
      const lines = readFileSync(join(tasksDir(home), name), "utf8").split(
        "\n",
      );
      if (lines[1] && lines[2]) {
        records.push({
          id: name.slice(0, -".sha256".length),
          primary: lines[1],
          worktree: lines[2],
        });
      }
    } catch {
      // not a record we can judge
    }
  }
  return records;
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
  const file = recordFile(home, taskId(primary, worktree));
  mkdirSync(tasksDir(home), { recursive: true, mode: 0o700 });
  chmodSync(tasksDir(home), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${sha256(text)}\n${real(primary)}\n${real(worktree)}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Drops the record of a removed worktree; never throws (the worktree is already gone by then). */
export function forgetTaskHash(home: string, id: string): boolean {
  try {
    rmSync(recordFile(home, id), { force: true });
    return true;
  } catch {
    return false;
  }
}
