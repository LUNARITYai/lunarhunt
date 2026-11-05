import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRules, runCheck, runHook } from "../src/engine.ts";
import { MESSAGE_PATTERN, wardenMessage } from "../src/messages.ts";
import type { Rule } from "../src/rules.ts";
import { cliPath, tempRepo, writeRepoFile } from "./support.ts";

function readLog(root: string): string[] {
  return readFileSync(join(root, ".panopticon/wardens.log.jsonl"), "utf8")
    .trim()
    .split("\n");
}

describe("fail-closed engine", () => {
  it("denies an empty stdin, an unknown tool and a missing Charter without exiting 1", () => {
    const root = tempRepo();
    const deps = { cwd: () => root, env: {} };
    const empty = runHook("claude", "PreToolUse", "", deps);
    expect(empty.exitCode).toBe(0);
    expect(empty.exitCode).not.toBe(1);
    expect(JSON.parse(empty.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );

    const unknown = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        tool_name: "Grep",
        tool_input: { pattern: "x" },
        cwd: root,
      }),
      deps,
    );
    expect(unknown.exitCode).toBe(0);
    expect(
      JSON.parse(unknown.stdout).hookSpecificOutput.permissionDecision,
    ).toBe("deny");

    const bare = tempRepo();
    writeRepoFile(bare, "panopticon.charter.yaml", "version: [\n");
    const broken = runCheck("charter-validate", "", { cwd: () => bare });
    expect(broken.exitCode).toBe(2);
    expect(broken.exitCode).not.toBe(1);
    expect(JSON.parse(broken.stdout).rule).toBe("engine");
    expect(JSON.parse(broken.stdout).message).toMatch(MESSAGE_PATTERN);
  });

  it("appends one allow line and omits contents, email and absolute cwd", () => {
    const root = tempRepo();
    writeRepoFile(root, "wardens/src/cli.ts", "export {}\n");
    const sentinel = "SENTINEL_CONTENT_9f3a";
    const email = "SENTINEL_EMAIL_9f3a";
    const result = runHook(
      "cursor",
      "beforeReadFile",
      JSON.stringify({
        file_path: join(root, "wardens/src/cli.ts"),
        content: sentinel,
        user_email: email,
        cwd: root,
        session_id: "sess_abc",
      }),
      { cwd: () => root, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
    const lines = readLog(root);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).not.toContain(sentinel);
    expect(line).not.toContain(email);
    expect(line).not.toContain(root);
    const parsed = JSON.parse(line) as {
      rule: string;
      decision: string;
      path: string;
    };
    expect(parsed).toMatchObject({
      rule: "none",
      decision: "allow",
      rendered: "allow",
      path: "wardens/src/cli.ts",
      command: null,
      session_id: "sess_abc",
    });
    expect(parsed).not.toHaveProperty("cwd");
    expect(parsed).not.toHaveProperty("user_email");
  });

  it("turns a throwing log writer into an engine deny and does not throw again", () => {
    const root = tempRepo();
    let calls = 0;
    const result = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "wardens/src/cli.ts" },
        cwd: root,
      }),
      {
        cwd: () => root,
        env: {},
        append: () => {
          calls += 1;
          throw new Error("disk full");
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toMatch(
      MESSAGE_PATTERN,
    );
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain(
      "verdict log",
    );
  });

  it("gives deny precedence over rewrite and ask", () => {
    const root = tempRepo();
    const ctx = {
      event: {
        tool: "claude" as const,
        event: "PreToolUse",
        action: "edit" as const,
        path: "docs/constitution.md",
        command: null,
        mcp_server: null,
        session_id: null,
        agent: null,
        model: null,
        interactive: true,
        cwd: root,
        phase: "pre" as const,
        stop_status: null,
        foreign: false,
      },
      charter: {} as never,
      task: { kind: "missing" as const },
      root,
    };
    const deny: Rule = () => ({
      rule: "protected-paths",
      decision: "deny",
      message: wardenMessage("protected-paths", "blocked", "Stop"),
      replacement: null,
    });
    const ask: Rule = () => ({
      rule: "scope-guard",
      decision: "ask",
      message: wardenMessage("scope-guard", "ask", "Wait"),
      replacement: null,
    });
    const rewrite: Rule = () => ({
      rule: "command-guard",
      decision: "rewrite",
      message: wardenMessage("command-guard", "rewrite", "Run pnpm install"),
      replacement: "pnpm install",
    });
    const verdict = evaluateRules(ctx, {
      "worktree-guard": () => null,
      "protected-paths": deny,
      "secret-read-guard": () => null,
      "generated-files-guard": () => null,
      "command-guard": rewrite,
      "scope-guard": ask,
    });
    expect(verdict.rule).toBe("protected-paths");
    expect(verdict.decision).toBe("deny");
  });
});

describe("hook CLI", () => {
  it("returns exit 0 and empty stdout for a Claude allow", () => {
    const root = tempRepo();
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cliPath,
        "hook",
        "--tool",
        "claude",
        "--event",
        "PreToolUse",
      ],
      {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "wardens/src/cli.ts", content: "nope" },
          cwd: root,
        }),
      },
    );
    expect(result.status).toBe(0);
    expect(result.status).not.toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("permissionDecision");
  });
});
