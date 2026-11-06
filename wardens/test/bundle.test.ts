import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAnchor } from "../src/sync/anchor.ts";
import { repoRoot, tempRepo } from "./support.ts";

// One level below wardens/ so the bundle finds ../schema like dist/ does.
const outDir = mkdtempSync(join(repoRoot, "wardens", ".bundle-test-"));
const bundle = join(outDir, "wardens.mjs");

function run(
  args: string[],
  cwd: string,
  input?: string,
  env?: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    input,
    ...(env ? { env } : {}),
  });
}

describe("built bundle", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["exec", "tsup", "--out-dir", outDir], {
      cwd: join(repoRoot, "wardens"),
      stdio: "pipe",
    });
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("runs charter-validate without a dynamic require crash", () => {
    const res = run([bundle, "check", "charter-validate"], repoRoot);
    expect(res.stderr).not.toContain("Dynamic require");
    expect(res.status).toBe(0);
  });

  it("answers a hook payload from the primary it sits in, and fails closed anywhere else (#73)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wardens-home-")));
    const root = realpathSync(tempRepo());
    const fixture = JSON.parse(
      readFileSync(
        join(repoRoot, "wardens/test/fixtures/claude/edit.json"),
        "utf8",
      ),
    );
    const input = JSON.stringify(fixture.stdin).replaceAll(
      "__WORKTREE__",
      root,
    );
    const args = ["hook", "--tool", "claude", "--event", "PreToolUse"];
    const env = { PATH: process.env.PATH ?? "", HOME: home };
    try {
      // `root` is a primary checkout (`.git` directory) listed in the anchor.
      mkdirSync(join(root, "wardens", "dist"), { recursive: true });
      cpSync(bundle, join(root, "wardens", "dist", "wardens.mjs"));
      cpSync(
        join(repoRoot, "wardens", "schema"),
        join(root, "wardens", "schema"),
        {
          recursive: true,
        },
      );
      writeAnchor(home, root);
      const trusted = run(
        [join(root, "wardens", "dist", "wardens.mjs"), ...args],
        root,
        input,
        env,
      );
      expect(trusted.stderr).toBe("");
      // The Charter of the primary judged it: scope-guard, not the engine.
      expect(trusted.stdout).toContain("Blocked by Warden scope-guard");
      expect(trusted.stdout).not.toContain("wardens sync");
      expect(trusted.status).toBe(0);
      // The same bundle where the anchor does not list it fails closed.
      const untrusted = run([bundle, ...args], root, input, env);
      expect(untrusted.status).toBe(0);
      expect(untrusted.stdout).toContain("wardens sync");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
