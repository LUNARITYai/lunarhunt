import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_RECORD_BYTES,
  readLedgerDirectory,
  readLedgerFile,
} from "../src/ledger/reader.ts";
import { type LedgerRecord, ledgerRecordSchema } from "../src/ledger/record.ts";
import { sampleRecord, tempHome } from "./fixtures/ledger/sample.ts";

function line(overrides: Partial<LedgerRecord> = {}): string {
  return `${JSON.stringify(sampleRecord(overrides))}\n`;
}

function directory(): string {
  return fs.mkdtempSync(join(tempHome(), "project-"));
}

function read(dir: string, maxBytes?: number) {
  const records: LedgerRecord[] = [];
  const stats = readLedgerDirectory(dir, (r) => records.push(r), maxBytes);
  return { records, stats };
}

describe("reader", () => {
  it("returns the records of a file, in order, with zero counts", () => {
    const dir = directory();
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      line({ duration_ms: 1 }) + line({ duration_ms: 2 }),
    );
    const { records, stats } = read(dir);
    expect(records.map((r) => r.duration_ms)).toEqual([1, 2]);
    expect(stats).toEqual({
      files: 1,
      malformed: 0,
      partial: 0,
      skipped: 0,
      truncated: false,
    });
  });

  it("reads rotated files in name order, then events.jsonl", () => {
    const dir = directory();
    fs.writeFileSync(join(dir, "events.jsonl"), line({ duration_ms: 3 }));
    fs.writeFileSync(
      join(dir, "events-20261120T000002Z-1.jsonl"),
      line({ duration_ms: 2 }),
    );
    fs.writeFileSync(
      join(dir, "events-20261120T000001Z-1.jsonl"),
      line({ duration_ms: 1 }),
    );
    fs.writeFileSync(join(dir, "notes.txt"), "not a ledger file");
    expect(read(dir).records.map((r) => r.duration_ms)).toEqual([1, 2, 3]);
  });

  it("ignores empty lines and counts bad lines as malformed", () => {
    const dir = directory();
    const extraKey = JSON.stringify({ ...sampleRecord(), command: "ls" });
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      `\n${line()}\n\nnot json\n[1]\n${extraKey}\n${line({ duration_ms: 9 })}`,
    );
    const { records, stats } = read(dir);
    expect(records.map((r) => r.duration_ms)).toEqual([12, 9]);
    expect(stats).toMatchObject({ malformed: 3, partial: 0 });
  });

  it("counts a last line without a newline as partial and does not parse it", () => {
    const dir = directory();
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      line() + line().trimEnd().slice(0, 40),
    );
    const { records, stats } = read(dir);
    expect(records).toHaveLength(1);
    expect(stats).toMatchObject({ malformed: 0, partial: 1 });
  });

  it("streams a file larger than one chunk without splitting a line", () => {
    const dir = directory();
    const count = 600;
    let text = "";
    for (let index = 0; index < count; index += 1) {
      text += line({ duration_ms: index });
    }
    fs.writeFileSync(join(dir, "events.jsonl"), text);
    expect(Buffer.byteLength(text)).toBeGreaterThan(2 * 64 * 1024);
    const { records, stats } = read(dir);
    expect(records).toHaveLength(count);
    expect(records.every((r, index) => r.duration_ms === index)).toBe(true);
    expect(stats).toMatchObject({ malformed: 0, partial: 0 });
  });

  it("counts a very long line as malformed without keeping it", () => {
    const dir = directory();
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      `${"x".repeat(300_000)}\n${line()}`,
    );
    const { records, stats } = read(dir);
    expect(records).toHaveLength(1);
    expect(stats).toMatchObject({ malformed: 1, partial: 0 });
  });

  it("reads regular files only: a symlink and a FIFO are skipped", () => {
    const dir = directory();
    const target = join(tempHome(), "target.jsonl");
    fs.writeFileSync(target, line());
    fs.symlinkSync(target, join(dir, "events-20261120T000001Z-1.jsonl"));
    execFileSync("mkfifo", [join(dir, "events-20261120T000002Z-1.jsonl")]);
    fs.mkdirSync(join(dir, "events-20261120T000003Z-1.jsonl"));
    fs.writeFileSync(join(dir, "events.jsonl"), line());
    const { records, stats } = read(dir);
    expect(records).toHaveLength(1);
    expect(stats).toMatchObject({ files: 1, skipped: 3 });
    const alone = {
      files: 0,
      malformed: 0,
      partial: 0,
      skipped: 0,
      truncated: false,
    };
    expect(
      readLedgerFile(
        join(dir, "events-20261120T000001Z-1.jsonl"),
        alone,
        () => {},
      ),
    ).toBe(0);
    expect(alone.skipped).toBe(1);
  });

  it("stops at the total cap", () => {
    const dir = directory();
    const one = Buffer.byteLength(line());
    fs.writeFileSync(
      join(dir, "events-20261120T000001Z-1.jsonl"),
      line() + line(),
    );
    fs.writeFileSync(join(dir, "events.jsonl"), line());
    const { records, stats } = read(dir, one * 2);
    expect(records).toHaveLength(2);
    expect(stats.truncated).toBe(true);
    expect(read(dir, one * 3).stats.truncated).toBe(false);
  });

  it("sets truncated when the cap cuts inside the last file, without counting the cut as partial", () => {
    const dir = directory();
    const one = Buffer.byteLength(line());
    let text = "";
    for (let index = 0; index < 10; index += 1) {
      text += line({ duration_ms: index });
    }
    fs.writeFileSync(join(dir, "events.jsonl"), text);
    const { records, stats } = read(dir, one * 2 + 25);
    expect(records.map((r) => r.duration_ms)).toEqual([0, 1]);
    expect(stats).toMatchObject({ truncated: true, partial: 0, malformed: 0 });
    const exact = read(dir, one * 10);
    expect(exact.records).toHaveLength(10);
    expect(exact.stats).toMatchObject({ truncated: false, partial: 0 });
    expect(read(dir, one * 3).stats.truncated).toBe(true);
  });

  it("counts a short line or a line that does not start like a record as malformed", () => {
    const dir = directory();
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(sampleRecord()).reverse()),
    );
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      `{"v":1,"record":"event"}\n${reordered}\n${line()}`,
    );
    const { records, stats } = read(dir);
    expect(records).toHaveLength(1);
    expect(stats).toMatchObject({ malformed: 2, partial: 0 });
  });

  it("keeps the shortest record the writer can produce above the parse threshold", () => {
    const smallest = JSON.stringify(
      sampleRecord({
        project: "a",
        session_id: null,
        run_id: null,
        tool: null,
        model: null,
        event: null,
        tool_name: null,
        action: null,
        warden_rule_id: null,
        worktree: null,
        branch: null,
        issue: null,
        decision: "ask",
        rendered: "ask",
        duration_ms: 0,
      }),
    );
    expect(ledgerRecordSchema.safeParse(JSON.parse(smallest)).success).toBe(
      true,
    );
    expect(smallest.length).toBeGreaterThanOrEqual(MIN_RECORD_BYTES);
    const dir = directory();
    fs.writeFileSync(join(dir, "events.jsonl"), `${smallest}\n`);
    expect(read(dir).records).toHaveLength(1);
  });

  it("reads a missing directory as empty", () => {
    expect(read(join(directory(), "missing"))).toEqual({
      records: [],
      stats: {
        files: 0,
        malformed: 0,
        partial: 0,
        skipped: 0,
        truncated: false,
      },
    });
  });

  it("returns records that match the schema", () => {
    const dir = directory();
    fs.writeFileSync(
      join(dir, "events.jsonl"),
      line({ record: "run_end", outcome: "dod_green" }),
    );
    for (const record of read(dir).records) {
      expect(ledgerRecordSchema.safeParse(record).success).toBe(true);
    }
  });
});
