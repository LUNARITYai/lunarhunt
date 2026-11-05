import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runHook } from "../src/engine.ts";
import { classifyCwd } from "../src/git.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { normativeCharter, tempRepo } from "./support.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    { stdio: "ignore" },
  );
}

type Fixture = {
  primary: string;
  linked: string;
  other: string;
  external: string;
  home: string;
};

/** Primary checkout on main with a committed Charter and two linked worktrees on task branches. */
function fixture(charter?: (doc: Record<string, unknown>) => void): Fixture {
  const primary = realpathSync(tempRepo({ worktree: true }));
  if (charter) {
    const doc = parse(normativeCharter()) as Record<string, unknown>;
    charter(doc);
    writeFileSync(join(primary, "panopticon.charter.yaml"), stringify(doc));
  }
  const external = realpathSync(mkdtempSync(join(tmpdir(), "wg-ext-")));
  const doc = parse(
    execFileSync("cat", [join(primary, "panopticon.charter.yaml")], {
      encoding: "utf8",
    }),
  ) as { paths: { external?: unknown } };
  doc.paths.external = { read: [`${external}/**`], write: [`${external}/**`] };
  writeFileSync(join(primary, "panopticon.charter.yaml"), stringify(doc));
  git(primary, "checkout", "-q", "-B", "main");
  git(primary, "add", "-A");
  git(primary, "commit", "-q", "-m", "init");
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "wg-wt-")));
  const linked = join(parent, "1-one");
  const other = join(parent, "2-two");
  git(primary, "worktree", "add", "-q", "-b", "feat/1-one", linked);
  git(primary, "worktree", "add", "-q", "-b", "feat/2-two", other);
  mkdirSync(join(primary, "apps"), { recursive: true });
  return {
    primary,
    linked,
    other,
    external,
    home: realpathSync(mkdtempSync(join(tmpdir(), "wg-home-"))),
  };
}

function claude(f: Fixture, cwd: string, tool: string, input: object): string {
  return runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd, tool_name: tool, tool_input: input }),
    { cwd: () => cwd, env: {}, home: f.home },
  ).stdout;
}

const edit = (f: Fixture, cwd: string, file: string) =>
  claude(f, cwd, "Edit", { file_path: file });
const bash = (f: Fixture, cwd: string, command: string) =>
  claude(f, cwd, "Bash", { command });

const esc = (text: string) => JSON.stringify(text).slice(1, -1);

const PRIMARY_EDIT =
  'Blocked by Warden worktree-guard: edits in the primary checkout are not allowed for agents. Run "wardens worktree new <issue>" and continue in .claude/worktrees/<issue>-<slug>.';

describe("classifyCwd", () => {
  it("tells the primary checkout from a linked worktree and reads the branch", () => {
    const f = fixture();
    expect(classifyCwd(f.primary)).toEqual({ kind: "primary", branch: "main" });
    expect(classifyCwd(f.linked)).toEqual({
      kind: "linked",
      branch: "feat/1-one",
    });
    git(f.linked, "checkout", "-q", "--detach");
    expect(classifyCwd(f.linked)).toEqual({ kind: "linked", branch: null });
  });
});

describe("worktree-guard in the primary checkout", () => {
  it("denies edit, write and delete targets inside the repository", () => {
    const f = fixture();
    const file = join(f.primary, "apps/web.ts");
    for (const tool of ["Edit", "Write"]) {
      const out = claude(f, f.primary, tool, { file_path: file });
      expect(out, tool).toContain(esc(PRIMARY_EDIT));
      expect(out, tool).toContain("deny");
    }
    const cursor = runHook(
      "cursor",
      "preToolUse",
      JSON.stringify({
        cwd: f.primary,
        tool_name: "Delete",
        tool_input: { file_path: file },
        conversation_id: "c",
      }),
      { cwd: () => f.primary, env: {}, home: f.home },
    );
    expect(cursor.stdout).toContain(esc(PRIMARY_EDIT));
  });

  it("wins over scope-guard and uses the C-30 format", () => {
    const f = fixture();
    const out = edit(f, f.primary, join(f.primary, "outside-scope.txt"));
    expect(out).toContain("worktree-guard");
    expect(out).not.toContain("scope-guard");
    expect(PRIMARY_EDIT).toMatch(MESSAGE_PATTERN);
  });

  it("allows a write to an allowed paths.external target", () => {
    const f = fixture();
    expect(edit(f, f.primary, join(f.external, "memory.md"))).toBe("");
  });

  it("allows reads", () => {
    const f = fixture();
    expect(claude(f, f.primary, "Read", { file_path: "README.md" })).toBe("");
  });

  it("allows an allowlisted read-only command", () => {
    const f = fixture();
    for (const command of [
      "git status",
      "git log --oneline",
      "ls",
      "cat panopticon.charter.yaml",
      "gh issue view 49",
      "rg foo | cat",
    ]) {
      expect(bash(f, f.primary, command), command).toBe("");
    }
  });

  it("allows an allowlisted command with a quoted heredoc into gh", () => {
    const f = fixture();
    const command = "gh pr create --title t --body-file - <<'EOF'\nbody\nEOF";
    expect(bash(f, f.primary, command)).toBe("");
  });

  it("denies a command that is not allowlisted", () => {
    const f = fixture();
    const out = bash(f, f.primary, "touch x");
    expect(out).toContain("Blocked by Warden worktree-guard");
    expect(out).toContain('Run \\"wardens worktree new <issue>\\"');
    expect(bash(f, f.primary, "git status; touch x")).toContain(
      "worktree-guard",
    );
  });

  it("denies an allowlisted command that redirects or writes", () => {
    const f = fixture();
    for (const command of [
      "cat panopticon.charter.yaml > y",
      "ls > out",
      "ls >> out",
      "cat x 2> err",
      "cat x | tee y",
      "git diff --output=patch.txt",
    ]) {
      expect(bash(f, f.primary, command), command).toContain("worktree-guard");
    }
  });

  it("allows an allowlisted command that redirects only to /dev/null or an external path", () => {
    const f = fixture();
    expect(bash(f, f.primary, "ls > /dev/null 2>&1")).toBe("");
    expect(bash(f, f.primary, `ls > ${join(f.external, "out.txt")}`)).toBe("");
    expect(bash(f, f.primary, "ls > /etc/hosts")).not.toBe("");
  });

  it("denies the same on Cursor beforeShellExecution", () => {
    const f = fixture();
    const run = (command: string) =>
      runHook(
        "cursor",
        "beforeShellExecution",
        JSON.stringify({ cwd: f.primary, command, conversation_id: "c" }),
        { cwd: () => f.primary, env: {}, home: f.home },
      ).stdout;
    expect(run("git status")).not.toContain("deny");
    expect(run("rm -rf apps")).toContain("worktree-guard");
    expect(run("ls > out")).toContain("worktree-guard");
  });
});

describe("worktree-guard on a protected branch or detached HEAD", () => {
  it("denies edits on a linked worktree that is on main", () => {
    const f = fixture();
    git(f.primary, "checkout", "-q", "--detach");
    git(f.linked, "checkout", "-q", "main");
    const out = edit(f, f.linked, join(f.linked, "apps/web.ts"));
    expect(out).toContain(
      'Blocked by Warden worktree-guard: branch main is protected. Create a task worktree with \\"wardens worktree new <issue>\\".',
    );
    expect(bash(f, f.linked, "touch x")).toContain("branch main is protected");
    expect(bash(f, f.linked, "git status")).toBe("");
  });

  it("denies edits on a detached HEAD but allows allowlisted commands", () => {
    const f = fixture();
    git(f.linked, "checkout", "-q", "--detach");
    const out = edit(f, f.linked, join(f.linked, "apps/web.ts"));
    expect(out).toContain(
      "Blocked by Warden worktree-guard: HEAD is detached. Create a task worktree",
    );
    expect(bash(f, f.linked, "rm -rf apps")).toContain("HEAD is detached");
    expect(bash(f, f.linked, "gh pr list")).toBe("");
    expect(bash(f, f.linked, "cat x > y")).toContain("HEAD is detached");
    expect(edit(f, f.linked, join(f.external, "n.md"))).toBe("");
  });
});

describe("worktree-guard in a linked worktree on a task branch", () => {
  it("is a no-op for edits and commands, whatever the branch name", () => {
    const f = fixture();
    expect(edit(f, f.linked, join(f.linked, "apps/web.ts"))).toBe("");
    expect(bash(f, f.linked, "touch x")).toBe("");
    git(f.linked, "checkout", "-q", "-b", "fix/99-elsewhere");
    expect(edit(f, f.linked, join(f.linked, "apps/web.ts"))).toBe("");
  });

  it("denies an edit that targets the primary checkout", () => {
    const f = fixture();
    const target = join(f.primary, "README.md");
    const out = edit(f, f.linked, target);
    expect(out).toContain(
      `Blocked by Warden worktree-guard: ${target} is in another worktree or in the primary checkout. Edit only files inside the worktree of your task.`,
    );
    expect(edit(f, f.linked, "../../../README.md")).not.toBe("");
  });

  it("denies an edit that targets another worktree, including a new file", () => {
    const f = fixture();
    for (const name of ["README.md", "new/file.ts"]) {
      const out = edit(f, f.linked, join(f.other, name));
      expect(out, name).toContain("worktree-guard");
      expect(out, name).toContain("another worktree");
    }
  });

  it("still denies a path outside every worktree with the engine message", () => {
    const f = fixture();
    const out = edit(f, f.linked, join(f.home, "x.txt"));
    expect(out).toContain("path escapes the worktree");
    expect(out).not.toContain("worktree-guard");
  });
});

describe("worktree-guard configuration", () => {
  it("is a no-op when the worktree section is absent", () => {
    const f = fixture((doc) => {
      delete doc.worktree;
    });
    expect(edit(f, f.primary, join(f.primary, "apps/a.ts"))).not.toContain(
      "worktree-guard",
    );
    expect(bash(f, f.primary, "touch x")).not.toContain("worktree-guard");
  });

  it("is a no-op when required_for_agents is false", () => {
    const f = fixture((doc) => {
      (doc.worktree as { required_for_agents: boolean }).required_for_agents =
        false;
    });
    expect(edit(f, f.primary, join(f.primary, "apps/a.ts"))).not.toContain(
      "worktree-guard",
    );
    expect(bash(f, f.primary, "touch x")).not.toContain("worktree-guard");
  });
});

describe("worktree-guard post-edit audit", () => {
  it("reports an edit made in the primary checkout", () => {
    const f = fixture();
    const out = runHook(
      "claude",
      "PostToolUse",
      JSON.stringify({
        cwd: f.primary,
        tool_name: "Edit",
        tool_input: { file_path: join(f.primary, "apps/a.ts") },
      }),
      { cwd: () => f.primary, env: {}, home: f.home },
    ).stdout;
    expect(out).toContain("worktree-guard");
    expect(out).toContain("apps/a.ts was edited in the primary checkout");
  });
});
