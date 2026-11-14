import * as nodeFs from "node:fs";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ledgerRecordSchema,
  MAX_LINE_BYTES,
  UNKNOWN_PROJECT,
} from "./record.ts";

/**
 * Ledger v0 writer (spec "Write path and failure"). One record, one `write`, no lock, retry,
 * `fsync`, child process or network. It never throws: every problem is a failure reason, and
 * no error text, path or errno string leaves this module.
 */

export const FAILURE_REASONS = [
  "home_unresolved",
  "not_directory",
  "symlink",
  "not_owned",
  "bad_mode",
  "mkdir",
  "open",
  "not_regular",
  "link_count",
  "write",
  "too_long",
  "schema",
  "rotate",
  "cap",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];
export type WriteResult = { ok: true } | { ok: false; reason: FailureReason };

const MIB = 1024 * 1024;

export type Limits = { rotateBytes: number; totalBytes: number };

export const DEFAULT_LIMITS = {
  project: { rotateBytes: 64 * MIB, totalBytes: 1024 * MIB },
  unknown: { rotateBytes: 16 * MIB, totalBytes: 64 * MIB },
} as const satisfies Record<string, Limits>;

export type LedgerFs = Pick<
  typeof nodeFs,
  | "lstatSync"
  | "mkdirSync"
  | "readdirSync"
  | "renameSync"
  | "openSync"
  | "fstatSync"
  | "readSync"
  | "writeSync"
  | "closeSync"
>;

export type WriterDeps = {
  /** `trustedHome(env)`; null gives `home_unresolved`. */
  home: string | null;
  /** The current UID; defaults to `process.getuid()`. Tests set another one to reach `not_owned`. */
  uid?: number;
  now?: () => Date;
  pid?: number;
  limits?: { project?: Partial<Limits>; unknown?: Partial<Limits> };
  /** Test seam for single operations, for example a short `write` or a call count. */
  fs?: Partial<LedgerFs>;
};

const OPEN_FLAGS =
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

class Failure extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(reason);
    this.reason = reason;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function rotatedName(now: Date, pid: number): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `events-${stamp.replace(/[-:]/g, "")}-${pid}.jsonl`;
}

/** `panopticon`, `ledger` and `<project>` must be directories, not links, owned by the UID, mode 0700. */
function checkDirectory(st: nodeFs.Stats, uid: number): void {
  if (st.isSymbolicLink()) {
    throw new Failure("symlink");
  }
  if (!st.isDirectory()) {
    throw new Failure("not_directory");
  }
  if (st.uid !== uid) {
    throw new Failure("not_owned");
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw new Failure("bad_mode");
  }
}

function ensureDirectories(
  fs: LedgerFs,
  home: string,
  project: string,
  uid: number,
): string {
  const state = join(home, ".local", "state");
  const parts = [
    join(state, "panopticon"),
    join(state, "panopticon", "ledger"),
    join(state, "panopticon", "ledger", project),
  ];
  for (const [index, dir] of parts.entries()) {
    let st: nodeFs.Stats | undefined;
    try {
      st = fs.lstatSync(dir);
    } catch (error) {
      if (code(error) === "ENOTDIR") {
        throw new Failure("not_directory");
      }
      if (code(error) !== "ENOENT") {
        throw new Failure("mkdir");
      }
    }
    if (st === undefined) {
      try {
        if (index === 0) {
          // A missing `~/.local` or `~/.local/state` is created with the default mode.
          for (const parent of [join(home, ".local"), state]) {
            try {
              fs.mkdirSync(parent);
            } catch (error) {
              if (code(error) !== "EEXIST") {
                throw error;
              }
            }
          }
        }
        fs.mkdirSync(dir, { mode: 0o700 });
        continue;
      } catch (error) {
        if (code(error) !== "EEXIST") {
          throw new Failure("mkdir");
        }
        // Another writer created it first: judge what it made. No retry of the mkdir.
        try {
          st = fs.lstatSync(dir);
        } catch {
          throw new Failure("mkdir");
        }
      }
    }
    checkDirectory(st, uid);
  }
  return parts[2] ?? "";
}

/** Open the file and check the descriptor. The caller closes it on every path. */
function openChecked(
  fs: LedgerFs,
  file: string,
  uid: number,
): { fd: number; st: nodeFs.Stats } {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_FLAGS, 0o600);
  } catch {
    throw new Failure("open");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Failure("not_regular");
    }
    if (st.nlink !== 1) {
      throw new Failure("link_count");
    }
    if (st.uid !== uid) {
      throw new Failure("not_owned");
    }
    return { fd, st };
  } catch (error) {
    closeQuietly(fs, fd);
    throw error instanceof Failure ? error : new Failure("open");
  }
}

function closeQuietly(fs: LedgerFs, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Nothing to do: the record is written or the failure is already known.
  }
}

/** Sum of the sizes of the directory's entries; a vanished entry counts 0. */
function directoryBytes(fs: LedgerFs, dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      total += fs.lstatSync(join(dir, name)).size;
    } catch {
      // Removed between `readdir` and `lstat`.
    }
  }
  return total;
}

function writeLine(
  fs: LedgerFs,
  dir: string,
  line: string,
  deps: WriterDeps,
  limits: Limits,
  uid: number,
): void {
  const file = join(dir, "events.jsonl");
  let { fd, st } = openChecked(fs, file, uid);
  try {
    if (st.size >= limits.rotateBytes) {
      let rotated: string;
      try {
        if (directoryBytes(fs, dir) >= limits.totalBytes) {
          throw new Failure("cap");
        }
        rotated = rotatedName(
          (deps.now ?? (() => new Date()))(),
          deps.pid ?? process.pid,
        );
        fs.renameSync(file, join(dir, rotated));
      } catch (error) {
        throw error instanceof Failure ? error : new Failure("rotate");
      }
      // A writer that still holds the old descriptor finishes into the renamed file.
      closeQuietly(fs, fd);
      fd = -1;
      ({ fd, st } = openChecked(fs, file, uid));
    }
    let prefix = "";
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, st.size - 1) !== 1) {
        throw new Failure("write");
      }
      prefix = last[0] === 0x0a ? "" : "\n";
    }
    const data = Buffer.from(`${prefix}${line}`, "utf8");
    if (fs.writeSync(fd, data) !== data.length) {
      throw new Failure("write");
    }
  } catch (error) {
    throw error instanceof Failure ? error : new Failure("write");
  } finally {
    if (fd >= 0) {
      closeQuietly(fs, fd);
    }
  }
}

/**
 * Append one record to `<home>/.local/state/panopticon/ledger/<project>/events.jsonl`. The directory is
 * the record's own `project` (the schema allows only `_unknown` or a `[a-z0-9-]` name). A line over the
 * cap is `too_long` before the schema runs, so a hand-made oversize record reaches that reason.
 */
export function writeLedgerRecord(
  record: unknown,
  deps: WriterDeps,
): WriteResult {
  try {
    const fs: LedgerFs = { ...nodeFs, ...deps.fs };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      return { ok: false, reason: "too_long" };
    }
    const parsed = ledgerRecordSchema.safeParse(record);
    if (!parsed.success) {
      return { ok: false, reason: "schema" };
    }
    if (deps.home === null || !isAbsolute(deps.home)) {
      return { ok: false, reason: "home_unresolved" };
    }
    const uid = deps.uid ?? process.getuid?.() ?? -1;
    const kind =
      parsed.data.project === UNKNOWN_PROJECT ? "unknown" : "project";
    const limits = { ...DEFAULT_LIMITS[kind], ...deps.limits?.[kind] };
    const dir = ensureDirectories(fs, deps.home, parsed.data.project, uid);
    writeLine(fs, dir, line, deps, limits, uid);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Failure ? error.reason : "write",
    };
  }
}
