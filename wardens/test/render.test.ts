import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/event.ts";
import { wardenMessage } from "../src/messages.ts";
import { finalizeVerdict, renderHook } from "../src/render.ts";
import type { Verdict } from "../src/verdict.ts";

const rewriteMessage = wardenMessage(
  "command-guard",
  "npm install is rewritten to pnpm install",
  "Run pnpm install",
);

function event(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    tool: "cursor",
    event: "preToolUse",
    action: "edit",
    path: "docs/constitution.md",
    command: null,
    mcp_server: null,
    session_id: null,
    agent: null,
    model: null,
    interactive: true,
    cwd: "/work",
    ...partial,
  };
}

describe("hook rendering", () => {
  it("emits empty stdout for a Claude allow and never permissionDecision allow", () => {
    const stdout = renderHook({
      tool: "claude",
      event: "PreToolUse",
      verdict: {
        rule: "none",
        decision: "allow",
        message: null,
        replacement: null,
        rendered: "allow",
      },
      raw: {},
    });
    expect(stdout).toBe("");
    expect(stdout).not.toContain("permissionDecision");
  });

  it("emits Claude deny and ask JSON", () => {
    const deny = renderHook({
      tool: "claude",
      event: "PreToolUse",
      verdict: {
        rule: "engine",
        decision: "deny",
        message: wardenMessage(
          "engine",
          "the hook event is not mapped",
          "Label the issue needs:human",
        ),
        replacement: null,
        rendered: "deny",
      },
      raw: {},
    });
    expect(JSON.parse(deny)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const ask = renderHook({
      tool: "claude",
      event: "PreToolUse",
      verdict: {
        rule: "protected-paths",
        decision: "ask",
        message: wardenMessage(
          "protected-paths",
          "docs/constitution.md requires approval",
          "Ask Krzysztof to approve this edit in the session",
        ),
        replacement: null,
        rendered: "ask",
      },
      raw: {},
    });
    expect(JSON.parse(ask)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
  });

  it("rewrites npm install without a Claude permissionDecision", () => {
    const stdout = renderHook({
      tool: "claude",
      event: "PreToolUse",
      verdict: {
        rule: "command-guard",
        decision: "rewrite",
        message: rewriteMessage,
        replacement: "pnpm install",
        rendered: "rewrite",
      },
      raw: { tool_input: { command: "npm install", description: "deps" } },
    });
    const body = JSON.parse(stdout) as {
      hookSpecificOutput: {
        permissionDecision?: string;
        updatedInput: { command: string };
      };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(body.hookSpecificOutput.updatedInput.command).toBe("pnpm install");
    expect(body.hookSpecificOutput.updatedInput).toMatchObject({
      description: "deps",
    });
  });

  it("renders a Cursor preToolUse ask as deny while the decision stays ask", () => {
    const ask: Verdict = {
      rule: "protected-paths",
      decision: "ask",
      message: wardenMessage(
        "protected-paths",
        "docs/constitution.md requires approval",
        "Ask Krzysztof to approve this edit in the session",
      ),
      replacement: null,
      rendered: "ask",
    };
    const finalized = finalizeVerdict(
      ask,
      event({ tool: "cursor", event: "preToolUse" }),
    );
    expect(finalized.decision).toBe("ask");
    expect(finalized.rendered).toBe("deny");
    expect(finalized.message).toBe(
      "Blocked by Warden protected-paths: docs/constitution.md requires ask and this hook cannot prompt. Label the issue needs:human.",
    );
    const stdout = renderHook({
      tool: "cursor",
      event: "preToolUse",
      verdict: finalized,
      raw: {},
    });
    expect(JSON.parse(stdout)).toMatchObject({ permission: "deny" });
  });

  it("denies a beforeShellExecution rewrite because that hook cannot update input", () => {
    const stdout = renderHook({
      tool: "cursor",
      event: "beforeShellExecution",
      verdict: {
        rule: "command-guard",
        decision: "rewrite",
        message: rewriteMessage,
        replacement: "pnpm install",
        rendered: "rewrite",
      },
      raw: { command: "npm install" },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      permission: "deny",
      agent_message: rewriteMessage,
    });
  });
});
