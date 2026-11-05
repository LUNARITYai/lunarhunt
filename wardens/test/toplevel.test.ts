import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";

const UNRESOLVED =
  "Blocked by Warden engine: git toplevel could not be resolved. Move the session into an existing worktree (EnterWorktree) or restart it in the primary checkout.";

function nonGitDir(): string {
  return mkdtempSync(join(tmpdir(), "wardens-nogit-"));
}

function setup() {
  const cwd = nonGitDir();
  const tmp = mkdtempSync(join(tmpdir(), "wardens-fallback-"));
  const logPath = join(tmp, "panopticon", "wardens.log.jsonl");
  return { cwd, tmp, logPath, deps: { cwd: () => cwd, env: {}, tmpDir: tmp } };
}

describe("unresolvable git toplevel", () => {
  it("allows a Claude Stop and logs one fallback line", () => {
    const { cwd, logPath, deps } = setup();
    const result = runHook("claude", "Stop", JSON.stringify({ cwd }), deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string);
    expect(line.rule).toBe("engine");
    expect(line.decision).toBe("allow");
    expect(line.message).toBe("git toplevel could not be resolved");
  });

  it("allows a Cursor stop", () => {
    const { cwd, logPath, deps } = setup();
    const result = runHook("cursor", "stop", JSON.stringify({ cwd }), deps);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("still allows the stop when the fallback log cannot be written", () => {
    const cwd = nonGitDir();
    const result = runHook("claude", "Stop", JSON.stringify({ cwd }), {
      cwd: () => cwd,
      env: {},
      // A path under a regular file cannot be created.
      tmpDir: join(import.meta.filename, "nope"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("keeps denying Claude PreToolUse with the new next action", () => {
    const { cwd, tmp, deps } = setup();
    const result = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd,
      }),
      deps,
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toBe(UNRESOLVED);
    expect(UNRESOLVED).toMatch(MESSAGE_PATTERN);
    expect(() =>
      readFileSync(join(tmp, "panopticon", "wardens.log.jsonl")),
    ).toThrow();
  });

  it("keeps denying Cursor preToolUse with the new next action", () => {
    const { cwd, deps } = setup();
    const result = runHook(
      "cursor",
      "preToolUse",
      JSON.stringify({
        tool_name: "Shell",
        tool_input: { command: "ls" },
        cwd,
      }),
      deps,
    );
    const out = JSON.parse(result.stdout);
    expect(out.permission).toBe("deny");
    expect(JSON.stringify(out)).toContain(UNRESOLVED);
  });
});
