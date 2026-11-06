import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { runWorktreeHook } from "../src/worktree/hook.ts";
import type { Deps, Result } from "../src/worktree/index.ts";
import { cliPath, normativeCharter } from "./support.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "worktree-hook");
const bases: string[] = [];

afterAll(() => {
  for (const dir of bases) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const ISSUE_BODY = [
  "### Goal",
  "x",
  "",
  "### Allowed paths",
  "wardens/**",
  "docs/specs/**",
  "",
  "### Depends on",
  "nothing",
].join("\n");

type Repo = {
  origin: string;
  primary: string;
  steps: string[];
  failStep: { command: string | null };
  deps: (cwd?: string) => Deps;
  path: (name: string) => string;
};

function repo(): Repo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-hook-")));
  bases.push(base);
  const origin = join(base, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "user.email", "t@example.com");
  sh(origin, "config", "user.name", "t");
  sh(origin, "config", "commit.gpgsign", "false");
  writeFileSync(join(origin, "panopticon.charter.yaml"), normativeCharter());
  writeFileSync(join(origin, ".env.example"), "TASK_ISSUE=\nWEB_PORT=1\n");
  writeFileSync(
    join(origin, ".gitignore"),
    ".env\n.panopticon/\n.claude/worktrees/\n",
  );
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "init");
  const primary = join(base, "primary");
  execFileSync("git", ["clone", "-q", origin, primary]);
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  sh(primary, "config", "commit.gpgsign", "false");
  const steps: string[] = [];
  const failStep: { command: string | null } = { command: null };
  const deps = (cwd = primary): Deps => ({
    env: { CLAUDECODE: "1" },
    cwd,
    gh: (args) => {
      if (args[0] === "issue") {
        return {
          status: 0,
          stdout: JSON.stringify({
            title: "Hook",
            body: ISSUE_BODY,
            labels: [{ name: "type:feature" }],
            state: "OPEN",
            url: `https://github.com/o/r/issues/${args[2]}`,
          }),
        };
      }
      return { status: 0, stdout: "[]" };
    },
    step: (command) => {
      steps.push(command);
      return command === failStep.command ? 1 : 0;
    },
  });
  return {
    origin,
    primary,
    steps,
    failStep,
    deps,
    path: (name) => join(primary, ".claude", "worktrees", name),
  };
}

function payload(
  file: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as {
    stdin: unknown;
  };
  let text = JSON.stringify(raw.stdin);
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(key, value);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

const failures: string[] = [];

function run(
  kind: "create" | "remove",
  r: Repo,
  body: unknown,
  tool = "claude",
): Result {
  const cwd =
    typeof body === "object" &&
    body !== null &&
    "cwd" in body &&
    typeof body.cwd === "string"
      ? body.cwd
      : r.primary;
  const res = runWorktreeHook(
    kind,
    tool,
    typeof body === "string" ? body : JSON.stringify(body),
    r.deps(cwd),
  );
  if (res.exitCode !== 0) {
    failures.push(res.stderr);
  }
  return res;
}

const createBody = (cwd: string, name: string) => ({
  hook_event_name: "WorktreeCreate",
  cwd,
  name,
  session_id: "s",
  unknown_future_field: { a: 1 },
});

function branches(r: Repo): string[] {
  return sh(r.primary, "branch", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean)
    .sort();
}

function worktreeCount(r: Repo): number {
  return sh(r.primary, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

/** A task worktree for issue 66 made by the hook itself. */
function taskWorktree(r: Repo): string {
  const res = run(
    "create",
    r,
    payload("worktree-create-flag.json", { __PRIMARY__: r.primary }),
  );
  expect(res.exitCode).toBe(0);
  return r.path("66-rec-test");
}

function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), file);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", file);
}

describe("WorktreeCreate: task names", () => {
  it("creates the worktree like `new` and prints only the path", () => {
    const r = repo();
    const res = run(
      "create",
      r,
      payload("worktree-create-flag.json", { __PRIMARY__: r.primary }),
    );
    const wt = r.path("66-rec-test");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${wt}\n`);
    expect(res.stderr).toContain("granted allowed_paths");
    expect(sh(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/66-rec-test",
    );
    expect(
      JSON.parse(readFileSync(join(wt, ".panopticon", "task.json"), "utf8")),
    ).toEqual({
      issue: 66,
      branch: "feat/66-rec-test",
      slug: "rec-test",
      allowed_paths: ["wardens/**", "docs/specs/**"],
    });
    expect(existsSync(join(wt, ".panopticon", "setup.ok"))).toBe(true);
    expect(r.steps).toEqual([
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "pnpm exec lefthook install",
    ]);
  });

  it("works from a nested cwd and still creates under the primary location", () => {
    const r = repo();
    const parent = taskWorktree(r);
    const res = run("create", r, createBody(parent, "67-second-task"));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${r.path("67-second-task")}\n`);
    expect(res.stdout.startsWith(parent + sep)).toBe(false);
    expect(existsSync(join(parent, ".claude", "worktrees"))).toBe(false);
  });

  it("refuses a name that is not the canonical name of the issue", () => {
    const r = repo();
    const res = run("create", r, createBody(r.primary, "66-rec--test"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("canonical");
    expect(existsSync(r.path("66-rec--test"))).toBe(false);
    expect(branches(r)).toEqual(["main"]);
  });

  it("removes the worktree and the branch when a setup step fails", () => {
    const r = repo();
    r.failStep.command = "uv sync --frozen";
    const res = run("create", r, createBody(r.primary, "66-rec-test"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("setup step failed");
    expect(res.stderr).not.toContain("stays at");
    expect(existsSync(r.path("66-rec-test"))).toBe(false);
    expect(branches(r)).toEqual(["main"]);
    expect(worktreeCount(r)).toBe(1);
  });

  it("refuses a second create of the same name and keeps the first", () => {
    const r = repo();
    const wt = taskWorktree(r);
    const res = run("create", r, createBody(r.primary, "66-rec-test"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("already exists");
    expect(existsSync(join(wt, ".panopticon", "setup.ok"))).toBe(true);
  });
});

describe("WorktreeCreate: subagents", () => {
  it("branches from the parent HEAD and copies task.json (nested cwd stays flat)", () => {
    const r = repo();
    const parent = taskWorktree(r);
    commit(parent, "local.txt");
    r.steps.length = 0;
    const res = run(
      "create",
      r,
      payload("worktree-create-subagent.json", { __PARENT__: parent }),
    );
    const wt = r.path("agent-a0baa00347bfbc0ab");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${wt}\n`);
    expect(res.stdout.startsWith(parent + sep)).toBe(false);
    expect(sh(wt, "rev-parse", "HEAD")).toBe(sh(parent, "rev-parse", "HEAD"));
    expect(sh(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "worktree-agent-a0baa00347bfbc0ab",
    );
    expect(readFileSync(join(wt, ".panopticon", "task.json"), "utf8")).toBe(
      readFileSync(join(parent, ".panopticon", "task.json"), "utf8"),
    );
    expect(r.steps).toEqual([]);
    expect(existsSync(join(wt, ".env"))).toBe(false);
  });

  it("branches from the fetched base_ref for a detached parent, without task.json", () => {
    const r = repo();
    const parent = r.path("overseer");
    sh(r.primary, "worktree", "add", "--detach", parent, "origin/main");
    commit(r.origin, "upstream.txt");
    const res = run("create", r, createBody(parent, "agent-det1"));
    const wt = r.path("agent-det1");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${wt}\n`);
    expect(sh(wt, "rev-parse", "HEAD")).toBe(sh(r.origin, "rev-parse", "HEAD"));
    expect(sh(wt, "rev-parse", "HEAD")).not.toBe(
      sh(parent, "rev-parse", "HEAD"),
    );
    expect(existsSync(join(wt, ".panopticon", "task.json"))).toBe(false);
  });

  it("fails with a worktree-guard message for a parent in the primary checkout", () => {
    const r = repo();
    const res = run("create", r, createBody(r.primary, "agent-p1"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Blocked by Warden worktree-guard");
    expect(res.stderr).toContain("wardens worktree new <issue>");
    expect(existsSync(r.path("agent-p1"))).toBe(false);
    expect(branches(r)).toEqual(["main"]);
  });

  it("fails with a worktree-guard message for a linked worktree on main", () => {
    const r = repo();
    sh(r.primary, "switch", "-q", "-c", "dev");
    const onMain = r.path("on-main");
    sh(r.primary, "worktree", "add", onMain, "main");
    const res = run("create", r, createBody(onMain, "agent-m1"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Blocked by Warden worktree-guard");
    expect(existsSync(r.path("agent-m1"))).toBe(false);
  });

  it("fails closed on an invalid parent task.json and leaves nothing", () => {
    const r = repo();
    const parent = taskWorktree(r);
    writeFileSync(join(parent, ".panopticon", "task.json"), "{nope");
    const before = branches(r);
    const res = run("create", r, createBody(parent, "agent-bad1"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("task.json is invalid");
    expect(existsSync(r.path("agent-bad1"))).toBe(false);
    expect(branches(r)).toEqual(before);
  });

  it("refuses when the branch already exists", () => {
    const r = repo();
    const parent = taskWorktree(r);
    sh(r.primary, "branch", "worktree-agent-dup", "main");
    const res = run("create", r, createBody(parent, "agent-dup"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("already exists");
    expect(existsSync(r.path("agent-dup"))).toBe(false);
    expect(branches(r)).toContain("worktree-agent-dup");
  });
});

describe("WorktreeCreate: validation", () => {
  const BAD = [
    "../x",
    "-x",
    "a/b",
    "x..y",
    "A",
    "a b",
    "",
    "x".repeat(65),
    "agent-$(id)",
    "a;b",
  ];

  it.each(BAD)("refuses the name %j and creates nothing", (name) => {
    const r = repo();
    const parent = taskWorktree(r);
    const before = branches(r);
    const res = run("create", r, createBody(parent, name));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("worktree name");
    expect(branches(r)).toEqual(before);
    expect(worktreeCount(r)).toBe(2);
  });

  it("refuses an existing path that is not a worktree", () => {
    const r = repo();
    const parent = taskWorktree(r);
    mkdirSync(r.path("agent-exists"), { recursive: true });
    const res = run("create", r, createBody(parent, "agent-exists"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("already exists");
    expect(existsSync(r.path("agent-exists"))).toBe(true);
  });

  it.each([
    ["not JSON", "{{"],
    [
      "wrong event",
      JSON.stringify({ hook_event_name: "Stop", cwd: "/", name: "a" }),
    ],
    [
      "no name",
      JSON.stringify({ hook_event_name: "WorktreeCreate", cwd: "/x" }),
    ],
    [
      "name is a number",
      JSON.stringify({ hook_event_name: "WorktreeCreate", cwd: "/x", name: 5 }),
    ],
    [
      "relative cwd",
      JSON.stringify({
        hook_event_name: "WorktreeCreate",
        cwd: "rel",
        name: "a",
      }),
    ],
    [
      "cwd is not a repository",
      JSON.stringify({
        hook_event_name: "WorktreeCreate",
        cwd: tmpdir(),
        name: "agent-x",
      }),
    ],
  ])("rejects a bad payload: %s", (_label, body) => {
    const r = repo();
    const res = run("create", r, body);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("refuses every tool but claude", () => {
    const r = repo();
    const res = run("create", r, createBody(r.primary, "66-x"), "cursor");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("68");
  });

  it("prints C-30 messages on every failure", () => {
    expect(failures.length).toBeGreaterThan(5);
    for (const text of failures) {
      const first = text.trim().split("\n")[0] ?? "";
      expect(first).toMatch(MESSAGE_PATTERN);
    }
  });
});

describe("WorktreeRemove (provisional payload)", () => {
  const body = (r: Repo, wt: string) =>
    payload("worktree-remove-provisional.json", {
      __PRIMARY__: r.primary,
      __WORKTREE__: wt,
    });

  it("removes a clean worktree and its branch, exit 0, empty stdout", () => {
    const r = repo();
    const parent = taskWorktree(r);
    const res = run("create", r, createBody(parent, "agent-r1"));
    expect(res.exitCode).toBe(0);
    const wt = r.path("agent-r1");
    const out = run("remove", r, body(r, wt));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(existsSync(wt)).toBe(false);
    expect(branches(r)).not.toContain("worktree-agent-r1");
  });

  it("removes a subagent worktree whose only extra commits live on the parent branch", () => {
    const r = repo();
    const parent = taskWorktree(r);
    commit(parent, "unpushed.txt");
    run("create", r, createBody(parent, "agent-r2"));
    const wt = r.path("agent-r2");
    const out = run("remove", r, body(r, wt));
    expect(out.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(
      sh(r.primary, "log", "--oneline", "-1", "feat/66-rec-test"),
    ).toContain("unpushed.txt");
  });

  it("keeps a worktree with uncommitted changes and exits 0", () => {
    const r = repo();
    const wt = taskWorktree(r);
    writeFileSync(join(wt, "dirty.txt"), "x");
    const out = run("remove", r, body(r, wt));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("uncommitted");
    expect(existsSync(join(wt, "dirty.txt"))).toBe(true);
  });

  it("keeps a worktree with commits no remote or other branch holds", () => {
    const r = repo();
    const wt = taskWorktree(r);
    commit(wt, "mine.txt");
    const out = run("remove", r, body(r, wt));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("unpushed");
    expect(existsSync(wt)).toBe(true);
    expect(sh(wt, "log", "--oneline", "-1")).toContain("mine.txt");
  });

  it("logs a kept worktree to the primary Ledger log", () => {
    const r = repo();
    const wt = taskWorktree(r);
    writeFileSync(join(wt, "dirty.txt"), "x");
    run("remove", r, body(r, wt));
    const log = readFileSync(
      join(r.primary, ".panopticon", "wardens.log.jsonl"),
      "utf8",
    );
    expect(log).toContain("worktree-remove");
    expect(log).toContain("uncommitted");
  });

  it("keeps a linked worktree outside the Charter location", () => {
    const r = repo();
    const outside = join(r.primary, "..", "elsewhere");
    sh(r.primary, "worktree", "add", "-q", "--detach", outside, "main");
    const out = run("remove", r, body(r, realpathSync(outside)));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("not under the Charter location");
    expect(existsSync(outside)).toBe(true);
  });

  it("keeps the primary checkout, a plain directory and a missing path", () => {
    const r = repo();
    taskWorktree(r);
    const plain = r.path("plain");
    mkdirSync(plain, { recursive: true });
    for (const target of [
      r.primary,
      plain,
      r.path("missing"),
      "relative/path",
      join(r.path("66-rec-test"), ".."),
    ]) {
      const out = run("remove", r, body(r, target));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("kept the worktree");
    }
    expect(existsSync(r.primary)).toBe(true);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(r.path("66-rec-test"))).toBe(true);
  });

  it("works when the session cwd is inside the worktree", () => {
    const r = repo();
    const wt = taskWorktree(r);
    const out = run("remove", r, {
      ...body(r, wt),
      cwd: wt,
    });
    expect(out.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("exits 2 on a malformed payload and removes nothing", () => {
    const r = repo();
    const wt = taskWorktree(r);
    for (const bad of [
      "{",
      JSON.stringify({ hook_event_name: "WorktreeRemove", cwd: r.primary }),
      JSON.stringify({
        hook_event_name: "WorktreeCreate",
        cwd: r.primary,
        worktree_path: wt,
      }),
    ]) {
      expect(run("remove", r, bad).exitCode).toBe(2);
    }
    expect(existsSync(wt)).toBe(true);
  });
});

describe("CLI entrypoint", () => {
  function cli(r: Repo, args: string[], input: string) {
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "worktree", ...args],
      {
        cwd: r.primary,
        input,
        encoding: "utf8",
        env: { ...process.env, CLAUDECODE: "1", PANOPTICON_AGENT: "claude" },
      },
    );
  }

  it("runs despite the agent markers and prints only the path on stdout", () => {
    const r = repo();
    const parent = r.path("overseer");
    sh(r.primary, "worktree", "add", "--detach", parent, "origin/main");
    const res = cli(
      r,
      ["create", "--tool", "claude"],
      JSON.stringify(createBody(parent, "agent-cli1")),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${r.path("agent-cli1")}\n`);
    const removed = cli(
      r,
      ["remove", "--tool", "claude"],
      JSON.stringify({
        hook_event_name: "WorktreeRemove",
        cwd: r.primary,
        worktree_path: r.path("agent-cli1"),
      }),
    );
    expect(removed.status).toBe(0);
    expect(existsSync(r.path("agent-cli1"))).toBe(false);
  });

  it("keeps the human-only paths closed for agents and rejects create without --tool", () => {
    const r = repo();
    expect(cli(r, ["new", "42"], "").status).toBe(2);
    const bare = cli(r, ["create"], "{}");
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("Blocked by Warden");
    expect(cli(r, ["list", "--tool", "claude"], "{}").status).toBe(2);
  });
});
