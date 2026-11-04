import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapPayload,
  normalizeHook,
  parseNormalizedEvent,
  resolveInteractive,
} from "../src/event.ts";
import { resolveRepoPath } from "../src/paths.ts";
import { loadTask } from "../src/task.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

const env = {} as NodeJS.ProcessEnv;

describe("interactive", () => {
  it("is false unless the payload or PANOPTICON_INTERACTIVE says otherwise", () => {
    expect(resolveInteractive({}, env)).toBe(false);
    expect(resolveInteractive({}, { PANOPTICON_INTERACTIVE: "1" })).toBe(true);
    expect(resolveInteractive({}, { PANOPTICON_INTERACTIVE: "true" })).toBe(
      true,
    );
    expect(resolveInteractive({}, { PANOPTICON_INTERACTIVE: "0" })).toBe(false);
    expect(
      resolveInteractive(
        { interactive: false },
        { PANOPTICON_INTERACTIVE: "1" },
      ),
    ).toBe(false);
    expect(resolveInteractive({ interactive: true }, env)).toBe(true);
  });
});

describe("path resolution", () => {
  it("keeps a missing file inside the worktree and rejects a path outside it", () => {
    const root = tempRepo();
    writeRepoFile(root, "apps/web/app.tsx", "export {}\n");
    expect(resolveRepoPath("apps/web/app.tsx", root, root)).toEqual({
      ok: true,
      path: "apps/web/app.tsx",
    });
    expect(resolveRepoPath("wardens/new-file.ts", root, root)).toEqual({
      ok: true,
      path: "wardens/new-file.ts",
    });
    expect(resolveRepoPath("apps\\web\\app.tsx", root, root)).toEqual({
      ok: true,
      path: "apps/web/app.tsx",
    });
    expect(resolveRepoPath("/etc/passwd", root, root).ok).toBe(false);
    const outside = join(root, "..", "outside.txt");
    writeFileSync(outside, "x");
    mkdirSync(join(root, "apps"), { recursive: true });
    symlinkSync(outside, join(root, "apps", "leak"));
    expect(resolveRepoPath("apps/leak", root, root).ok).toBe(false);
  });
});

describe("task file", () => {
  it("is missing, valid, or invalid", () => {
    const root = tempRepo();
    expect(loadTask(root)).toEqual({ kind: "missing" });
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({
        issue: 6,
        allowed_paths: ["wardens/**"],
        branch: "feat/6-wardens-core-charter",
        slug: "wardens-core",
      }),
    );
    expect(loadTask(root)).toMatchObject({
      kind: "ok",
      issue: 6,
      allowed_paths: ["wardens/**"],
    });
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({ issue: 0, allowed_paths: [] }),
    );
    expect(loadTask(root)).toEqual({ kind: "invalid" });
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({ issue: 6, allowed_paths: ["!secret/**"] }),
    );
    expect(loadTask(root)).toEqual({ kind: "invalid" });
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({ issue: 6, allowed_paths: ["wardens/**"], extra: true }),
    );
    expect(loadTask(root)).toEqual({ kind: "invalid" });
  });
});

describe("mapping table", () => {
  const root = tempRepo();

  function normalize(
    tool: string,
    event: string,
    payload: Record<string, unknown>,
  ) {
    return normalizeHook({
      tool,
      event,
      payload: { cwd: root, ...payload },
      fallbackCwd: root,
      toplevel: root,
      env,
    });
  }

  it("maps every Claude and Cursor row", () => {
    const cases: Array<{
      tool: string;
      event: string;
      payload: Record<string, unknown>;
      action: string;
      path: string | null;
      command: string | null;
      mcp_server: string | null;
    }> = [
      {
        tool: "claude",
        event: "PreToolUse",
        payload: { tool_name: "Bash", tool_input: { command: "echo ok" } },
        action: "shell",
        path: null,
        command: "echo ok",
        mcp_server: null,
      },
      {
        tool: "claude",
        event: "PreToolUse",
        payload: {
          tool_name: "PowerShell",
          tool_input: { command: "Get-ChildItem" },
        },
        action: "shell",
        path: null,
        command: "Get-ChildItem",
        mcp_server: null,
      },
      {
        tool: "claude",
        event: "PreToolUse",
        payload: {
          tool_name: "Read",
          tool_input: { file_path: "apps/web/app.tsx" },
        },
        action: "read",
        path: "apps/web/app.tsx",
        command: null,
        mcp_server: null,
      },
      {
        tool: "claude",
        event: "PreToolUse",
        payload: {
          tool_name: "Edit",
          tool_input: { file_path: "docs/constitution.md" },
        },
        action: "edit",
        path: "docs/constitution.md",
        command: null,
        mcp_server: null,
      },
      {
        tool: "claude",
        event: "PreToolUse",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "wardens/src/cli.ts" },
        },
        action: "write",
        path: "wardens/src/cli.ts",
        command: null,
        mcp_server: null,
      },
      {
        tool: "claude",
        event: "PreToolUse",
        payload: {
          tool_name: "mcp__memory__create_entities",
          mcp_server: { name: "memory", source: "project" },
        },
        action: "mcp",
        path: null,
        command: null,
        mcp_server: "memory",
      },
      {
        tool: "cursor",
        event: "beforeShellExecution",
        payload: { command: "pnpm test" },
        action: "shell",
        path: null,
        command: "pnpm test",
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "beforeReadFile",
        payload: { file_path: "wardens/src/cli.ts", content: "SECRET" },
        action: "read",
        path: "wardens/src/cli.ts",
        command: null,
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "preToolUse",
        payload: { tool_name: "Shell", tool_input: { command: "npm install" } },
        action: "shell",
        path: null,
        command: "npm install",
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "preToolUse",
        payload: {
          tool_name: "Read",
          tool_input: { file_path: "apps/web/app.tsx" },
        },
        action: "read",
        path: "apps/web/app.tsx",
        command: null,
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "preToolUse",
        payload: { tool_name: "Write", path: "apps/web/app.tsx" },
        action: "write",
        path: "apps/web/app.tsx",
        command: null,
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "preToolUse",
        payload: { tool_name: "Delete", file_path: "wardens/src/cli.ts" },
        action: "delete",
        path: "wardens/src/cli.ts",
        command: null,
        mcp_server: null,
      },
      {
        tool: "cursor",
        event: "beforeMCPExecution",
        payload: { tool_name: "search", mcp_server_name: "linear" },
        action: "mcp",
        path: null,
        command: null,
        mcp_server: "linear",
      },
      {
        tool: "cursor",
        event: "preToolUse",
        payload: { tool_name: "MCP:linear_search" },
        action: "mcp",
        path: null,
        command: null,
        mcp_server: "MCP:linear_search",
      },
    ];

    for (const row of cases) {
      const mapped = mapPayload(row.tool, row.event, row.payload);
      expect(
        mapped.ok,
        `${row.tool} ${row.event} ${row.payload.tool_name ?? row.event}`,
      ).toBe(true);
      const normalized = normalize(row.tool, row.event, row.payload);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) {
        continue;
      }
      expect(normalized.event.action).toBe(row.action);
      expect(normalized.event.path).toBe(row.path);
      expect(normalized.event.command).toBe(row.command);
      expect(normalized.event.mcp_server).toBe(row.mcp_server);
    }
  });

  it("drops file contents and rejects an unmapped tool", () => {
    const normalized = normalize("cursor", "beforeReadFile", {
      file_path: "wardens/src/cli.ts",
      content: "SENTINEL_CONTENT",
      user_email: "person@example.com",
      session_id: "sess",
      model: "grok-4.7-high",
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(JSON.stringify(normalized.event)).not.toContain(
        "SENTINEL_CONTENT",
      );
      expect(JSON.stringify(normalized.event)).not.toContain(
        "person@example.com",
      );
      expect(normalized.event.model).toBe("grok-4.7-high");
      expect(normalized.event.session_id).toBe("sess");
    }
    expect(
      mapPayload("claude", "PreToolUse", { tool_name: "Grep", tool_input: {} })
        .ok,
    ).toBe(false);
    expect(normalize("claude", "PostToolUse", { tool_name: "Bash" }).ok).toBe(
      false,
    );
  });

  it("uses conversation_id and prefers a boolean interactive field", () => {
    const normalized = normalize("cursor", "beforeShellExecution", {
      command: "echo ok",
      conversation_id: "conv",
      interactive: false,
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.event.session_id).toBe("conv");
      expect(normalized.event.interactive).toBe(false);
      expect(normalized.event.agent).toBeNull();
    }
  });

  it("rejects a normalized event with extra keys", () => {
    expect(
      parseNormalizedEvent({ tool: "cursor", user_email: "a@b.c" }).ok,
    ).toBe(false);
  });
});
