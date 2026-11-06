import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCharterYaml } from "../src/charter.ts";
import {
  type CheckResult,
  type DoctorDeps,
  DUPLICATES_WARNING,
  isWorktreeHook,
  runChecks,
  runDoctor,
  STALE_BUNDLE_WARNING,
} from "../src/doctor.ts";
import { MAPPING_ROWS } from "../src/mapping.ts";
import { embeddedHash, hashSources } from "../src/source-hash.ts";
import { anchorPath, writeAnchor } from "../src/sync/anchor.ts";
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

// One level below wardens/ so the bundle finds ../schema like dist/ does.
const outDir = mkdtempSync(join(repoRoot, "wardens", ".bundle-test-doctor-"));
const bundle = join(outDir, "wardens.mjs");
const scratch: string[] = [];

const NOW = Date.parse("2026-11-05T12:00:00Z");
const CLAUDE = ".claude/settings.json";
const CURSOR = ".cursor/hooks.json";

beforeAll(() => {
  execFileSync("pnpm", ["exec", "tsup", "--out-dir", outDir], {
    cwd: join(repoRoot, "wardens"),
    stdio: "pipe",
  });
}, 60_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wardens-doctor-test-"));
  scratch.push(dir);
  return dir;
}

type Fixture = {
  root: string;
  primary: string;
  home: string;
  deps: DoctorDeps;
};

/** A temp repo with the generated files, plus a fake primary holding a copy of `wardens/src`. */
function fixture(overrides: Partial<DoctorDeps> = {}): Fixture {
  const root = tempRepo();
  scratch.push(root);
  for (const [path, text] of rendered) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const file of [
    ".gitignore",
    "biome.json",
    "tsconfig.base.json",
    "pyproject.toml",
  ]) {
    writeFileSync(join(root, file), ".claude/worktrees\n");
  }
  const primary = scratchDir();
  cpSync(join(repoRoot, "wardens/src"), join(primary, "wardens/src"), {
    recursive: true,
  });
  mkdirSync(join(primary, ".git"));
  const home = realpathSync(scratchDir());
  writeAnchor(home, primary);
  const deps: DoctorDeps = {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    home,
    now: () => NOW,
    claudeVersion: () => "2.1.295 (Claude Code)",
    primary,
    bundlePath: bundle,
    ...overrides,
  };
  return { root, primary, home, deps };
}

function byId(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  if (!found) {
    throw new Error(`no result for ${id}`);
  }
  return found;
}

function editJson(
  file: string,
  // biome-ignore lint/suspicious/noExplicitAny: test helper edits arbitrary JSON
  edit: (value: Record<string, any>) => void,
): void {
  const value = JSON.parse(readFileSync(file, "utf8"));
  edit(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLog(root: string, lines: object[]): void {
  mkdirSync(join(root, ".panopticon"), { recursive: true });
  writeFileSync(
    join(root, ".panopticon/wardens.log.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("source hash", () => {
  it("is deterministic and changes with the sources", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "a.ts"), "a");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/b.ts"), "b");
    const first = hashSources(dir);
    expect(hashSources(dir)).toBe(first);
    writeFileSync(join(dir, "sub/b.ts"), "c");
    expect(hashSources(dir)).not.toBe(first);
  });

  it("is embedded in the built bundle", () => {
    const text = readFileSync(bundle, "utf8");
    expect(embeddedHash(text)).toBe(hashSources(join(repoRoot, "wardens/src")));
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("wardens doctor", () => {
  it("reports every check ok on a healthy setup and exits 0", () => {
    const { deps } = fixture();
    const out = runDoctor({ ci: false, json: false }, deps);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "ok drift",
      "ok fail-closed",
      "ok coverage",
      "ok break-hook",
      "ok bundle",
      "ok worktree-exclusions",
      "ok launcher-anchor",
      "ok duplicates",
      "ok disable-all-hooks",
      "ok claude-version",
      "ok worktrees",
      "ok task-databases",
    ]);
  });

  it("exits 2 when a check fails and prints fail on its line", () => {
    const { root, deps } = fixture();
    writeFileSync(join(root, "lefthook.yml"), "x: 1\n");
    const out = runDoctor({ ci: false, json: false }, deps);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toMatch(/^fail drift: lefthook\.yml differs/m);
  });

  it("exits 0 when a check only warns", () => {
    const { deps } = fixture({ claudeVersion: () => "2.0.1" });
    expect(runDoctor({ ci: false, json: false }, deps).exitCode).toBe(0);
  });

  it("--ci skips the machine-dependent checks", () => {
    const { deps } = fixture();
    const ids = runChecks(true, deps).map((r) => r.id);
    expect(ids).toEqual([
      "drift",
      "fail-closed",
      "coverage",
      "break-hook",
      "bundle",
      "worktree-exclusions",
    ]);
  });

  it("--json prints one array of id, status and message", () => {
    const { deps } = fixture();
    const out = runDoctor({ ci: true, json: true }, deps);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(6);
    for (const item of parsed) {
      expect(Object.keys(item).sort()).toEqual(["id", "message", "status"]);
      expect(item.status).toBe("ok");
    }
  });

  it("runs from the CLI and exits 2 outside a healthy checkout", () => {
    const { root } = fixture();
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "doctor", "--ci"],
      { cwd: root, encoding: "utf8" },
    );
    // The temp repo has no wardens bundle, so `bundle` and `break-hook` fail.
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/^ok drift: /m);
    expect(res.stdout).toMatch(/^fail bundle: /m);
  });
});

describe("drift", () => {
  it("fails when a generated file differs from the render", () => {
    const { root, deps } = fixture();
    editJson(join(root, CURSOR), (c) => {
      c.version = 2;
    });
    expect(byId(runChecks(true, deps), "drift").status).toBe("fail");
  });

  it("fails when a generated file is missing", () => {
    const { root, deps } = fixture();
    rmSync(join(root, CLAUDE));
    expect(byId(runChecks(true, deps), "drift").status).toBe("fail");
  });
});

describe("worktree hooks", () => {
  it("recognizes only the two Claude worktree events", () => {
    expect(isWorktreeHook({ tool: "claude", event: "WorktreeCreate" })).toBe(
      true,
    );
    expect(isWorktreeHook({ tool: "claude", event: "WorktreeRemove" })).toBe(
      true,
    );
    expect(isWorktreeHook({ tool: "claude", event: "Stop" })).toBe(false);
    expect(isWorktreeHook({ tool: "cursor", event: "WorktreeCreate" })).toBe(
      false,
    );
  });

  it("is ok without onFailure on the worktree hooks", () => {
    const { deps } = fixture();
    expect(byId(runChecks(true, deps), "fail-closed").status).toBe("ok");
  });

  it.each(["WorktreeCreate", "WorktreeRemove"])(
    "fails when %s is missing",
    (event) => {
      const { root, deps } = fixture();
      editJson(join(root, CLAUDE), (s) => {
        delete s.hooks[event];
      });
      const res = byId(runChecks(true, deps), "fail-closed");
      expect(res.status).toBe("fail");
      expect(res.message).toContain(event);
    },
  );

  it("fails when WorktreeCreate does not run the --tool claude entrypoint or lacks a timeout", () => {
    const { root, deps } = fixture();
    editJson(join(root, CLAUDE), (s) => {
      s.hooks.WorktreeCreate[0].hooks[0].command = "true";
    });
    expect(byId(runChecks(true, deps), "fail-closed").status).toBe("fail");
    const second = fixture();
    editJson(join(second.root, CLAUDE), (s) => {
      delete s.hooks.WorktreeRemove[0].hooks[0].timeout;
    });
    const res = byId(runChecks(true, second.deps), "fail-closed");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("WorktreeRemove");
  });
});

describe("fail-closed", () => {
  it("fails when a Claude hook lacks onFailure block", () => {
    const { root, deps } = fixture();
    editJson(join(root, CLAUDE), (s) => {
      delete s.hooks.Stop[0].hooks[0].onFailure;
    });
    const res = byId(runChecks(true, deps), "fail-closed");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("claude Stop");
  });

  it("fails when a Cursor hook lacks failClosed", () => {
    const { root, deps } = fixture();
    editJson(join(root, CURSOR), (c) => {
      c.hooks.beforeReadFile[0].failClosed = false;
    });
    expect(byId(runChecks(true, deps), "fail-closed").status).toBe("fail");
  });

  it("fails when a hook lacks a timeout", () => {
    const { root, deps } = fixture();
    editJson(join(root, CLAUDE), (s) => {
      delete s.hooks.PreToolUse[0].hooks[0].timeout;
    });
    const res = byId(runChecks(true, deps), "fail-closed");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("timeout");
  });
});

describe("coverage", () => {
  it("fails on a subscribed matcher alternative without a mapping row", () => {
    const { root, deps } = fixture();
    editJson(join(root, CLAUDE), (s) => {
      s.hooks.PreToolUse[0].matcher = "^(Bash|Glob)$";
    });
    const res = byId(runChecks(true, deps), "coverage");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("claude PreToolUse Glob is subscribed");
  });

  it("fails on a subscribed event without a mapping row", () => {
    const { root, deps } = fixture();
    editJson(join(root, CURSOR), (c) => {
      c.hooks.postToolUse = [{ command: "true", timeout: 1, failClosed: true }];
    });
    expect(byId(runChecks(true, deps), "coverage").message).toContain(
      "cursor postToolUse is subscribed",
    );
  });

  it("fails on a mapping row that is not subscribed", () => {
    const { root, deps } = fixture();
    editJson(join(root, CURSOR), (c) => {
      delete c.hooks.beforeReadFile;
    });
    expect(byId(runChecks(true, deps), "coverage").message).toContain(
      "cursor beforeReadFile has a mapping row but is not subscribed",
    );
  });

  it("has a row the engine maps for every sample", () => {
    expect(MAPPING_ROWS.length).toBeGreaterThan(0);
    const { deps } = fixture();
    expect(byId(runChecks(true, deps), "coverage").status).toBe("ok");
  });
});

describe("break-hook", () => {
  it("fails when a hook command still exits 0 with the bundle missing", () => {
    const { root, deps } = fixture();
    editJson(join(root, CLAUDE), (s) => {
      const hook = s.hooks.Stop[0].hooks[0];
      hook.command = `true wardens/dist/wardens.mjs`;
    });
    const res = byId(runChecks(true, deps), "break-hook");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("claude Stop does not fail");
  });

  it("fails when the real bundle is missing", () => {
    const { deps } = fixture({ bundlePath: join(scratchDir(), "none.mjs") });
    const res = byId(runChecks(true, deps), "break-hook");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("real bundle is missing");
  });

  it("fails when the real bundle allows an invalid Charter and malformed stdin", () => {
    const stub = join(scratchDir(), "allow.mjs");
    writeFileSync(
      stub,
      'process.stdout.write(JSON.stringify({ permission: "allow" }));\n',
    );
    const { deps } = fixture({ bundlePath: stub });
    const res = byId(runChecks(true, deps), "break-hook");
    expect(res.status).toBe("fail");
    expect(res.message).toContain(
      "claude hook does not deny an invalid Charter",
    );
    expect(res.message).toContain("cursor hook does not deny malformed stdin");
  });
});

describe("bundle", () => {
  it("fails when the primary bundle is missing", () => {
    const { deps } = fixture({ bundlePath: join(scratchDir(), "none.mjs") });
    expect(byId(runChecks(true, deps), "bundle").status).toBe("fail");
  });

  it("warns with the exact rebuild text when the source hash differs", () => {
    const { primary, deps } = fixture();
    writeFileSync(join(primary, "wardens/src/extra.ts"), "export {};\n");
    const res = byId(runChecks(true, deps), "bundle");
    expect(res.status).toBe("warn");
    expect(res.message).toBe(STALE_BUNDLE_WARNING);
    expect(res.message).toBe(
      "Run pnpm --filter wardens build in the primary checkout.",
    );
  });

  it("warns when the bundle carries no hash", () => {
    const stub = join(scratchDir(), "old.mjs");
    writeFileSync(stub, "// old bundle\n");
    const { deps } = fixture({ bundlePath: stub });
    expect(byId(runChecks(true, deps), "bundle").status).toBe("warn");
  });
});

describe("duplicates", () => {
  const base = {
    rule: "none",
    decision: "allow",
    action: "shell",
    phase: "pre",
    command: "echo ok",
    session_id: "s1",
    foreign: false,
  };

  it("warns on a foreign line in the last 7 days", () => {
    const { root, deps } = fixture();
    writeLog(root, [
      { ...base, tool: "cursor", ts: iso(NOW - 1000), foreign: true },
    ]);
    const res = byId(runChecks(false, deps), "duplicates");
    expect(res.status).toBe("warn");
    expect(res.message).toBe(DUPLICATES_WARNING);
    expect(res.message).toBe(
      "Cursor is running the Claude Code hooks too. Disable third-party hooks in Cursor settings.",
    );
  });

  it("ignores a foreign line older than 7 days", () => {
    const { root, deps } = fixture();
    writeLog(root, [
      { ...base, tool: "cursor", ts: iso(NOW - 8 * 86_400_000), foreign: true },
    ]);
    expect(byId(runChecks(false, deps), "duplicates").status).toBe("ok");
  });

  it("warns on two tools with the same session, event and target within 2 s", () => {
    const { root, deps } = fixture();
    writeLog(root, [
      { ...base, tool: "claude", event: "PreToolUse", ts: iso(NOW - 5000) },
      {
        ...base,
        tool: "cursor",
        event: "beforeShellExecution",
        ts: iso(NOW - 4000),
      },
    ]);
    expect(byId(runChecks(false, deps), "duplicates").status).toBe("warn");
  });

  it("does not warn when the two lines are further apart, differ in target or share a tool", () => {
    const { root, deps } = fixture();
    writeLog(root, [
      { ...base, tool: "claude", ts: iso(NOW - 20_000) },
      { ...base, tool: "cursor", ts: iso(NOW - 10_000) },
      { ...base, tool: "claude", ts: iso(NOW - 5000), command: "ls" },
      { ...base, tool: "cursor", ts: iso(NOW - 4900), command: "pwd" },
      { ...base, tool: "claude", ts: iso(NOW - 3000) },
      { ...base, tool: "claude", ts: iso(NOW - 2900) },
      "not json" as unknown as object,
    ]);
    expect(byId(runChecks(false, deps), "duplicates").status).toBe("ok");
  });
});

describe("disable-all-hooks", () => {
  it("warns when .claude/settings.local.json disables hooks", () => {
    const { root, deps } = fixture();
    writeFileSync(
      join(root, ".claude/settings.local.json"),
      '{"disableAllHooks": true}',
    );
    expect(byId(runChecks(false, deps), "disable-all-hooks").status).toBe(
      "warn",
    );
  });

  it("warns when the home settings disable hooks", () => {
    const { home, deps } = fixture();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude/settings.json"),
      '{"disableAllHooks": true}',
    );
    expect(byId(runChecks(false, deps), "disable-all-hooks").status).toBe(
      "warn",
    );
  });
});

describe("claude-version", () => {
  it("warns below 2.1.295, is ok at or above it and ok without claude", () => {
    const status = (v: string | null) =>
      byId(
        runChecks(false, fixture({ claudeVersion: () => v }).deps),
        "claude-version",
      ).status;
    expect(status("2.1.294 (Claude Code)")).toBe("warn");
    expect(status("2.1.295 (Claude Code)")).toBe("ok");
    expect(status("2.2.0")).toBe("ok");
    expect(status("3.0.0")).toBe("ok");
    expect(status("garbage")).toBe("warn");
    expect(status(null)).toBe("ok");
  });
});

describe("launcher-anchor", () => {
  const check = (deps: DoctorDeps) =>
    byId(runChecks(false, deps), "launcher-anchor");

  it("is ok when the anchor lists this primary and is private", () => {
    const { deps } = fixture();
    expect(check(deps).status).toBe("ok");
  });

  it("is not part of --ci", () => {
    const { deps } = fixture();
    expect(runChecks(true, deps).map((r) => r.id)).not.toContain(
      "launcher-anchor",
    );
  });

  it("fails when the anchor is missing", () => {
    const { home, deps } = fixture();
    rmSync(anchorPath(home));
    const res = check(deps);
    expect(res.status).toBe("fail");
    expect(res.message).toContain("is missing");
    expect(runDoctor({ ci: false, json: false }, deps).exitCode).toBe(2);
  });

  it("fails when the anchor does not list this primary", () => {
    const { home, deps } = fixture();
    writeFileSync(anchorPath(home), "/some/other/primary\n");
    const res = check(deps);
    expect(res.status).toBe("fail");
    expect(res.message).toContain("does not list");
  });

  it("fails when the anchor file is writable by group or other", () => {
    const { home, deps } = fixture();
    chmodSync(anchorPath(home), 0o620);
    const res = check(deps);
    expect(res.status).toBe("fail");
    expect(res.message).toContain("must not be writable");
  });

  it("fails when the anchor directory is writable by group or other", () => {
    const { home, deps } = fixture();
    chmodSync(join(home, ".config/panopticon"), 0o770);
    expect(check(deps).status).toBe("fail");
    chmodSync(join(home, ".config/panopticon"), 0o702);
    expect(check(deps).status).toBe("fail");
  });

  it("break-hook does not depend on the real anchor", () => {
    const { home, deps } = fixture();
    rmSync(anchorPath(home));
    expect(byId(runChecks(false, deps), "break-hook").status).toBe("ok");
  });

  describe("verifies every entry", () => {
    const withEntries = (
      extra: (primary: string) => string[],
      overrides: Partial<DoctorDeps> = {},
    ) => {
      const { home, primary, deps } = fixture(overrides);
      const lines = [primary, ...extra(primary)].join("\n");
      writeFileSync(anchorPath(home), `${lines}\n`);
      return check({ ...deps, ...overrides });
    };
    const linkedWorktree = (path: string) => {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, ".git"), "gitdir: /nowhere\n");
      return path;
    };

    it("fails on an entry that is a linked worktree", () => {
      const res = withEntries(() => [linkedWorktree(scratchDir())]);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("is a linked worktree");
    });

    it("fails on an entry under another entry's .claude/worktrees", () => {
      const res = withEntries((primary) => {
        const inner = join(primary, ".claude/worktrees/1-t");
        mkdirSync(join(inner, ".git"), { recursive: true });
        return [inner];
      });
      expect(res.status).toBe("fail");
      expect(res.message).toContain("lies under");
    });

    it("fails on an entry that is not a checkout", () => {
      const res = withEntries(() => ["/some/other/primary"]);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("entry /some/other/primary");
    });

    it("fails on a carriage return", () => {
      const { home, primary, deps } = fixture();
      writeFileSync(anchorPath(home), `${primary}\r\n${primary}\n`);
      const res = check(deps);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("carriage return");
    });

    it("fails when the anchor or its directory is not owned by the user", () => {
      const res = withEntries(() => [], { uid: (process.getuid?.() ?? 0) + 1 });
      expect(res.status).toBe("fail");
      expect(res.message).toContain("is not owned by the current user");
    });
  });

  it("derives the primary from the file system: a forged pointer in a task worktree fails", () => {
    const { root, deps, home } = fixture();
    const worktree = join(root, ".claude/worktrees/1-t");
    forgePointer(worktree);
    const { primary: _unused, ...rest } = deps;
    const results = runChecks(false, { ...rest, cwd: worktree });
    const res = byId(results, "launcher-anchor");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("is not a verified primary checkout");
    // Nor does the anchor gain an entry from running doctor.
    expect(readFileSync(anchorPath(home), "utf8")).not.toContain(".evil");
  });
});
