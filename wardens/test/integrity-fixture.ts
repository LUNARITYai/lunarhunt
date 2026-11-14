import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { runHook } from "../src/engine.ts";
import { type Deps, runWorktree } from "../src/worktree/index.ts";
import { normativeCharter } from "./support.ts";

const bases: string[] = [];

/** Call from an `afterAll` of each test file that uses the fixture. */
export function cleanupFixtures(): void {
  for (const dir of bases) {
    rmSync(dir, { recursive: true, force: true });
  }
  bases.length = 0;
}

export function track(dir: string): void {
  bases.push(dir);
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const NEXT = "Ask Krzysztof to run wardens worktree setup";
export const REMOTE = "https://github.com/o/r.git";

export type Fixture = {
  origin: string;
  primary: string;
  home: string;
  wt: string;
  tasksDir: string;
  deps: Deps;
  /** Arguments of every `gh` call the commands made. */
  ghCalls: string[][];
};

/**
 * A primary clone with one task worktree made by `wardens worktree new` (issue
 * 5, Allowed paths `wardens/**`). The primary's origin URL is GitHub's, fetched
 * from the local origin through `insteadOf`; the sidecar `repos` lists `o/r`
 * for it unless `repos` is false.
 */
export function fixture(
  options: { worktree?: boolean; repos?: boolean } = {},
): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-integrity-")));
  bases.push(base);
  const origin = join(base, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "commit.gpgsign", "false");
  sh(origin, "config", "user.email", "t@example.com");
  sh(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "panopticon.charter.yaml"), normativeCharter());
  writeFileSync(join(origin, ".env.example"), "TASK_ISSUE=\n");
  writeFileSync(
    join(origin, ".gitignore"),
    ".panopticon/\n.claude/worktrees/\n",
  );
  mkdirSync(join(origin, "wardens"));
  writeFileSync(join(origin, "wardens", "x.ts"), "export {};\n");
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "init");
  const primary = join(base, "primary");
  execFileSync("git", ["clone", "-q", origin, primary]);
  sh(primary, "config", "commit.gpgsign", "false");
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  sh(primary, "config", "remote.origin.url", REMOTE);
  sh(primary, "config", `url.${origin}.insteadOf`, REMOTE);
  const home = join(base, "home");
  mkdirSync(join(home, ".config", "panopticon"), { recursive: true });
  if (options.repos !== false) {
    writeFileSync(
      join(home, ".config", "panopticon", "repos"),
      `${primary}\to/r\n`,
    );
  }
  const ghCalls: string[][] = [];
  const deps: Deps = {
    env: { HOME: home },
    cwd: primary,
    gh: (args) => {
      ghCalls.push(args);
      if (args[0] !== "issue") {
        return { status: 0, stdout: "[]" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          title: "Fix the thing",
          body: "### Allowed paths\nwardens/**\n",
          labels: [{ name: "type:bug" }],
          state: "OPEN",
          url: "https://github.com/o/r/issues/5",
        }),
      };
    },
    step: () => 0,
  };
  const wt = join(primary, ".claude", "worktrees", "5-fix-the-thing");
  const tasksDir = join(home, ".config", "panopticon", "tasks");
  const made = { origin, primary, home, wt, tasksDir, deps, ghCalls };
  if (options.worktree !== false) {
    expect(runWorktree({ sub: "new", arg: "5" }, deps).exitCode).toBe(0);
  }
  return made;
}

export function hashFiles(f: Fixture): string[] {
  return existsSync(f.tasksDir) ? readdirSync(f.tasksDir) : [];
}

export function setupAgain(f: Fixture, refresh = false) {
  return runWorktree(
    { sub: "setup", ...(refresh ? { refresh: true } : {}) },
    { ...f.deps, cwd: f.wt },
  );
}

export function taskFile(f: Fixture): string {
  return join(f.wt, ".panopticon", "task.json");
}

export function widen(f: Fixture): void {
  const task = JSON.parse(readFileSync(taskFile(f), "utf8"));
  task.allowed_paths.push("docs/**");
  writeFileSync(taskFile(f), JSON.stringify(task));
}

/** `allow`, or `<decision> <message>` for a hook run with a trusted primary. */
export function hook(
  f: Fixture,
  tool: string,
  input: object,
  cwd = f.wt,
): string {
  const out = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd, tool_name: tool, tool_input: input }),
    { cwd: () => cwd, env: { HOME: f.home }, home: f.home, primary: f.primary },
  ).stdout;
  if (out === "") {
    return "allow";
  }
  const decision = JSON.parse(out).hookSpecificOutput;
  return `${decision.permissionDecision} ${decision.permissionDecisionReason}`;
}

export function edit(f: Fixture, rel: string, cwd = f.wt): string {
  return hook(f, "Write", { file_path: join(cwd, rel), content: "x" }, cwd);
}
