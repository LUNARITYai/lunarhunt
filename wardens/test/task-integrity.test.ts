import { execFileSync } from "node:child_process";
import {
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
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkPrimaryBehind,
  checkTaskIntegrity,
} from "../src/doctor-worktree.ts";
import { runHook } from "../src/engine.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { taskId } from "../src/task-integrity.ts";
import { type Deps, runWorktree } from "../src/worktree/index.ts";
import { normativeCharter } from "./support.ts";

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

const NEXT = "Ask Krzysztof to run wardens worktree setup";

type Fixture = {
  origin: string;
  primary: string;
  home: string;
  wt: string;
  tasksDir: string;
  deps: Deps;
  /** Arguments of every `gh` call the commands made. */
  ghCalls: string[][];
};

const REMOTE = "https://github.com/o/r.git";

/** A primary clone with one task worktree made by `wardens worktree new` (issue 5, Allowed paths `wardens/**`). */
function fixture(options: { worktree?: boolean } = {}): Fixture {
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
  // GitHub's URL on record (what setup parses), fetched from the local origin.
  sh(primary, "config", "remote.origin.url", REMOTE);
  sh(primary, "config", `url.${origin}.insteadOf`, REMOTE);
  const home = join(base, "home");
  mkdirSync(home);
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

function hashFiles(f: Fixture): string[] {
  return existsSync(f.tasksDir) ? readdirSync(f.tasksDir) : [];
}

function setupAgain(f: Fixture, refresh = false) {
  return runWorktree(
    { sub: "setup", ...(refresh ? { refresh: true } : {}) },
    { ...f.deps, cwd: f.wt },
  );
}

function taskFile(f: Fixture): string {
  return join(f.wt, ".panopticon", "task.json");
}

function widen(f: Fixture): void {
  const task = JSON.parse(readFileSync(taskFile(f), "utf8"));
  task.allowed_paths.push("docs/**");
  writeFileSync(taskFile(f), JSON.stringify(task));
}

/** `allow`, or `<decision> <message>` for a hook run with a trusted primary. */
function hook(f: Fixture, tool: string, input: object, cwd = f.wt): string {
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

function edit(f: Fixture, rel: string, cwd = f.wt): string {
  return hook(f, "Write", { file_path: join(cwd, rel), content: "x" }, cwd);
}

describe("task.json integrity", () => {
  it("worktree new records one hash and the task scope applies", () => {
    const f = fixture();
    expect(hashFiles(f)).toHaveLength(1);
    expect(hashFiles(f)[0]).toMatch(/^[0-9a-f]+\.sha256$/);
    expect(edit(f, "wardens/x.ts")).toBe("allow");
    expect(edit(f, "docs/y.md")).toMatch(/^deny .*scope-guard/);
  });

  it("denies when task.json no longer matches the recorded hash, even if it widens scope", () => {
    const f = fixture();
    widen(f);
    const verdict = edit(f, "docs/y.md");
    expect(verdict).toMatch(/^deny /);
    expect(verdict).toContain(NEXT);
    expect(verdict.slice(5)).toMatch(MESSAGE_PATTERN);
    expect(verdict).toContain("scope-guard");
    // The previously allowed path is denied too: the file cannot be believed.
    expect(edit(f, "wardens/x.ts")).toContain(NEXT);
  });

  it("denies write commands on a mismatch and still allows a read-only command", () => {
    const f = fixture();
    widen(f);
    expect(hook(f, "Bash", { command: "touch wardens/new.ts" })).toContain(
      NEXT,
    );
    expect(hook(f, "Bash", { command: "git status" })).toBe("allow");
  });

  it("denies when task.json exists but no hash was recorded (migration)", () => {
    const f = fixture();
    for (const file of hashFiles(f)) {
      rmSync(join(f.tasksDir, file));
    }
    const verdict = edit(f, "wardens/x.ts");
    expect(verdict).toMatch(/^deny /);
    expect(verdict).toContain(NEXT);
  });

  it("keeps the Charter scope when there is no task.json (subagent worktrees)", () => {
    const f = fixture();
    const sub = join(f.primary, ".claude", "worktrees", "agent-abc123");
    sh(f.primary, "worktree", "add", "-q", "-b", "worktree-agent-abc123", sub);
    expect(existsSync(join(sub, ".panopticon", "task.json"))).toBe(false);
    expect(edit(f, "docs/y.md", sub)).toBe("allow");
    expect(edit(f, "infra/main.tf", sub)).toMatch(/^deny .*scope-guard/);
  });

  it("worktree setup restores the issue's scope instead of blessing a tampered file", () => {
    const f = fixture();
    widen(f);
    expect(setupAgain(f).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(taskFile(f), "utf8")).allowed_paths).toEqual(
      ["wardens/**"],
    );
    expect(edit(f, "wardens/x.ts")).toBe("allow");
    expect(edit(f, "docs/y.md")).toMatch(/^deny .*scope-guard/);
  });

  it("worktree setup migrates a worktree that has no recorded hash", () => {
    const f = fixture();
    for (const file of hashFiles(f)) {
      rmSync(join(f.tasksDir, file));
    }
    expect(setupAgain(f).exitCode).toBe(0);
    expect(hashFiles(f)).toHaveLength(1);
    expect(edit(f, "wardens/x.ts")).toBe("allow");
  });

  it("setup with an unchanged, recorded task.json keeps working offline", () => {
    const f = fixture();
    const offline = {
      ...f.deps,
      cwd: f.wt,
      gh: () => ({ status: 1, stdout: "" }),
    };
    expect(runWorktree({ sub: "setup" }, offline).exitCode).toBe(0);
  });
});

describe("a recorded worktree whose task.json is gone", () => {
  it("is denied, not given the Charter scope, however the file disappears", () => {
    const removals: ((f: Fixture) => void)[] = [
      (f) => rmSync(taskFile(f)),
      (f) => renameSync(join(f.wt, ".panopticon"), join(f.wt, ".p")),
      (f) => rmSync(join(f.wt, ".panopticon"), { recursive: true }),
    ];
    for (const remove of removals) {
      const f = fixture();
      remove(f);
      for (const verdict of [
        edit(f, "docs/y.md"),
        edit(f, "wardens/x.ts"),
        hook(f, "Bash", { command: "touch docs/y.md" }),
      ]) {
        expect(verdict).toMatch(/^deny /);
        expect(verdict).toContain(NEXT);
      }
      expect(hook(f, "Bash", { command: "git status" })).toBe("allow");
      expect(checkTaskIntegrity(f.primary, f.home).status).toBe("fail");
    }
  });

  it("worktree setup restores it from the issue", () => {
    const f = fixture();
    rmSync(join(f.wt, ".panopticon"), { recursive: true });
    expect(setupAgain(f).exitCode).toBe(0);
    expect(edit(f, "wardens/x.ts")).toBe("allow");
    expect(edit(f, "docs/y.md")).toMatch(/^deny .*scope-guard/);
  });
});

describe("setup reads the issue from the primary's origin", () => {
  it("pins -R to the owner/repo of the primary's remote.origin.url", () => {
    const f = fixture();
    expect(setupAgain(f, true).exitCode).toBe(0);
    const issueCalls = f.ghCalls.filter((c) => c[0] === "issue");
    expect(issueCalls.length).toBeGreaterThan(1);
    for (const call of issueCalls) {
      expect(call.slice(-2)).toEqual(["-R", "o/r"]);
    }
  });

  it("accepts ssh and .git-less spellings of a GitHub remote", () => {
    for (const url of [
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r",
      "https://github.com/o/r",
    ]) {
      const f = fixture();
      sh(f.primary, "config", "remote.origin.url", url);
      sh(f.primary, "config", `url.${f.origin}.insteadOf`, url);
      expect(setupAgain(f, true).exitCode).toBe(0);
      expect(f.ghCalls.at(-1)?.slice(-2)).toEqual(["-R", "o/r"]);
    }
  });

  it("fails with a next action when the remote is not a GitHub repository", () => {
    const f = fixture();
    sh(f.primary, "config", "remote.origin.url", f.origin);
    const res = setupAgain(f, true);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.trim()).toMatch(MESSAGE_PATTERN);
    expect(res.stderr).toContain("remote");
  });

  it("denies git commands that rewrite remotes or refs, and allows reading them", () => {
    const f = fixture();
    for (const command of [
      "git remote set-url origin https://github.com/evil/x.git",
      "git remote add evil https://github.com/evil/x.git",
      "git remote rename origin gone",
      "git remote remove origin",
      "git update-ref -d refs/remotes/origin/main",
      "git update-ref refs/remotes/origin/main HEAD",
    ]) {
      expect(hook(f, "Bash", { command })).toMatch(/^deny .*command-guard/);
    }
    for (const command of [
      "git remote -v",
      "git remote",
      "git remote get-url origin",
      "git remote show origin",
    ]) {
      expect(hook(f, "Bash", { command })).toBe("allow");
    }
  });
});

describe("worktree remove", () => {
  it("drops the record of the removed worktree", () => {
    const f = fixture();
    expect(hashFiles(f)).toHaveLength(1);
    const res = runWorktree(
      { sub: "remove", arg: "5-fix-the-thing", force: true },
      f.deps,
    );
    expect(res.exitCode).toBe(0);
    expect(hashFiles(f)).toEqual([]);
  });
});

describe("task id", () => {
  const insensitive = (() => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wardens-case-")));
    bases.push(dir);
    return existsSync(dir.toUpperCase());
  })();

  it("is the same for a symlinked spelling of the primary", () => {
    const f = fixture();
    const link = `${f.primary}-link`;
    symlinkSync(f.primary, link);
    expect(taskId(link, f.wt)).toBe(taskId(f.primary, f.wt));
  });

  it.skipIf(!insensitive)(
    "is the same for a differently-cased spelling on a case-insensitive file system",
    () => {
      const f = fixture();
      expect(taskId(f.primary.toUpperCase(), f.wt.toUpperCase())).toBe(
        taskId(f.primary, f.wt),
      );
    },
  );

  it("depends on the primary and the worktree path only, not on files inside the worktree", () => {
    const f = fixture();
    const before = hashFiles(f);
    writeFileSync(join(f.wt, ".panopticon", "extra"), "x");
    widen(f);
    expect(setupAgain(f).exitCode).toBe(0);
    expect(hashFiles(f)).toEqual(before);
    expect(taskId(f.primary, f.wt)).toBe(before[0]?.replace(".sha256", ""));
    expect(taskId(f.primary, join(f.wt, "..", "other"))).not.toBe(
      taskId(f.primary, f.wt),
    );
  });

  it("setup fails closed without a resolvable HOME", () => {
    const f = fixture();
    const res = setupAgain({ ...f, deps: { ...f.deps, env: { HOME: "" } } });
    expect(res.exitCode).toBe(2);
    expect(res.stderr.trim()).toMatch(MESSAGE_PATTERN);
  });
});

describe("doctor task-integrity", () => {
  it("is ok for a recorded, unchanged task.json and for a worktree without one", () => {
    const f = fixture();
    sh(
      f.primary,
      "worktree",
      "add",
      "-q",
      "-b",
      "b-sub",
      join(f.primary, ".claude", "worktrees", "agent-1"),
    );
    const res = checkTaskIntegrity(f.primary, f.home);
    expect(res.id).toBe("task-integrity");
    expect(res.status).toBe("ok");
  });

  it("says so when HOME cannot be resolved, when there is no task.json, and when a record is orphaned", () => {
    const f = fixture();
    const noHome = checkTaskIntegrity(f.primary, "");
    expect(noHome.status).toBe("warn");
    expect(noHome.message).toContain("HOME");
    const none = fixture({ worktree: false });
    const empty = checkTaskIntegrity(none.primary, none.home);
    expect(empty.status).toBe("ok");
    expect(empty.message).toContain("no task worktree");
    sh(f.primary, "worktree", "remove", "--force", f.wt);
    const orphan = checkTaskIntegrity(f.primary, f.home);
    expect(orphan.status).toBe("warn");
    expect(orphan.message).toContain("5-fix-the-thing");
    expect(orphan.message).toContain("orphan");
  });

  it("does not call another primary's record an orphan", () => {
    const f = fixture();
    const other = fixture({ worktree: false });
    // Both primaries share one HOME, so one tasks directory.
    expect(checkTaskIntegrity(other.primary, f.home).status).toBe("ok");
    expect(checkTaskIntegrity(f.primary, f.home).status).toBe("ok");
  });

  it("warns when a task.json has no recorded hash", () => {
    const f = fixture();
    for (const file of hashFiles(f)) {
      rmSync(join(f.tasksDir, file));
    }
    const res = checkTaskIntegrity(f.primary, f.home);
    expect(res.status).toBe("warn");
    expect(res.message).toContain("5-fix-the-thing");
    expect(res.message).toContain("wardens worktree setup");
  });

  it("fails when task.json changed after setup", () => {
    const f = fixture();
    widen(f);
    const res = checkTaskIntegrity(f.primary, f.home);
    expect(res.status).toBe("fail");
    expect(res.message).toContain("5-fix-the-thing");
  });
});

describe("doctor primary-behind", () => {
  function commitIn(dir: string, rel: string, text: string): void {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", `edit ${rel}`);
  }

  it("is ok when the primary equals origin/main", () => {
    const f = fixture();
    expect(checkPrimaryBehind(f.primary).status).toBe("ok");
  });

  it("warns and suggests git pull when origin/main changed wardens/ or the Charter", () => {
    for (const rel of ["wardens/x.ts", "panopticon.charter.yaml"]) {
      const f = fixture();
      commitIn(f.origin, rel, `changed ${rel}\n`);
      sh(f.primary, "fetch", "-q", "origin");
      const res = checkPrimaryBehind(f.primary);
      expect(res.id).toBe("primary-behind");
      expect(res.status).toBe("warn");
      expect(res.message).toContain("git pull");
    }
  });

  it("is ok when origin/main only changed other paths", () => {
    const f = fixture();
    commitIn(f.origin, "docs/note.md", "x\n");
    sh(f.primary, "fetch", "-q", "origin");
    expect(checkPrimaryBehind(f.primary).status).toBe("ok");
  });

  it("does not use the network: a stale fetched ref is what it compares", () => {
    const f = fixture();
    commitIn(f.origin, "wardens/x.ts", "unfetched\n");
    expect(checkPrimaryBehind(f.primary).status).toBe("ok");
  });

  it("warns when origin/main does not exist, because the ref can be deleted", () => {
    const f = fixture();
    sh(f.primary, "remote", "remove", "origin");
    const res = checkPrimaryBehind(f.primary);
    expect(res.status).toBe("warn");
    expect(res.message).toContain("origin/main");
  });

  it("describes a primary that is ahead or dirty without advising git pull", () => {
    const ahead = fixture();
    commitIn(ahead.primary, "wardens/x.ts", "local\n");
    const dirty = fixture();
    writeFileSync(join(dirty.primary, "wardens", "x.ts"), "edited\n");
    for (const f of [ahead, dirty]) {
      const res = checkPrimaryBehind(f.primary);
      expect(res.status).toBe("warn");
      expect(res.message).not.toContain("git pull");
      expect(res.message).not.toMatch(/\)\s*\./);
    }
    expect(checkPrimaryBehind(ahead.primary).message).toContain("ahead");
    expect(checkPrimaryBehind(dirty.primary).message).toContain("uncommitted");
  });
});
