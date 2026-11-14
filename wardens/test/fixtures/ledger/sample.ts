import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerRecord, runIdOf } from "../../../src/ledger/record.ts";

/** Synthetic values only. */
export function sampleRecord(
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  const tool = overrides.tool === undefined ? "claude" : overrides.tool;
  const sessionId =
    overrides.session_id === undefined ? "session-1" : overrides.session_id;
  return {
    v: 1,
    record: "event",
    ts: "2026-11-20T08:00:00.000Z",
    project: "lunarhunt",
    session_id: sessionId,
    run_id: runIdOf(tool, sessionId),
    tool,
    role: null,
    model: "example-model[1m]",
    agent_type: null,
    event: "PreToolUse",
    tool_name: "Bash",
    action: "shell",
    decision: "deny",
    rendered: "deny",
    warden_rule_id: "command-guard",
    outcome: null,
    interactive: false,
    worktree: "128-ledger-writer",
    primary: false,
    branch: "feat/128-ledger-writer",
    issue: 128,
    duration_ms: 12,
    ...overrides,
  };
}

/** A fresh temporary home, so no test touches the real `~/.local/state`. */
export function tempHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ledger-home-")));
}

export function ledgerDirectory(home: string, project = "lunarhunt"): string {
  return join(home, ".local", "state", "panopticon", "ledger", project);
}
