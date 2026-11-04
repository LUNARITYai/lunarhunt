import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliPath, repoRoot, tempRepo } from "./support.ts";

// One level below wardens/ so the bundle finds ../schema like dist/ does.
const outDir = mkdtempSync(join(repoRoot, "wardens", ".bundle-test-"));
const bundle = join(outDir, "wardens.mjs");

function run(args: string[], cwd: string, input?: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8", input });
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

  it("answers a hook payload exactly like the TypeScript source", () => {
    const root = tempRepo();
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
    const fromBundle = run([bundle, ...args], root, input);
    const fromSource = run(
      ["--experimental-strip-types", cliPath, ...args],
      root,
      input,
    );
    expect(fromBundle.stdout).not.toBe("");
    expect(fromBundle.stdout).toBe(fromSource.stdout);
    expect(fromBundle.status).toBe(fromSource.status);
  });
});
