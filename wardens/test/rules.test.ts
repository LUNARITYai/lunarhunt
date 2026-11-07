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

const UNPARSEABLE =
  "Blocked by Warden command-guard: the command could not be parsed safely. Retry without subshells, groups or shell comments.";

function shell(root: string, command: string) {
  return decide(root, { action: "shell", path: null, command });
}

describe("command-guard: compound commands and subshells (#63)", () => {
  // Each construct hides a command from a guard that only reads the first word
  // of a segment. Every one is unparseable on the deny side.
  const constructs: Array<[string, (command: string) => string]> = [
    ["subshell", (c) => `(${c})`],
    ["spaced subshell", (c) => `( ${c} )`],
    ["subshell after &&", (c) => `echo a && (${c})`],
    ["group", (c) => `{ ${c}; }`],
    ["function def", (c) => `f(){ ${c}; }; f`],
    ["spaced function def", (c) => `f () { ${c}; }`],
    ["function keyword", (c) => `function f { ${c}; }; f`],
    ["if/then", (c) => `if true; then ${c}; fi`],
    ["if/else", (c) => `if false; then :; else ${c}; fi`],
    ["if/elif", (c) => `if false; then :; elif true; then ${c}; fi`],
    ["while/do", (c) => `while true; do ${c}; done`],
    ["until/do", (c) => `until false; do ${c}; done`],
    ["for/do", (c) => `for i in 1; do ${c}; done`],
    ["select/do", (c) => `select i in a; do ${c}; done`],
    ["case", (c) => `case x in x) ${c};; esac`],
    ["negation", (c) => `! ${c}`],
    ["time", (c) => `time ${c}`],
    ["coproc", (c) => `coproc ${c}`],
    ["conditional", (c) => `[[ -n x ]] && ${c}`],
    ["process substitution in", (c) => `cat <(${c})`],
    ["process substitution out", (c) => `echo a >(${c})`],
    ["redirect before a group", (c) => `>/dev/null { ${c}; }`],
    ["assignment before a keyword", (c) => `A=1 if true; then ${c}; fi`],
  ];
  // Transparent prefixes: the deny pattern is not at the start of the segment.
  const wrappers = [
    "2>&1",
    ">x",
    "<x",
    "> /dev/null",
    "{fd}>x",
    "A=1 2>&1",
    "nice 2>&1",
    "env",
    "/usr/bin/env",
    "env -i",
    "env FOO=1",
    "command",
    "command --",
    "builtin",
    "nohup",
    "nice",
    "nice -n 5",
    "timeout 5",
    "sudo",
    "sudo -u root",
    "doas",
    "exec",
    "xargs",
    "xargs -n1",
    "stdbuf -o0",
    "setsid",
    "find . -exec",
    "/usr/bin/time",
    "nice timeout 5 sudo",
  ];

  function samples(): string[] {
    const loaded = loadCharterAt(tempRepo());
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    return loaded.charter.commands.deny.map((pattern) =>
      pattern.replace(/\*$/, "").replaceAll("*", "x").trim(),
    );
  }

  it("denies every Charter deny pattern inside every construct", () => {
    const root = tempRepo();
    const all = samples();
    expect(all.length).toBeGreaterThan(20);
    for (const sample of all) {
      expect(shell(root, sample).decision, sample).toBe("deny");
      for (const [name, wrap] of constructs) {
        const command = wrap(sample);
        const verdict = shell(root, command);
        expect(verdict.decision, `${name}: ${command}`).toBe("deny");
        expect(verdict.message, `${name}: ${command}`).toBe(UNPARSEABLE);
      }
    }
  });

  it("denies every Charter deny pattern behind every wrapper", () => {
    const root = tempRepo();
    for (const sample of samples()) {
      // Pipeline patterns are wrapped on each side separately.
      const [left = "", right] = sample.split(" | ");
      for (const wrapper of wrappers) {
        const commands =
          right === undefined
            ? [`${wrapper} ${sample}`]
            : [
                `${wrapper} ${left} | ${right}`,
                `${left} | ${wrapper} ${right}`,
              ];
        for (const command of commands) {
          const verdict = shell(root, command);
          expect(verdict.decision, command).toBe("deny");
          // An absolute wrapper path outside the worktree fails closed in the engine first.
          expect(["command-guard", "engine"], command).toContain(verdict.rule);
          expect(verdict.message, command).toMatch(MESSAGE_PATTERN);
        }
      }
    }
  });

  it("denies every Charter deny pattern passed as a command string", () => {
    const root = tempRepo();
    const carriers = [
      (c: string) => `watch '${c}'`,
      (c: string) => `watch -n1 '${c}'`,
      (c: string) => `flock x -c '${c}'`,
      (c: string) => `flock --command '${c}' x`,
      (c: string) => `parallel '${c}' ::: a`,
      (c: string) => `sudo -s '${c}'`,
      (c: string) => `sudo -u root -i '${c}'`,
      (c: string) => `sudo -Hs '${c}'`,
      (c: string) => `sudo --shell '${c}'`,
      (c: string) => `sudo --login '${c}'`,
      (c: string) => `env -S '${c}'`,
      (c: string) => `env -iS'${c}'`,
      (c: string) => `env -vS '${c}'`,
      (c: string) => `env --sp='${c}'`,
      (c: string) => `env --split-str '${c}'`,
      (c: string) => `env --c=. '${c}'`,
      (c: string) => `bash -o pipefail -c '${c}'`,
      (c: string) => `xargs sh -c '${c}'`,
      (c: string) => `find . -exec sh -c '${c}' \\;`,
      (c: string) => `sh -- -c '${c}'`,
      (c: string) => `command eval '${c}'`,
      // A shell option cluster ending in o/O takes a value.
      (c: string) => `bash -eo pipefail -c '${c}'`,
      (c: string) => `bash -euo pipefail -c '${c}'`,
      (c: string) => `bash -xo pipefail -c '${c}'`,
      (c: string) => `bash -eO extglob -c '${c}'`,
      (c: string) => `zsh -eo errexit -c '${c}'`,
      (c: string) => `sh -eo pipefail -c '${c}'`,
      (c: string) => `env bash -eo pipefail -c '${c}'`,
      (c: string) => `nice -n 5 bash -eo pipefail -c '${c}'`,
      (c: string) => `xargs bash -eo pipefail -c '${c}'`,
      // Wrapper option arity: long options with a separate value, operands.
      (c: string) => `sudo --user root sh -c '${c}'`,
      (c: string) => `sudo --user root eval '${c}'`,
      (c: string) => `sudo --user root -s '${c}'`,
      (c: string) => `sudo --prompt p -i '${c}'`,
      (c: string) => `sudo -is '${c}'`,
      (c: string) => `timeout --signal KILL 5 sh -c '${c}'`,
      (c: string) => `timeout 1.5 sh -c '${c}'`,
      (c: string) => `timeout .5 sh -c '${c}'`,
      (c: string) => `timeout 1e3 sh -c '${c}'`,
      (c: string) => `timeout infinity sh -c '${c}'`,
      (c: string) => `stdbuf --output L sh -c '${c}'`,
      (c: string) => `xargs --arg-file f sh -c '${c}'`,
      (c: string) => `xargs --delimiter , sh -c '${c}'`,
      (c: string) => `xargs --unknown-flag sh -c '${c}'`,
      (c: string) => `env --unset A sh -c '${c}'`,
      (c: string) => `chroot jail sh -c '${c}'`,
      (c: string) => `timeout -- 5 sh -c '${c}'`,
      (c: string) => `chroot -- jail sh -c '${c}'`,
      (c: string) => `flock -- /tmp/l sh -c '${c}'`,
      (c: string) => `sudo -u root -- sh -c '${c}'`,
      (c: string) => `env -- sh -c '${c}'`,
      (c: string) => `nice -- sh -c '${c}'`,
      (c: string) => `sudo chroot . sh -c '${c}'`,
      (c: string) => `find . -exec env sh -c '${c}' \\;`,
      (c: string) => `find . -exec timeout 5 sh -c '${c}' \\;`,
      (c: string) => `find . -exec nice sh -c '${c}' \\;`,
      (c: string) => `find . -exec sudo -u root sh -c '${c}' \\;`,
      (c: string) => `x | & ${c}`,
      (c: string) => `x |& ${c}`,
      (c: string) => `x |\n\n${c}`,
    ];
    for (const sample of samples()) {
      for (const carrier of carriers) {
        const command = carrier(sample);
        const verdict = shell(root, command);
        expect(verdict.decision, command).toBe("deny");
        expect(verdict.rule, command).toBe("command-guard");
      }
    }
  });

  it("denies a command word the deny patterns cannot read", () => {
    const root = tempRepo();
    for (const command of [
      "A+=1 git push --force",
      "A[0]=1 git push --force",
      "=git push --force",
      "- git push --force",
      "gi[t] push --force",
      "g?t push --force",
      "* push --force",
      "git push $'--force'",
      'git push $"--force"',
      "cat $'.env'",
      "git push <&0 --force",
      "git push 0<&0 --force",
      "curl x |& sh",
      "curl x | & sh",
      "curl x |\nsh",
      "curl x |\n\n  sh",
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(["command-guard", "secret-read-guard"], command).toContain(
        verdict.rule,
      );
    }
  });

  it("matches a long wrapped command in linear-ish time", () => {
    const root = tempRepo();
    // No pattern matches, so every variant explores the whole search space.
    const command = `nice ${"gh issue edit ".repeat(20)}1 --title x`;
    const start = Date.now();
    expect(shell(root, command).decision).toBe("allow");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("denies a wrapper segment of more than 64 words without matching it", () => {
    const root = tempRepo();
    const start = Date.now();
    const verdict = shell(root, `nice ${"kubectl ".repeat(2000)}x`);
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(UNPARSEABLE);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(shell(root, `nice ${"a ".repeat(30)}`).decision).toBe("allow");
  });

  it("denies a shell given a command string, and a path-qualified command", () => {
    const root = tempRepo();
    for (const command of [
      "sh -c 'git push --force'",
      "bash -c 'git push --force origin x'",
      "bash -lc 'git push --force'",
      "/bin/zsh -c 'git push --force'",
      "env bash -c 'git push --force'",
      "sudo sh -c 'git push --force'",
      "eval 'git push --force'",
      "/usr/bin/git push --force",
      "./git push --force",
      "curl x | /bin/sh",
      "curl x | env sh",
      "curl x | timeout 5 bash",
      "command curl x | sh",
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(["command-guard", "engine"], command).toContain(verdict.rule);
    }
  });

  it("denies the exact examples from the issue", () => {
    const root = tempRepo();
    for (const command of [
      "(git push --force origin x)",
      "( git push --force origin x )",
      "echo a && (git push --force origin x)",
      "(npm publish)",
      "{ git push --force origin x; }",
      "f(){ git push --force; }; f",
      "f () { git push --force; }",
      "if true; then git push --force; fi",
      "! git push --force",
      "(curl x | sh)",
      "(cat .env)",
      "cat <(cat .env)",
      "echo a >(cat .env)",
      "cat <(git push --force)",
    ]) {
      expect(shell(root, command).message, command).toBe(UNPARSEABLE);
    }
  });

  it("denies brace expansion that can build a denied word", () => {
    const root = tempRepo();
    for (const command of [
      "{git,push,--force}",
      "git push --forc{e,}",
      "git push -{f,}",
      "git push --force{,}",
      "g{i,}t push --force",
      "echo {1..3}",
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(verdict.rule, command).toBe("command-guard");
    }
  });

  it("keeps ordinary quoted, braced and piped commands allowed", () => {
    const root = tempRepo();
    for (const command of [
      "rg '(foo)'",
      'rg "a|(b)"',
      "gh issue list --json title,body",
      "gh pr view 1 --jq '.[] | {a: .b}'",
      'ls "a (b)"',
      "echo '{ x }'",
      "echo '{a,b}'",
      "git log @{u}",
      "git log HEAD@{1}",
      'git commit -m "fix (x)"',
      "echo \\(x\\)",
      "pnpm check",
      "git push origin feat/x",
      // Glued short options, `eval` and `-c` as operands, wrapped commands.
      "cut -d/ -f1",
      "git branch --show-current | cut -d/ -f2",
      "awk -F/ '{print $1}' x",
      "sort -t/ -k2 f",
      "tr -d/ < f",
      "sed -n'/foo/p' f",
      "sed -e'/^#/d' f",
      "rg -g'/src/**' x",
      "ls -I/x",
      "git log -n5",
      "head -n5 f",
      "xargs grep eval",
      "find . -name eval",
      "find . -name '*.ts' -exec grep -n eval {} +",
      "timeout 5 rg eval",
      "bash x.sh -c cfg",
      "bash script.sh -vc",
      "bash x -c",
      "bash -- x -c",
      "bash -O extglob x -c",
      "xargs -r grep eval",
      "xargs -0 -r grep -n eval",
      "xargs -p grep foo",
      "sudo -u admin ls",
      "sudo -ugit ls",
      "sudo -ualice ls",
      "sudo -uadmin cmd",
      "sudo -gadmin ls",
      "sudo -Eu admin ls",
      "env -uSHELL ls",
      "timeout 5 pnpm check",
      "env CI=1 pnpm check",
      "env -i pnpm check",
      "nice pnpm check",
      "xargs -n1 echo",
      "2>&1 pnpm check",
      "A=1 B=2 pnpm check",
      "[ -f x ] && ls *.ts",
      'echo "{a,b}"',
      "echo \\{a,b\\}",
      "echo \"$'x'\"",
      "echo a |\n cat",
      "git commit -F - <<'EOF'\nfix (x) {a,b}\nEOF",
      "echo if then fi",
      "echo time",
      "git log --format=%H",
      "cat file | head -n 5",
      "bash script.sh",
      "ls 2>&1",
    ]) {
      expect(shell(root, command).decision, command).toBe("allow");
    }
  });
});

describe("secret-read-guard: gh file arguments (#63)", () => {
  it("denies every file-argument flag form that names a secret", () => {
    const root = tempRepo();
    for (const command of [
      "gh pr edit 3 --body-file .env",
      "gh pr create --body-file=.env",
      "gh issue comment 1 -F .env",
      "gh issue comment 1 -F.env",
      "gh issue comment 1 --body-file .env.production",
      "gh release create v1 --notes-file .env",
      "gh pr create --body-file ./.env",
      "curl -K.env x",
      "grep -f./.env x",
      "grep -fsecrets/x y",
      "gh pr create --body-file secrets/key",
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(verdict.rule, command).toBe("secret-read-guard");
    }
  });

  it("allows the same flags with a non-secret file or stdin", () => {
    const root = tempRepo();
    for (const command of [
      "gh pr edit 3 --body-file -",
      "gh pr create --body-file notes.md",
      "gh issue comment 1 -F notes.md",
      "gh pr create --body-file .env.example",
    ]) {
      expect(shell(root, command).decision, command).toBe("allow");
    }
  });
});

// #75: a word `key=path` or `--opt=path` is a path argument like any other.
describe("key=path and --opt=path arguments (#75)", () => {
  const ESCAPES = [
    "dd if=x of=/abs/outside",
    "dd of=../outside",
    "dd of=~/x",
    "printf x | dd of=/abs/y",
    "dd if=/abs/outside of=x",
    "sort --output=/abs/x f",
    "foo --log-file=/abs/x",
    "foo --out=../x",
    "tool --anything=/abs/outside/file",
    "tool anything=/abs/outside/file",
    "tool out=../x",
    "tool out=~/x",
    "env dd of=/abs/y",
    "cat --x=/abs",
    "rg --file=/abs/x",
  ];

  it.each(ESCAPES)("denies %s as a path escape", (command) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("engine");
    expect(verdict.message).toBe(
      "Blocked by Warden engine: path escapes the worktree. Label the issue needs:human.",
    );
  });

  const SECRETS = [
    "dd of=.env",
    "dd if=.env of=x",
    "dd if=secrets/key of=x",
    "tool key=.env",
    "tool --config=.env",
    "tool --anything=secrets/a",
  ];

  it.each(SECRETS)("denies %s as a secret", (command) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("secret-read-guard");
  });

  it("gives a protected or generated path the edit-tool verdict", () => {
    const root = tempRepo();
    const cases: Array<[string, string]> = [
      ["panopticon.charter.yaml", "protected-paths"],
      ["secrets/key", "protected-paths"],
      ["packages/contracts/openapi.json", "generated-files-guard"],
      ["packages/api-client/src/client.ts", "generated-files-guard"],
    ];
    for (const [target, rule] of cases) {
      const edit = decide(root, { action: "edit", path: target });
      expect(edit.rule).toBe(rule);
      for (const command of [
        `dd of=${target}`,
        `dd if=x of=${target} bs=1`,
        `tool --out=${target}`,
        `tool out=${target}`,
        `env dd of=${target}`,
        `cp x ${target}`,
        `tee ${target}`,
        `echo x > ${target}`,
      ]) {
        const verdict = shell(root, command);
        expect(verdict.decision, command).toBe(edit.decision);
        expect(verdict.rule, command).toBe(
          // `.env`-like secrets are also read candidates, so either rule may win.
          target.startsWith("secrets/") ? verdict.rule : rule,
        );
        expect(verdict.message, command).toMatch(MESSAGE_PATTERN);
      }
    }
  });

  it("asks for an ask path exactly as the edit tool does", () => {
    const root = tempRepo();
    const target = "docs/specs/AGENTS.md";
    const edit = decide(root, { action: "edit", path: target });
    expect(edit.decision).toBe("ask");
    for (const command of [
      `dd of=${target}`,
      `tool --out=${target}`,
      `tool out=${target}`,
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("ask");
      expect(verdict.rule, command).toBe("protected-paths");
    }
    const headless = decide(root, {
      action: "shell",
      path: null,
      command: `dd of=${target}`,
      interactive: false,
    });
    expect(headless.decision).toBe("deny");
  });

  // The class: a target that `cp x <target>` refuses is refused for every form.
  it.each([
    "/abs/outside/file",
    "/etc/passwd",
    "../outside",
    "../../outside/x",
    "~/x",
    "~",
    "sub/../../outside",
    "/tmp/wardens-nowhere/x",
    // Forms the shell rewrites: none can be proven inside the worktree.
    "x$X",
    "$HOME/x",
    "~root/x",
    "~-/x",
    "~+/x",
    "a`id`b",
  ])("treats %s alike for cp, dd of=, --out= and key=", (target) => {
    const root = tempRepo();
    const reference = shell(root, `cp x ${target}`);
    expect(reference.decision).toBe("deny");
    for (const command of [
      `dd of=${target}`,
      `dd if=x of=${target}`,
      `tool --out=${target}`,
      `tool --anything=${target}`,
      `tool out=${target}`,
      `tool anything=${target}`,
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(verdict.rule, command).toBe(reference.rule);
      expect(verdict.message, command).toBe(reference.message);
    }
  });

  const ALLOWED = [
    "dd if=/dev/zero of=./tmp.bin bs=1 count=1",
    "dd if=x of=out.bin",
    "dd of=/dev/null",
    "git log --format=%H",
    "git log --pretty=format:%s",
    "pnpm --filter=wardens test",
    "node --experimental-strip-types wardens/src/cli.ts check charter-validate",
    "env A=/tmp/x pnpm check",
    "env -i A=/tmp/x B=../y pnpm check",
    "sudo A=/tmp/x pnpm check",
    "A=/tmp/x pnpm check",
    "A=/tmp/x B=../y pnpm check",
    "rg --glob=src/** x",
    "gh pr list --json=number",
    'git commit -m "path=/abs"',
    'git commit -am "path=/abs"',
    'gh pr create --title "a=/abs" --body "b=../c"',
    "cut -d/ -f1 f",
    "awk -F/ 1 f",
    "tar --exclude=.git -cf x.tar .",
    "git --git-dir=.git status",
    "git -c color.ui=never log",
    "curl https://example.com/?a=/b",
  ];

  it.each(ALLOWED)("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  it("still denies the command after an env assignment prefix", () => {
    const root = tempRepo();
    expect(shell(root, "env A=/tmp/x dd of=/abs/y").decision).toBe("deny");
    expect(shell(root, "A=/tmp/x dd of=/abs/y").decision).toBe("deny");
    expect(shell(root, "env A=/tmp/x cp x /abs/y").decision).toBe("deny");
  });

  it("denies an expansion that hides the path of a key=value word", () => {
    const root = tempRepo();
    for (const command of [
      "dd of=$HOME/x",
      "tool out=$HOME/x",
      "tool --out=$HOME/x",
    ]) {
      expect(shell(root, command).decision, command).toBe("deny");
    }
    // A glob inside the worktree stays provably inside.
    expect(shell(root, "tool --filter=./apps/*").decision).toBe("allow");
  });

  // Round 1: the key, the operand or any part of the value may be a variable.
  const EXPANDING = [
    "K=of; dd $K=/opt/p/x",
    'K=of; dd "$K"=/opt/p/x',
    "X=of=/opt/p/x; dd $X",
    'K=of; dd "$K"',
    "X=/../../opt/p/y; tsc --outFile=x$X f.ts",
    "X=/../../opt/p/y; node --redirect-warnings=x$X a.js",
    "foo out=a$X",
    "make DESTDIR=x$X install",
    "dd of=~root/x",
    "dd of=~-/x",
    "dd of=~+/x",
    "tool out=~root/x",
    "tool --sink=x$X",
    "tool --sink=~root/x",
    "env dd $X",
    // Accepted false positives: a variable in a value of a non-read-only command.
    "git log --since=$X",
    'gh api -f body="$MSG"',
    "curl -d a=$B",
    "make VAR=$PWD",
  ];

  it.each(EXPANDING)("denies %s as an unprovable path", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  // Builtins that only assign or print take no path: their redirects still count.
  const BUILTINS_ALLOWED = [
    "export FOO=$BAR",
    "export PATH=$PATH:/x",
    "export PATH=$HOME/.local/bin:$PATH",
    "export UV_PROJECT_ENVIRONMENT=/abs/venv",
    "declare A=/x",
    "typeset A=/x",
    "local A=/x",
    "readonly A=/x",
    "set -o errexit",
    "echo a=/etc/b",
    "echo --x=/etc/b",
    "printf a=/etc/b",
    "dd of=/dev/tty",
  ];

  it.each(BUILTINS_ALLOWED)("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  it.each([
    "echo x > /abs/y",
    "echo a=/etc/b > /abs/y",
    "export A=1 && dd of=/abs",
    "export A=1; echo x >> ../y",
  ])("still denies %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  // Round 2: only the shell's own expansion counts, so quoting decides.
  const QUOTED_ALLOWED = [
    "git log --grep='^fix$'",
    "git log --grep='fix$' --oneline",
    "git log --author='a$'",
    "git log --grep='$x'",
    "git log --format='%H $x'",
    "git log --pretty=format:'%h $x'",
    "tar --exclude='*.log$' -cf a.tar .",
    "tool out='~root/x'",
    "tool --out='~root/x'",
    "dd of='~-/x'",
    "tool out='a$X'",
    "tool --sink='x${X}'",
    "tool --out='$HOME/x'",
  ];

  it.each(QUOTED_ALLOWED)(
    "allows %s: the quoting makes it literal",
    (command) => {
      const root = tempRepo();
      expect(shell(root, command).decision).toBe("allow");
    },
  );

  it.each([
    "dd of=~root/x",
    "dd of=~-/x",
    "tool out=~root/x",
    "tool --out=~root/x",
    "K=of; dd $K=/abs",
    "X=/../../abs; tsc --outFile=x$X f.ts",
    'tool --out=x"$X"',
    "tool --out=x${X}",
    'git log --grep="$x"',
    "dd of=$((1))",
  ])("denies %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  // The class: every expansion form is denied unquoted and allowed single-quoted.
  it.each([
    ["tool out=a$X", "tool out='a$X'"],
    ["tool --out=a$X", "tool --out='a$X'"],
    ["tool --sink=$X", "tool --sink='$X'"],
    ["tool --sink=x${X}", "tool --sink='x${X}'"],
    ['tool --sink=x"$X"', "tool --sink='x$X'"],
    ["tool out=~root/x", "tool out='~root/x'"],
    ["tool --out=~root/x", "tool --out='~root/x'"],
    ["tool out=~-/x", "tool out='~-/x'"],
    ["tool out=~+/x", "tool out='~+/x'"],
    ["dd of=~root/x", "dd of='~root/x'"],
    ["dd of=$HOME/x", "dd of='$HOME/x'"],
    ["git log --grep=$x", "git log --grep='$x'"],
  ])("denies %s and allows %s", (unquoted, quoted) => {
    const root = tempRepo();
    expect(shell(root, unquoted).decision, unquoted).toBe("deny");
    expect(shell(root, quoted).decision, quoted).toBe("allow");
  });

  // Round 2: the git exemption covers --git-dir and --work-tree against .git only.
  it.each([
    "git fast-export --all --export-marks=panopticon.charter.yaml",
    "git fast-import --export-marks=panopticon.charter.yaml",
    "git fast-export --all --export-marks=packages/contracts/openapi.json",
  ])("denies %s as a protected or generated write", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  it.each([
    "git --git-dir=.git status",
    "git log --grep=panopticon",
    "git log --grep=.git",
  ])("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  // Round 2: pattern options are patterns only for the readers that take them.
  it.each([
    "tool --pattern=panopticon.charter.yaml",
    "tool --ignore=panopticon.charter.yaml",
    "sort --filter=panopticon.charter.yaml",
    "tool --exclude=.git/x",
  ])("denies %s: not a reader's pattern option", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  it.each([
    "tar --exclude=.git -cf x.tar .",
    "tar --exclude=panopticon.charter.yaml -cf x.tar .",
    "rg --glob=panopticon.charter.yaml x",
    "rsync -a --exclude=.git a/ b/",
    "grep --include=panopticon.charter.yaml x f",
  ])("allows %s: a reader's pattern option", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  // Round 2: a builtin is the bare word, not a script that happens to share its name.
  it.each([
    "./echo of=/abs",
    "bin/set out=/abs",
    "x/printf out=/abs",
    "tools/export --out=/abs",
  ])("denies %s: not the builtin", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  // F3: git metadata and the launcher anchor, for values of unclassified commands.
  it.each([
    "foo out=.git/x",
    "foo --sink=.git",
    "foo --sink=.git/hooks/pre-commit",
    "cd x; foo out=../.git/x",
    "foo out=.config/panopticon/primaries",
    "foo --sink=~/.config/panopticon/primaries",
  ])("denies %s as git metadata or the anchor", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  it.each([
    "tar --exclude=.git -cf x.tar .",
    "git --git-dir=.git status",
    "rg --glob=!.git x",
    "rsync -a --exclude=.git/x a/ b/",
  ])("allows %s: a pattern or a read, not a write", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });
});

// #79: the tokenizer splits an unquoted redirect out of the middle of a word, so
// a glued redirect is judged exactly like a spaced one.
describe("redirects glued to the previous word (#79)", () => {
  const ESCAPE =
    "Blocked by Warden engine: path escapes the worktree. Label the issue needs:human.";

  const DENIED: Array<[string, string]> = [
    ["echo x>/abs/y", "engine"],
    ["ls>/abs", "engine"],
    ["echo x>>/abs/y", "engine"],
    ["echo x 2>/abs/y", "engine"],
    ["x>/abs", "engine"],
    ["echo x2>/abs/y", "engine"],
    ["echo x>panopticon.charter.yaml", "protected-paths"],
    ["echo x>packages/contracts/openapi.json", "generated-files-guard"],
    ["echo x>.env", "secret-read-guard"],
    ["cat<.env", "secret-read-guard"],
    ["cat x<.env", "secret-read-guard"],
    ["wc -l<.env", "secret-read-guard"],
    ["dd of=a>/abs", "engine"],
    ["echo x>|/abs", "engine"],
    ["echo x>|panopticon.charter.yaml", "protected-paths"],
    ["echo x&>/abs", "engine"],
    ["echo x&>>/abs", "engine"],
    ["cmd<>/abs", "engine"],
    ["cmd<>.env", "secret-read-guard"],
    ["echo x>&/abs", "engine"],
    ["echo x>&.env", "secret-read-guard"],
    ["cat 0</abs", "engine"],
    ["cat 0<.env", "secret-read-guard"],
    ["echo x {fd}>/abs", "command-guard"],
    ["cat {fd}<.env", "secret-read-guard"],
    ["echo x>.git/hooks/pre-commit", "protected-paths"],
    ["echo x>~root/y", "command-guard"],
    ["echo x>$X", "command-guard"],
    ["nice echo x>/abs", "engine"],
    ["env A=1 cat<.env", "secret-read-guard"],
    ["a=b>/abs", "engine"],
    ['echo "a">/abs', "engine"],
    ["echo x>out.txt>/abs", "engine"],
    ["cat<<<.env", "secret-read-guard"],
  ];

  it.each(DENIED)("denies %s", (command, rule) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe(rule);
    if (rule === "engine") {
      expect(verdict.message).toBe(ESCAPE);
    }
  });

  const ALLOWED = [
    "rg 'a>b'",
    'echo "x<y"',
    "echo 'x>y'",
    "echo x\\>y",
    "git log --format='%h > %s'",
    'git commit -m "a>b"',
    "cmd 2>&1",
    "cmd 2>/dev/null",
    "cmd>/dev/null",
    "cmd &>/dev/null",
    "cmd&>/dev/null",
    "cmd>/dev/null 2>&1",
    "cmd 2>&1>/dev/null",
    "cmd>&2",
    "cmd 2>&-",
    "cat <&-",
    "cat 0<&-",
    "echo x>out.txt",
    "echo x>>out.txt",
    "echo x>|out.txt",
    "echo x&>out.txt",
    "pnpm check 2>&1",
    "pnpm check>out.txt 2>&1",
    "cat <<<'x'",
    "cat<<<'x'",
    "git log HEAD~1..HEAD>out.txt",
    // As in bash, `a=b>c` is the assignment `a=b` and the redirect `>c`.
    "a=b>c",
    "a=b >c",
    "a>b>c",
  ];

  it.each(ALLOWED)("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  // Digits are a descriptor only when they are the whole word before the
  // operator: `x2>f` is the word `x2` and `>f`, `x 2>f` redirects fd 2.
  it("reads digits as a descriptor only when they are the whole word", () => {
    const root = tempRepo();
    for (const command of [
      "echo x2>/abs/y",
      "echo x 2>/abs/y",
      "echo x2 >/abs/y",
      'echo "2">/abs/y',
      "echo 2>/abs/y",
      "echo 2 >/abs/y",
    ]) {
      const verdict = shell(root, command);
      expect(verdict.decision, command).toBe("deny");
      expect(verdict.message, command).toBe(ESCAPE);
    }
    for (const command of ["echo x2>out.txt", "echo x 2>out.txt"]) {
      expect(shell(root, command).decision, command).toBe("allow");
    }
  });

  // A quoted or escaped operator is a literal character, not a redirect.
  it("keeps a quoted or escaped operator literal", () => {
    const root = tempRepo();
    for (const command of [
      "echo 'x>/abs/y'",
      'echo "x>/abs/y"',
      "echo x\\>/abs/y",
      'echo "x"\'>\'"/abs/y"',
      'rg "a<.env"',
    ]) {
      expect(shell(root, command).decision, command).toBe("allow");
    }
  });

  // The class: every target the spaced form refuses is refused, with the same
  // rule and message, when the redirect is glued to the word before it.
  const TARGETS = [
    // path escapes
    "/abs/outside/file",
    "/etc/passwd",
    "../outside",
    "../../outside/x",
    "~/x",
    "~",
    "sub/../../outside",
    // forms the shell rewrites
    "x$X",
    "$HOME/x",
    "~root/y",
    "~-/x",
    "a`id`b",
    // protected, generated, secret, git metadata, the launcher anchor
    "panopticon.charter.yaml",
    "packages/contracts/openapi.json",
    "packages/api-client/src/client.ts",
    "docs/specs/AGENTS.md",
    "secrets/key",
    ".env",
    ".env.local",
    ".git/hooks/pre-commit",
    ".git",
    ".config/panopticon/primaries",
    "~/.config/panopticon/primaries",
  ];

  // [spaced form, glued form] for a target T.
  const FORMS: Array<[string, string]> = [
    ["cmd x > T", "cmd x>T"],
    ["cmd x >> T", "cmd x>>T"],
    ["cmd x 2> T", "cmd x 2>T"],
    ["cmd x < T", "cmd x<T"],
    ["cmd x 0< T", "cmd x 0<T"],
    ["cmd x >| T", "cmd x>|T"],
    ["cmd x &> T", "cmd x&>T"],
    ["cmd x &>> T", "cmd x&>>T"],
    ["cmd x <> T", "cmd x<>T"],
    ["cmd x >& T", "cmd x>&T"],
    ["x > T", "x>T"],
    ["ls > T", "ls>T"],
    ["cat < T", "cat<T"],
    ["cat x < T", "cat x<T"],
    ["wc -l < T", "wc -l<T"],
    ["cmd x2 > T", "cmd x2>T"],
    ["dd of=a > T", "dd of=a>T"],
    ["nice cmd x > T", "nice cmd x>T"],
    ["env A=1 cat < T", "env A=1 cat<T"],
    ["cmd x > out.txt > T", "cmd x>out.txt>T"],
  ];

  const CASES = TARGETS.flatMap((target) =>
    FORMS.map(([spaced, glued]): [string, string, string] => [
      target,
      spaced.replaceAll("T", target),
      glued.replaceAll("T", target),
    ]),
  );

  it.each(CASES)("treats %s alike in %s and %s", (_target, spaced, glued) => {
    const root = tempRepo();
    const reference = shell(root, spaced);
    const verdict = shell(root, glued);
    expect(verdict.decision, glued).toBe(reference.decision);
    expect(verdict.rule, glued).toBe(reference.rule);
    expect(verdict.message, glued).toBe(reference.message);
  });

  it("denies or asks for every write redirect to a refused target", () => {
    const root = tempRepo();
    for (const target of TARGETS) {
      for (const glued of [
        `cmd x>${target}`,
        `cmd x>>${target}`,
        `cmd x 2>${target}`,
        `cmd x>|${target}`,
        `cmd x&>${target}`,
        `x>${target}`,
      ]) {
        expect(shell(root, glued).decision, glued).not.toBe("allow");
      }
    }
    // A read of a secret is refused; a read of a protected path is not a write.
    for (const target of ["secrets/key", ".env", ".env.local"]) {
      for (const glued of [`cmd x<${target}`, `cat<${target}`]) {
        expect(shell(root, glued).decision, glued).toBe("deny");
      }
    }
  });

  // Round 1, B1: the harness shell is zsh. `!` after a `>`-family operator and `|`
  // after `>>`, `>&`, `&>`, `&>>` or `>>&` are zsh spellings with their own
  // meaning (clobber override, append of both streams, `>>|`). Bash does not need
  // them, so the tokenizer calls them unparseable: spaced and glued alike.
  const UNPARSEABLE_MESSAGE = (() => {
    const reference = shell(tempRepo(), "echo (x)");
    return reference.message;
  })();

  const ZSH_DENIED = [
    "echo x>!panopticon.charter.yaml",
    "echo x >! panopticon.charter.yaml",
    "echo x>>!/abs",
    "echo x>>&/abs",
    "echo x>&!.env",
    "echo x&>!/abs",
    "echo x&>>!.env",
    "echo x 2>!/abs",
    "echo x>>&!/abs",
    "echo x>>|panopticon.charter.yaml",
    "echo x>&|panopticon.charter.yaml",
    "echo x&>|panopticon.charter.yaml",
    "echo x&>>|panopticon.charter.yaml",
    "echo x>>&|panopticon.charter.yaml",
    "echo x >>| panopticon.charter.yaml",
    "echo x 2>>|/abs",
    "echo x >>& /abs",
    "echo x >&! .env",
    ">!panopticon.charter.yaml",
    "x>!out.txt",
  ];

  it.each(ZSH_DENIED)(
    "denies the zsh spelling %s as unparseable",
    (command) => {
      const root = tempRepo();
      const verdict = shell(root, command);
      expect(verdict.decision).toBe("deny");
      expect(verdict.rule).toBe("command-guard");
      expect(verdict.message).toBe(UNPARSEABLE_MESSAGE);
    },
  );

  it.each([
    "echo 'x>!y'",
    "rg '>>|'",
    'git commit -m "a>!b"',
    'echo "x>>&y"',
    "echo x\\>!y",
    "cmd 2>&1",
    "cmd>/dev/null",
    "cmd 2>&1|tail",
    "cmd>&2|tail",
    "echo x>|out.txt",
    "echo x 2>|out.txt",
    "echo x>out.txt|cat",
    "echo x >>out.txt",
    "echo x&>out.txt",
    "git log --format='%h>>|%s'",
  ])("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  // Round 2: an empty quoted target adds nothing to the word text, but the `|`
  // after it is a real pipe, not a clobber `>|`: the command behind it is judged.
  const EMPTY_QUOTE_PIPE: Array<[string, string]> = [
    ['echo x >""|touch panopticon.charter.yaml', "protected-paths"],
    ["echo x >''|git push --force", "command-guard"],
    ['echo x >""|tee panopticon.charter.yaml', "protected-paths"],
    ['echo x 2>""|touch panopticon.charter.yaml', "protected-paths"],
    ['echo x >""""|touch panopticon.charter.yaml', "protected-paths"],
    ['echo x >\\\n""|touch panopticon.charter.yaml', "protected-paths"],
    ["echo x >''\\\n\\\n|touch panopticon.charter.yaml", "protected-paths"],
  ];

  it.each(EMPTY_QUOTE_PIPE)("denies the pipe after %j", (command, rule) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe(rule);
  });

  // Round 1, B2: a backslash-newline between two operator characters joins them.
  const CONTINUED_DENIED: Array<[string, string]> = [
    ["echo x>\\\n|panopticon.charter.yaml", "protected-paths"],
    ["echo x>\\\n&packages/contracts/openapi.json", "generated-files-guard"],
    ["echo x&>\\\n|.github/x", "command-guard"],
    ["echo x>>\\\n|panopticon.charter.yaml", "command-guard"],
    ["echo x>\\\n>panopticon.charter.yaml", "protected-paths"],
    ["echo x<\\\n>panopticon.charter.yaml", "protected-paths"],
    ["echo x>\\\n|/abs", "engine"],
    ["echo x>\\\n&/abs", "engine"],
    ["echo x>\\\n!panopticon.charter.yaml", "command-guard"],
    ["echo x>>\\\n&/abs", "command-guard"],
  ];

  it.each(CONTINUED_DENIED)("denies %j", (command, rule) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe(rule);
  });

  // The class: every zsh spelling and every continued spelling of an operator is
  // refused for every target the plain spelling refuses.
  const ZSH_OPERATORS = [
    ">!",
    ">>!",
    "&>!",
    "&>>!",
    ">&!",
    ">>&!",
    "2>!",
    ">>|",
    ">&|",
    "&>|",
    "&>>|",
    ">>&|",
    ">>&",
    "2>>|",
  ];

  it("refuses every zsh spelling for every target as unparseable", () => {
    const root = tempRepo();
    for (const operator of ZSH_OPERATORS) {
      for (const target of TARGETS) {
        for (const command of [
          `cmd x${operator}${target}`,
          `cmd x ${operator} ${target}`,
          `cmd x ${operator}${target}`,
          `x${operator}${target}`,
        ]) {
          const verdict = shell(root, command);
          expect(verdict.decision, command).toBe("deny");
          // The launcher anchor is matched on the raw text first: also a deny.
          if (!target.includes(".config/panopticon")) {
            expect(verdict.message, command).toBe(UNPARSEABLE_MESSAGE);
          }
        }
      }
    }
  });

  // [joined spelling, the same with a continuation inside the operator]
  const CONTINUED_FORMS: Array<[string, string]> = [
    [">|T", ">\\\n|T"],
    [">&T", ">\\\n&T"],
    ["&>T", "&\\\n>T"],
    ["&>T", "&>\\\nT"],
    ["&>|T", "&>\\\n|T"],
    [">>T", ">\\\n>T"],
    [">>|T", ">>\\\n|T"],
    [">>&T", ">>\\\n&T"],
    [">!T", ">\\\n!T"],
    ["<>T", "<\\\n>T"],
    ["2>|T", "2>\\\n|T"],
    ["2>&T", "2>\\\n&T"],
  ];

  it("treats a continued operator like the joined one for every target", () => {
    const root = tempRepo();
    for (const [joined, continued] of CONTINUED_FORMS) {
      for (const target of TARGETS) {
        for (const head of ["cmd x", "x", "nice cmd x"]) {
          const reference = shell(
            root,
            `${head}${joined.replaceAll("T", target)}`,
          );
          const command = `${head}${continued.replaceAll("T", target)}`;
          const verdict = shell(root, command);
          expect(verdict.decision, command).toBe(reference.decision);
          expect(verdict.rule, command).toBe(reference.rule);
          expect(verdict.message, command).toBe(reference.message);
        }
      }
    }
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

// #78: a read candidate the shell rewrites must be proven inside the worktree
// (or in `paths.external`), exactly as a write target is (#76).
describe("expanding read candidates (#78)", () => {
  const UNPROVABLE = [
    "cat $HOME/.ssh/id_rsa",
    "cat ${HOME}/.ssh/id_rsa",
    'cat "$HOME/.ssh/id_rsa"',
    "cat ~root/.ssh/id_rsa",
    "cat ~+/x",
    "cat ~-/x",
    "X=/etc/passwd; cat $X",
    "K=.env; cat $K",
    'K=.env; cat "$K"',
    "cat .e*",
    "cat .en?",
    "cat .[e]nv",
    "cat .env.l*",
    "cat secr*/x",
    "cat */../.env",
    "cat ../*",
    "cat /etc/pass*",
    "rg foo $HOME/.config/gh",
    "wc -l <$HOME/.ssh/id_rsa",
    "wc -l < $HOME/.ssh/id_rsa",
    "head -1 < ~root/x",
    "xargs cat < $X",
    "tool --input=$HOME/x",
    "tool in=$X",
    "cat --input=$HOME/x",
    "cat --input=.e*",
    "cat in=$X",
    "sed -n 1p $HOME/x",
    "git show $HOME/x",
    "nice cat $HOME/.ssh/id_rsa",
    "env cat $X",
    "env A=1 cat ~root/x",
    "gh issue comment 1 -F$HOME/x",
    "shopt -s dotglob; cat *",
    "cat $PWD/README.md",
    'cat "$PWD/README.md"',
    // Accepted false positives: a variable in a pattern, a glob outside the worktree.
    'rg "$PATTERN" src',
    "git log --since=$X",
    "cat ~/.claude/projects/x-lunarhunt/memory/*.md",
  ];

  it.each(UNPROVABLE)("denies %s as unprovable", (command) => {
    const root = tempRepo();
    const verdict = shell(root, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toContain("Retry with literal paths");
  });

  // The class: a read target denied as a literal path is denied in every
  // spelling the shell rewrites, and the single-quoted twin stays literal.
  const TARGETS: Array<[string, string]> = [
    ["/etc/passwd", "/etc/pass*"],
    ["/abs/outside/file", "/abs/out*/file"],
    ["../x", "../*"],
    [".env", ".e*"],
    [".env.local", ".env.l*"],
    ["secrets/key", "secr*/key"],
  ];

  it.each(TARGETS)("denies %s in every expanding spelling", (path, glob) => {
    const root = tempRepo();
    expect(shell(root, `cat ${path}`).decision).toBe("deny");
    const bare = path.replace(/^\/+/, "");
    for (const command of [
      `cat $HOME/${bare}`,
      `cat \${HOME}/${bare}`,
      `cat ~someone/${bare}`,
      `X=${path}; cat $X`,
      `X=${path}; cat "$X"`,
      `X=${path}; cat < $X`,
      `X=${path}; cat <$X`,
      `X=${path}; rg foo $X`,
      `X=${path}; tool --in=$X`,
      `X=${path}; tool in=$X`,
      `X=${path}; nice cat $X`,
      `cat ${glob}`,
      `cat < ${glob}`,
      `rg foo ${glob}`,
      `tool --in=${glob}`,
    ]) {
      expect(shell(root, command).decision, command).toBe("deny");
    }
  });

  it.each([
    "cat '$HOME/x'",
    "cat '$X'",
    "cat '~root/x'",
    "cat '*.ts'",
    "cat '.e*'",
    "cat < '$X'",
    "tool --in='$HOME/x'",
    "tool in='$X'",
    "git log --grep='$x'",
  ])("allows %s: the quoting makes it literal", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  const ALLOWED = [
    "cat ~/.claude/projects/x-lunarhunt/memory/a.md",
    "cat ./src/*.ts",
    "cat src/*.ts",
    "rg foo src/*.ts",
    "ls wardens/src/*.ts",
    "ls *.md",
    "cat *",
    "git log @{u}",
    "ls src/*/",
    "cat docs/**/*.md",
    "cat < src/*.ts",
    "cat --input=src/*.ts",
    "echo $HOME",
    'echo "$X"',
    "printf '%s' $X",
    "export FOO=$BAR",
    "git log --grep='$x'",
    "cat '$HOME'",
    "ls",
    "rg -n foo wardens/src",
    "pnpm check",
  ];

  it.each(ALLOWED)("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  it("still denies a read behind an echo-only line", () => {
    const root = tempRepo();
    expect(shell(root, "echo $HOME; cat $HOME/x").decision).toBe("deny");
    expect(shell(root, "echo $X < $HOME/x").decision).toBe("deny");
  });

  // A here-string supplies data: it names no file.
  it.each(['cat <<< "$X"', 'grep foo <<< "$X"', "read X <<< $Y", "cat <<<$X"])(
    "allows %s",
    (command) => {
      const root = tempRepo();
      expect(shell(root, command).decision).toBe("allow");
    },
  );
});

// #78 round 1: a glob is proven by a real intersection test with the
// secret patterns, not by sample strings.
describe("glob intersection with the secret patterns (#78)", () => {
  const DENIED = [
    // `.env.*`: a wildcard, class or `?` at every position of the name.
    "cat .env[.]local",
    "cat .env?local",
    "cat .env*local",
    "cat .e*local",
    "cat .env*ocal",
    "cat .env[!x]local",
    "cat .env[a-z.]local",
    "cat .env*production",
    "cat .e*v.production",
    "cat .?nv.local",
    "cat .*.local",
    "cat .*local",
    "cat .[e]*local",
    "cat .e[n]v.local",
    "cat apps/*/.env*local",
    "cat .e*.l*",
    "cat .e?v.l*",
    "cat .e*l*",
    "cat .en*.local",
    // Not every match is `*.example`: `.env.xample` is a secret.
    "cat .e*xample",
    // `.env`.
    "cat .[!a]nv",
    "cat .e[!x]v",
    "cat .e[^x]v",
    "cat .[!.]*",
    "cat .*",
    "cat .e*",
    "cat .?nv",
    // zsh `extendedglob` forms are wildcards.
    "cat .^x",
    "cat .e#nv",
    "cat .env~x",
    // `secrets/**`: a directory reader meets the directory itself.
    "rg foo secret*",
    "rg foo sec*s",
    "rg foo s*ts",
    "rg foo ?ecrets",
    "rg foo sec*",
    "rg foo s*",
    "rg foo secre?s",
    "rg foo secret?",
    "grep -r x sec*",
    "find sec* -type f",
    "tar -cf out.tar sec*",
    "cp -r sec*s dest",
    // Round 2: readers that descend, and option values of any command.
    "git add *",
    "git -C . add sec*",
    "rg foo *",
    "nice rg foo *",
    "diff sec* x",
    "diff -r sec* x",
    "diff -q sec* x",
    "jq -n -L sec* x",
    "jq -Lsec* x",
    "jq --library-path sec* x",
    "jq --library-path=sec* x",
    "file -m sec* x",
    "file --magic-file=sec* x",
    "grep -rn x sec*",
    "grep --recursive x sec*",
    "egrep -R x sec*",
    "cp -a sec* dest",
    "zip -r out.zip sec*",
    "rsync -a sec* dest",
    "scp -r sec* host:",
    "wc --files0-from=sec*",
    // Round 2: zsh `^` (anything but) and `#` (zero or more).
    "cat ^x/key",
    "cat ^x/*",
    "cat sec^x/key",
    "rg x ^x",
    "rg x sec^x",
    "cat .envx#",
    "cat .envx#.local",
    "cat .env^.example",
    // Round 2: POSIX classes and escapes inside a class; an unparseable class meets.
    "cat .[[:alpha:]]nv",
    "cat sec[[:lower:]]ets/key",
    "cat .env[[:punct:]]local",
    "cat .env[[:punct:]]*",
    "rg x s[[:lower:]]crets",
    "cat .[a\\]e]nv",
    "cat .[[:unknown:]]nv",
    "cat .[[=e=]]nv",
    "cat .[[.e.]]nv",
    "cat .e[n",
    // Any command: a file inside the directory.
    "cat secr*/key",
    "cat s*/k*",
    "cat secrets/[!x]ey",
    "cat sec*s/*",
    "cat */key",
    "cat **/key",
  ];

  it.each(DENIED)("denies %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  const ALLOWED = [
    // A leading wildcard does not match a leading dot.
    "find . -name *.env",
    "cat src/*.env",
    "rg foo -g *.env",
    "cat *.env",
    "cat .env.example",
    "cat .e*.example",
    "cat .env*.example",
    "cat .env.*.example",
    "ls wardens/src/*.ts",
    "cat docs/specs/*.md",
    "cat docs/**/*.md",
    "cat docs/*/AGENTS.md",
    "cat *.md",
    "cat *",
    "cat sec*",
    // Round 2: readers that do not descend, behind a wrapper or not.
    "ls *",
    "ls -la *",
    "ls -d */",
    "ls sec*",
    "du -sh *",
    "stat *",
    "nice cat *",
    "wc -l *",
    "head -1 *",
    "file *",
    "rg ^foo src",
    "rg -n ^foo src",
    "grep -E ^a f",
    "git log HEAD^",
    "cat HEAD^",
    "git log HEAD^",
    "git log HEAD~2",
    // Cannot match `secrets`, `.env` or `.env.*`.
    "rg foo secrets?",
    "rg foo ?secrets",
    "rg foo secret??",
    "cat .envx",
    "cat .?nvx",
    "cat .[a-d]nv",
  ];

  // Another case is the same file on a case-insensitive volume (#77): `.eNv`
  // is a secret, so a glob that can name it is refused.
  // An upper-case glob (`S*`, `[A-Z]*`) can name `Secrets` or `.eNv` too: intended denies.
  it.each([
    "cat .ENV",
    "cat .e[!n]v",
    "cat .[!e]nv",
    "cat .[!E]nv",
    "rg foo S*",
    "rg foo [A-Z]*",
    "cat .[A-Z]nv",
  ])("denies %s: another case names the secret", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("deny");
  });

  it.each(ALLOWED)("allows %s", (command) => {
    const root = tempRepo();
    expect(shell(root, command).decision).toBe("allow");
  });

  it("gives up on a state explosion in under a second, denying", () => {
    const root = tempRepo();
    const started = Date.now();
    const verdict = shell(root, `cat .env.*a${"?".repeat(20)}.example`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(verdict.decision).toBe("deny");
  });

  // The class: a glob that matches a secret pattern is denied at every
  // position of the name, and its disjoint twin is allowed.
  const SPELLINGS: Array<{ name: string; hits: string[]; misses: string[] }> = [
    {
      name: ".env",
      hits: [
        ".e*",
        ".*nv",
        ".en?",
        ".e?v",
        ".[e]nv",
        ".[!x]nv",
        ".[^x]nv",
        ".[!e]nv",
        ".[^e]nv",
      ],
      misses: [".e??v", "e*", "*nv"],
    },
    {
      name: ".env.local",
      hits: [
        ".env.l*",
        ".env*local",
        ".env?local",
        ".env[.]local",
        ".env[!x]local",
        ".e*local",
        ".e*v.l*",
        ".*.local",
        ".?nv.local",
        ".env.[l]ocal",
        ".env.*",
        ".e[!n]v.local",
      ],
      misses: [".env[!.]local", "*.local", ".envlocal*"],
    },
    {
      name: "secrets/key",
      hits: [
        "secr*/key",
        "s*/key",
        "secre?s/key",
        "sec*s/k*",
        "?ecrets/key",
        "secrets/[!x]ey",
        "secrets/k?y",
        "*/key",
      ],
      misses: ["secrets?/key", "sec/*", "secrx*/key", "?ecret/key"],
    },
  ];

  it.each(SPELLINGS)("class: $name", ({ hits, misses }) => {
    const root = tempRepo();
    for (const glob of hits) {
      expect(shell(root, `cat ${glob}`).decision, glob).toBe("deny");
      expect(shell(root, `cat < ${glob}`).decision, glob).toBe("deny");
      expect(shell(root, `tool --in=${glob}`).decision, glob).toBe("deny");
    }
    for (const glob of misses) {
      expect(shell(root, `cat ${glob}`).decision, glob).toBe("allow");
    }
  });
});
