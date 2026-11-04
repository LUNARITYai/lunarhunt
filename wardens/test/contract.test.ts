import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { normalizeHook } from "../src/event.ts";
import { gitToplevel } from "../src/git.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { tempRepo } from "./support.ts";

const fixturesRoot = join(import.meta.dirname, "fixtures");

type Expectation = {
  action: "shell" | "read" | "edit" | "write" | "delete" | "mcp";
  path: string | null;
  command: string | null;
  mcp_server: string | null;
  decision: "allow" | "deny" | "ask" | "rewrite";
  rule: string;
};

type Fixture = {
  _meta: {
    source: string;
    provisional: boolean;
    tool: string;
    event: string;
    expect: Expectation;
  };
  stdin: Record<string, unknown>;
};

const REQUIRED_ROWS: Array<[string, string, Expectation["action"]]> = [
  ["claude", "PreToolUse", "shell"],
  ["claude", "PreToolUse", "read"],
  ["claude", "PreToolUse", "edit"],
  ["claude", "PreToolUse", "write"],
  ["claude", "PreToolUse", "mcp"],
  ["cursor", "beforeShellExecution", "shell"],
  ["cursor", "beforeReadFile", "read"],
  ["cursor", "preToolUse", "shell"],
  ["cursor", "preToolUse", "read"],
  ["cursor", "preToolUse", "write"],
  ["cursor", "preToolUse", "delete"],
  ["cursor", "preToolUse", "mcp"],
  ["cursor", "beforeMCPExecution", "mcp"],
];

function load(
  dir: string,
): Array<{ name: string; raw: string; fixture: Fixture }> {
  return readdirSync(join(fixturesRoot, dir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(fixturesRoot, dir, name), "utf8");
      return {
        name: `${dir}/${name}`,
        raw,
        fixture: JSON.parse(raw) as Fixture,
      };
    });
}

function expand(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll("__WORKTREE__", root);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expand(item, root));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = expand(item, root);
    }
    return out;
  }
  return value;
}

function leakedStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => leakedStrings(item));
  }
  if (typeof value === "object" && value !== null) {
    const found: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (
        key === "content" ||
        key === "old_string" ||
        key === "new_string" ||
        key === "user_email"
      ) {
        found.push(...leakedStrings(item));
      }
    }
    return found;
  }
  return [];
}

const fixtures = [...load("claude"), ...load("cursor")];

describe("hook contract fixtures", () => {
  it("covers every mapping-table row and rejects a Cursor fixture marked as docs", () => {
    const covered = new Set<string>();
    for (const { name, raw, fixture } of fixtures) {
      expect(raw, name).not.toContain("/Users/");
      expect(raw, name).not.toContain("@");
      expect(raw, name).not.toContain("/tmp/wardens-cursor-record");
      const meta = fixture._meta;
      if (name.startsWith("cursor/")) {
        expect(meta.source, name).toBe("recorded-cursor-session");
        expect(meta.provisional, name).toBe(false);
      } else {
        expect(meta.source, name).toBe("claude-docs");
        expect(meta.provisional, name).toBe(true);
      }
      covered.add(`${meta.tool}|${meta.event}|${meta.expect.action}`);
    }
    for (const [tool, event, action] of REQUIRED_ROWS) {
      expect(
        covered.has(`${tool}|${event}|${action}`),
        `${tool} ${event} ${action}`,
      ).toBe(true);
    }
  });

  it.each(fixtures.map((item) => [item.name, item] as const))(
    "%s maps and matches the Charter verdict",
    (_name, item) => {
      const root = tempRepo();
      const toplevel = gitToplevel(root);
      expect(toplevel).toBeTruthy();
      const stdin = expand(item.fixture.stdin, root) as Record<string, unknown>;
      const meta = item.fixture._meta;
      const normalized = normalizeHook({
        tool: meta.tool,
        event: meta.event,
        payload: stdin,
        fallbackCwd: root,
        toplevel: toplevel ?? root,
        env: {},
      });
      expect(normalized.ok, item.name).toBe(true);
      if (!normalized.ok) {
        return;
      }
      expect(normalized.event).toMatchObject({
        action: meta.expect.action,
        path: meta.expect.path,
        command: meta.expect.command,
        mcp_server: meta.expect.mcp_server,
      });

      const result = runHook(meta.tool, meta.event, JSON.stringify(stdin), {
        cwd: () => root,
        env: {},
      });
      expect(result.exitCode).toBe(0);
      const logPath = join(root, ".panopticon/wardens.log.jsonl");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const line = lines[0] ?? "";
      expect(line).not.toContain(root);
      for (const secret of leakedStrings(stdin)) {
        const flat = secret.replaceAll(/\s+/g, " ").trim();
        if (flat.length > 0) {
          expect(line, item.name).not.toContain(flat);
        }
      }
      const parsed = JSON.parse(line) as {
        action: string;
        path: string | null;
        command: string | null;
        mcp_server: string | null;
        decision: string;
        rule: string;
        message: string | null;
      };
      expect(parsed).toMatchObject({
        action: meta.expect.action,
        path: meta.expect.path,
        command: meta.expect.command,
        mcp_server: meta.expect.mcp_server,
        decision: meta.expect.decision,
        rule: meta.expect.rule,
      });
      if (parsed.decision !== "allow") {
        expect(parsed.message).toMatch(MESSAGE_PATTERN);
      }
    },
  );
});
