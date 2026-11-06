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
