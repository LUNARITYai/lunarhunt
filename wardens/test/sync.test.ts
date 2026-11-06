import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCharterYaml } from "../src/charter.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { anchorPath, readAnchor } from "../src/sync/anchor.ts";
import { render } from "../src/sync/index.ts";
import {
  cliPath,
  forgePointer,
  normativeCharter,
  repoRoot,
  tempRepo,
} from "./support.ts";

const loaded = loadCharterYaml(normativeCharter());
if (!loaded.ok) {
  throw new Error("normative Charter must be valid");
}
const rendered = render(loaded.charter);
const FILES = [".claude/settings.json", ".cursor/hooks.json", "lefthook.yml"];

/** Every sync run gets a throwaway home, so the launcher anchor never lands in the real one. */
const TEST_HOME = realpathSync(mkdtempSync(join(tmpdir(), "wardens-home-")));
const homes: string[] = [TEST_HOME];
afterAll(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});

const CLEAN_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: TEST_HOME,
};

function runCli(cwd: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    { cwd, env, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(root, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

describe("render", () => {
  it("returns exactly the three generated files", () => {
    expect([...rendered.keys()].sort()).toEqual([...FILES].sort());
  });

  it("is deterministic (byte-identical twice)", () => {
    const again = render(loaded.charter);
    for (const [path, text] of rendered) {
      expect(again.get(path)).toBe(text);
    }
  });

  it("matches the normative blocks of the spec (golden)", () => {
    const golden = {
      ".claude/settings.json": "claude-settings.json",
      ".cursor/hooks.json": "cursor-hooks.json",
      "lefthook.yml": "lefthook.yml",
    };
    for (const [path, name] of Object.entries(golden)) {
      const expected = readFileSync(
        join(repoRoot, "wardens/test/golden", name),
        "utf8",
      );
      expect(rendered.get(path), path).toBe(expected);
    }
  });

  it("is left unchanged by biome format", () => {
    for (const path of ["lefthook.yml"]) {
      const text = rendered.get(path) ?? "";
      const out = spawnSync(
        "pnpm",
        ["exec", "biome", "format", `--stdin-file-path=${path}`],
        { cwd: repoRoot, input: text, encoding: "utf8" },
      );
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toBe(text);
    }
    for (const path of [".claude/settings.json", ".cursor/hooks.json"]) {
      const text = rendered.get(path) ?? "";
      const out = spawnSync(
        "pnpm",
        ["exec", "biome", "format", `--stdin-file-path=${path}`],
        { cwd: repoRoot, input: text, encoding: "utf8" },
      );
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toBe(text);
    }
  });

  it("sets the Claude Code hooks, env and permissions", () => {
    const settings = JSON.parse(rendered.get(".claude/settings.json") ?? "");
    expect(settings.env.PANOPTICON_AGENT).toBe("claude");
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "WorktreeCreate",
      "WorktreeRemove",
    ]);
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({
      timeout: 10,
      onFailure: "block",
    });
    for (const [event, groups] of Object.entries(settings.hooks) as [
      string,
      { hooks: { onFailure?: string; timeout: number }[] }[],
    ][]) {
      for (const hook of groups.flatMap((g) => g.hooks)) {
        expect(hook.timeout).toBeGreaterThan(0);
        if (!event.startsWith("Worktree")) {
          expect(hook.onFailure).toBe("block");
        }
      }
    }
    expect(Object.keys(settings.worktree ?? {})).toEqual(["baseRef"]);
    expect(settings.worktree.baseRef).toBe("fresh");
    const create = settings.hooks.WorktreeCreate[0].hooks[0];
    const remove = settings.hooks.WorktreeRemove[0].hooks[0];
    expect(create.command).toContain(
      'wardens/dist/wardens.mjs" worktree create --tool claude',
    );
    expect(remove.command).toContain(
      'wardens/dist/wardens.mjs" worktree remove --tool claude',
    );
    // Same launcher as the other hooks: anchor file, no git.
    expect(create.command).toContain(".config/panopticon/primaries");
    expect(create.command).not.toContain("git");
    expect(remove.command).not.toContain("git");
    // Setup steps (pnpm install, uv sync) need far more than a guard hook.
    expect(create.timeout).toBeGreaterThanOrEqual(600);
    expect(create.onFailure).toBeUndefined();
    expect(remove.onFailure).toBeUndefined();
    expect(settings.permissions.deny).toContain("NotebookEdit");
    expect(settings.permissions.deny).not.toContain("Read(**/.env.*)");
    expect(settings.permissions.deny).not.toContain("Read(**/.env.example)");
  });

  it("sets the Cursor hooks fail-closed", () => {
    const hooks = JSON.parse(rendered.get(".cursor/hooks.json") ?? "");
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual([
      "sessionStart",
      "preToolUse",
      "beforeShellExecution",
      "beforeMCPExecution",
      "beforeReadFile",
      "afterFileEdit",
      "stop",
    ]);
    for (const [event, entries] of Object.entries(hooks.hooks) as [
      string,
      { failClosed: boolean; timeout: number; loop_limit?: number }[],
    ][]) {
      for (const entry of entries) {
        expect(entry.failClosed).toBe(true);
        expect(entry.timeout).toBeGreaterThan(0);
        expect(entry.loop_limit).toBe(event === "stop" ? 3 : undefined);
      }
    }
  });

  it("renders a launcher that reads the anchor, never git, and exits 2 without a trusted primary", () => {
    for (const path of [".claude/settings.json", ".cursor/hooks.json"]) {
      const text = rendered.get(path) ?? "";
      expect(text).toContain('a=\\"$HOME/.config/panopticon/primaries\\"');
      expect(text).toContain('{ echo \\"Blocked by Warden launcher:');
      expect(text).toContain(
        'exit 2; }; exec node \\"$r/wardens/dist/wardens.mjs',
      );
      expect(text).not.toContain("--git-common-dir");
      expect(text).not.toContain("dirname");
    }
  });

  it("adds a commit-msg agent-trailer command to lefthook.yml", () => {
    const text = rendered.get("lefthook.yml") ?? "";
    expect(text).toContain("commit-msg:");
    expect(text).toContain("check agent-trailer {1}");
    expect(text).toContain("pre-commit:");
    expect(text).toContain("pre-push:");
  });
});

describe("wardens sync", () => {
  it("writes exactly the three files at the git toplevel, byte-identical twice", () => {
    const repo = tempRepo();
    const before = listFiles(repo);
    expect(runCli(repo, ["sync"], CLEAN_ENV).status).toBe(0);
    expect(listFiles(repo)).toEqual([...before, ...FILES].sort());
    const first = FILES.map((f) => readFileSync(join(repo, f), "utf8"));
    expect(runCli(repo, ["sync"], CLEAN_ENV).status).toBe(0);
    expect(FILES.map((f) => readFileSync(join(repo, f), "utf8"))).toEqual(
      first,
    );
    for (const [i, f] of FILES.entries()) {
      expect(first[i]).toBe(rendered.get(f));
    }
  });

  it("writes at the toplevel when started in a subdirectory", () => {
    const repo = tempRepo();
    execFileSync("mkdir", ["-p", join(repo, "sub")]);
    expect(runCli(join(repo, "sub"), ["sync"], CLEAN_ENV).status).toBe(0);
    expect(existsSync(join(repo, "lefthook.yml"))).toBe(true);
    expect(existsSync(join(repo, "sub/lefthook.yml"))).toBe(false);
  });

  it("--check exits 0 when files match", () => {
    const repo = tempRepo();
    runCli(repo, ["sync"], CLEAN_ENV);
    const result = runCli(repo, ["sync", "--check"], CLEAN_ENV);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("--check reports each missing or differing file, exits 2 and writes nothing", () => {
    const repo = tempRepo();
    runCli(repo, ["sync"], CLEAN_ENV);
    writeFileSync(join(repo, "lefthook.yml"), "changed\n");
    execFileSync("rm", [join(repo, ".cursor/hooks.json")]);
    const before = listFiles(repo);
    const result = runCli(repo, ["sync", "--check"], CLEAN_ENV);
    expect(result.status).toBe(2);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toEqual([
      "Blocked by Warden charter-drift: .cursor/hooks.json differs from wardens sync output. Ask a human to run wardens sync and commit the result.",
      "Blocked by Warden charter-drift: lefthook.yml differs from wardens sync output. Ask a human to run wardens sync and commit the result.",
    ]);
    for (const line of lines) {
      expect(line).toMatch(MESSAGE_PATTERN);
    }
    expect(listFiles(repo)).toEqual(before);
    expect(readFileSync(join(repo, "lefthook.yml"), "utf8")).toBe("changed\n");
  });

  it("--check in an agent session is allowed", () => {
    const repo = tempRepo();
    runCli(repo, ["sync"], CLEAN_ENV);
    const result = runCli(repo, ["sync", "--check"], {
      ...CLEAN_ENV,
      CLAUDECODE: "1",
    });
    expect(result.status).toBe(0);
  });

  const markers: [string, Record<string, string>][] = [
    ["PANOPTICON_AGENT=claude", { PANOPTICON_AGENT: "claude" }],
    ["PANOPTICON_AGENT=cursor", { PANOPTICON_AGENT: "cursor" }],
    ["CLAUDECODE=1", { CLAUDECODE: "1" }],
    ["CURSOR_AGENT", { CURSOR_AGENT: "1" }],
  ];
  it.each(markers)("refuses a writing sync under %s", (_name, marker) => {
    const repo = tempRepo();
    const before = listFiles(repo);
    const result = runCli(repo, ["sync"], { ...CLEAN_ENV, ...marker });
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(
      "Blocked by Warden charter-drift: wardens sync writes protected configs and is for humans. Ask Krzysztof to run wardens sync.",
    );
    expect(listFiles(repo)).toEqual(before);
  });

  it.each([["sync"], ["sync --check"]])(
    "%s exits 2 with the engine message on an invalid Charter and writes nothing",
    (cmd) => {
      const repo = tempRepo();
      writeFileSync(join(repo, "panopticon.charter.yaml"), "version: 99\n");
      const before = listFiles(repo);
      const result = runCli(repo, cmd.split(" "), CLEAN_ENV);
      expect(result.status).toBe(2);
      expect(result.stderr.split("\n")[0]).toBe(
        "Blocked by Warden engine: Charter validation failed. Label the issue needs:human.",
      );
      expect(listFiles(repo)).toEqual(before);
    },
  );

  it("fails with the engine message outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardens-nogit-"));
    const result = runCli(dir, ["sync", "--check"], CLEAN_ENV);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Blocked by Warden engine");
  });
});

describe("wardens sync: launcher anchor", () => {
  function freshHome(): { PATH: string; HOME: string } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wardens-home-")));
    homes.push(home);
    return { PATH: process.env.PATH ?? "", HOME: home };
  }
  const mode = (path: string) => statSync(path).mode & 0o777;

  it("writes its own primary toplevel to the anchor with private modes", () => {
    const repo = tempRepo();
    const env = freshHome();
    expect(runCli(repo, ["sync"], env).status).toBe(0);
    expect(readAnchor(env.HOME)).toEqual([realpathSync(repo)]);
    expect(mode(anchorPath(env.HOME))).toBe(0o600);
    expect(mode(join(env.HOME, ".config/panopticon"))).toBe(0o700);
  });

  it("is idempotent, keeps other entries and repairs loose modes", () => {
    const repo = tempRepo();
    const env = freshHome();
    mkdirSync(join(env.HOME, ".config/panopticon"), { recursive: true });
    writeFileSync(anchorPath(env.HOME), "/some/other/primary\n");
    chmodSync(anchorPath(env.HOME), 0o666);
    chmodSync(join(env.HOME, ".config/panopticon"), 0o777);
    expect(runCli(repo, ["sync"], env).status).toBe(0);
    const once = readFileSync(anchorPath(env.HOME), "utf8");
    expect(once).toBe(`/some/other/primary\n${realpathSync(repo)}\n`);
    expect(runCli(repo, ["sync"], env).status).toBe(0);
    expect(readFileSync(anchorPath(env.HOME), "utf8")).toBe(once);
    expect(mode(anchorPath(env.HOME))).toBe(0o600);
    expect(mode(join(env.HOME, ".config/panopticon"))).toBe(0o700);
  });

  it("adds the primary, not the linked worktree, when run in a worktree", () => {
    const repo = tempRepo();
    const env = freshHome();
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd: repo, stdio: "ignore" },
      );
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const worktree = join(repo, ".claude/worktrees/1-t");
    git("worktree", "add", "-q", worktree, "-b", "t");
    expect(runCli(worktree, ["sync"], env).status).toBe(0);
    expect(readAnchor(env.HOME)).toEqual([realpathSync(repo)]);
  });

  it("prints the primary it adds", () => {
    const repo = tempRepo();
    const env = freshHome();
    const result = runCli(repo, ["sync"], env);
    expect(result.stdout).toContain(realpathSync(repo));
    expect(result.stdout).toContain(anchorPath(env.HOME));
  });

  it("derives the primary from the file system: a forged pointer in a task worktree adds no entry", () => {
    const repo = tempRepo();
    const env = freshHome();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd, encoding: "utf8" },
      );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const worktree = join(repo, ".claude/worktrees/1-t");
    git(repo, "worktree", "add", "-q", worktree, "-b", "t");
    const fake = forgePointer(worktree);
    // Git itself is fooled: it reports the fake repository's layout.
    expect(git(worktree, "rev-parse", "--git-common-dir").trim()).toBe(
      join(fake, ".git"),
    );
    const result = runCli(worktree, ["sync"], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a verified primary checkout");
    expect(result.stderr.split("\n")[0]).toMatch(MESSAGE_PATTERN);
    expect(existsSync(join(env.HOME, ".config"))).toBe(false);
    expect(existsSync(join(worktree, ".claude/settings.json"))).toBe(false);
  });

  it("refuses a worktree whose pointer names a primary outside its own worktrees directory", () => {
    const env = freshHome();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wardens-fake-")));
    homes.push(outside);
    const worktree = join(outside, "wt");
    const fake = forgePointer(worktree);
    writeFileSync(
      join(worktree, "panopticon.charter.yaml"),
      normativeCharter(),
    );
    expect(fake.startsWith(outside)).toBe(true);
    const result = runCli(worktree, ["sync"], env);
    expect(result.status).toBe(2);
    expect(existsSync(join(env.HOME, ".config"))).toBe(false);
  });

  it("--check neither reads nor writes the anchor", () => {
    const repo = tempRepo();
    expect(runCli(repo, ["sync"], CLEAN_ENV).status).toBe(0);
    const env = freshHome();
    const result = runCli(repo, ["sync", "--check"], env);
    expect(result.status).toBe(0);
    expect(existsSync(join(env.HOME, ".config"))).toBe(false);
  });

  it("an agent session writes nothing, anchor included", () => {
    const repo = tempRepo();
    const env = freshHome();
    const result = runCli(repo, ["sync"], { ...env, CLAUDECODE: "1" });
    expect(result.status).toBe(2);
    expect(existsSync(join(env.HOME, ".config"))).toBe(false);
  });
});

describe("wardens package check script", () => {
  it("runs sync --check after charter-validate", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "wardens/package.json"), "utf8"),
    );
    expect(pkg.scripts.check).toBe(
      "node --experimental-strip-types src/cli.ts check charter-validate && node --experimental-strip-types src/cli.ts sync --check",
    );
  });
});
