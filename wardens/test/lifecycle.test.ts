import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { normalizeHook } from "../src/event.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { detectAgent, runAgentTrailer } from "../src/trailer.ts";
import { trackedRepo } from "./dod-support.ts";
import { cliPath, tempRepo, writeRepoFile } from "./support.ts";

type Line = Record<string, unknown>;

function lines(root: string): Line[] {
  return readFileSync(join(root, ".panopticon/wardens.log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
}

const GREEN = { runCheck: () => ({ status: "green" as const, output: "" }) };

function claude(root: string, event: string, payload: Record<string, unknown>) {
  return runHook(
    "claude",
    event,
    JSON.stringify({ session_id: "s1", cwd: root, ...payload }),
    { cwd: () => root, env: {}, dod: GREEN },
  );
}

function cursor(root: string, event: string, payload: Record<string, unknown>) {
  return runHook(
    "cursor",
    event,
    JSON.stringify({ conversation_id: "c1", cwd: root, ...payload }),
    { cwd: () => root, env: {}, dod: GREEN },
  );
}

describe("generated-files-guard", () => {
  const cases: Array<[string, string, string]> = [
    ["Claude Edit", "claude", "Edit"],
    ["Claude Write", "claude", "Write"],
  ];

  it.each(cases)(
    "denies a %s of a generated path with the next action",
    (_n, _t, name) => {
      const root = tempRepo();
      for (const path of [
        "packages/contracts/openapi.json",
        "packages/api-client/src/client.ts",
      ]) {
        const result = claude(root, "PreToolUse", {
          tool_name: name,
          tool_input: { file_path: path },
        });
        const out = JSON.parse(result.stdout).hookSpecificOutput;
        expect(out.permissionDecision).toBe("deny");
        expect(out.permissionDecisionReason).toBe(
          `Blocked by Warden generated-files-guard: ${path} is generated. Run uv run export-openapi to regenerate it.`,
        );
      }
    },
  );

  it("denies a Cursor Delete of a generated path", () => {
    const root = tempRepo();
    const result = cursor(root, "preToolUse", {
      tool_name: "Delete",
      tool_input: { file_path: join(root, "packages/contracts/openapi.json") },
    });
    const body = JSON.parse(result.stdout);
    expect(body.permission).toBe("deny");
    expect(body.agent_message).toContain("generated-files-guard");
  });

  it("does not object to the contracts README or to uv run export-openapi", () => {
    const root = tempRepo();
    const readme = claude(root, "PreToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "packages/contracts/README.md" },
    });
    expect(readme.stdout).toBe("");
    const shell = claude(root, "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "uv run export-openapi" },
    });
    expect(shell.stdout).toBe("");
  });
});

describe("post-edit audit", () => {
  const revert = (path: string) =>
    `Revert ${path} with git checkout -- ${path}.`;
  const remove = (path: string) => `Delete ${path}.`;

  it("blocks a Claude PostToolUse edit that scope-guard would have denied", () => {
    const root = tempRepo();
    const result = claude(root, "PostToolUse", {
      tool_name: "Write",
      tool_input: { file_path: "infra/main.tf" },
      tool_response: { success: true },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "block",
      reason: `Blocked by Warden scope-guard: infra/main.tf was edited outside allowed_paths for this task. ${remove("infra/main.tf")}`,
    });
  });

  it("names git checkout for a tracked path and Delete for an untracked one", () => {
    const root = trackedRepo({ "infra/main.tf": "x\n" });
    const tracked = JSON.parse(
      claude(root, "PostToolUse", {
        tool_name: "Edit",
        tool_input: { file_path: "infra/main.tf" },
      }).stdout,
    );
    expect(tracked.reason).toContain(revert("infra/main.tf"));
    const fresh = JSON.parse(
      claude(root, "PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: "infra/new.tf" },
      }).stdout,
    );
    expect(fresh.reason).toContain(remove("infra/new.tf"));
  });

  it("blocks protected deny paths and generated paths with a revert next action", () => {
    const root = tempRepo();
    const charter = claude(root, "PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "panopticon.charter.yaml" },
    });
    const generated = claude(root, "PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "packages/contracts/openapi.json" },
    });
    const a = JSON.parse(charter.stdout);
    const b = JSON.parse(generated.stdout);
    expect(a.reason).toMatch(MESSAGE_PATTERN);
    expect(a.reason).toContain("Warden protected-paths");
    expect(a.reason).toContain(remove("panopticon.charter.yaml"));
    expect(b.reason).toMatch(MESSAGE_PATTERN);
    expect(b.reason).toContain("Warden generated-files-guard");
    expect(b.reason).toContain(remove("packages/contracts/openapi.json"));
  });

  it("does not object to an edit of a paths.protected.ask path", () => {
    const root = tempRepo();
    const result = claude(root, "PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "apps/api/migrations/0001.sql" },
    });
    expect(result.stdout).toBe("");
    expect(lines(root)[0]).toMatchObject({ decision: "allow", phase: "post" });
  });

  it("runs the same audit for Cursor afterFileEdit, logs it and prints {}", () => {
    const root = tempRepo();
    const result = cursor(root, "afterFileEdit", {
      file_path: join(root, "infra/main.tf"),
      edits: [{ old_string: "", new_string: "SENTINEL_CONTENT_9f3a" }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("{}\n");
    const log = lines(root);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      rule: "scope-guard",
      decision: "deny",
      event: "afterFileEdit",
      action: "edit",
      path: "infra/main.tf",
      phase: "post",
    });
    expect(JSON.stringify(log[0])).not.toContain("SENTINEL_CONTENT_9f3a");
  });
});

describe("stop and session start", () => {
  it("allows a Claude Stop with empty stdout and a Cursor stop with {}", () => {
    const root = tempRepo();
    const a = claude(root, "Stop", { stop_hook_active: false });
    expect(a).toMatchObject({ exitCode: 0, stdout: "" });
    const b = cursor(root, "stop", { status: "completed", loop_count: 0 });
    expect(b).toMatchObject({ exitCode: 0, stdout: "{}\n" });
    const log = lines(root);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ action: "stop", stop_status: "completed" });
    expect(log[1]).toMatchObject({ action: "stop", tool: "cursor" });
  });

  it("returns the PANOPTICON_AGENT env for Cursor sessionStart", () => {
    const root = tempRepo();
    const result = cursor(root, "sessionStart", {});
    expect(JSON.parse(result.stdout)).toEqual({
      env: { PANOPTICON_AGENT: "cursor" },
    });
    expect(lines(root)).toHaveLength(1);
  });

  it("renders an engine failure on stop as a block", () => {
    const root = tempRepo();
    writeRepoFile(root, "panopticon.charter.yaml", "version: [\n");
    const a = JSON.parse(claude(root, "Stop", {}).stdout);
    expect(a.decision).toBe("block");
    expect(a.reason).toMatch(MESSAGE_PATTERN);
    const b = JSON.parse(cursor(root, "stop", { status: "completed" }).stdout);
    expect(b.followup_message).toMatch(MESSAGE_PATTERN);
  });

  it("denies unmapped combinations with rule engine", () => {
    const root = tempRepo();
    const read = claude(root, "PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
    });
    expect(JSON.parse(read.stdout).reason).toContain("Warden engine");
    const status = cursor(root, "stop", { status: "weird" });
    expect(JSON.parse(status.stdout).followup_message).toContain(
      "Warden engine",
    );
  });
});

describe("normalized event fields", () => {
  const base = { fallbackCwd: "/r", toplevel: "/r", env: {} };

  it("sets phase, stop_status and foreign", () => {
    const post = normalizeHook({
      ...base,
      tool: "claude",
      event: "PostToolUse",
      payload: { tool_name: "Edit", tool_input: { file_path: "a.ts" } },
    });
    expect(post.ok && post.event).toMatchObject({
      phase: "post",
      stop_status: null,
      foreign: false,
    });
    const aborted = normalizeHook({
      ...base,
      tool: "cursor",
      event: "stop",
      payload: { status: "aborted" },
    });
    expect(aborted.ok && aborted.event).toMatchObject({
      action: "stop",
      phase: null,
      stop_status: "aborted",
    });
    const foreign = normalizeHook({
      ...base,
      tool: "claude",
      event: "Stop",
      payload: { cursor_version: "2026.10.22" },
    });
    expect(foreign.ok && foreign.event).toMatchObject({
      stop_status: "completed",
      foreign: true,
    });
    const pre = normalizeHook({
      ...base,
      tool: "claude",
      event: "PreToolUse",
      payload: { tool_name: "Read", tool_input: { file_path: "a.ts" } },
    });
    expect(pre.ok && pre.event).toMatchObject({ phase: "pre" });
  });
});

describe("agent-trailer", () => {
  function message(root: string, text: string): string {
    writeRepoFile(root, ".git/MSG", text);
    return join(root, ".git/MSG");
  }

  const body = "feat(x): y (#1)\n\nBody text.\n\n";

  it("passes a matching trailer, including a model with a comma", () => {
    const root = tempRepo();
    const file = message(root, `${body}Agent: claude (sonnet, high)\n`);
    expect(runAgentTrailer(file, { PANOPTICON_AGENT: "claude" }, root)).toEqual(
      {
        exitCode: 0,
        stderr: "",
      },
    );
    expect(lines(root)[0]).toMatchObject({
      rule: "none",
      tool: "claude",
      event: "commit-msg",
      action: "commit",
    });
  });

  it("fails a missing trailer and a trailer for another tool", () => {
    const root = tempRepo();
    const expected =
      'Blocked by Warden agent-trailer: agent commit has no Agent: trailer. Add "Agent: <tool> (<model>)" as the last trailer and commit again.\n';
    const none = runAgentTrailer(
      message(root, body),
      { PANOPTICON_AGENT: "cursor" },
      root,
    );
    expect(none).toEqual({ exitCode: 2, stderr: expected });
    const other = runAgentTrailer(
      message(root, `${body}Agent: claude (sonnet)\n`),
      { PANOPTICON_AGENT: "cursor" },
      root,
    );
    expect(other).toEqual({ exitCode: 2, stderr: expected });
    expect(lines(root).at(-1)).toMatchObject({
      rule: "agent-trailer",
      decision: "deny",
      tool: "cursor",
    });
  });

  it("falls back to CLAUDECODE=1 and exits 0 with no marker", () => {
    const root = tempRepo();
    const file = message(root, body);
    expect(runAgentTrailer(file, { CLAUDECODE: "1" }, root).exitCode).toBe(2);
    expect(runAgentTrailer(file, {}, root).exitCode).toBe(0);
    expect(
      runAgentTrailer(file, { PANOPTICON_AGENT: "x" }, root).exitCode,
    ).toBe(0);
  });

  it("detects the agent by marker order, with CURSOR_AGENT as the last fallback", () => {
    expect(detectAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(detectAgent({ CURSOR_AGENT: "" })).toBeNull();
    expect(detectAgent({})).toBeNull();
    expect(detectAgent({ PANOPTICON_AGENT: "claude", CURSOR_AGENT: "1" })).toBe(
      "claude",
    );
    expect(detectAgent({ CLAUDECODE: "1", CURSOR_AGENT: "1" })).toBe("claude");
    expect(detectAgent({ PANOPTICON_AGENT: "cursor", CLAUDECODE: "1" })).toBe(
      "cursor",
    );
  });

  it("judges a Cursor commit by CURSOR_AGENT alone", () => {
    const root = tempRepo();
    const env = { CURSOR_AGENT: "1" };
    expect(runAgentTrailer(message(root, body), env, root).exitCode).toBe(2);
    const ok = message(root, `${body}Agent: cursor (grok-4.7)\n`);
    expect(runAgentTrailer(ok, env, root).exitCode).toBe(0);
  });

  it("runs through the CLI as wardens check agent-trailer <file>", () => {
    const root = tempRepo();
    const file = message(root, body);
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", cliPath, "check", "agent-trailer", file],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", ...env },
        },
      );
    const bad = run({ PANOPTICON_AGENT: "claude" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^Blocked by Warden agent-trailer: /);
    expect(run({}).status).toBe(0);
  });
});
