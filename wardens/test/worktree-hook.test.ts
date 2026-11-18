import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { writeRepo } from "../src/sync/anchor.ts";
import { loadTask } from "../src/task.ts";
import { integrityOf, recordTaskHash, taskId } from "../src/task-integrity.ts";
import { runWorktreeHook } from "../src/worktree/hook.ts";
import { type Deps, type Result, runWorktree } from "../src/worktree/index.ts";
import { normativeCharter, repoRoot } from "./support.ts";

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
  base: string;
  origin: string;
  primary: string;
  /** The HOME of the hook process: task.json hashes and the sync records live below it. */
  home: string;
  steps: string[];
  failStep: { command: string | null };
  deps: (cwd?: string) => Deps;
  path: (name: string) => string;
};

type RepoOptions = {
  /** Edits the parsed Charter before it is committed. */
  charter?: (charter: Record<string, unknown>) => void;
  /** Commits a symlink at `.panopticon`, so a copy of task.json into a fresh checkout must fail. */
  panopticonSymlink?: boolean;
};

const STUB_ISSUE = (n: string | undefined) =>
  JSON.stringify({
    title: "Hook",
    body: ISSUE_BODY,
    labels: [{ name: "type:feature" }],
    state: "OPEN",
    url: `https://github.com/o/r/issues/${n}`,
  });

function repo(options: RepoOptions = {}): Repo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-hook-")));
  bases.push(base);
  const origin = join(base, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "user.email", "t@example.com");
  sh(origin, "config", "user.name", "t");
  sh(origin, "config", "commit.gpgsign", "false");
  const charter = parse(normativeCharter()) as Record<string, unknown>;
  options.charter?.(charter);
  writeFileSync(join(origin, "panopticon.charter.yaml"), stringify(charter));
  writeFileSync(join(origin, ".env.example"), "TASK_ISSUE=\nWEB_PORT=1\n");
  writeFileSync(
    join(origin, ".gitignore"),
    ".env\n.panopticon/\n.claude/worktrees/\n",
  );
  if (options.panopticonSymlink === true) {
    symlinkSync("elsewhere", join(origin, ".panopticon"));
    sh(origin, "add", "-f", ".panopticon");
  }
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "init");
  const primary = join(base, "primary");
  execFileSync("git", ["clone", "-q", origin, primary]);
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  sh(primary, "config", "commit.gpgsign", "false");
  // The GitHub URL on record is what setup parses for `gh -R`; git still fetches the local origin.
  sh(primary, "config", "remote.origin.url", "https://github.com/o/r.git");
  sh(
    primary,
    "config",
    `url.${origin}.insteadOf`,
    "https://github.com/o/r.git",
  );
  const home = join(base, "home");
  mkdirSync(home);
  // What `wardens sync` records for the primary; the issue repository is read only from here.
  writeRepo(home, primary, "o/r");
  const steps: string[] = [];
  const failStep: { command: string | null } = { command: null };
  const deps = (cwd = primary): Deps => ({
    env: { CLAUDECODE: "1", HOME: home },
    cwd,
    gh: (args) =>
      args[0] === "issue"
        ? { status: 0, stdout: STUB_ISSUE(args[2]) }
        : { status: 0, stdout: "[]" },
    step: (command) => {
      steps.push(command);
      return command === failStep.command ? 1 : 0;
    },
  });
  return {
    base,
    origin,
    primary,
    home,
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

function run(
  kind: "create" | "remove",
  r: Repo,
  body: unknown,
  tool = "claude",
  anchor: string | null = r.primary,
): Result {
  const cwd =
    typeof body === "object" &&
    body !== null &&
    "cwd" in body &&
    typeof body.cwd === "string"
      ? body.cwd
      : r.primary;
  return runWorktreeHook(
    kind,
    tool,
    typeof body === "string" ? body : JSON.stringify(body),
    r.deps(cwd),
    anchor,
  );
}

const createBody = (cwd: string, name: string) => ({
  hook_event_name: "WorktreeCreate",
  cwd,
  name,
  session_id: "s",
  unknown_future_field: { a: 1 },
});

const removeBody = (cwd: string, path: string) => ({
  hook_event_name: "WorktreeRemove",
  cwd,
  worktree_path: path,
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

/** A task worktree for issue 66 made by the hook itself (it carries a task.json). */
function taskWorktree(r: Repo): string {
  const res = run(
    "create",
    r,
    payload("worktree-create-flag.json", { __PRIMARY__: r.primary }),
  );
  expect(res.exitCode).toBe(0);
  return r.path("66-rec-test");
}

/** A detached worktree like the one OVERSEER works in: no task.json. */
function detachedParent(r: Repo, dir = r.path("overseer")): string {
  sh(r.primary, "worktree", "add", "-q", "--detach", dir, "origin/main");
  return dir;
}

/** A subagent worktree made by the hook from a detached parent. */
function subagent(r: Repo, name: string): string {
  const res = run(
    "create",
    r,
    createBody(detachedParent(r, r.path(`p-${name}`)), name),
  );
  expect(res.exitCode).toBe(0);
  return r.path(name);
}

function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), file);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", file);
}

/** Replaces a parent's task.json and, unless `record` is false, records its hash as `wardens worktree setup` does. */
/** The hash records below the test HOME. */
function records(r: Repo): string[] {
  try {
    return readdirSync(join(r.home, ".config", "panopticon", "tasks")).filter(
      (name) => name.endsWith(".sha256"),
    );
  } catch {
    return [];
  }
}

function writeTask(r: Repo, dir: string, task: unknown, record = true): void {
  const text = typeof task === "string" ? task : JSON.stringify(task);
  mkdirSync(join(dir, ".panopticon"), { recursive: true });
  writeFileSync(join(dir, ".panopticon", "task.json"), text);
  if (record) {
    recordTaskHash(r.home, r.primary, dir, text);
  }
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
    const parent = detachedParent(r);
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
    // The record written before the failing step goes with the worktree.
    expect(records(r)).toEqual([]);
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

describe("WorktreeCreate: a scoped session cannot widen its scope (S-B3)", () => {
  it("refuses a task name for another issue when the parent has a task.json", () => {
    const r = repo();
    const parent = taskWorktree(r);
    const before = branches(r);
    const res = run("create", r, createBody(parent, "67-other-issue"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Blocked by Warden worktree-guard");
    expect(res.stderr).toContain("scoped to issue #66");
    expect(existsSync(r.path("67-other-issue"))).toBe(false);
    expect(branches(r)).toEqual(before);
  });

  it("refuses any task name when the parent task.json is invalid", () => {
    const r = repo();
    const parent = taskWorktree(r);
    writeTask(r, parent, "{nope");
    const res = run("create", r, createBody(parent, "66-again"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("invalid");
    expect(existsSync(r.path("66-again"))).toBe(false);
  });

  it("allows any open issue from a primary, detached or no-task.json parent (residual risk, inside the Charter envelope)", () => {
    const r = repo();
    expect(
      run("create", r, createBody(r.primary, "70-from-primary")).exitCode,
    ).toBe(0);
    const parent = detachedParent(r);
    expect(
      run("create", r, createBody(parent, "71-from-detached")).exitCode,
    ).toBe(0);
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

  it("branches from the fetched base_ref for a detached parent, without task.json and without tracking", () => {
    const r = repo();
    const parent = detachedParent(r);
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
    expect(
      spawnSync("git", [
        "-C",
        r.primary,
        "config",
        "--get",
        "branch.worktree-agent-det1.remote",
      ]).status,
    ).toBe(1);
  });

  it("copies the task.json of a detached parent that has one (S-B2)", () => {
    const r = repo();
    const parent = detachedParent(r);
    writeTask(r, parent, { issue: 5, allowed_paths: ["docs/**"] });
    const res = run("create", r, createBody(parent, "agent-det2"));
    expect(res.exitCode).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(r.path("agent-det2"), ".panopticon", "task.json"),
          "utf8",
        ),
      ),
    ).toEqual({ issue: 5, allowed_paths: ["docs/**"] });
  });

  it("fails closed on an invalid task.json of a detached parent (S-B2)", () => {
    const r = repo();
    const parent = detachedParent(r);
    writeTask(r, parent, "{nope");
    const before = branches(r);
    const res = run("create", r, createBody(parent, "agent-det3"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("task.json is invalid");
    expect(existsSync(r.path("agent-det3"))).toBe(false);
    expect(branches(r)).toEqual(before);
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
    writeTask(r, parent, "{nope");
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

  it("cleans up when the task.json copy fails (symlinked .panopticon in the checkout)", () => {
    const r = repo({ panopticonSymlink: true });
    const parent = detachedParent(r);
    rmSync(join(parent, ".panopticon"), { force: true });
    writeTask(r, parent, { issue: 5, allowed_paths: ["docs/**"] });
    const before = branches(r);
    const res = run("create", r, createBody(parent, "agent-sym1"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("could not be copied");
    expect(existsSync(r.path("agent-sym1"))).toBe(false);
    expect(branches(r)).toEqual(before);
    expect(worktreeCount(r)).toBe(2);
  });
});

describe("WorktreeCreate: trust anchor (S-B1)", () => {
  it("refuses a cwd in another repository", () => {
    const r = repo();
    const other = repo();
    const create = run("create", r, createBody(other.primary, "agent-x1"));
    expect(create.exitCode).toBe(2);
    expect(create.stderr).toContain("another repository");
    expect(existsSync(r.path("agent-x1"))).toBe(false);
    expect(existsSync(other.path("agent-x1"))).toBe(false);
    const task = run("create", r, createBody(other.primary, "66-x"));
    expect(task.exitCode).toBe(2);
    expect(branches(r)).toEqual(["main"]);
    expect(branches(other)).toEqual(["main"]);
  });

  it("refuses a nested repository inside a worktree", () => {
    const r = repo();
    const parent = detachedParent(r);
    const nested = join(parent, "nested");
    mkdirSync(nested);
    execFileSync("git", ["init", "-q", nested]);
    const res = run("create", r, createBody(nested, "agent-n1"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("another repository");
    expect(existsSync(r.path("agent-n1"))).toBe(false);
  });

  it("refuses when the bundle location is unknown", () => {
    const r = repo();
    const res = run("create", r, createBody(r.primary, "66-x"), "claude", null);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Wardens bundle");
  });

  it("reads steps, location and base_ref from the primary Charter, not from the parent worktree", () => {
    const r = repo();
    const parent = detachedParent(r);
    const doc = parse(
      readFileSync(join(parent, "panopticon.charter.yaml"), "utf8"),
    ) as {
      worktree: {
        setup: { steps: string[] };
        location: { default: string };
        base_ref: string;
      };
    };
    doc.worktree.setup.steps = ["touch pwned"];
    doc.worktree.location.default = ".claude/elsewhere/{name}";
    doc.worktree.base_ref = "origin/does-not-exist";
    writeFileSync(join(parent, "panopticon.charter.yaml"), stringify(doc));
    const task = run("create", r, createBody(parent, "67-from-evil"));
    expect(task.exitCode).toBe(0);
    expect(task.stdout).toBe(`${r.path("67-from-evil")}\n`);
    expect(r.steps).toEqual([
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "pnpm exec lefthook install",
    ]);
    expect(existsSync(join(r.primary, ".claude", "elsewhere"))).toBe(false);
    const sub = run("create", r, createBody(parent, "agent-evil1"));
    expect(sub.exitCode).toBe(0);
    expect(sh(r.path("agent-evil1"), "rev-parse", "HEAD")).toBe(
      sh(r.primary, "rev-parse", "origin/main"),
    );
  });

  it("refuses a Charter location that resolves outside the primary checkout", () => {
    const r = repo();
    const parent = detachedParent(r, join(r.base, "outside-parent"));
    const outside = join(r.base, "outside");
    mkdirSync(outside);
    mkdirSync(join(r.primary, ".claude"), { recursive: true });
    symlinkSync(outside, join(r.primary, ".claude", "worktrees"));
    const res = run("create", r, createBody(parent, "agent-loc1"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("resolves outside the primary checkout");
    expect(existsSync(join(outside, "agent-loc1"))).toBe(false);
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
    const parent = detachedParent(r);
    const before = branches(r);
    const res = run("create", r, createBody(parent, name));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("worktree name");
    expect(branches(r)).toEqual(before);
    expect(worktreeCount(r)).toBe(2);
  });

  it.each(["0-x", "007-abc", "66-", "1234567890-toolong"])(
    "reserves the name %j for task worktrees",
    (name) => {
      const r = repo();
      const parent = detachedParent(r);
      const res = run("create", r, createBody(parent, name));
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("reserved for task worktrees");
      expect(worktreeCount(r)).toBe(2);
    },
  );

  it("refuses an existing path that is not a worktree and leaves it alone", () => {
    const r = repo();
    const parent = detachedParent(r);
    mkdirSync(r.path("agent-exists"), { recursive: true });
    writeFileSync(join(r.path("agent-exists"), "keep.txt"), "mine");
    const res = run("create", r, createBody(parent, "agent-exists"));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("already exists");
    expect(readFileSync(join(r.path("agent-exists"), "keep.txt"), "utf8")).toBe(
      "mine",
    );
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

  it("prints a C-30 message on every failure", () => {
    const r = repo();
    const parent = detachedParent(r);
    const failures = [
      run("create", r, "{{"),
      run("create", r, createBody(parent, "../x")),
      run("create", r, createBody(r.primary, "agent-c30")),
      run("create", r, createBody(parent, "007-abc")),
      run("create", r, createBody(tmpdir(), "agent-c30")),
      run("create", r, createBody(r.primary, "66-x"), "cursor"),
    ];
    for (const res of failures) {
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr.trim().split("\n")[0]).toMatch(MESSAGE_PATTERN);
    }
  });
});

/**
 * The two shapes of the `cwd` field. Recorded 2026-11-18 (`claude --worktree`, exit and remove): the removed worktree itself.
 * Documented, not recorded: the parent session's directory (the subagent flow). Every remove case runs for both.
 */
const CWD_SHAPES = ["recorded", "documented"] as const;

describe.each(CWD_SHAPES)(
  "WorktreeRemove (recorded payload, cwd %s)",
  (shape) => {
    /** `cwdIsWorktree` is false for a bad `worktree_path`: `cwd` then stays a valid directory, the primary checkout. */
    const body = (
      r: Repo,
      wt: string,
      cwdIsWorktree = true,
    ): Record<string, unknown> => ({
      ...payload("worktree-remove.json", { __WORKTREE__: wt }),
      cwd: shape === "recorded" && cwdIsWorktree ? wt : r.primary,
    });

    it("sends the payload cwd that its shape names", () => {
      const r = repo();
      const wt = subagent(r, "agent-shape");
      const sent = body(r, wt);
      expect(sent.cwd).toBe(shape === "recorded" ? wt : r.primary);
      expect(sent.worktree_path).toBe(wt);
    });

    it("removes a clean subagent worktree and its branch, exit 0, empty stdout", () => {
      const r = repo();
      const wt = subagent(r, "agent-r1");
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

    it("keeps a task worktree: only a human removes those", () => {
      const r = repo();
      const wt = taskWorktree(r);
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("task worktree");
      expect(out.stderr).toContain("wardens worktree remove 66-rec-test");
      expect(existsSync(wt)).toBe(true);
    });

    it("keeps a subagent worktree with uncommitted changes and names git worktree remove", () => {
      const r = repo();
      const wt = subagent(r, "agent-k0");
      writeFileSync(join(wt, "dirty.txt"), "x");
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("uncommitted");
      expect(out.stderr).toContain(`git worktree remove ${wt}`);
      expect(existsSync(join(wt, "dirty.txt"))).toBe(true);
    });

    it("keeps a subagent with its own commit and branch", () => {
      const r = repo();
      const wt = subagent(r, "agent-k1");
      commit(wt, "mine.txt");
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("unpushed");
      expect(existsSync(wt)).toBe(true);
      expect(branches(r)).toContain("worktree-agent-k1");
      expect(sh(wt, "log", "--oneline", "-1")).toContain("mine.txt");
    });

    it("keeps a detached subagent worktree with a commit no branch holds", () => {
      const r = repo();
      const wt = subagent(r, "agent-k2");
      sh(wt, "checkout", "-q", "--detach");
      commit(wt, "lost.txt");
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("kept the worktree");
      expect(existsSync(wt)).toBe(true);
      expect(sh(wt, "log", "--oneline", "-1")).toContain("lost.txt");
    });

    it("keeps a clean worktree on another branch (N1)", () => {
      const r = repo();
      const wt = r.path("scratch");
      sh(
        r.primary,
        "worktree",
        "add",
        "-q",
        "-b",
        "my-feature",
        wt,
        "origin/main",
      );
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("not worktree-scratch");
      expect(existsSync(wt)).toBe(true);
      expect(branches(r)).toContain("my-feature");
      const log = readFileSync(
        join(r.primary, ".panopticon", "wardens.log.jsonl"),
        "utf8",
      );
      expect(log).toContain("worktree-remove");
      expect(log).toContain("did not make it");
    });

    it("keeps a clean detached worktree (N1)", () => {
      const r = repo();
      const wt = detachedParent(r, r.path("detached-clean"));
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("not worktree-detached-clean");
      expect(existsSync(wt)).toBe(true);
      expect(
        readFileSync(
          join(r.primary, ".panopticon", "wardens.log.jsonl"),
          "utf8",
        ),
      ).toContain("did not make it");
    });

    it("never runs a program or hooks named in the repository configuration (N2)", () => {
      const r = repo();
      const parent = detachedParent(r);
      const wt = subagent(r, "agent-g1");
      const marker = join(r.base, "marker");
      const hookMarker = join(r.base, "hook-marker");
      const script = join(r.base, "fsmonitor.sh");
      writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      const hooks = join(r.base, "hooks");
      mkdirSync(hooks);
      writeFileSync(
        join(hooks, "post-checkout"),
        `#!/bin/sh\ntouch ${hookMarker}\n`,
        { mode: 0o755 },
      );
      sh(r.primary, "config", "core.fsmonitor", script);
      sh(r.primary, "config", "core.hooksPath", hooks);
      const created = run("create", r, createBody(parent, "agent-g2"));
      const removed = run("remove", r, body(r, wt));
      expect(created.exitCode).toBe(0);
      expect(removed.exitCode).toBe(0);
      expect(existsSync(r.path("agent-g2"))).toBe(true);
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(hookMarker)).toBe(false);
      // Control: plain git does run both.
      sh(
        r.primary,
        "worktree",
        "add",
        "-q",
        "--detach",
        r.path("control"),
        "origin/main",
      );
      sh(r.path("control"), "status");
      expect(existsSync(hookMarker)).toBe(true);
      expect(existsSync(marker)).toBe(true);
    });

    it("keeps a locked worktree", () => {
      const r = repo();
      const wt = subagent(r, "agent-k3");
      sh(r.primary, "worktree", "lock", wt);
      const out = run("remove", r, body(r, wt));
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("kept the worktree");
      expect(existsSync(wt)).toBe(true);
    });

    it("logs a kept worktree to the primary Ledger log", () => {
      const r = repo();
      const wt = subagent(r, "agent-k4");
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
        const out = run("remove", r, body(r, target, false));
        expect(out.exitCode).toBe(0);
        expect(out.stderr).toContain("kept the worktree");
      }
      expect(existsSync(r.primary)).toBe(true);
      expect(existsSync(plain)).toBe(true);
      expect(existsSync(r.path("66-rec-test"))).toBe(true);
    });
  },
);

describe("WorktreeRemove payload errors", () => {
  it("works when the session cwd is inside the worktree", () => {
    const r = repo();
    const wt = subagent(r, "agent-k5");
    const out = run("remove", r, removeBody(wt, wt));
    expect(out.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("exits 2 for a cwd in another repository and removes nothing", () => {
    const r = repo();
    const other = repo();
    const wt = subagent(r, "agent-k6");
    const out = run("remove", r, removeBody(other.primary, wt));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("another repository");
    expect(existsSync(wt)).toBe(true);
  });

  it("exits 2 on a malformed payload and removes nothing", () => {
    const r = repo();
    const wt = subagent(r, "agent-k7");
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

/**
 * Class: worktree-controlled git configuration is not used. A worktree's `.git`
 * can be replaced by whoever works in it, so the inspections before a removal
 * must never read it. Each shape below is a tampered `.git`; where a repository
 * of its own is involved it carries a clean filter that would create `marker`.
 */
type Tamper = {
  name: string;
  /** The payload cwd of the recorded shape is then outside this repository: the cwd gate refuses with exit 2. */
  foreign: boolean;
  apply: (r: Repo, wt: string, marker: string) => void;
};

/** Turns `wt` into a standalone repository whose modified tracked file runs a marker-creating clean filter. */
function plantFilterRepo(r: Repo, wt: string, marker: string): void {
  rmSync(join(wt, ".git"), { force: true });
  sh(wt, "init", "-q", "-b", "main");
  sh(wt, "config", "user.email", "t@example.com");
  sh(wt, "config", "user.name", "t");
  sh(wt, "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".gitattributes"), "tracked.txt filter=x\n");
  writeFileSync(join(wt, "tracked.txt"), "a\n");
  sh(wt, "add", ".gitattributes", "tracked.txt");
  sh(wt, "commit", "-q", "-m", "fake");
  const script = join(r.base, "filter.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  sh(wt, "config", "filter.x.clean", script);
  // Same size, new content: git then has to run the filter to compare it.
  writeFileSync(join(wt, "tracked.txt"), "b\n");
  expect(existsSync(marker)).toBe(false);
}

/** Moves the standalone repository's `.git` out of `wt`, so `wt/.git` can be rebuilt as a link to it. */
function moveGitOut(r: Repo, wt: string): string {
  const moved = join(r.base, `moved-${Math.random().toString(36).slice(2)}`);
  renameSync(join(wt, ".git"), moved);
  return moved;
}

const adminOf = (wt: string) =>
  /^gitdir: (.+)$/m.exec(readFileSync(join(wt, ".git"), "utf8"))?.[1] ?? "";

const TAMPERED_GIT: Tamper[] = [
  {
    name: "a directory repository",
    foreign: true,
    apply: (r, wt, marker) => plantFilterRepo(r, wt, marker),
  },
  {
    name: "a symlink to a repository",
    foreign: true,
    apply: (r, wt, marker) => {
      plantFilterRepo(r, wt, marker);
      symlinkSync(moveGitOut(r, wt), join(wt, ".git"));
    },
  },
  {
    name: "a pointer to another repository",
    foreign: true,
    apply: (r, wt, marker) => {
      plantFilterRepo(r, wt, marker);
      writeFileSync(join(wt, ".git"), `gitdir: ${moveGitOut(r, wt)}\n`);
    },
  },
  {
    name: "a pointer to another worktree's admin directory",
    foreign: false,
    apply: (r, wt) => {
      const other = subagent(r, "agent-other");
      writeFileSync(join(wt, ".git"), `gitdir: ${adminOf(other)}\n`);
    },
  },
  {
    name: "a pointer to the primary .git",
    foreign: false,
    apply: (r, wt) => {
      writeFileSync(join(wt, ".git"), `gitdir: ${join(r.primary, ".git")}\n`);
    },
  },
];

describe.each(CWD_SHAPES)(
  "worktree-controlled git config is not used: hook remove (cwd %s)",
  (shape) => {
    it.each(TAMPERED_GIT)("keeps a worktree whose .git is $name", (tamper) => {
      const r = repo();
      const wt = subagent(r, "agent-t1");
      const marker = join(r.base, "MARKER");
      tamper.apply(r, wt, marker);
      const out = run("remove", r, {
        ...payload("worktree-remove.json", { __WORKTREE__: wt }),
        cwd: shape === "recorded" ? wt : r.primary,
      });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(wt)).toBe(true);
      if (shape === "recorded" && tamper.foreign) {
        expect(out.exitCode).toBe(2);
        expect(out.stderr).toContain("another repository");
      } else {
        expect(out.exitCode).toBe(0);
        expect(out.stderr).toContain("kept the worktree");
        expect(out.stderr).toContain("cannot be inspected safely");
      }
      expect(branches(r)).toContain("worktree-agent-t1");
    });
  },
);

/** Deps of a human running `wardens worktree remove|prune`; `gh` reports every branch's PR in `state`. */
const human = (r: Repo, state: string): Deps => ({
  ...r.deps(),
  env: { HOME: r.home },
  charterRoot: r.primary,
  gh: () => ({ status: 0, stdout: JSON.stringify([{ state }]) }),
});

/** Runs `fn` with a `git` first on PATH that logs every argument vector, then runs the real git. */
function spyOnGit<T>(r: Repo, fn: () => T): { result: T; calls: string[][] } {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(r.base, "spy-bin");
  const log = join(r.base, "git-calls.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\t' "$a" >> ${log}; done\nprintf '\\n' >> ${log}\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before ?? ""}`;
  try {
    const result = fn();
    const calls = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t").slice(0, -1))
      : [];
    return { result, calls };
  } finally {
    process.env.PATH = before;
  }
}

const isRemove = (argv: string[]) =>
  argv.includes("worktree") && argv.includes("remove");
const isInspection = (argv: string[]) =>
  argv.some((a) => a.startsWith("--git-dir=")) && argv.includes("status");

/** Every way a worktree gets removed on the non-force path. */
const REMOVERS: {
  name: string;
  make: (r: Repo) => string;
  go: (r: Repo, wt: string) => Result;
}[] = [
  {
    name: "the WorktreeRemove hook",
    make: (r) => subagent(r, "agent-f1"),
    go: (r, wt) => run("remove", r, removeBody(r.primary, wt)),
  },
  {
    name: "wardens worktree remove",
    make: taskWorktree,
    go: (r) =>
      runWorktree({ sub: "remove", arg: "66-rec-test" }, human(r, "MERGED")),
  },
  {
    name: "wardens worktree prune",
    make: taskWorktree,
    go: (r) => runWorktree({ sub: "prune" }, human(r, "MERGED")),
  },
];

describe("git's own removal does not re-read worktree-controlled state", () => {
  it.each(REMOVERS)(
    "$name: the one git worktree remove carries --force and follows the inspection",
    ({ make, go }) => {
      const r = repo();
      const wt = make(r);
      const { result, calls } = spyOnGit(r, () => go(r, wt));
      expect(result.exitCode).toBe(0);
      expect(existsSync(wt)).toBe(false);
      const removes = calls.filter(isRemove);
      expect(removes).toHaveLength(1);
      expect(removes[0]).toContain("--force");
      expect(removes[0]?.filter((a) => a === "--force")).toHaveLength(1);
      expect(calls.findIndex(isInspection)).toBeGreaterThanOrEqual(0);
      expect(calls.findIndex(isInspection)).toBeLessThan(
        calls.findIndex(isRemove),
      );
    },
  );

  it.each(REMOVERS)(
    "$name: a failed inspection issues no git worktree remove",
    ({ make, go }) => {
      const r = repo();
      const wt = make(r);
      writeFileSync(join(wt, "dirty.txt"), "x");
      const { calls } = spyOnGit(r, () => go(r, wt));
      expect(calls.filter(isRemove)).toEqual([]);
      expect(existsSync(join(wt, "dirty.txt"))).toBe(true);
    },
  );

  it.each(REMOVERS)(
    "$name: a worktree whose .git cannot be trusted issues no git worktree remove",
    ({ make, go }) => {
      const r = repo();
      const wt = make(r);
      rmSync(join(wt, ".git"), { force: true });
      sh(wt, "init", "-q");
      const { calls } = spyOnGit(r, () => go(r, wt));
      expect(calls.filter(isRemove)).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    },
  );
});

describe("gh state of a worktree's branch is asked from the primary checkout", () => {
  it.each([
    ["list", { sub: "list" }],
    ["prune", { sub: "prune" }],
  ] as const)("%s runs gh in the primary with -R", (_name, args) => {
    const r = repo();
    taskWorktree(r);
    const calls: { args: string[]; cwd: string }[] = [];
    const deps: Deps = {
      ...human(r, "OPEN"),
      gh: (a, cwd) => {
        calls.push({ args: a, cwd });
        return { status: 0, stdout: JSON.stringify([{ state: "OPEN" }]) };
      },
    };
    expect(runWorktree(args, deps).exitCode).toBe(0);
    const lists = calls.filter((c) => c.args[0] === "pr");
    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) {
      expect(call.cwd).toBe(r.primary);
      expect(call.args.slice(-2)).toEqual(["-R", "o/r"]);
    }
  });
});

describe("worktree-controlled git config is not used: remove and prune", () => {
  it.each(TAMPERED_GIT)(
    "wardens worktree remove and prune keep a worktree whose .git is $name",
    (tamper) => {
      const r = repo();
      const wt = taskWorktree(r);
      const marker = join(r.base, "MARKER");
      tamper.apply(r, wt, marker);
      const removed = runWorktree(
        { sub: "remove", arg: "66-rec-test" },
        human(r, "MERGED"),
      );
      expect(removed.exitCode).toBe(2);
      expect(removed.stderr).toContain("cannot be inspected safely");
      const pruned = runWorktree({ sub: "prune" }, human(r, "MERGED"));
      expect(pruned.stdout).toContain("kept 66-rec-test");
      expect(pruned.stdout).toContain("cannot be inspected safely");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(wt)).toBe(true);
    },
  );
});

describe("WorktreeRemove: the recorded cwd leaves the repository (S1)", () => {
  it("exits 2 and keeps the worktree when its .git is a standalone repository", () => {
    const r = repo();
    const wt = subagent(r, "agent-s1a");
    const marker = join(r.base, "MARKER");
    plantFilterRepo(r, wt, marker);
    const out = run("remove", r, {
      ...payload("worktree-remove.json", { __WORKTREE__: wt }),
      cwd: wt,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("another repository");
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 2 and keeps the worktree when the cwd is a repository nested inside it", () => {
    const r = repo();
    const wt = subagent(r, "agent-s1b");
    const nested = join(wt, "nested");
    mkdirSync(nested);
    sh(nested, "init", "-q");
    const out = run("remove", r, {
      ...payload("worktree-remove.json", { __WORKTREE__: wt }),
      cwd: nested,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("another repository");
    expect(existsSync(wt)).toBe(true);
  });
});

/** A copy of the Wardens sources inside the temp primary: the anchor then is that repository, like the bundle in `<primary>/wardens/dist`. */
function installSources(r: Repo): void {
  const dest = join(r.primary, "wardens");
  mkdirSync(dest, { recursive: true });
  cpSync(join(repoRoot, "wardens", "src"), join(dest, "src"), {
    recursive: true,
  });
  cpSync(join(repoRoot, "wardens", "schema"), join(dest, "schema"), {
    recursive: true,
  });
  cpSync(join(repoRoot, "wardens", "package.json"), join(dest, "package.json"));
  symlinkSync(
    join(repoRoot, "wardens", "node_modules"),
    join(dest, "node_modules"),
  );
}

describe("task.json hash records (#96)", () => {
  const verified = (r: Repo, wt: string) =>
    loadTask(wt, { primary: r.primary, home: r.home });

  it("records the hash of a task.json the hook copies into a subagent worktree", () => {
    const r = repo();
    const parent = taskWorktree(r);
    const res = run("create", r, createBody(parent, "agent-rec1"));
    expect(res.exitCode).toBe(0);
    const wt = r.path("agent-rec1");
    expect(verified(r, wt)).toMatchObject({ kind: "ok", issue: 66 });
    // The record is the guard's view: a later edit makes the file unverified.
    writeFileSync(join(wt, ".panopticon", "task.json"), "{}");
    expect(verified(r, wt)).toEqual({ kind: "unverified", reason: "mismatch" });
  });

  it("records the hash of a task.json copied from a detached parent", () => {
    const r = repo();
    const parent = detachedParent(r);
    writeTask(r, parent, { issue: 5, allowed_paths: ["docs/**"] });
    expect(run("create", r, createBody(parent, "agent-rec2")).exitCode).toBe(0);
    expect(verified(r, r.path("agent-rec2")).kind).toBe("ok");
  });

  it("records the hash of a task worktree and drops it again on remove", () => {
    const r = repo();
    const parent = taskWorktree(r);
    expect(verified(r, parent).kind).toBe("ok");
    const sub = run("create", r, createBody(parent, "agent-rec3"));
    expect(sub.exitCode).toBe(0);
    const wt = r.path("agent-rec3");
    const removed = run("remove", r, removeBody(parent, wt));
    expect(removed.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
    mkdirSync(wt, { recursive: true });
    expect(
      integrityOf(Buffer.from("x"), wt, { primary: r.primary, home: r.home }),
    ).toBe("unrecorded");
  });

  it.each([
    ["unrecorded", false],
    ["edited after it was recorded", true],
  ])(
    "refuses a subagent and a task name when the parent task.json is %s",
    (_label, edited) => {
      const r = repo();
      const parent = detachedParent(r);
      writeTask(r, parent, { issue: 5, allowed_paths: ["docs/**"] }, edited);
      if (edited) {
        writeFileSync(
          join(parent, ".panopticon", "task.json"),
          JSON.stringify({ issue: 5, allowed_paths: ["**"] }),
        );
      }
      const before = branches(r);
      const sub = run("create", r, createBody(parent, "agent-un1"));
      expect(sub.exitCode).toBe(2);
      expect(sub.stderr).toContain("unverified");
      const named = run("create", r, createBody(parent, "5-same-issue"));
      expect(named.exitCode).toBe(2);
      expect(named.stderr).toContain("unverified");
      expect(existsSync(r.path("agent-un1"))).toBe(false);
      expect(branches(r)).toEqual(before);
    },
  );

  it("refuses a parent whose task.json was deleted after it was recorded", () => {
    const r = repo();
    const parent = detachedParent(r);
    writeTask(r, parent, { issue: 5, allowed_paths: ["docs/**"] });
    rmSync(join(parent, ".panopticon", "task.json"));
    const before = branches(r);
    const sub = run("create", r, createBody(parent, "agent-del1"));
    expect(sub.exitCode).toBe(2);
    expect(sub.stderr).toContain("unverified");
    expect(branches(r)).toEqual(before);
    const named = run("create", r, createBody(parent, "5-same-issue"));
    expect(named.exitCode).toBe(2);
    expect(named.stderr).toContain("unverified");
  });

  it("cleans up and records nothing when the record cannot be written", () => {
    const r = repo();
    const parent = taskWorktree(r);
    const target = r.path("agent-rec4");
    // A directory where the record file belongs makes the atomic rename fail.
    mkdirSync(
      join(
        r.home,
        ".config",
        "panopticon",
        "tasks",
        `${taskId(r.primary, target)}.sha256`,
      ),
    );
    const before = branches(r);
    const res = run("create", r, createBody(parent, "agent-rec4"));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("could not be copied and recorded");
    expect(existsSync(target)).toBe(false);
    expect(branches(r)).toEqual(before);
    expect(worktreeCount(r)).toBe(2);
    // Only the parent record and the blocking directory remain.
    expect(records(r)).toHaveLength(2);
  });

  it("drops a stale record when a subagent without a task.json takes its name", () => {
    const r = repo();
    const parent = detachedParent(r);
    const target = r.path("agent-stale1");
    recordTaskHash(r.home, r.primary, target, "{}");
    expect(records(r)).toHaveLength(1);
    expect(run("create", r, createBody(parent, "agent-stale1")).exitCode).toBe(
      0,
    );
    expect(records(r)).toEqual([]);
    expect(loadTask(target, { primary: r.primary, home: r.home }).kind).toBe(
      "missing",
    );
  });

  it("stops starting setup steps at the deadline and cleans up", () => {
    const r = repo();
    let now = 0;
    const deps = r.deps();
    const slow: Deps = {
      ...deps,
      step: (command, cwd) => {
        now += 1000;
        return deps.step(command, cwd);
      },
    };
    const before = branches(r);
    const res = runWorktreeHook(
      "create",
      "claude",
      JSON.stringify(createBody(r.primary, "66-slow")),
      slow,
      r.primary,
      { now: () => now, limitMs: 500 },
    );
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(r.steps).toHaveLength(1);
    expect(existsSync(r.path("66-slow"))).toBe(false);
    expect(branches(r)).toEqual(before);
    expect(records(r)).toEqual([]);
  });

  it("fails when HOME does not resolve, before touching git", () => {
    const r = repo();
    const parent = detachedParent(r);
    const before = branches(r);
    const res = runWorktreeHook(
      "create",
      "claude",
      JSON.stringify(createBody(parent, "agent-nohome")),
      { ...r.deps(parent), env: { CLAUDECODE: "1", HOME: "relative/home" } },
      r.primary,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("HOME");
    expect(branches(r)).toEqual(before);
  });
});

describe("CLI entrypoint", () => {
  function cli(r: Repo, args: string[], input: string, cwd = r.primary) {
    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(r.primary, "wardens", "src", "cli.ts"),
        "worktree",
        ...args,
      ],
      {
        cwd,
        input,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDECODE: "1",
          PANOPTICON_AGENT: "claude",
          HOME: r.home,
        },
      },
    );
  }

  it("takes its anchor from the bundle location, runs despite the agent markers and prints only the path", () => {
    const r = repo();
    installSources(r);
    const parent = detachedParent(r);
    const res = cli(
      r,
      ["create", "--tool", "claude"],
      JSON.stringify(createBody(parent, "agent-cli1")),
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${r.path("agent-cli1")}\n`);
    const removed = cli(
      r,
      ["remove", "--tool", "claude"],
      JSON.stringify(removeBody(r.primary, r.path("agent-cli1"))),
    );
    expect(removed.status).toBe(0);
    expect(existsSync(r.path("agent-cli1"))).toBe(false);
  });

  it.each(CWD_SHAPES)(
    "removes a worktree while the hook process itself runs inside it (payload cwd %s)",
    (shape) => {
      const r = repo();
      installSources(r);
      const wt = subagent(r, "agent-cli3");
      const sent = {
        ...payload("worktree-remove.json", { __WORKTREE__: wt }),
        cwd: shape === "recorded" ? wt : r.primary,
      };
      const removed = cli(
        r,
        ["remove", "--tool", "claude"],
        JSON.stringify(sent),
        wt,
      );
      expect(removed.stdout).toBe("");
      expect(removed.status).toBe(0);
      expect(removed.stderr).toContain("removed agent-cli3");
      expect(existsSync(wt)).toBe(false);
      expect(branches(r)).not.toContain("worktree-agent-cli3");
    },
  );

  it("refuses a cwd outside the repository of the bundle", () => {
    const r = repo();
    installSources(r);
    const other = repo();
    const res = cli(
      r,
      ["create", "--tool", "claude"],
      JSON.stringify(createBody(other.primary, "agent-cli2")),
    );
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("another repository");
  });

  it("keeps the human-only paths closed for agents and rejects create without --tool", () => {
    const r = repo();
    installSources(r);
    expect(cli(r, ["new", "42"], "").status).toBe(2);
    const bare = cli(r, ["create"], "{}");
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("Blocked by Warden");
    expect(cli(r, ["list", "--tool", "claude"], "{}").status).toBe(2);
  });

  it("keeps noisy setup steps off stdout", () => {
    const r = repo({
      charter: (charter) => {
        const worktree = charter.worktree as {
          setup: { steps: string[] };
        };
        worktree.setup.steps = ["echo noisy-stdout; echo noisy-stderr 1>&2"];
      },
    });
    const res = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(import.meta.dirname, "noisy-runner.ts"),
        r.primary,
        r.home,
      ],
      {
        cwd: r.primary,
        input: JSON.stringify(createBody(r.primary, "66-noisy")),
        encoding: "utf8",
      },
    );
    expect(res.stderr).toContain("noisy-stdout");
    expect(res.stderr).toContain("noisy-stderr");
    expect(res.stdout).toBe(`${r.path("66-noisy")}\n`);
    expect(res.status).toBe(0);
  });
});
