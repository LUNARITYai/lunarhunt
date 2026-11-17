import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { type LedgerRecord, ledgerRecordSchema } from "./record.ts";
import { DEFAULT_LIMITS, MAX_ENTRIES, ROTATED_NAME } from "./writer.ts";

/**
 * Ledger v0 reader (spec "Concurrent appends, partial lines, rotation and cap"). Regular files only,
 * streamed in chunks, never loaded whole. Synchronous like the rest of the Wardens engine.
 */

export type ReadStats = {
  files: number;
  /** Lines that are not JSON or do not match the record schema (also lines longer than the line cap). */
  malformed: number;
  /** Files whose last line has no `\n`; that line is not parsed. */
  partial: number;
  /** Lines that start with `{"v":` and another version than 1: a future format, not damage. */
  unsupported: number;
  /**
   * Entries named `events*.jsonl` that are not read: not regular files (symlink, FIFO, directory)
   * or not named like `events.jsonl` or a rotated file of the writer.
   */
  skipped: number;
  /** True when a cap stopped the read with data left: the byte cap, or more rotated files than the window. */
  truncated: boolean;
};

const CHUNK_BYTES = 64 * 1024;
/** A line longer than this many bytes (without its newline) is `malformed`, never parsed or buffered. */
export const LINE_LIMIT = 4 * 4096;
/** Case-insensitive on purpose: a case variant of a Ledger name is counted as `skipped`, never silent. */
const NAME = /^events.*\.jsonl$/i;
/** At most this many files are opened: `events.jsonl` and the newest `MAX_ENTRIES - 1` rotated ones. */
export const MAX_FILES = MAX_ENTRIES;
/**
 * The default byte cap: the writer's total cap plus two rotation sizes, so the legitimate overshoot
 * of a full Ledger (a rotation by the last scan below the cap, a new file past the rotation size)
 * does not cut the newest file.
 */
export const READ_BYTE_CAP =
  DEFAULT_LIMITS.project.totalBytes + 2 * DEFAULT_LIMITS.project.rotateBytes;
/** Every record the writer produces starts like this (key order of the schema). */
const RECORD_START = Buffer.from('{"v":1,"record":"');
const OTHER_VERSION = /^\{"v":(\d+)[,}]/;
/** A floor below the smallest valid record (367 bytes): a shorter line is `malformed` without a parse. */
export const MIN_RECORD_BYTES = 300;

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

function parse(line: Buffer): LedgerRecord | "unsupported" | null {
  if (!line.subarray(0, RECORD_START.length).equals(RECORD_START)) {
    const version = OTHER_VERSION.exec(line.toString("latin1", 0, 32))?.[1];
    return version !== undefined && version !== "1" ? "unsupported" : null;
  }
  try {
    const parsed = ledgerRecordSchema.safeParse(
      JSON.parse(line.toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Stream one file. Returns the bytes read. Opens with `O_NOFOLLOW | O_NONBLOCK` and checks the
 * descriptor, so a symlink or FIFO planted after the `lstat` is skipped as well.
 */
export function readLedgerFile(
  path: string,
  stats: ReadStats,
  onRecord: (record: LedgerRecord) => void,
  maxBytes: number = Number.POSITIVE_INFINITY,
): number {
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) {
      stats.skipped += 1;
      return 0;
    }
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    stats.skipped += 1;
    return 0;
  }
  let total = 0;
  try {
    if (!fstatSync(fd).isFile()) {
      stats.skipped += 1;
      return 0;
    }
    stats.files += 1;
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversize = false;
    // `length` is the line's byte length; a short line is counted without a buffer or a parse.
    const finish = (length: number) => {
      const line = length >= MIN_RECORD_BYTES ? Buffer.concat(pending) : null;
      pending = [];
      pendingBytes = 0;
      if (oversize) {
        oversize = false;
        stats.malformed += 1;
      } else if (length > 0) {
        const record = line === null ? null : parse(line);
        if (record === "unsupported") {
          stats.unsupported += 1;
        } else if (record === null) {
          stats.malformed += 1;
        } else {
          onRecord(record);
        }
      }
    };
    while (total < maxBytes) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(CHUNK_BYTES, maxBytes - total),
        null,
      );
      if (count === 0) {
        break;
      }
      total += count;
      let start = 0;
      for (let index = 0; index < count; index += 1) {
        if (chunk[index] !== 0x0a) {
          continue;
        }
        const length = pendingBytes + index - start;
        if (length > LINE_LIMIT) {
          // Wherever the line sits relative to the chunk borders: never buffered, never parsed.
          oversize = true;
          pending = [];
        }
        if (!oversize && length >= MIN_RECORD_BYTES) {
          pending.push(Buffer.from(chunk.subarray(start, index)));
        }
        finish(length);
        start = index + 1;
      }
      if (start < count && !oversize) {
        pendingBytes += count - start;
        if (pendingBytes > LINE_LIMIT) {
          oversize = true;
          pending = [];
        } else {
          pending.push(Buffer.from(chunk.subarray(start, count)));
        }
      }
    }
    if (total >= maxBytes && fstatSync(fd).size > total) {
      // The cap cut the read: the unread tail is not a partial line.
      stats.truncated = true;
    } else if (oversize || pendingBytes > 0) {
      stats.partial += 1;
    }
    return total;
  } catch {
    stats.skipped += 1;
    return total;
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream the Ledger files of a project directory: the newest `MAX_FILES - 1` rotated files in name
 * (time) order, then `events.jsonl`. Only `events.jsonl` and names that match the writer's rotated
 * pattern are read; any other `events*.jsonl` entry is `skipped`. More rotated files than the window
 * set `truncated`. A missing directory reads as empty. Stops once `maxBytes` (the byte cap, default
 * the total cap plus two rotation sizes) is read.
 */
export function readLedgerDirectory(
  dir: string,
  onRecord: (record: LedgerRecord) => void,
  maxBytes: number = READ_BYTE_CAP,
): ReadStats {
  const stats: ReadStats = {
    files: 0,
    malformed: 0,
    partial: 0,
    unsupported: 0,
    skipped: 0,
    truncated: false,
  };
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => NAME.test(name));
  } catch {
    return stats;
  }
  const rotated = entries
    .filter((name) => ROTATED_NAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const window = rotated.slice(-(MAX_FILES - 1));
  stats.truncated = rotated.length > window.length;
  const names = entries.includes("events.jsonl")
    ? [...window, "events.jsonl"]
    : window;
  stats.skipped = entries.filter(
    (name) => name !== "events.jsonl" && !ROTATED_NAME.test(name),
  ).length;
  let read = 0;
  for (const [index, name] of names.entries()) {
    if (read >= maxBytes) {
      // Truncated only when a remaining file has bytes; empty files cost nothing.
      if (names.slice(index).some((rest) => sizeOf(join(dir, rest)) > 0)) {
        stats.truncated = true;
      }
      break;
    }
    read += readLedgerFile(join(dir, name), stats, onRecord, maxBytes - read);
  }
  return stats;
}
