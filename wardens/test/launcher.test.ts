import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadCharterYaml } from "../src/charter.ts";
import { render } from "../src/sync/index.ts";
import {
  LAUNCHER_BLOCK_MESSAGE,
  LAUNCHER_BUNDLE_MESSAGE,
} from "../src/sync/render.ts";
import { bundlePrimary } from "../src/trusted.ts";
import { normativeCharter } from "./support.ts";

const loaded = loadCharterYaml(normativeCharter());
if (!loaded.ok) {
  throw new Error("normative Charter must be valid");
}
const rendered = render(loaded.charter);

function hookCommand(tool: "claude" | "cursor", event: string): string {
  if (tool === "claude") {
    const settings = JSON.parse(rendered.get(".claude/settings.json") ?? "");
    const groups = settings.hooks[event] as { hooks: { command: string }[] }[];
    return groups[0]?.hooks[0]?.command ?? "";
  }
  const hooks = JSON.parse(rendered.get(".cursor/hooks.json") ?? "");
  return (hooks.hooks[event] as { command: string }[])[0]?.command ?? "";
}

const CLAUDE = hookCommand("claude", "PreToolUse");
const CURSOR = hookCommand("cursor", "beforeShellExecution");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wardens-launcher-")));
  scratch.push(dir);
  return dir;
}

/** A directory holding a stub bundle that prints a marker with its own path and arguments. */
function withBundle(dir: string, marker: string): string {
  mkdirSync(join(dir, "wardens/dist"), { recursive: true });
  writeFileSync(
    join(dir, "wardens/dist/wardens.mjs"),
    `process.stdout.write("${marker}:" + process.argv.slice(1).join(" "));\n`,
  );
  return dir;
}

function anchor(home: string, lines: string): void {
  mkdirSync(join(home, ".config/panopticon"), { recursive: true });
  writeFileSync(join(home, ".config/panopticon/primaries"), lines);
}

type Run = { status: number | null; stdout: string; stderr: string };

function launch(
  command: string,
  opts: { home: string; cwd: string; env?: Record<string, string> },
): Run {
  const res = spawnSync("sh", ["-c", command], {
    cwd: opts.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: opts.home, ...opts.env },
    input: '{"cwd":""}',
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const claudeIn = (dir: string, home: string, cwd = dir): Run =>
  launch(CLAUDE, { home, cwd, env: { CLAUDE_PROJECT_DIR: dir } });

const BLOCKED = `${LAUNCHER_BLOCK_MESSAGE}\n`;

function expectRan(run: Run, primary: string, tool: string, event: string) {
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(
    `PRIMARY:${join(primary, "wardens/dist/wardens.mjs")} hook --tool ${tool} --event ${event}`,
  );
}

function expectBlocked(run: Run) {
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe(BLOCKED);
  expect(run.status).toBe(2);
}

describe("launcher: rendered commands", () => {
  it("pins the Claude and Cursor launcher strings", () => {
    expect(CLAUDE).toBe(
      `sh -c 's=; case "$CLAUDE_PROJECT_DIR" in /*) s=$(cd -P -- "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P);; esac; a="$HOME/.config/panopticon/primaries"; r=; [ -n "$HOME" ] && [ -n "$s" ] && [ -r "$a" ] && while IFS= read -r p || [ -n "$p" ]; do case "$p" in /*) ;; *) continue;; esac; p=$(cd -P -- "$p" 2>/dev/null && pwd -P) || continue; case "$s" in "$p"|"$p"/.claude/worktrees/*) r=$p; break;; esac; done < "$a"; [ -n "$r" ] || { echo "${LAUNCHER_BLOCK_MESSAGE}" >&2; exit 2; }; exec node "$r/wardens/dist/wardens.mjs" hook --tool claude --event PreToolUse'`.replace(
        'exec node "$r/wardens/dist/wardens.mjs"',
        `[ -f "$r/wardens/dist/wardens.mjs" ] || { echo "${LAUNCHER_BUNDLE_MESSAGE}" >&2; exit 2; }; exec node "$r/wardens/dist/wardens.mjs"`,
      ),
    );
    expect(CURSOR).toBe(
      `sh -c 'c=\${CURSOR_PROJECT_DIR:-.}; s=; case "$c" in /*|.) s=$(cd -P -- "$c" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- "$HOME" 2>/dev/null && pwd -P) || h=/dev/null; a="$HOME/.config/panopticon/primaries"; r=; [ -n "$HOME" ] && [ -n "$s" ] && [ -r "$a" ] && while IFS= read -r p || [ -n "$p" ]; do case "$p" in /*) ;; *) continue;; esac; p=$(cd -P -- "$p" 2>/dev/null && pwd -P) || continue; case "$s" in "$p"|"$p"/.claude/worktrees/*|"$h/.cursor/worktrees/\${p##*/}"/*) r=$p; break;; esac; done < "$a"; [ -n "$r" ] || { echo "${LAUNCHER_BLOCK_MESSAGE}" >&2; exit 2; }; exec node "$r/wardens/dist/wardens.mjs" hook --tool cursor --event beforeShellExecution'`.replace(
        'exec node "$r/wardens/dist/wardens.mjs"',
        `[ -f "$r/wardens/dist/wardens.mjs" ] || { echo "${LAUNCHER_BUNDLE_MESSAGE}" >&2; exit 2; }; exec node "$r/wardens/dist/wardens.mjs"`,
      ),
    );
  });

  it("never consults git or repository data", () => {
    for (const command of [CLAUDE, CURSOR]) {
      expect(command).not.toMatch(/\bgit\b/);
      expect(command).not.toContain("dirname");
    }
  });

  it("has no environment override of the anchor location", () => {
    for (const command of [CLAUDE, CURSOR]) {
      expect(command).toContain('a="$HOME/.config/panopticon/primaries"');
      expect(command.match(/\ba=/g)).toHaveLength(1);
    }
  });

  it("uses the same launcher body for every event", () => {
    const stop = hookCommand("claude", "Stop");
    expect(stop.replace("--event Stop", "--event PreToolUse")).toBe(CLAUDE);
  });
});

describe("launcher: behaviour", () => {
  it("runs the bundle of the anchored primary", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    anchor(home, `${primary}\n`);
    expectRan(claudeIn(primary, home), primary, "claude", "PreToolUse");
    expectRan(
      launch(CURSOR, {
        home,
        cwd: primary,
        env: { CURSOR_PROJECT_DIR: primary },
      }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
  });

  it("runs the bundle of the anchored primary from a task worktree under .claude/worktrees", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const worktree = join(primary, ".claude/worktrees/42-task");
    mkdirSync(join(worktree, "sub"), { recursive: true });
    withBundle(worktree, "WORKTREE");
    anchor(home, `${primary}\n`);
    expectRan(claudeIn(worktree, home), primary, "claude", "PreToolUse");
    expectRan(
      claudeIn(join(worktree, "sub"), home),
      primary,
      "claude",
      "PreToolUse",
    );
  });

  it("runs the bundle of the anchored primary whatever the worktree's git files say", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd, stdio: "ignore" },
      );
    git(primary, "init", "-q", "-b", "main");
    git(primary, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(primary, ".claude/worktrees/42-task");
    git(primary, "worktree", "add", "-q", worktree, "-b", "task");
    // The worktree now describes a repository of its own, with another bundle.
    const elsewhere = join(worktree, ".other");
    mkdirSync(join(elsewhere, ".git/worktrees/x"), { recursive: true });
    withBundle(elsewhere, "OTHER");
    withBundle(worktree, "WORKTREE");
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(elsewhere, ".git/worktrees/x")}\n`,
    );
    anchor(home, `${primary}\n`);
    expectRan(claudeIn(worktree, home), primary, "claude", "PreToolUse");
    expectRan(
      launch(CURSOR, {
        home,
        cwd: worktree,
        env: { CURSOR_PROJECT_DIR: worktree },
      }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
  });

  it("blocks a directory outside every anchored primary", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = withBundle(tmp(), "OUTSIDE");
    anchor(home, `${primary}\n`);
    expectBlocked(claudeIn(outside, home));
    // A sibling whose name starts with the primary's name is not under it.
    const sibling = withBundle(`${primary}-sibling`, "SIBLING");
    scratch.push(sibling);
    expectBlocked(claudeIn(sibling, home));
    // Neither is a directory under the primary but outside .claude/worktrees.
    const inside = join(primary, "apps/web");
    mkdirSync(inside, { recursive: true });
    expectBlocked(claudeIn(inside, home));
  });

  it("blocks when the anchor file is missing", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    expectBlocked(claudeIn(primary, home));
    expectBlocked(
      launch(CURSOR, {
        home,
        cwd: primary,
        env: { CURSOR_PROJECT_DIR: primary },
      }),
    );
  });

  it("blocks an empty anchor and ignores blank and relative lines", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    anchor(home, "");
    expectBlocked(claudeIn(primary, home));
    anchor(home, `\n\nrelative/path\n.\n${primary.slice(1)}\n`);
    expectBlocked(claudeIn(primary, home, primary));
    anchor(home, `\n\nrelative/path\n${primary}`);
    expectRan(claudeIn(primary, home), primary, "claude", "PreToolUse");
  });

  it("blocks a symlinked session directory that points outside the anchored primary", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = withBundle(tmp(), "OUTSIDE");
    mkdirSync(join(primary, ".claude/worktrees"), { recursive: true });
    const link = join(primary, ".claude/worktrees/42-link");
    symlinkSync(outside, link);
    anchor(home, `${primary}\n`);
    expectBlocked(claudeIn(link, home));
    // A symlink that lands inside the primary is judged by where it lands.
    const alias = join(tmp(), "alias");
    symlinkSync(primary, alias);
    expectRan(claudeIn(alias, home), primary, "claude", "PreToolUse");
  });

  it("treats a primary path with spaces and pattern characters literally", () => {
    const home = tmp();
    const base = tmp();
    const primary = withBundle(join(base, "my repo *"), "PRIMARY");
    const decoy = withBundle(join(base, "my repo x"), "DECOY");
    mkdirSync(join(primary, ".claude/worktrees/1-t"), { recursive: true });
    anchor(
      home,
      `${join(base, "*")}\n${join(base, "my repo ?")}\n${primary}\n`,
    );
    expectRan(claudeIn(primary, home), primary, "claude", "PreToolUse");
    expectRan(
      claudeIn(join(primary, ".claude/worktrees/1-t"), home),
      primary,
      "claude",
      "PreToolUse",
    );
    expectBlocked(claudeIn(decoy, home));
    anchor(home, `${join(base, "*")}\n${join(base, "my repo ?")}\n`);
    expectBlocked(claudeIn(decoy, home));
    expectBlocked(claudeIn(primary, home));
  });

  it("picks the first anchored primary that matches", () => {
    const home = tmp();
    const first = withBundle(tmp(), "PRIMARY");
    const second = withBundle(tmp(), "PRIMARY");
    anchor(home, `${first}\n${second}\n`);
    expectRan(claudeIn(second, home), second, "claude", "PreToolUse");
    expectRan(claudeIn(first, home), first, "claude", "PreToolUse");
  });
});

describe("launcher: session directory source", () => {
  it("Claude takes the session directory from CLAUDE_PROJECT_DIR only", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = tmp();
    anchor(home, `${primary}\n`);
    // Unset: the working directory does not stand in, even inside the primary.
    expectBlocked(launch(CLAUDE, { home, cwd: primary }));
    // Set: the working directory is irrelevant.
    expectRan(
      launch(CLAUDE, {
        home,
        cwd: outside,
        env: { CLAUDE_PROJECT_DIR: primary },
      }),
      primary,
      "claude",
      "PreToolUse",
    );
    expectBlocked(
      launch(CLAUDE, {
        home,
        cwd: primary,
        env: { CLAUDE_PROJECT_DIR: outside },
      }),
    );
    // CURSOR_PROJECT_DIR does not stand in for it.
    expectBlocked(
      launch(CLAUDE, {
        home,
        cwd: outside,
        env: { CURSOR_PROJECT_DIR: primary },
      }),
    );
  });

  it("Cursor takes the session directory from CURSOR_PROJECT_DIR", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = tmp();
    anchor(home, `${primary}\n`);
    expectRan(
      launch(CURSOR, {
        home,
        cwd: outside,
        env: { CURSOR_PROJECT_DIR: primary },
      }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
    expectBlocked(
      launch(CURSOR, {
        home,
        cwd: primary,
        env: { CURSOR_PROJECT_DIR: outside },
      }),
    );
    // CLAUDE_PROJECT_DIR (Cursor sets it too) is not consulted.
    expectBlocked(
      launch(CURSOR, {
        home,
        cwd: outside,
        env: { CURSOR_PROJECT_DIR: outside, CLAUDE_PROJECT_DIR: primary },
      }),
    );
  });

  it("Cursor falls back to the hook's working directory when CURSOR_PROJECT_DIR is unset", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = tmp();
    anchor(home, `${primary}\n`);
    expectRan(
      launch(CURSOR, { home, cwd: primary }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
    expectBlocked(launch(CURSOR, { home, cwd: outside }));
  });

  it("Cursor never uses the cwd of the hook payload", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const outside = tmp();
    anchor(home, `${primary}\n`);
    const res = spawnSync("sh", ["-c", CURSOR], {
      cwd: outside,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      input: JSON.stringify({ cwd: primary, workspace_roots: [primary] }),
      encoding: "utf8",
    });
    expectBlocked({
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  });

  it("Cursor accepts its own worktree directory for an anchored primary, Claude does not", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    const name = primary.split("/").pop() ?? "";
    const worktree = join(home, ".cursor/worktrees", name, "abc");
    mkdirSync(worktree, { recursive: true });
    anchor(home, `${primary}\n`);
    expectRan(
      launch(CURSOR, {
        home,
        cwd: worktree,
        env: { CURSOR_PROJECT_DIR: worktree },
      }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
    expectBlocked(claudeIn(worktree, home));
    // Another repository's name under ~/.cursor/worktrees does not match.
    const foreign = join(home, ".cursor/worktrees", `${name}-x`, "abc");
    mkdirSync(foreign, { recursive: true });
    expectBlocked(
      launch(CURSOR, {
        home,
        cwd: foreign,
        env: { CURSOR_PROJECT_DIR: foreign },
      }),
    );
  });
});

describe("launcher: hardening", () => {
  it("rejects a relative CLAUDE_PROJECT_DIR", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    anchor(home, `${primary}\n`);
    // Relative to the working directory, it would name the primary.
    expectBlocked(
      launch(CLAUDE, { home, cwd: primary, env: { CLAUDE_PROJECT_DIR: "." } }),
    );
    expectBlocked(
      launch(CLAUDE, {
        home,
        cwd: join(primary, ".."),
        env: { CLAUDE_PROJECT_DIR: primary.split("/").pop() ?? "" },
      }),
    );
  });

  it("rejects a relative CURSOR_PROJECT_DIR but still falls back when it is unset", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    anchor(home, `${primary}\n`);
    expectBlocked(
      launch(CURSOR, {
        home,
        cwd: join(primary, ".."),
        env: { CURSOR_PROJECT_DIR: primary.split("/").pop() ?? "" },
      }),
    );
    expectRan(
      launch(CURSOR, { home, cwd: primary }),
      primary,
      "cursor",
      "beforeShellExecution",
    );
  });

  it("stops with the bundle message when the trusted primary has no bundle", () => {
    const home = tmp();
    const primary = tmp();
    anchor(home, `${primary}\n`);
    const run = claudeIn(primary, home);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`${LAUNCHER_BUNDLE_MESSAGE}\n`);
    expect(run.status).toBe(2);
  });

  it("does not strip a carriage return from an anchor line", () => {
    const home = tmp();
    const primary = withBundle(tmp(), "PRIMARY");
    anchor(home, `${primary}\r\n`);
    expectBlocked(claudeIn(primary, home));
  });
});

describe("bundlePrimary: the trusted primary of a running bundle (#73)", () => {
  /** A structural primary (`.git` directory) with a stub bundle in `wardens/dist`. */
  function primaryWithBundle(): string {
    const primary = withBundle(tmp(), "PRIMARY");
    mkdirSync(join(primary, ".git"));
    return primary;
  }
  const url = (primary: string) =>
    pathToFileURL(join(primary, "wardens/dist/wardens.mjs")).href;

  it("names the anchored primary the bundle sits in", () => {
    const home = tmp();
    const primary = primaryWithBundle();
    anchor(home, `${primary}\n`);
    expect(bundlePrimary(url(primary), home)).toBe(primary);
  });

  it("returns the physical path for a bundle reached through a symlink", () => {
    const home = tmp();
    const primary = primaryWithBundle();
    const link = join(tmp(), "link");
    symlinkSync(primary, link);
    anchor(home, `${primary}\n`);
    expect(bundlePrimary(url(link), home)).toBe(primary);
  });

  it("is null without an anchor, with a foreign anchor entry and with an empty anchor", () => {
    const home = tmp();
    const primary = primaryWithBundle();
    expect(bundlePrimary(url(primary), home)).toBeNull();
    anchor(home, `${primaryWithBundle()}\n`);
    expect(bundlePrimary(url(primary), home)).toBeNull();
    anchor(home, "");
    expect(bundlePrimary(url(primary), home)).toBeNull();
  });

  it("is null for a bundle built inside a task worktree, even when the anchor lists the worktree", () => {
    const home = tmp();
    const primary = primaryWithBundle();
    const worktree = join(primary, ".claude/worktrees/42-task");
    withBundle(worktree, "WORKTREE");
    writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
    anchor(home, `${primary}\n${worktree}\n`);
    expect(bundlePrimary(url(worktree), home)).toBeNull();
  });

  it("is null, and never throws, for a home that is undefined, empty, relative or missing", () => {
    const primary = primaryWithBundle();
    for (const home of [
      undefined,
      "",
      "relative/home",
      join(tmp(), "no-such-dir"),
    ]) {
      expect(bundlePrimary(url(primary), home as string)).toBeNull();
    }
  });

  it("is null when run from TypeScript source or from a bundle with another name or place", () => {
    const home = tmp();
    const primary = primaryWithBundle();
    anchor(home, `${primary}\n`);
    mkdirSync(join(primary, "wardens/src"), { recursive: true });
    writeFileSync(join(primary, "wardens/src/cli.ts"), "");
    writeFileSync(join(primary, "wardens/dist/other.mjs"), "");
    for (const file of ["wardens/src/cli.ts", "wardens/dist/other.mjs"]) {
      expect(
        bundlePrimary(pathToFileURL(join(primary, file)).href, home),
      ).toBeNull();
    }
    expect(bundlePrimary("file:///no/such/wardens.mjs", home)).toBeNull();
  });
});
