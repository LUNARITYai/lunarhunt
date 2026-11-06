import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import {
  type Deps,
  type Result,
  runWorktree as runWorktreeRaw,
  type WorktreeArgs,
} from "../src/worktree/index.ts";
import { cliPath, forgePointer, normativeCharter } from "./support.ts";

const noPasswd = join(import.meta.dirname, "no-passwd.mjs");

type Issue = {
  title: string;
  labels: string[];
  body: string;
  state?: string;
  url?: string;
};

const bases: string[] = [];
const failures: string[] = [];

afterAll(() => {
  for (const dir of bases) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Records every failing stderr so one test can check the C-30 format. */
function runWorktree(args: WorktreeArgs, deps: Deps): Result {
  const res = runWorktreeRaw(args, deps);
  if (res.exitCode !== 0) {
    failures.push(res.stderr);
  }
  return res;
}

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
  prHead: Map<string, string>;
  prBase: Map<string, string>;
  ghFail: { on: boolean };
  steps: { command: string; cwd: string }[];
  failStep: { command: string | null };
  deps: (over?: Partial<Deps>) => Deps;
};

function fixture(
  transform?: (charter: Record<string, unknown>) => void,
): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-wt-")));
  bases.push(base);
  const origin = join(base, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "commit.gpgsign", "false");
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
  sh(primary, "config", "commit.gpgsign", "false");
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  writeFileSync(join(primary, ".env"), "SECRET=hunter2-primary\n");

  const issues = new Map<number, Issue>();
  const prs = new Map<string, string>();
  const prHead = new Map<string, string>();
  const prBase = new Map<string, string>();
  const steps: { command: string; cwd: string }[] = [];
  const failStep: { command: string | null } = { command: null };
  const ghFail = { on: false };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    env: {},
    cwd: primary,
    gh: (args) => {
      if (ghFail.on) {
        return { status: 1, stdout: "" };
      }
      if (args[0] === "issue") {
        const issue = issues.get(Number(args[2]));
        return issue
          ? {
              status: 0,
              stdout: JSON.stringify({
                title: issue.title,
                body: issue.body,
                labels: issue.labels.map((name) => ({ name })),
                state: issue.state ?? "OPEN",
                url: issue.url ?? `https://github.com/o/r/issues/${args[2]}`,
              }),
            }
          : { status: 1, stdout: "" };
      }
      const branch = String(args[3]);
      const state = prs.get(branch);
      if (state === undefined || (args[5] === "merged" && state !== "MERGED")) {
        return { status: 0, stdout: "[]" };
      }
      let head = prHead.get(branch);
      if (head === undefined) {
        try {
          head = sh(primary, "rev-parse", `refs/heads/${branch}`);
        } catch {
          head = "0".repeat(40);
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            state,
            headRefOid: head,
            baseRefName: prBase.get(branch) ?? "main",
          },
        ]),
      };
    },
    step: (command, cwd) => {
      steps.push({ command, cwd });
      return command === failStep.command ? 1 : 0;
    },
    ...over,
  });
  return {
    primary,
    issues,
    prs,
    prHead,
    prBase,
    steps,
    failStep,
    ghFail,
    deps,
  };
}

function wtPath(f: Fixture, name: string): string {
  return join(f.primary, ".claude", "worktrees", name);
}

describe("wardens worktree new", () => {
  it("creates worktree, branch, task.json, .env and setup.ok", () => {
    const f = fixture();
    f.issues.set(1042, FEATURE);
    const res = runWorktree({ sub: "new", arg: "1042" }, f.deps());
    expect(res.stderr).toBe(
      "granted allowed_paths: wardens/**, docs/specs/**\n",
    );
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
    const wt = join(f.primary, ".claude", "worktrees", "77-tidy-up");
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
    expect(res.stderr).toBe(
      "granted allowed_paths: wardens/**, docs/specs/**\n",
    );
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

describe("wardens worktree reads the Charter of the primary (#73)", () => {
  function linked(f: Fixture, name: string, branch: string): string {
    const wt = join(f.primary, ".claude", "worktrees", name);
    sh(f.primary, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
    return wt;
  }

  it("ignores a Charter edited on the invoker's branch", () => {
    const f = fixture();
    f.issues.set(77, FEATURE);
    const wt = linked(f, "77-tidy-up", "chore/77-tidy-up");
    const own = parse(normativeCharter()) as {
      worktree: { setup: { steps: string[] } };
    };
    own.worktree.setup.steps = ["touch pwned"];
    writeFileSync(join(wt, "panopticon.charter.yaml"), stringify(own));
    const res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(0);
    expect(f.steps.map((s) => s.command)).toEqual([
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "pnpm exec lefthook install",
    ]);
  });

  it("does not follow a forged .git pointer when the bundle is untrusted", () => {
    const f = fixture();
    const wt = join(f.primary, ".claude", "worktrees", "99-evil");
    const fake = forgePointer(wt);
    writeFileSync(join(fake, "panopticon.charter.yaml"), "version: [\n");
    for (const sub of ["list", "setup"]) {
      const res = runWorktree({ sub }, f.deps({ cwd: wt }));
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("not a verified primary checkout");
      expect(res.stderr).not.toContain("Charter validation failed");
    }
  });

  it("takes the trusted primary from the CLI when it passes one", () => {
    const f = fixture();
    f.issues.set(77, FEATURE);
    const wt = linked(f, "77-tidy-up", "chore/77-tidy-up");
    const other = fixture((charter) => {
      (charter.worktree as { setup: { steps: string[] } }).setup.steps = [
        "echo trusted",
      ];
    });
    const res = runWorktree(
      { sub: "setup" },
      f.deps({ cwd: wt, charterRoot: other.primary }),
    );
    expect(res.exitCode).toBe(0);
    expect(f.steps.map((s) => s.command)).toEqual(["echo trusted"]);
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

  it("refuses an agent before resolving any primary, with no HOME and no passwd entry", () => {
    const f = fixture();
    const res = spawnSync(
      process.execPath,
      [
        "--import",
        noPasswd,
        "--experimental-strip-types",
        cliPath,
        "worktree",
        "prune",
      ],
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

function manualWorktree(f: Fixture, name: string, branch: string): string {
  const wt = wtPath(f, name);
  sh(f.primary, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
  return wt;
}

describe("hardening: new", () => {
  it("rejects loose issue numbers before calling gh", () => {
    const f = fixture();
    const calls: string[][] = [];
    for (const arg of ["1e3", "0x10", " 5 ", "0", "-3", "1234567890", ""]) {
      const res = runWorktree(
        { sub: "new", arg },
        f.deps({
          gh: (args) => {
            calls.push(args);
            return { status: 1, stdout: "" };
          },
        }),
      );
      expect(res.exitCode).toBe(2);
    }
    expect(calls).toEqual([]);
  });

  it("requires an open issue that is not a pull request", () => {
    const f = fixture();
    f.issues.set(1, { ...FEATURE, state: "CLOSED" });
    f.issues.set(2, { ...FEATURE, url: "https://github.com/o/r/pull/2" });
    expect(runWorktree({ sub: "new", arg: "1" }, f.deps()).stderr).toContain(
      "not open",
    );
    expect(runWorktree({ sub: "new", arg: "2" }, f.deps()).stderr).toContain(
      "not an issue",
    );
    expect(existsSync(join(f.primary, ".claude", "worktrees"))).toBe(false);
  });

  it("rejects several or unknown type labels", () => {
    const f = fixture();
    f.issues.set(3, { ...FEATURE, labels: ["type:bug", "type:chore"] });
    f.issues.set(4, { ...FEATURE, labels: ["type:wat"] });
    expect(runWorktree({ sub: "new", arg: "3" }, f.deps()).stderr).toContain(
      "several type:* labels",
    );
    expect(runWorktree({ sub: "new", arg: "4" }, f.deps()).stderr).toContain(
      "unknown type label type:wat",
    );
    expect(existsSync(join(f.primary, ".claude", "worktrees"))).toBe(false);
  });

  it("maps chore, docs and spike labels", () => {
    const f = fixture();
    const cases = [
      ["type:chore", "chore"],
      ["type:docs", "docs"],
      ["type:spike", "spike"],
    ] as const;
    cases.forEach(([label, type], i) => {
      const n = 100 + i;
      f.issues.set(n, { ...FEATURE, labels: [label] });
      expect(
        runWorktree({ sub: "new", arg: String(n), slug: "s" }, f.deps())
          .exitCode,
      ).toBe(0);
      expect(sh(wtPath(f, `${n}-s`), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        `${type}/${n}-s`,
      );
    });
  });

  it("rejects bad Allowed paths and creates nothing", () => {
    const f = fixture();
    const bodies = [
      "### Allowed paths\na/**\n### Goal\nx\n### Allowed paths\nb/**",
      "### Allowed paths\n../outside/**",
      "### Allowed paths\n/etc/**",
      "### Allowed paths\n!wardens/**",
      "### Allowed paths\n`a/../b`",
    ];
    bodies.forEach((body, i) => {
      f.issues.set(200 + i, { ...FEATURE, body });
      const res = runWorktree({ sub: "new", arg: String(200 + i) }, f.deps());
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("Allowed paths");
    });
    expect(existsSync(join(f.primary, ".claude", "worktrees"))).toBe(false);
    expect(sh(f.primary, "branch", "--list")).not.toContain("feat/");
  });

  it("ignores a fake heading and entries inside fenced blocks", () => {
    const f = fixture();
    const body = [
      "### Goal",
      "```",
      "### Allowed paths",
      "evil/**",
      "```",
      "### Allowed paths",
      "good/**",
      "```",
      "fenced/**",
      "```",
      "",
      "### Next",
    ].join("\n");
    f.issues.set(210, { ...FEATURE, body });
    const res = runWorktree({ sub: "new", arg: "210", slug: "s" }, f.deps());
    expect(res.exitCode).toBe(0);
    const task = JSON.parse(
      readFileSync(
        join(wtPath(f, "210-s"), ".panopticon", "task.json"),
        "utf8",
      ),
    );
    expect(task.allowed_paths).toEqual(["good/**"]);
  });

  it("writes .env with mode 0600", () => {
    const f = fixture();
    f.issues.set(220, FEATURE);
    runWorktree({ sub: "new", arg: "220", slug: "s" }, f.deps());
    expect(statSync(join(wtPath(f, "220-s"), ".env")).mode & 0o777).toBe(0o600);
  });

  it("detects a port collision through the branch-name fallback", () => {
    const f = fixture();
    manualWorktree(f, "5-a", "feat/5-a");
    f.issues.set(1005, FEATURE);
    const res = runWorktree({ sub: "new", arg: "1005", slug: "b" }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("5-a");
    expect(res.stderr).toContain("1005-b");
  });
});

describe("hardening: standalone setup", () => {
  it("detects a port collision", () => {
    const f = fixture();
    manualWorktree(f, "6-a", "feat/6-a");
    const wt = manualWorktree(f, "1006-b", "feat/1006-b");
    f.issues.set(1006, FEATURE);
    const res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("6-a");
    expect(res.stderr).toContain("1006-b");
  });

  it("requires the directory prefix to match the branch issue", () => {
    const f = fixture();
    const wt = manualWorktree(f, "99-x", "feat/77-x");
    f.issues.set(77, FEATURE);
    const res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("does not start with 77-");
    expect(existsSync(join(wt, ".panopticon"))).toBe(false);
  });

  it("keeps a valid task.json unless --refresh, and prints the grant", () => {
    const f = fixture();
    f.issues.set(78, FEATURE);
    runWorktree({ sub: "new", arg: "78", slug: "k" }, f.deps());
    const wt = wtPath(f, "78-k");
    f.issues.set(78, { ...FEATURE, body: "### Allowed paths\n**" });
    let res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe(
      "granted allowed_paths: wardens/**, docs/specs/**\n",
    );
    const file = join(wt, ".panopticon", "task.json");
    expect(JSON.parse(readFileSync(file, "utf8")).allowed_paths).toEqual([
      "wardens/**",
      "docs/specs/**",
    ]);
    res = runWorktree({ sub: "setup", refresh: true }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("granted allowed_paths: **\n");
    expect(JSON.parse(readFileSync(file, "utf8")).allowed_paths).toEqual([
      "**",
    ]);
  });

  it("refuses to write through symlinks and checks the template first", () => {
    const f = fixture();
    f.issues.set(79, FEATURE);
    runWorktree({ sub: "new", arg: "79", slug: "l" }, f.deps());
    const wt = wtPath(f, "79-l");
    const target = join(f.primary, "..", "victim.txt");
    writeFileSync(target, "keep");
    rmSync(join(wt, ".env"));
    symlinkSync(target, join(wt, ".env"));
    let res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain(".env");
    expect(readFileSync(target, "utf8")).toBe("keep");
    rmSync(join(wt, ".env"));
    f.steps.length = 0;
    rmSync(join(wt, ".env.example"));
    symlinkSync(target, join(wt, ".env.example"));
    res = runWorktree({ sub: "setup" }, f.deps({ cwd: wt }));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("env template");
    expect(f.steps).toEqual([]);
  });
});

describe("hardening: remove and prune", () => {
  function made(issue: number, slug: string) {
    const f = fixture();
    f.issues.set(issue, FEATURE);
    runWorktree({ sub: "new", arg: String(issue), slug }, f.deps());
    return { f, name: `${issue}-${slug}`, branch: `feat/${issue}-${slug}` };
  }

  it("fails closed when git cannot verify the worktree", () => {
    const { f, name } = made(50, "gone");
    rmSync(wtPath(f, name), { recursive: true, force: true });
    const res = runWorktree({ sub: "remove", arg: name }, f.deps());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("could not verify");
  });

  it("does not delete a branch whose tip differs from the merged PR head", () => {
    const { f, name, branch } = made(51, "t");
    const wt = wtPath(f, name);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "after merge");
    f.prs.set(branch, "MERGED");
    f.prHead.set(branch, "1".repeat(40));
    const res = runWorktree(
      { sub: "remove", arg: name, force: true },
      f.deps(),
    );
    expect(res.exitCode).toBe(0);
    expect(sh(f.primary, "branch", "--list", branch)).toContain(branch);
  });

  it("does not delete a branch merged into another base", () => {
    const { f, name, branch } = made(52, "b");
    f.prs.set(branch, "MERGED");
    f.prBase.set(branch, "develop");
    sh(wtPath(f, name), "commit", "-q", "--allow-empty", "-m", "w");
    const res = runWorktree(
      { sub: "remove", arg: name, force: true },
      f.deps(),
    );
    expect(res.exitCode).toBe(0);
    expect(sh(f.primary, "branch", "--list", branch)).toContain(branch);
  });

  it("never deletes a branch that does not match the convention", () => {
    const f = fixture();
    manualWorktree(f, "91-dev", "develop");
    const res = runWorktree({ sub: "remove", arg: "91-dev" }, f.deps());
    expect(res.exitCode).toBe(0);
    expect(sh(f.primary, "branch", "--list", "develop")).toContain("develop");
  });

  it("treats a squash-merged tip as pushed, so prune needs no --force", () => {
    const { f, name, branch } = made(53, "q");
    const wt = wtPath(f, name);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "work");
    f.prs.set(branch, "MERGED");
    const res = runWorktree({ sub: "prune" }, f.deps());
    expect(res.stdout).toContain(`removed ${name}, deleted branch ${branch}`);
    expect(existsSync(wt)).toBe(false);
  });

  it("only acts on task worktrees under the location root", () => {
    const f = fixture();
    manualWorktree(f, "agent-x", "worktree-agent-x");
    const outside = join(f.primary, "..", "outside-wt");
    sh(
      f.primary,
      "worktree",
      "add",
      "-q",
      "-b",
      "feat/60-o",
      outside,
      "origin/main",
    );
    f.prs.set("worktree-agent-x", "MERGED");
    f.prs.set("feat/60-o", "MERGED");
    const res = runWorktree({ sub: "prune" }, f.deps());
    expect(res.stdout).toContain("kept agent-x: not a task worktree");
    expect(res.stdout).toContain("kept outside-wt: not a task worktree");
    const rm = runWorktree({ sub: "remove", arg: "agent-x" }, f.deps());
    expect(rm.exitCode).toBe(2);
    expect(rm.stderr).toContain("not a task worktree");
  });

  it("refuses from inside the worktree without suggesting --force", () => {
    const { f, name } = made(54, "i");
    const wt = wtPath(f, name);
    f.prs.set(`feat/${name}`, "MERGED");
    const rm = runWorktree({ sub: "remove", arg: name }, f.deps({ cwd: wt }));
    expect(rm.exitCode).toBe(2);
    expect(rm.stderr).not.toContain("--force");
    const pr = runWorktree({ sub: "prune" }, f.deps({ cwd: wt }));
    expect(pr.stdout).toContain("kept");
    expect(existsSync(wt)).toBe(true);
  });

  it("keeps an unmerged branch's unpushed commits unless --force", () => {
    const { f, name } = made(55, "u");
    sh(wtPath(f, name), "commit", "-q", "--allow-empty", "-m", "w");
    expect(runWorktree({ sub: "remove", arg: name }, f.deps()).exitCode).toBe(
      2,
    );
    expect(
      runWorktree({ sub: "remove", arg: name, force: true }, f.deps()).exitCode,
    ).toBe(0);
  });

  it("still removes when resources.database is set", () => {
    const f = fixture((c) => {
      const wt = c.worktree as { resources: Record<string, unknown> };
      wt.resources.database = "lunarhunt_t{issue}";
    });
    manualWorktree(f, "70-d", "feat/70-d");
    const res = runWorktree({ sub: "remove", arg: "70-d" }, f.deps());
    expect(res.exitCode).toBe(0);
  });
});

describe("gh failures and agents", () => {
  it("shows a gh failure as unknown, not none, and prune keeps it", () => {
    const f = fixture();
    manualWorktree(f, "80-g", "feat/80-g");
    f.ghFail.on = true;
    expect(runWorktree({ sub: "list" }, f.deps()).stdout).toContain(
      "PR unknown (gh failed)",
    );
    const res = runWorktree({ sub: "prune" }, f.deps());
    expect(res.stdout).toContain("kept 80-g: PR unknown (gh failed)");
  });

  it("refuses with CURSOR_AGENT set", () => {
    const f = fixture();
    const res = runWorktree(
      { sub: "new", arg: "1" },
      f.deps({ env: { CURSOR_AGENT: "1" } }),
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("worktree-guard");
  });

  it("sends setup step output to stderr, not stdout", () => {
    const types = join(process.cwd(), "src", "worktree", "types.ts");
    const res = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "-e",
        `import(${JSON.stringify(types)}).then((m) => process.exit(m.realDeps.step("echo from-step", ".")))`,
      ],
      { encoding: "utf8" },
    );
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("from-step");
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

describe("message format", () => {
  it("every failing stderr starts with a C-30 line", () => {
    expect(failures.length).toBeGreaterThan(10);
    for (const stderr of failures) {
      const first = stderr.split("\n")[0] ?? "";
      expect(first, stderr).toMatch(MESSAGE_PATTERN);
    }
  });
});
