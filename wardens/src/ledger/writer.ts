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

/** `maxEntries` is the entry cap: more entries than this in the project directory fail the write with `cap`. */
export type Limits = {
  rotateBytes: number;
  totalBytes: number;
  maxEntries: number;
};

export const MAX_ENTRIES = 256;

export const DEFAULT_LIMITS = {
  project: {
    rotateBytes: 64 * MIB,
    totalBytes: 1024 * MIB,
    maxEntries: MAX_ENTRIES,
  },
  unknown: {
    rotateBytes: 16 * MIB,
    totalBytes: 64 * MIB,
    maxEntries: MAX_ENTRIES,
  },
} as const satisfies Record<string, Limits>;

export type LedgerFs = Pick<
  typeof nodeFs,
  | "lstatSync"
  | "mkdirSync"
  | "opendirSync"
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

export const OPEN_FLAGS =
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/** Carries a failure reason out of the helpers; `writeLedgerRecord` turns it into a result. */
export class LedgerFailure extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(reason);
    this.reason = reason;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** The exact name `rotatedName` produces; the reader reads a rotated file only under this pattern. */
export const ROTATED_NAME = /^events-\d{8}T\d{6}Z-\d+\.jsonl$/;

function rotatedName(now: Date, pid: number): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `events-${stamp.replace(/[-:]/g, "")}-${pid}.jsonl`;
}

/** `panopticon`, `ledger` and `<project>` must be directories, not links, owned by the UID, mode 0700. */
function checkDirectory(st: nodeFs.Stats, uid: number): void {
  if (st.isSymbolicLink()) {
    throw new LedgerFailure("symlink");
  }
  if (!st.isDirectory()) {
    throw new LedgerFailure("not_directory");
  }
  if (st.uid !== uid) {
    throw new LedgerFailure("not_owned");
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw new LedgerFailure("bad_mode");
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
        throw new LedgerFailure("not_directory");
      }
      if (code(error) !== "ENOENT") {
        throw new LedgerFailure("mkdir");
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
          throw new LedgerFailure("mkdir");
        }
        // Another writer created it first: judge what it made. No retry of the mkdir.
        try {
          st = fs.lstatSync(dir);
        } catch {
          throw new LedgerFailure("mkdir");
        }
      }
    }
    checkDirectory(st, uid);
  }
  return parts[2] ?? "";
}

/**
 * Open the file with `OPEN_FLAGS` (mode 0600) and check the descriptor: a regular file, link count 1,
 * owned by `uid`. Throws `LedgerFailure` (`open`, `not_regular`, `link_count`, `not_owned`) and then
 * holds no descriptor. On success the caller closes `fd` on every path (`closeQuietly`). Exported
 * so the failure-line appender (Task 4) opens its file the same way.
 */
export function openChecked(
  fs: LedgerFs,
  file: string,
  uid: number,
): { fd: number; st: nodeFs.Stats } {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_FLAGS, 0o600);
  } catch {
    throw new LedgerFailure("open");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new LedgerFailure("not_regular");
    }
    if (st.nlink !== 1) {
      throw new LedgerFailure("link_count");
    }
    if (st.uid !== uid) {
      throw new LedgerFailure("not_owned");
    }
    return { fd, st };
  } catch (error) {
    closeQuietly(fs, fd);
    throw error instanceof LedgerFailure ? error : new LedgerFailure("open");
  }
}

export function closeQuietly(fs: LedgerFs, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Nothing to do: the record is written or the failure is already known.
  }
}

/**
 * The directory's entry names, read one by one and stopping at `maxEntries + 1`: more names than
 * `maxEntries` fail with `cap` without reading further. The `Dir` is closed on every path, including
 * a throw from `readSync` (which the caller turns into `rotate`).
 */
function listBounded(fs: LedgerFs, dir: string, maxEntries: number): string[] {
  const handle = fs.opendirSync(dir);
  try {
    const names: string[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) {
        return names;
      }
      names.push(entry.name);
      if (names.length > maxEntries) {
        throw new LedgerFailure("cap");
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Nothing to do: the listing is finished or its failure is already known.
    }
  }
}

/**
 * The directory's entry names and the sum of their sizes; a vanished entry counts 0. More than
 * `maxEntries` names fail with `cap` during the one bounded listing, before any per-entry `lstat`.
 */
function scanDirectory(
  fs: LedgerFs,
  dir: string,
  maxEntries: number,
): { names: string[]; bytes: number } {
  const names = listBounded(fs, dir, maxEntries);
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += fs.lstatSync(join(dir, name)).size;
    } catch {
      // Removed between the listing and `lstat`.
    }
  }
  return { names, bytes };
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
        const scan = scanDirectory(fs, dir, limits.maxEntries);
        if (scan.bytes >= limits.totalBytes) {
          throw new LedgerFailure("cap");
        }
        rotated = rotatedName(
          (deps.now ?? (() => new Date()))(),
          deps.pid ?? process.pid,
        );
        const folded = rotated.toLowerCase();
        if (scan.names.some((name) => name.toLowerCase() === folded)) {
          // `rename` would replace it and lose a rotated file.
          throw new LedgerFailure("rotate");
        }
        fs.renameSync(file, join(dir, rotated));
      } catch (error) {
        throw error instanceof LedgerFailure
          ? error
          : new LedgerFailure("rotate");
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
        throw new LedgerFailure("write");
      }
      prefix = last[0] === 0x0a ? "" : "\n";
    }
    const data = Buffer.from(`${prefix}${line}`, "utf8");
    if (fs.writeSync(fd, data) !== data.length) {
      throw new LedgerFailure("write");
    }
  } catch (error) {
    throw error instanceof LedgerFailure ? error : new LedgerFailure("write");
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
    // Each read of the input is one read of a possibly non-plain object: measure it, parse it, and
    // write only what the schema returned.
    let raw: string | undefined;
    try {
      raw = JSON.stringify(record);
    } catch {
      return { ok: false, reason: "schema" };
    }
    if (Buffer.byteLength(`${raw}\n`, "utf8") > MAX_LINE_BYTES) {
      return { ok: false, reason: "too_long" };
    }
    let parsed: ReturnType<typeof ledgerRecordSchema.safeParse>;
    let line: string;
    try {
      parsed = ledgerRecordSchema.safeParse(record);
      line = `${JSON.stringify(parsed.data)}\n`;
    } catch {
      return { ok: false, reason: "schema" };
    }
    if (!parsed.success) {
      return { ok: false, reason: "schema" };
    }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      return { ok: false, reason: "too_long" };
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
      reason: error instanceof LedgerFailure ? error.reason : "write",
    };
  }
}
