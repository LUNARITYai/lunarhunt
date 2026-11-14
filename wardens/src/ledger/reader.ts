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
import { DEFAULT_LIMITS } from "./writer.ts";

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
  /** Entries named like Ledger files that are not regular files (symlink, FIFO, directory). */
  skipped: number;
  /** True when the total cap stopped the read with bytes left, in a file or in later files. */
  truncated: boolean;
};

const CHUNK_BYTES = 64 * 1024;
const LINE_LIMIT = 4 * 4096;
const NAME = /^events.*\.jsonl$/;
/** Every record the writer produces starts like this (key order of the schema). */
const RECORD_START = Buffer.from('{"v":1,"record":"');
/** Shorter than the smallest valid record (all nullable keys null): not worth a JSON parse. */
export const MIN_RECORD_BYTES = 300;

function parse(line: Buffer): LedgerRecord | null {
  if (
    line.length < MIN_RECORD_BYTES ||
    !line.subarray(0, RECORD_START.length).equals(RECORD_START)
  ) {
    return null;
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
    const finish = () => {
      const line = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      if (oversize) {
        oversize = false;
        stats.malformed += 1;
      } else if (line.length > 0) {
        const record = parse(line);
        if (record === null) {
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
        if (!oversize) {
          pending.push(Buffer.from(chunk.subarray(start, index)));
        }
        finish();
        start = index + 1;
      }
      if (start < count && !oversize) {
        pending.push(Buffer.from(chunk.subarray(start, count)));
        pendingBytes += count - start;
        if (pendingBytes > LINE_LIMIT) {
          oversize = true;
          pending = [];
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
 * Stream every `events*.jsonl` file of a project directory: rotated files in name (time) order, then
 * `events.jsonl`. A missing directory reads as empty. Stops once `maxBytes` (the total cap) is read.
 */
export function readLedgerDirectory(
  dir: string,
  onRecord: (record: LedgerRecord) => void,
  maxBytes: number = DEFAULT_LIMITS.project.totalBytes,
): ReadStats {
  const stats: ReadStats = {
    files: 0,
    malformed: 0,
    partial: 0,
    skipped: 0,
    truncated: false,
  };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => NAME.test(name));
  } catch {
    return stats;
  }
  names.sort((a, b) =>
    a === "events.jsonl"
      ? 1
      : b === "events.jsonl"
        ? -1
        : a < b
          ? -1
          : a > b
            ? 1
            : 0,
  );
  let read = 0;
  for (const name of names) {
    if (read >= maxBytes) {
      stats.truncated = true;
      break;
    }
    read += readLedgerFile(join(dir, name), stats, onRecord, maxBytes - read);
  }
  return stats;
}
