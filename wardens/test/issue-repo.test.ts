import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkIssueRepo } from "../src/doctor-worktree.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { runSync } from "../src/sync/index.ts";
import { runWorktree } from "../src/worktree/index.ts";
import {
  cleanupFixtures,
  type Fixture,
  fixture,
  hook,
  setupAgain,
  sh,
} from "./integrity-fixture.ts";

afterAll(cleanupFixtures);

const SYNC_NEXT = "Ask Krzysztof to run wardens sync";

function reposFile(f: Fixture): string {
  return join(f.home, ".config", "panopticon", "repos");
}

function issueCalls(f: Fixture): string[][] {
  return f.ghCalls.filter((c) => c[0] === "issue");
}

describe("setup and new read the issue repository from the sidecar only", () => {
  it("fail with the sync next action, and call no gh, when the sidecar entry is missing", () => {
    const f = fixture();
    rmSync(reposFile(f));
    const before = issueCalls(f).length;
    for (const res of [
      runWorktree({ sub: "new", arg: "6" }, f.deps),
      setupAgain(f, true),
    ]) {
      expect(res.exitCode).toBe(2);
      expect(res.stderr.trim()).toMatch(MESSAGE_PATTERN);
      expect(res.stderr).toContain(SYNC_NEXT);
    }
    expect(issueCalls(f)).toHaveLength(before);
  });

  it("fail when the only entry names another primary", () => {
    const f = fixture({ worktree: false });
    writeFileSync(reposFile(f), `${f.primary}-other\to/r\n`);
    const res = runWorktree({ sub: "new", arg: "5" }, f.deps);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain(SYNC_NEXT);
  });

  it("use the sidecar's repository for gh -R", () => {
    const f = fixture();
    expect(setupAgain(f, true).exitCode).toBe(0);
    for (const call of issueCalls(f)) {
      expect(call.slice(-2)).toEqual(["-R", "o/r"]);
    }
  });

  it("fail, and never ask gh, when remote.origin.url was rewritten after sync", () => {
    const f = fixture();
    const before = issueCalls(f).length;
    sh(
      f.primary,
      "config",
      "remote.origin.url",
      "https://github.com/evil/x.git",
    );
    const res = setupAgain(f, true);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain(SYNC_NEXT);
    expect(issueCalls(f)).toHaveLength(before);
  });
});

describe("wardens sync writes the sidecar", () => {
  it("records owner/repo of the primary's origin, 0600, replacing an older entry", () => {
    const f = fixture({ repos: false, worktree: false });
    const env = { HOME: f.home };
    expect(runSync(false, env, f.primary).exitCode).toBe(0);
    expect(readFileSync(reposFile(f), "utf8")).toBe(`${f.primary}\to/r\n`);
    expect(statSync(reposFile(f)).mode & 0o777).toBe(0o600);
    sh(
      f.primary,
      "config",
      "remote.origin.url",
      "git@github.com:o/renamed.git",
    );
    expect(runSync(false, env, f.primary).exitCode).toBe(0);
    expect(readFileSync(reposFile(f), "utf8")).toBe(
      `${f.primary}\to/renamed\n`,
    );
  });

  it("records nothing and says so when origin is not a GitHub repository", () => {
    const f = fixture({ repos: false, worktree: false });
    sh(f.primary, "config", "remote.origin.url", f.origin);
    const res = runSync(false, { HOME: f.home }, f.primary);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("not a github.com repository");
    expect(() => readFileSync(reposFile(f), "utf8")).toThrow();
  });

  it("is refused for an agent", () => {
    const f = fixture({ repos: false, worktree: false });
    const res = runSync(false, { HOME: f.home, CLAUDECODE: "1" }, f.primary);
    expect(res.exitCode).toBe(2);
    expect(() => readFileSync(reposFile(f), "utf8")).toThrow();
  });
});

describe("the sidecar is protected from agents", () => {
  it("denies the edit tools and shell writes on the repos file", () => {
    const f = fixture();
    const file = reposFile(f);
    expect(hook(f, "Write", { file_path: file, content: "x" })).toMatch(
      /^deny /,
    );
    for (const command of [
      `printf x > ${file}`,
      `tee ${file}`,
      `cp wardens/x.ts ${file}`,
    ]) {
      expect(hook(f, "Bash", { command })).toMatch(/^deny /);
    }
  });
});

describe("doctor issue-repo", () => {
  it("is ok when the sidecar matches the primary's origin", () => {
    const f = fixture();
    const res = checkIssueRepo(f.primary, f.home);
    expect(res.id).toBe("issue-repo");
    expect(res.status).toBe("ok");
    expect(res.message).toContain("o/r");
  });

  it("warns when the entry is absent and names wardens sync", () => {
    const f = fixture({ repos: false, worktree: false });
    const res = checkIssueRepo(f.primary, f.home);
    expect(res.status).toBe("warn");
    expect(res.message).toContain("wardens sync");
  });

  it("warns when origin was rewritten after sync", () => {
    const f = fixture();
    sh(
      f.primary,
      "config",
      "remote.origin.url",
      "https://github.com/evil/x.git",
    );
    const res = checkIssueRepo(f.primary, f.home);
    expect(res.status).toBe("warn");
    expect(res.message).toContain("evil/x");
  });

  it("warns when HOME cannot be resolved", () => {
    const f = fixture();
    expect(checkIssueRepo(f.primary, "").message).toContain("HOME");
  });
});

describe("the git-metadata deny sees through wrappers", () => {
  const denied = [
    "env git remote set-url origin https://github.com/evil/x.git",
    "command git remote add x u",
    "nohup git update-ref refs/remotes/origin/main HEAD",
    "xargs git remote remove",
    "find . -exec git remote rename origin x \\;",
    "env git config remote.origin.url X",
    "env git -c remote.origin.url=X fetch",
    "env -i git remote set-url origin u",
    "exec git remote rm origin",
    "sudo git remote set-url origin u",
    "nice git update-ref -d refs/remotes/origin/main",
    "timeout 5 git config --add remote.origin.url X",
    "env FOO=1 command git remote set-branches origin x",
    "env git -C . remote add x u",
  ];
  const allowed = [
    "env git remote -v",
    "env git remote get-url origin",
    "env git status",
    "command git remote show origin",
    "env git -c color.ui=never log -1",
    "git remote update",
    "git remote prune origin",
    "git remote set-head origin -a",
    "env git remote update",
  ];

  it("denies every wrapped writer", () => {
    const f = fixture();
    for (const command of denied) {
      expect(hook(f, "Bash", { command }), command).toMatch(
        /^deny .*command-guard/,
      );
    }
  });

  it("still allows reads and the remote commands that do not change the URL", () => {
    const f = fixture();
    for (const command of allowed) {
      expect(hook(f, "Bash", { command }), command).toBe("allow");
    }
  });
});
