import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { type CheckResult, type DoctorDeps, runChecks } from "../src/doctor.ts";
import {
  checkTaskDatabases,
  checkWorktreeExclusions,
  checkWorktrees,
  type DatabasesUnavailable,
  psqlDatabases,
  type WorktreeCheckDeps,
} from "../src/doctor-worktree.ts";
import { GH_FAILED_STATE, prState } from "../src/worktree/index.ts";
import {
  charterWithoutWorktree,
  normativeCharter,
  repoRoot,
} from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;
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

const EXCLUSION_TEXT: Record<string, string> = {
  ".gitignore": ".env\n.claude/worktrees/\n",
  "biome.json": '{ "files": { "includes": ["!!.claude/worktrees"] } }\n',
  "tsconfig.base.json": '{ "exclude": [".claude/worktrees"] }\n',
  "pyproject.toml": 'exclude = [".claude/worktrees"]\n',
};

type Fixture = {
  primary: string;
  /** Adds a linked worktree; `setupOk` writes `.panopticon/setup.ok`. */
  addWorktree: (name: string, branch: string, setupOk?: boolean) => string;
  prs: Map<string, string>;
  ghFail: { on: boolean };
  databases: { list: string[] | DatabasesUnavailable | "throw" };
  deps: (now?: number) => WorktreeCheckDeps;
};

function fixture(
  options: { database?: string; charter?: string } = {},
): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-doctor-wt-")));
  bases.push(base);
  const primary = join(base, "primary");
  mkdirSync(primary);
  sh(primary, "init", "-q", "-b", "main");
  sh(primary, "config", "commit.gpgsign", "false");
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  let charter = options.charter ?? normativeCharter();
  if (options.database !== undefined) {
    const data = parse(charter) as {
      worktree: { resources: Record<string, unknown> };
    };
    data.worktree.resources.database = options.database;
    charter = stringify(data);
  }
  writeFileSync(join(primary, "panopticon.charter.yaml"), charter);
  for (const [file, text] of Object.entries(EXCLUSION_TEXT)) {
    writeFileSync(join(primary, file), text);
  }
  sh(primary, "add", "-A");
  sh(primary, "commit", "-q", "-m", "init");

  const prs = new Map<string, string>();
  const ghFail = { on: false };
  const databases: Fixture["databases"] = { list: [] };
  return {
    primary,
    prs,
    ghFail,
    databases,
    addWorktree: (name, branch, setupOk = true) => {
      const wt = join(primary, ".claude", "worktrees", name);
      sh(primary, "worktree", "add", "-q", "-b", branch, wt);
      if (setupOk) {
        mkdirSync(join(wt, ".panopticon"), { recursive: true });
        writeFileSync(join(wt, ".panopticon", "setup.ok"), "");
      }
      return wt;
    },
    deps: (now = Date.now()) => ({
      env: {},
      now: () => now,
      gh: (args) => {
        if (ghFail.on) {
          return { status: 1, stdout: "" };
        }
        const state = prs.get(String(args[3]));
        return {
          status: 0,
          stdout: JSON.stringify(state === undefined ? [] : [{ state }]),
        };
      },
      listDatabases: () => {
        if (databases.list === "throw") {
          throw new Error("boom");
        }
        return databases.list;
      },
    }),
  };
}

describe("doctor worktrees", () => {
  it("is ok for a set-up, fresh worktree without a finished PR", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    f.prs.set("feat/42-offer-crud", "OPEN");
    const res = checkWorktrees(f.primary, f.deps());
    expect(res).toEqual({
      id: "worktrees",
      status: "ok",
      message: "1 linked worktree is in use",
    });
  });

  it("pluralises the count", () => {
    const f = fixture();
    expect(checkWorktrees(f.primary, f.deps()).message).toBe(
      "0 linked worktrees are in use",
    );
    f.addWorktree("42-a", "feat/42-a");
    f.addWorktree("43-b", "feat/43-b");
    expect(checkWorktrees(f.primary, f.deps()).message).toBe(
      "2 linked worktrees are in use",
    );
  });

  it("gives advice that matches what prune does", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    expect(checkWorktrees(f.primary, f.deps()).message).toContain(
      "Run wardens worktree prune for merged/closed PRs; set up or remove the others with wardens worktree setup/remove",
    );
  });

  it("warns about a worktree without setup.ok and names it", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    f.addWorktree("43-fine", "feat/43-fine");
    const res = checkWorktrees(f.primary, f.deps());
    expect(res.status).toBe("warn");
    expect(res.message).toContain("42-offer-crud: no setup.ok");
    expect(res.message).not.toContain("43-fine");
  });

  it.each(["MERGED", "CLOSED"])("warns when the PR is %s", (state) => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    f.prs.set("feat/42-offer-crud", state);
    const res = checkWorktrees(f.primary, f.deps());
    expect(res.status).toBe("warn");
    expect(res.message).toContain(`42-offer-crud: PR ${state.toLowerCase()}`);
  });

  it("warns about a stale worktree, with the days and the limit", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    const fresh = checkWorktrees(f.primary, f.deps(Date.now() + 3 * DAY));
    expect(fresh.status).toBe("ok");
    const stale = checkWorktrees(f.primary, f.deps(Date.now() + 10 * DAY));
    expect(stale.status).toBe("warn");
    expect(stale.message).toContain(
      "42-offer-crud: no commit for 10 days (stale after 7)",
    );
  });

  it("uses the commit date, not the clock of the checkout", () => {
    const f = fixture();
    const wt = f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    execFileSync(
      "git",
      ["-C", wt, "commit", "-q", "--allow-empty", "-m", "old"],
      {
        env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old },
        stdio: "ignore",
      },
    );
    const res = checkWorktrees(f.primary, f.deps());
    expect(res.status).toBe("warn");
    expect(res.message).toContain("no commit for 30 days");
  });

  it("lists every reason of a worktree", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    f.prs.set("feat/42-offer-crud", "MERGED");
    const res = checkWorktrees(f.primary, f.deps(Date.now() + 9 * DAY));
    expect(res.message).toContain(
      "42-offer-crud: no setup.ok, PR merged, no commit for 9 days (stale after 7)",
    );
  });

  it("does not warn about the PR when gh fails, and says so", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    f.ghFail.on = true;
    const res = checkWorktrees(f.primary, f.deps());
    expect(res.status).toBe("ok");
    expect(res.message).toContain("PR state not checked: gh failed");
  });

  it("is skipped without a worktree: section in the Charter", () => {
    const f = fixture({ charter: charterWithoutWorktree() });
    f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    const res = checkWorktrees(f.primary, f.deps());
    expect(res.status).toBe("ok");
    expect(res.message).toMatch(/^skipped: .*no worktree: section/);
  });
});

describe("doctor task-databases", () => {
  const TEMPLATE = "lunarhunt_t{issue}";

  it("is skipped when worktree.resources.database is not set", () => {
    const f = fixture();
    f.databases.list = ["lunarhunt_t9"];
    const res = checkTaskDatabases(f.primary, f.deps());
    expect(res.status).toBe("ok");
    expect(res.message).toMatch(/^skipped: .*database is not set/);
  });

  it("is skipped without a worktree: section in the Charter", () => {
    const f = fixture({ charter: charterWithoutWorktree() });
    const res = checkTaskDatabases(f.primary, f.deps());
    expect(res.status).toBe("ok");
    expect(res.message).toMatch(/^skipped: /);
  });

  it("warns about orphan databases and keeps the ones of open worktrees", () => {
    const f = fixture({ database: TEMPLATE });
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    f.databases.list = [
      "postgres",
      "lunarhunt",
      "lunarhunt_t42",
      "lunarhunt_t77",
      "lunarhunt_t88",
      "other_t5",
    ];
    const res = checkTaskDatabases(f.primary, f.deps());
    expect(res.status).toBe("warn");
    expect(res.message).toContain("lunarhunt_t77, lunarhunt_t88");
    expect(res.message).not.toContain("lunarhunt_t42");
    expect(res.message).not.toContain("other_t5");
  });

  it("matches a worktree by task.json when the branch has no issue", () => {
    const f = fixture({ database: TEMPLATE });
    const wt = f.addWorktree("scratch", "scratch-branch");
    writeFileSync(
      join(wt, ".panopticon", "task.json"),
      JSON.stringify({ issue: 55, allowed_paths: ["wardens/**"] }),
    );
    f.databases.list = ["lunarhunt_t55"];
    expect(checkTaskDatabases(f.primary, f.deps()).status).toBe("ok");
  });

  it("is ok when every task database has a worktree", () => {
    const f = fixture({ database: TEMPLATE });
    f.addWorktree("42-offer-crud", "feat/42-offer-crud");
    f.databases.list = ["lunarhunt_t42"];
    expect(checkTaskDatabases(f.primary, f.deps()).status).toBe("ok");
  });

  it("warns, and never fails, when the database is unreachable", () => {
    const f = fixture({ database: TEMPLATE });
    f.databases.list = { unavailable: "unreachable" };
    const unreachable = checkTaskDatabases(f.primary, f.deps());
    expect(unreachable.status).toBe("warn");
    expect(unreachable.message).toContain("unreachable");
    f.databases.list = "throw";
    const thrown = checkTaskDatabases(f.primary, f.deps());
    expect(thrown.status).toBe("warn");
    expect(thrown.message).toContain("unreachable");
  });

  it("names a missing psql as the cause", () => {
    const f = fixture({ database: TEMPLATE });
    f.databases.list = { unavailable: "psql-missing" };
    const res = checkTaskDatabases(f.primary, f.deps());
    expect(res.status).toBe("warn");
    expect(res.message).toContain("psql is not installed");
    expect(res.message).not.toContain("unreachable");
  });
});

describe("psqlDatabases", () => {
  type Call = { args: string[] };
  function stub(reply: Partial<SpawnSyncReturns<string>>, calls: Call[] = []) {
    return ((_command: string, args: string[]) => {
      calls.push({ args });
      return reply as SpawnSyncReturns<string>;
    }) as unknown as Parameters<typeof psqlDatabases>[1];
  }

  it("reads the names and never prompts for a password", () => {
    const calls: Call[] = [];
    const res = psqlDatabases(
      {},
      stub({ status: 0, stdout: "postgres\nlunarhunt_t7\n\n" }, calls),
    );
    expect(res).toEqual(["postgres", "lunarhunt_t7"]);
    expect(calls[0]?.args).toContain("-w");
  });

  it("reports a missing psql (ENOENT)", () => {
    const error = Object.assign(new Error("spawn psql ENOENT"), {
      code: "ENOENT",
    });
    expect(psqlDatabases({}, stub({ error, status: null }))).toEqual({
      unavailable: "psql-missing",
    });
  });

  it.each([
    ["a non-zero exit", { status: 2, stdout: "" }],
    ["a timeout", { status: null, stdout: "" }],
  ])("reports an unreachable server on %s", (_name, reply) => {
    expect(psqlDatabases({}, stub(reply))).toEqual({
      unavailable: "unreachable",
    });
  });
});

describe("gh failed state", () => {
  it("is the value prState returns when gh fails", () => {
    const failing = { gh: () => ({ status: 1, stdout: "" }) };
    expect(prState(failing, repoRoot, "feat/1-x")).toBe(GH_FAILED_STATE);
    expect(GH_FAILED_STATE).toBe("unknown (gh failed)");
  });
});

describe("doctor worktree-exclusions", () => {
  it("passes on the real repository", () => {
    expect(checkWorktreeExclusions(repoRoot)).toMatchObject({
      id: "worktree-exclusions",
      status: "ok",
    });
  });

  it("passes when all four files exclude the directory", () => {
    const f = fixture();
    expect(checkWorktreeExclusions(f.primary).status).toBe("ok");
  });

  it.each(Object.keys(EXCLUSION_TEXT))("fails when %s lacks it", (file) => {
    const f = fixture();
    writeFileSync(join(f.primary, file), "nothing here\n");
    const res = checkWorktreeExclusions(f.primary);
    expect(res.status).toBe("fail");
    expect(res.message).toContain(file);
    expect(
      res.message.match(
        /\.gitignore|biome\.json|tsconfig\.base\.json|pyproject\.toml/g,
      ),
    ).toEqual([file]);
  });

  it.each(Object.keys(EXCLUSION_TEXT))("fails when %s is missing", (file) => {
    const f = fixture();
    rmSync(join(f.primary, file));
    const res = checkWorktreeExclusions(f.primary);
    expect(res.status).toBe("fail");
    expect(res.message).toContain(file);
  });

  it("names every file that lacks it", () => {
    const f = fixture();
    writeFileSync(join(f.primary, ".gitignore"), "x\n");
    writeFileSync(join(f.primary, "biome.json"), "{}\n");
    const res = checkWorktreeExclusions(f.primary);
    expect(res.message).toContain(".gitignore, biome.json");
  });
});

function byId(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  if (!found) {
    throw new Error(`no result for ${id}`);
  }
  return found;
}

describe("doctor with the worktree checks", () => {
  function doctorDeps(f: Fixture): DoctorDeps {
    return {
      cwd: f.primary,
      env: { PATH: process.env.PATH ?? "" },
      home: f.primary,
      now: () => Date.now(),
      claudeVersion: () => "2.1.295 (Claude Code)",
      primary: f.primary,
      bundlePath: join(f.primary, "missing-bundle.mjs"),
      worktree: f.deps(),
    };
  }

  it("--ci runs only worktree-exclusions of the three", () => {
    const f = fixture();
    const ids = runChecks(true, doctorDeps(f)).map((r) => r.id);
    expect(ids).toContain("worktree-exclusions");
    expect(ids).not.toContain("worktrees");
    expect(ids).not.toContain("task-databases");
  });

  it("without --ci runs all three after the older checks", () => {
    const f = fixture();
    f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    const results = runChecks(false, doctorDeps(f));
    const ids = results.map((r) => r.id);
    expect(ids.slice(-8)).toEqual([
      "claude-version",
      "shell-glob-options",
      "worktrees",
      "task-databases",
      "charter-drift",
      "task-integrity",
      "issue-repo",
      "primary-behind",
    ]);
    expect(ids).toContain("worktree-exclusions");
    expect(results.find((r) => r.id === "worktrees")?.status).toBe("warn");
  });

  it("applies the primary's Charter inside a worktree whose own Charter differs, and reports the drift", () => {
    const f = fixture();
    const wt = f.addWorktree("42-offer-crud", "feat/42-offer-crud", false);
    const ownCharter = join(wt, "panopticon.charter.yaml");
    const inWorktree = { ...doctorDeps(f), cwd: wt };
    expect(byId(runChecks(false, inWorktree), "charter-drift").status).toBe(
      "ok",
    );
    // Dropping the worktree: section would skip both checks if it were read.
    writeFileSync(ownCharter, charterWithoutWorktree());
    const results = runChecks(false, inWorktree);
    expect(byId(results, "worktrees").status).toBe("warn");
    expect(byId(results, "worktrees").message).toContain("no setup.ok");
    expect(byId(results, "charter-drift").status).toBe("warn");
    expect(byId(results, "charter-drift").message).toContain(
      "differs from the primary's",
    );
    expect(readFileSync(ownCharter, "utf8")).toBe(charterWithoutWorktree());
  });

  it("--ci fails on a missing exclusion", () => {
    const f = fixture();
    writeFileSync(join(f.primary, "pyproject.toml"), "x = 1\n");
    const res = runChecks(true, doctorDeps(f)).find(
      (r) => r.id === "worktree-exclusions",
    );
    expect(res?.status).toBe("fail");
    expect(readFileSync(join(f.primary, "pyproject.toml"), "utf8")).toBe(
      "x = 1\n",
    );
  });
});
