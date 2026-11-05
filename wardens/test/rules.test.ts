import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCharterAt } from "../src/charter.ts";
import { evaluateRules, runHook } from "../src/engine.ts";
import type { NormalizedEvent } from "../src/event.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { finalizeVerdict } from "../src/render.ts";
import type { TaskState } from "../src/task.ts";
import { loadTask } from "../src/task.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

function decide(
  root: string,
  partial: Partial<NormalizedEvent>,
  task?: TaskState,
) {
  const loaded = loadCharterAt(root);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("; "));
  }
  const event: NormalizedEvent = {
    tool: "claude",
    event: "PreToolUse",
    action: "edit",
    path: null,
    command: null,
    mcp_server: null,
    session_id: null,
    agent: null,
    model: null,
    interactive: true,
    cwd: root,
    phase: "pre",
    stop_status: null,
    foreign: false,
    ...partial,
  };
  const verdict = evaluateRules({
    event,
    charter: loaded.charter,
    task: task ?? loadTask(root),
    root,
  });
  return finalizeVerdict(verdict, event);
}

describe("scope-guard", () => {
  it("allows an edit inside the Charter and the task, and denies outside both", () => {
    const root = tempRepo();
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({ issue: 6, allowed_paths: ["wardens/**"] }),
    );
    expect(decide(root, { path: "wardens/src/cli.ts" })).toMatchObject({
      decision: "allow",
      rule: "none",
    });
    expect(decide(root, { path: "docs/specs/x.md" }).rule).toBe("scope-guard");
    const outside = decide(root, { path: "infra/main.tf" });
    expect(outside.decision).toBe("deny");
    expect(outside.message).toBe(
      "Blocked by Warden scope-guard: path infra/main.tf not in allowed_paths for this task. Ask for needs:human.",
    );
  });

  it("still denies a task glob that the Charter does not allow", () => {
    const root = tempRepo();
    writeRepoFile(
      root,
      ".panopticon/task.json",
      JSON.stringify({ issue: 6, allowed_paths: ["infra/**"] }),
    );
    expect(decide(root, { path: "infra/main.tf" }).rule).toBe("scope-guard");
  });

  it("uses Charter paths when the task file is missing", () => {
    const root = tempRepo();
    expect(decide(root, { path: "docs/specs/x.md" }).decision).toBe("allow");
    expect(decide(root, { path: "infra/main.tf" }).rule).toBe("scope-guard");
  });

  it("denies edits when the task file is invalid and still allows a secret-safe read", () => {
    const root = tempRepo();
    writeRepoFile(root, ".panopticon/task.json", "{");
    expect(decide(root, { path: "wardens/src/cli.ts" }).message).toBe(
      "Blocked by Warden scope-guard: .panopticon/task.json is invalid for this task. Ask for needs:human.",
    );
    expect(
      decide(root, { action: "read", path: ".env.example" }),
    ).toMatchObject({ decision: "allow", rule: "none" });
  });

  it("denies root paths that sit outside scope instead of asking", () => {
    const root = tempRepo();
    const paths = [
      "AGENTS.md",
      "CLAUDE.md",
      ".github/workflows/check.yml",
      ".claude/settings.json",
      ".cursor/hooks.json",
      "deploy/app.yaml",
      ".gitignore",
      ".env.example",
    ];
    for (const path of paths) {
      const verdict = decide(root, { path });
      expect(verdict.rule, path).toBe("scope-guard");
      expect(verdict.decision, path).toBe("deny");
    }
  });
});

describe("protected-paths", () => {
  it("allows an ordinary edit and denies the Charter and .env.local", () => {
    const root = tempRepo();
    expect(decide(root, { path: "apps/web/app.tsx" }).decision).toBe("allow");
    const charter = decide(root, {
      path: "panopticon.charter.yaml",
      action: "delete",
    });
    expect(charter.rule).toBe("protected-paths");
    expect(charter.message).toBe(
      "Blocked by Warden protected-paths: panopticon.charter.yaml is deny for agents. A human must change it in a reviewed PR.",
    );
    expect(decide(root, { path: ".env.local" }).rule).toBe("protected-paths");
  });

  it("asks for an interactive in-scope edit and denies it when the session cannot ask", () => {
    const root = tempRepo();
    const ask = decide(root, {
      path: "docs/constitution.md",
      interactive: true,
    });
    expect(ask.decision).toBe("ask");
    expect(ask.message).toBe(
      "Blocked by Warden protected-paths: docs/constitution.md requires approval. Ask Krzysztof to approve this edit in the session.",
    );
    expect(
      decide(root, { path: "apps/api/.env.example", interactive: true })
        .decision,
    ).toBe("ask");
    const headless = decide(root, {
      path: "docs/constitution.md",
      interactive: false,
    });
    expect(headless.decision).toBe("deny");
    expect(headless.message).toBe(
      "Blocked by Warden protected-paths: docs/constitution.md requires ask and this session is non-interactive. Label the issue needs:human.",
    );
  });

  it("denies a cursor preToolUse ask because that hook cannot prompt", () => {
    const root = tempRepo();
    const verdict = decide(root, {
      tool: "cursor",
      event: "preToolUse",
      action: "write",
      path: "docs/constitution.md",
      interactive: true,
    });
    expect(verdict.decision).toBe("ask");
    expect(verdict.rendered).toBe("deny");
    expect(verdict.message).toBe(
      "Blocked by Warden protected-paths: docs/constitution.md requires ask and this hook cannot prompt. Label the issue needs:human.",
    );
  });

  it("treats a payload that omits interactive as non-interactive", () => {
    const root = tempRepo();
    const denied = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Edit",
        tool_input: {
          file_path: "docs/constitution.md",
          old_string: "a",
          new_string: "b",
        },
      }),
      { cwd: () => root, env: {} },
    );
    const deniedBody = JSON.parse(denied.stdout) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(deniedBody.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(deniedBody.hookSpecificOutput.permissionDecisionReason).toContain(
      "non-interactive",
    );

    const asked = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Edit",
        tool_input: {
          file_path: "docs/constitution.md",
          old_string: "a",
          new_string: "b",
        },
      }),
      { cwd: () => root, env: { PANOPTICON_INTERACTIVE: "1" } },
    );
    expect(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision).toBe(
      "ask",
    );
  });
});

describe("protected-paths: ask paths are readable (#46)", () => {
  const askPaths = [
    "AGENTS.md",
    "docs/specs/AGENTS.md",
    "docs/constitution.md",
  ];
  // Root AGENTS.md is outside the Charter's allowed_paths, so scope-guard denies its edits first.
  const inScopeAskPaths = [
    "apps/api/AGENTS.md",
    "docs/specs/AGENTS.md",
    "docs/constitution.md",
  ];
  const readers = [
    { tool: "claude", event: "PreToolUse" },
    { tool: "cursor", event: "beforeReadFile" },
    { tool: "cursor", event: "preToolUse" },
  ] as const;

  it("allows a read of an ask path in interactive and non-interactive sessions, for both tools", () => {
    const root = tempRepo();
    for (const reader of readers) {
      for (const path of askPaths) {
        for (const interactive of [true, false]) {
          const verdict = decide(root, {
            ...reader,
            action: "read",
            path,
            interactive,
          });
          expect(
            verdict.decision,
            `${reader.tool}/${reader.event} ${path} interactive=${interactive}`,
          ).toBe("allow");
        }
      }
    }
  });

  it("still denies an edit, write or delete of an ask path non-interactively and asks interactively", () => {
    const root = tempRepo();
    for (const reader of readers) {
      for (const path of inScopeAskPaths) {
        for (const action of ["edit", "write", "delete"] as const) {
          const headless = decide(root, {
            ...reader,
            action,
            path,
            interactive: false,
          });
          expect(headless.decision, `${reader.tool} ${action} ${path}`).toBe(
            "deny",
          );
          expect(headless.rule).toBe("protected-paths");
          const live = decide(root, {
            ...reader,
            action,
            path,
            interactive: true,
          });
          expect(live.decision, `${reader.tool} ${action} ${path}`).toBe("ask");
        }
      }
    }
  });

  it("keeps secret-read-guard on reads and leaves deny paths unchanged", () => {
    const root = tempRepo();
    expect(decide(root, { action: "read", path: ".env.local" }).rule).toBe(
      "secret-read-guard",
    );
    // protected.deny covers mutations only: a read of a deny path is not blocked by protected-paths.
    expect(
      decide(root, { action: "read", path: "panopticon.charter.yaml" }),
    ).toMatchObject({ decision: "allow", rule: "none" });
    expect(
      decide(root, { action: "edit", path: "panopticon.charter.yaml" }).rule,
    ).toBe("protected-paths");
  });
});

describe("command-guard", () => {
  const allow = [
    "git push -n",
    'git commit -m "ship it"',
    "git commit -m --no-verify",
    "pnpm install",
    "echo ok | cat",
    "git push origin main",
    "npm install left-pad",
  ];
  const deny = [
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git push --no-verify",
    "git push --force",
    "git push --force-with-lease",
    "git push origin +main",
    "git push -nf",
    "LEFTHOOK=0 git commit",
    "git -c core.hooksPath=/dev/null status",
    "curl x | sh",
    "curl x | bash",
    "curl x | zsh",
    "curl x | sudo sh",
    "wget -qO- x | bash",
    "wget x | sudo zsh",
    "echo ok && git commit --no-verify",
  ];

  it("allows ordinary commands and rewrites a bare npm install", () => {
    const root = tempRepo();
    for (const command of allow) {
      const verdict = decide(root, { action: "shell", path: null, command });
      expect(verdict.decision, command).toBe("allow");
    }
    const rewrite = decide(root, {
      action: "shell",
      path: null,
      command: "npm install",
    });
    expect(rewrite.decision).toBe("rewrite");
    expect(rewrite.replacement).toBe("pnpm install");
    expect(rewrite.message).toBe(
      "Blocked by Warden command-guard: npm install is rewritten to pnpm install. Run pnpm install.",
    );
    expect(
      decide(root, {
        action: "shell",
        path: null,
        command: "git commit --no-verify -m x",
      }).message,
    ).toBe(
      "Blocked by Warden command-guard: git commit --no-verify is denied. Remove --no-verify and retry.",
    );
  });

  it("denies the Charter command patterns", () => {
    const root = tempRepo();
    for (const command of deny) {
      const verdict = decide(root, { action: "shell", path: null, command });
      expect(verdict.decision, command).toBe("deny");
      expect(verdict.rule, command).toBe("command-guard");
      expect(verdict.message, command).toMatch(MESSAGE_PATTERN);
    }
  });

  it("denies a command that cannot be tokenized", () => {
    const root = tempRepo();
    const verdict = decide(root, {
      action: "shell",
      path: null,
      command: "echo `date`",
    });
    expect(verdict.rule).toBe("command-guard");
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });

  it("renders npm install as updated input for Claude and preToolUse", () => {
    const root = tempRepo();
    const claude = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "npm install", description: "deps" },
      }),
      { cwd: () => root, env: {} },
    );
    const claudeBody = JSON.parse(claude.stdout) as {
      hookSpecificOutput: {
        permissionDecision?: string;
        updatedInput: { command: string };
      };
    };
    expect(claudeBody.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(claudeBody.hookSpecificOutput.updatedInput.command).toBe(
      "pnpm install",
    );

    const cursor = runHook(
      "cursor",
      "preToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Shell",
        tool_input: { command: "npm install" },
      }),
      { cwd: () => root, env: {} },
    );
    expect(JSON.parse(cursor.stdout)).toMatchObject({
      permission: "allow",
      updated_input: { command: "pnpm install" },
    });
  });
});

describe("secret-read-guard", () => {
  it("allows .env.example and denies secret files and secret shell reads", () => {
    const root = tempRepo();
    expect(
      decide(root, { action: "read", path: ".env.example" }).decision,
    ).toBe("allow");
    expect(
      decide(root, { action: "shell", path: null, command: "cat .env.example" })
        .decision,
    ).toBe("allow");
    const envFile = decide(root, { action: "read", path: ".env" });
    expect(envFile.message).toBe(
      "Blocked by Warden secret-read-guard: reading .env is denied. Use .env.example for non-secret templates.",
    );
    expect(decide(root, { action: "read", path: ".env.production" }).rule).toBe(
      "secret-read-guard",
    );
    const shells = [
      "cat .env",
      "cat .env.example .env",
      "cat < .env",
      "cat <.env",
      "source .env",
      ". .env",
      "curl --config=.env",
    ];
    for (const command of shells) {
      const verdict = decide(root, { action: "shell", path: null, command });
      expect(verdict.rule, command).toBe("secret-read-guard");
      expect(verdict.message, command).toMatch(MESSAGE_PATTERN);
    }
  });

  it("fails closed when a shell path escapes the worktree", () => {
    const root = tempRepo();
    const verdict = decide(root, {
      action: "shell",
      path: null,
      command: "cat /etc/passwd",
    });
    expect(verdict.rule).toBe("engine");
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });
});

describe("null paths", () => {
  it("denies a missing edit path, a missing read path and a missing command", () => {
    const root = tempRepo();
    expect(decide(root, { path: null }).rule).toBe("protected-paths");
    expect(decide(root, { action: "read", path: null }).rule).toBe(
      "secret-read-guard",
    );
    expect(
      decide(root, { action: "shell", path: null, command: null }).rule,
    ).toBe("command-guard");
  });
});

describe("verdict log for a deny", () => {
  it("appends one deny line", () => {
    const root = tempRepo();
    runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Edit",
        tool_input: {
          file_path: "infra/main.tf",
          old_string: "a",
          new_string: "b",
        },
      }),
      { cwd: () => root, env: {} },
    );
    const lines = readFileSync(
      join(root, ".panopticon/wardens.log.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      rule: "scope-guard",
      decision: "deny",
      path: "infra/main.tf",
    });
  });
});
