import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { type Deps, runWorktree } from "../src/worktree/index.ts";
import { cliPath, normativeCharter } from "./support.ts";

type Issue = { title: string; labels: string[]; body: string };

const BODY = [
  "### Goal",
  "x",
  "",
  "### Allowed paths",
  "wardens/**",
  "- `docs/specs/**`",
  "",
  "### Depends on",
  "nothing",
].join("\n");

const FEATURE: Issue = {
  title: "Wardens: worktree CLI for the humans who run it every day",
  labels: ["type:feature", "area:wardens"],
  body: BODY,
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type Fixture = {
  primary: string;
  issues: Map<number, Issue>;
  prs: Map<string, string>;
  steps: { command: string; cwd: string }[];
  failStep: { command: string | null };
  deps: (over?: Partial<Deps>) => Deps;
};

function fixture(
  transform?: (charter: Record<string, unknown>) => void,
): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-wt-")));
  const origin = join(base, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "user.email", "t@example.com");
  sh(origin, "config", "user.name", "t");
  const charter = parse(normativeCharter()) as Record<string, unknown>;
  transform?.(charter);
  writeFileSync(join(origin, "panopticon.charter.yaml"), stringify(charter));
  writeFileSync(
    join(origin, ".env.example"),
    "COMPOSE_PROJECT_NAME=lunarhunt\nWEB_PORT=3000\nAPI_PORT=8000\nTASK_ISSUE=\n",
  );
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
  writeFileSync(join(primary, ".env"), "SECRET=hunter2-primary\n");

  const issues = new Map<number, Issue>();
  const prs = new Map<string, string>();
  const steps: { command: string; cwd: string }[] = [];
  const failStep: { command: string | null } = { command: null };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    env: {},
    cwd: primary,
    gh: (args) => {
      if (args[0] === "issue") {
        const issue = issues.get(Number(args[2]));
        return issue
          ? {
              status: 0,
              stdout: JSON.stringify({
                title: issue.title,
                body: issue.body,
                labels: issue.labels.map((name) => ({ name })),
              }),
            }
          : { status: 1, stdout: "" };
      }
      const state = prs.get(String(args[3]));
      return {
        status: 0,
        stdout: JSON.stringify(state ? [{ state }] : []),
      };
    },
    step: (command, cwd) => {
      steps.push({ command, cwd });
      return command === failStep.command ? 1 : 0;
    },
    ...over,
  });
  return { primary, issues, prs, steps, failStep, deps };
}

function wtPath(f: Fixture, name: string): string {
  return join(f.primary, ".claude", "worktrees", name);
}

describe("wardens worktree new", () => {
  it("creates worktree, branch, task.json, .env and setup.ok", () => {
    const f = fixture();
    f.issues.set(1042, FEATURE);
    const res = runWorktree({ sub: "new", arg: "1042" }, f.deps());
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    const name = "1042-wardens-worktree-cli-for-the-humans-who";
    const wt = wtPath(f, name);
    expect(res.stdout).toBe(`${wt}\n`);
    expect(sh(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`feat/${name}`);
    const task = JSON.parse(
      readFileSync(join(wt, ".panopticon", "task.json"), "utf8"),
    );
    expect(task).toEqual({
      issue: 1042,
      branch: `feat/${name}`,
      slug: "wardens-worktree-cli-for-the-humans-who",
      allowed_paths: ["wardens/**", "docs/specs/**"],
    });
    const env = readFileSync(join(wt, ".env"), "utf8");
    expect(env).toContain("TASK_ISSUE=1042");
    expect(env).toContain("WEB_PORT=30042");
    expect(env).toContain("API_PORT=31042");
    expect(env).toContain("COMPOSE_PROJECT_NAME=lunarhunt");
    expect(existsSync(join(wt, ".panopticon", "setup.ok"))).toBe(true);
    expect(f.steps.map((s) => s.command)).toEqual([
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "pnpm exec lefthook install",
    ]);
    expect(f.steps.every((s) => s.cwd === wt)).toBe(true);
  });

  it("uses --slug and maps type labels", () => {
    const f = fixture();
    f.issues.set(7, { ...FEATURE, labels: ["type:bug"] });
    const res = runWorktree(
      { sub: "new", arg: "7", slug: "Odd Slug!" },
      f.deps(),
    );
    expect(res.exitCode).toBe(0);
    expect(
      sh(wtPath(f, "7-odd-slug"), "rev-parse", "--abbrev-ref", "HEAD"),
    ).toBe("fix/7-odd-slug");
  });

  it("creates nothing and names the field when the type label is missing", () => {
    const f = fixture();
    f.issues.set(8, { ...FEATURE, labels: ["area:wardens"] });
    const res = runWorktree({ sub: "new", arg: "8" }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("type label");
    expect(existsSync(join(f.primary, ".claude", "worktrees"))).toBe(false);
    expect(sh(f.primary, "branch", "--list")).not.toContain("8-");
  });

  it("creates nothing when Allowed paths is empty or absent", () => {
    const f = fixture();
    f.issues.set(9, { ...FEATURE, body: "### Allowed paths\n\n### Next\nx" });
    f.issues.set(10, { ...FEATURE, body: "### Goal\nx" });
    for (const n of ["9", "10"]) {
      const res = runWorktree({ sub: "new", arg: n }, f.deps());
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("Allowed paths");
    }
    expect(existsSync(join(f.primary, ".claude", "worktrees"))).toBe(false);
  });

  it("never copies anything from the primary checkout but the template", () => {
    const f = fixture();
    f.issues.set(11, FEATURE);
    runWorktree({ sub: "new", arg: "11", slug: "s" }, f.deps());
    const wt = wtPath(f, "11-s");
    expect(readFileSync(join(wt, ".env"), "utf8")).not.toContain("hunter2");
    expect(
      readFileSync(join(wt, ".panopticon", "task.json"), "utf8"),
    ).not.toContain("hunter2");
  });

  it("fails on the first failing step and writes no setup.ok", () => {
    const f = fixture();
    f.issues.set(12, FEATURE);
    f.failStep.command = "uv sync --frozen";
    const res = runWorktree({ sub: "new", arg: "12", slug: "s" }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("uv sync --frozen");
    expect(f.steps).toHaveLength(2);
    expect(existsSync(join(wtPath(f, "12-s"), ".panopticon", "setup.ok"))).toBe(
      false,
    );
    expect(existsSync(join(wtPath(f, "12-s"), ".env"))).toBe(false);
  });

  it("fails naming both worktrees on a port collision", () => {
    const f = fixture();
    f.issues.set(5, FEATURE);
    f.issues.set(1005, FEATURE);
    expect(
      runWorktree({ sub: "new", arg: "5", slug: "a" }, f.deps()).exitCode,
    ).toBe(0);
    const res = runWorktree({ sub: "new", arg: "1005", slug: "b" }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("5-a");
    expect(res.stderr).toContain("1005-b");
    expect(existsSync(wtPath(f, "1005-b"))).toBe(false);
  });

  it("fails setup with a clear message when resources.database is set", () => {
    const f = fixture((c) => {
      const wt = c.worktree as { resources: Record<string, unknown> };
      wt.resources.database = "lunarhunt_t{issue}";
    });
    f.issues.set(13, FEATURE);
    const res = runWorktree({ sub: "new", arg: "13", slug: "s" }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not implemented in phase 0");
    expect(existsSync(join(wtPath(f, "13-s"), ".panopticon", "setup.ok"))).toBe(
      false,
    );
  });
});

describe("wardens worktree setup (standalone)", () => {
  it("derives issue, slug and type from the branch name", () => {
    const f = fixture();
    f.issues.set(77, FEATURE);
    const wt = join(f.primary, ".claude", "worktrees", "manual");
    sh(
      f.primary,
      "worktree",
      "add",
      "-q",
      "-b",
      "chore/77-tidy-up",
      wt,
      "origin/main",
    );
    const res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    const task = JSON.parse(
      readFileSync(join(wt, ".panopticon", "task.json"), "utf8"),
    );
    expect(task.issue).toBe(77);
    expect(task.slug).toBe("tidy-up");
    expect(task.branch).toBe("chore/77-tidy-up");
    expect(readFileSync(join(wt, ".env"), "utf8")).toContain("WEB_PORT=30077");
    expect(existsSync(join(wt, ".panopticon", "setup.ok"))).toBe(true);
  });

  it("refuses in the primary checkout and on foreign branch names", () => {
    const f = fixture();
    expect(runWorktree({ sub: "setup" }, f.deps()).exitCode).toBe(2);
    const wt = join(f.primary, ".claude", "worktrees", "agent-x");
    sh(
      f.primary,
      "worktree",
      "add",
      "-q",
      "-b",
      "worktree-agent-x",
      wt,
      "origin/main",
    );
    const res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("worktree-agent-x");
  });
});

describe("agent refusal", () => {
  const REFUSAL =
    "Blocked by Warden worktree-guard: wardens worktree grants task scope and is for humans. Ask Krzysztof to run it.\n";

  it("refuses new, setup, remove and prune but allows list", () => {
    const f = fixture();
    for (const env of [{ CLAUDECODE: "1" }, { PANOPTICON_AGENT: "cursor" }]) {
      for (const sub of ["new", "setup", "remove", "prune"]) {
        const res = runWorktree({ sub, arg: "1" }, f.deps({ env }));
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toBe(REFUSAL);
      }
      expect(runWorktree({ sub: "list" }, f.deps({ env })).exitCode).toBe(0);
    }
  });

  it("is wired into the CLI", () => {
    const f = fixture();
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "worktree", "prune"],
      {
        cwd: f.primary,
        env: { PATH: process.env.PATH ?? "", CLAUDECODE: "1" },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toBe(REFUSAL);
  });
});

describe("wardens worktree list", () => {
  it("prints name, branch, issue, setup.ok and PR state per linked worktree", () => {
    const f = fixture();
    f.issues.set(21, FEATURE);
    runWorktree({ sub: "new", arg: "21", slug: "one" }, f.deps());
    f.prs.set("feat/21-one", "OPEN");
    const wt = join(f.primary, ".claude", "worktrees", "bare");
    sh(f.primary, "worktree", "add", "-q", "-b", "scratch", wt, "origin/main");
    const res = runWorktree({ sub: "list" }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split("\n").sort()).toEqual([
      "21-one\tfeat/21-one\t#21\tsetup.ok yes\tPR OPEN",
      "bare\tscratch\t-\tsetup.ok no\tPR none",
    ]);
  });
});

describe("wardens worktree remove", () => {
  function made(issue: number, slug: string) {
    const f = fixture();
    f.issues.set(issue, FEATURE);
    runWorktree({ sub: "new", arg: String(issue), slug }, f.deps());
    return { f, name: `${issue}-${slug}`, branch: `feat/${issue}-${slug}` };
  }

  it("refuses uncommitted changes, unpushed commits and an enclosing cwd", () => {
    const { f, name } = made(31, "a");
    const wt = wtPath(f, name);
    writeFileSync(join(wt, "x.txt"), "x");
    let res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("uncommitted");
    sh(wt, "add", "x.txt");
    sh(wt, "commit", "-q", "-m", "x");
    res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unpushed");
    res = runWorktree(
      { sub: "remove", arg: name, force: true },
      f.deps({ cwd: join(wt, ".panopticon") }),
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("inside");
    expect(existsSync(wt)).toBe(true);
    res = runWorktree({ sub: "remove", arg: name, force: true }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("removes a clean worktree and deletes its merged branch", () => {
    const { f, name, branch } = made(32, "b");
    const res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    expect(existsSync(wtPath(f, name))).toBe(false);
    expect(sh(f.primary, "branch", "--list", branch)).toBe("");
  });

  it("keeps an unmerged branch", () => {
    const { f, name, branch } = made(33, "c");
    const wt = wtPath(f, name);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "work");
    sh(wt, "push", "-q", "origin", branch);
    const res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(sh(f.primary, "branch", "--list", branch)).toContain(branch);
  });

  it("deletes a squash-merged branch (PR MERGED, not an ancestor)", () => {
    const { f, name, branch } = made(34, "s");
    const wt = wtPath(f, name);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "work");
    sh(wt, "push", "-q", "origin", branch);
    f.prs.set(branch, "MERGED");
    const res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`deleted branch ${branch}`);
    expect(sh(f.primary, "branch", "--list", branch)).toBe("");
  });

  it("prune removes a closed-PR worktree but keeps its branch", () => {
    const { f, name, branch } = made(35, "x");
    const wt = wtPath(f, name);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "work");
    sh(wt, "push", "-q", "origin", branch);
    f.prs.set(branch, "CLOSED");
    const res = runWorktree({ sub: "prune" }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(sh(f.primary, "branch", "--list", branch)).toContain(branch);
  });

  it("fails on an unknown name", () => {
    const f = fixture();
    expect(runWorktree({ sub: "remove", arg: "nope" }, f.deps()).exitCode).toBe(
      2,
    );
  });
});

describe("wardens worktree prune", () => {
  it("removes merged and closed worktrees and lists the rest", () => {
    const f = fixture();
    for (const [n, s] of [
      [41, "m"],
      [42, "c"],
      [43, "o"],
      [44, "d"],
      [45, "n"],
    ] as const) {
      f.issues.set(n, FEATURE);
      runWorktree({ sub: "new", arg: String(n), slug: s }, f.deps());
    }
    f.prs.set("feat/41-m", "MERGED");
    f.prs.set("feat/42-c", "CLOSED");
    f.prs.set("feat/43-o", "OPEN");
    f.prs.set("feat/44-d", "MERGED");
    writeFileSync(join(wtPath(f, "44-d"), "dirty.txt"), "x");
    const res = runWorktree({ sub: "prune" }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(existsSync(wtPath(f, "41-m"))).toBe(false);
    expect(existsSync(wtPath(f, "42-c"))).toBe(false);
    expect(existsSync(wtPath(f, "43-o"))).toBe(true);
    expect(existsSync(wtPath(f, "44-d"))).toBe(true);
    expect(existsSync(wtPath(f, "45-n"))).toBe(true);
    expect(res.stdout).toContain("kept 43-o: PR OPEN");
    expect(res.stdout).toContain("kept 44-d: 44-d has uncommitted changes");
    expect(res.stdout).toContain("kept 45-n: PR none");
  });
});

describe("worktree section absent", () => {
  it("refuses every subcommand with an engine message", () => {
    const f = fixture((c) => {
      delete c.worktree;
    });
    for (const sub of ["new", "setup", "list", "remove", "prune"]) {
      const res = runWorktree({ sub, arg: "1" }, f.deps());
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("Blocked by Warden engine:");
      expect(res.stderr).toContain("worktree: section");
    }
  });
});
