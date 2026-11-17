import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  identifierOrNull,
  issueFromBranch,
  issueOrNull,
  ledgerRecordSchema,
  MAX_LINE_BYTES,
  modelOrNull,
  runIdOf,
  toolNameOrOther,
} from "../src/ledger/record.ts";
import { sampleRecord } from "./fixtures/ledger/sample.ts";

const KEYS = [
  "v",
  "record",
  "ts",
  "project",
  "session_id",
  "run_id",
  "tool",
  "role",
  "model",
  "agent_type",
  "event",
  "tool_name",
  "action",
  "decision",
  "rendered",
  "warden_rule_id",
  "outcome",
  "interactive",
  "worktree",
  "primary",
  "branch",
  "issue",
  "duration_ms",
];

const BAD_VALUES: [string, string][] = [
  ["a newline", "abc\ndef"],
  ["a NUL", "abc\u0000def"],
  ["too long", "a".repeat(129)],
  ["non-ASCII letters", "zażółć"],
  ["a backtick", "abc`def"],
  ["a space", "abc def"],
  ["a token shape", "ghp_0123456789abcdefghij"],
  ["a nested token shape", "x/sk-0123456789abcdefghij"],
];

describe("record schema", () => {
  it("accepts the sample and keeps exactly the keys of the spec", () => {
    const record = sampleRecord();
    expect(ledgerRecordSchema.safeParse(record).success).toBe(true);
    expect(Object.keys(record)).toEqual(KEYS);
    expect(Object.keys(ledgerRecordSchema.def.shape)).toEqual(KEYS);
  });

  it("rejects an extra key and a missing key", () => {
    expect(
      ledgerRecordSchema.safeParse({ ...sampleRecord(), command: "ls" })
        .success,
    ).toBe(false);
    const { issue: _issue, ...missing } = sampleRecord();
    expect(ledgerRecordSchema.safeParse(missing).success).toBe(false);
  });

  it("accepts null for every nullable key and `_unknown` as project", () => {
    const record = sampleRecord({
      project: "_unknown",
      tool: null,
      session_id: null,
      run_id: null,
      model: null,
      worktree: null,
      branch: null,
      issue: null,
      warden_rule_id: null,
      action: null,
      event: null,
      role: null,
      agent_type: null,
      tool_name: null,
      outcome: null,
    });
    expect(ledgerRecordSchema.safeParse(record).success).toBe(true);
  });

  it.each([
    "v",
    "record",
    "ts",
    "project",
    "decision",
    "rendered",
    "interactive",
    "primary",
    "duration_ms",
  ])("rejects null for the non-nullable key %s", (key) => {
    const record = { ...sampleRecord(), [key]: null };
    expect(ledgerRecordSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    ["a bad timestamp", { ts: "2026-11-20T08:00:00Z" }],
    ["an impossible date", { ts: "2026-02-31T08:00:00.000Z" }],
    ["a bad project", { project: "../x" }],
    ["a bad role", { role: "root" as never }],
    ["issue 0", { issue: 0 }],
    ["issue above the limit", { issue: 2147483648 }],
    ["negative duration", { duration_ms: -1 }],
    ["a fractional duration", { duration_ms: 1.5 }],
    ["a mismatching run_id", { run_id: "a".repeat(32) }],
    ["an outcome on an event", { outcome: "dod_green" as const }],
    ["a run_end without outcome", { record: "run_end" as const }],
    ["usage_limit, reserved for #99", { outcome: "usage_limit" as never }],
  ])("rejects %s", (_name, overrides) => {
    expect(ledgerRecordSchema.safeParse(sampleRecord(overrides)).success).toBe(
      false,
    );
  });

  it("accepts a run_end with an outcome", () => {
    const record = sampleRecord({ record: "run_end", outcome: "loop_limit" });
    expect(ledgerRecordSchema.safeParse(record).success).toBe(true);
  });

  it("keeps the largest record under the line cap", () => {
    const longest = sampleRecord({
      session_id: "s".repeat(128),
      agent_type: "a".repeat(128),
      tool_name: "t".repeat(128),
      branch: "b".repeat(128),
      worktree: "w".repeat(128),
      model: "m".repeat(64),
      event: "e".repeat(64),
      warden_rule_id: "r".repeat(64),
      project: "p".repeat(64),
      duration_ms: Number.MAX_SAFE_INTEGER,
    });
    expect(ledgerRecordSchema.safeParse(longest).success).toBe(true);
    expect(Buffer.byteLength(`${JSON.stringify(longest)}\n`)).toBeLessThan(
      MAX_LINE_BYTES / 2,
    );
  });
});

describe("field rules", () => {
  it.each(BAD_VALUES)("maps a value with %s to null", (_name, value) => {
    expect(identifierOrNull(value)).toBeNull();
    expect(modelOrNull(value)).toBeNull();
    expect(toolNameOrOther(value)).toBe("other");
    expect(
      ledgerRecordSchema.safeParse(sampleRecord({ branch: value })).success,
    ).toBe(false);
  });

  it("maps non-string payload values to null", () => {
    for (const value of [undefined, null, 7, {}, ["a"]]) {
      expect(identifierOrNull(value)).toBeNull();
      expect(modelOrNull(value)).toBeNull();
      expect(toolNameOrOther(value)).toBeNull();
    }
  });

  it("maps an empty string to null, and an empty tool name to other", () => {
    expect(identifierOrNull("")).toBeNull();
    expect(toolNameOrOther("")).toBe("other");
  });

  it("keeps names that pass, including a bracketed model id", () => {
    expect(identifierOrNull("feat/42-task-scheduler-refactor@v1")).toBe(
      "feat/42-task-scheduler-refactor@v1",
    );
    expect(identifierOrNull("a".repeat(128))).toBe("a".repeat(128));
    expect(modelOrNull("example-model[1m]")).toBe("example-model[1m]");
    expect(modelOrNull("m".repeat(65))).toBeNull();
    expect(identifierOrNull("example-model[1m]")).toBeNull();
    expect(toolNameOrOther("mcp__x__y")).toBe("mcp__x__y");
  });

  it("filters each token shape with at least 16 more characters", () => {
    const tail = "0123456789abcdef";
    for (const prefix of [
      "ghp_",
      "gho_",
      "ghs_",
      "ghu_",
      "github_pat_",
      "sk-",
      "xox",
    ]) {
      expect(identifierOrNull(`${prefix}${tail}`)).toBeNull();
      expect(identifierOrNull(`${prefix}${tail.slice(1)}`)).toBe(
        `${prefix}${tail.slice(1)}`,
      );
    }
  });

  it("keeps ordinary words that contain `sk-` or `xox`, and filters at the boundaries", () => {
    const tail = "0123456789abcdef";
    for (const kept of [
      `task-${tail}`,
      `Task-${tail}`,
      "risk-assessment-module",
      "feat/42-risk-assessment-module",
      `1sk-${tail}`,
      `fooxox${tail}`,
      `highs_${tail}`,
      `laughs_${tail}`,
      `weighs_${tail}`,
      `1ghs_${tail}`,
    ]) {
      expect(identifierOrNull(kept)).toBe(kept);
    }
    for (const filtered of [
      `x/sk-${tail}`,
      `a-sk-${tail}`,
      `a_sk-${tail}`,
      `a.xox${tail}`,
      `SK-${tail}`,
      `fooghp_${tail}`,
      `x-ghs_${tail}`,
      `task_github_pat_${tail}`,
    ]) {
      expect(identifierOrNull(filtered)).toBeNull();
    }
  });

  it("parses the issue number", () => {
    expect(issueFromBranch("feat/128-ledger-writer")).toBe(128);
    expect(issueFromBranch("feat/12345678901-x")).toBeNull();
    expect(issueFromBranch("feat/2147483647-x")).toBe(2147483647);
    expect(issueFromBranch("feat/2147483648-x")).toBeNull();
    expect(issueFromBranch("feat/0-x")).toBeNull();
    expect(issueFromBranch("worktree-agent-ac08")).toBeNull();
    expect(issueFromBranch(null)).toBeNull();
    expect(issueOrNull(5)).toBe(5);
    expect(issueOrNull(1.5)).toBeNull();
    expect(issueOrNull("0123")).toBeNull();
    expect(issueOrNull("99999999999999999999")).toBeNull();
    expect(issueOrNull("12")).toBe(12);
    expect(issueOrNull(Number.NaN)).toBeNull();
  });
});

describe("run_id", () => {
  it("is the first 16 bytes of SHA-256 of tool:session_id, in lowercase hex", () => {
    const id = runIdOf("claude", "session-1");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toBe(
      createHash("sha256")
        .update("claude:session-1")
        .digest()
        .subarray(0, 16)
        .toString("hex"),
    );
    expect(runIdOf("cursor", "session-1")).not.toBe(id);
    expect(runIdOf("claude", "session-2")).not.toBe(id);
  });

  it("is null when the tool or the session is null", () => {
    expect(runIdOf(null, "session-1")).toBeNull();
    expect(runIdOf("claude", null)).toBeNull();
  });
});
