import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { POST_PULL_SCRIPT } from "../src/sync/post-merge.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "wardens-pull-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function dir(name: string): string {
  const path = join(base, `${name}-${counter++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A `pnpm` that appends its arguments to `calls.log`, and fails when `FAIL_PNPM` is set. */
function stubBin(): { bin: string; log: string } {
  const bin = dir("bin");
  const log = join(bin, "calls.log");
  const script = join(bin, "pnpm");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$*" >> "${log}"\nif [ -n "$FAIL_PNPM" ]; then exit 1; fi\n`,
  );
  chmodSync(script, 0o755);
  return { bin, log };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commitFile(cwd: string, file: string, text: string): string {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `change ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function primaryRepo(): string {
  const root = dir("primary");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, "README.md", "a");
  return root;
}

function run(
  cwd: string,
  stub: { bin: string },
  env: Record<string, string> = {},
) {
  const out = execFileSync("sh", ["-c", POST_PULL_SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stub.bin}:${process.env.PATH}`, ...env },
  });
  return out;
}

function calls(stub: { log: string }): string[] {
  return existsSync(stub.log)
    ? readFileSync(stub.log, "utf8").trim().split("\n")
    : [];
}

/** Primary repo whose last commit changed `files`; ORIG_HEAD points at the parent. */
function pulled(files: Record<string, string>): string {
  const root = primaryRepo();
  const old = git(root, "rev-parse", "HEAD");
  for (const [file, text] of Object.entries(files)) {
    commitFile(root, file, text);
  }
  git(root, "update-ref", "ORIG_HEAD", old);
  return root;
}

describe("post-merge / post-rewrite shell", () => {
  it("installs then builds when the lockfile and wardens/ changed", () => {
    const stub = stubBin();
    const root = pulled({ "pnpm-lock.yaml": "x", "wardens/src/a.ts": "x" });
    run(root, stub);
    expect(calls(stub)).toEqual([
      "install --frozen-lockfile",
      "--filter wardens build",
    ]);
  });

  it("only builds when just wardens/ changed", () => {
    const stub = stubBin();
    run(pulled({ "wardens/test/a.test.ts": "x" }), stub);
    expect(calls(stub)).toEqual(["--filter wardens build"]);
  });

  it("only installs when just the lockfile changed", () => {
    const stub = stubBin();
    run(pulled({ "pnpm-lock.yaml": "x" }), stub);
    expect(calls(stub)).toEqual(["install --frozen-lockfile"]);
  });

  it("does nothing when neither changed", () => {
    const stub = stubBin();
    run(pulled({ "apps/web/a.ts": "x" }), stub);
    expect(calls(stub)).toEqual([]);
  });

  it("does not match a lockfile or wardens/ path nested elsewhere", () => {
    const stub = stubBin();
    run(pulled({ "apps/pnpm-lock.yaml": "x", "docs/wardens/a.md": "x" }), stub);
    expect(calls(stub)).toEqual([]);
  });

  it("does nothing in a linked worktree, even on main-like content", () => {
    const stub = stubBin();
    const root = pulled({ "wardens/src/a.ts": "x" });
    const linked = join(dir("linked"), "wt");
    git(root, "worktree", "add", "-q", "-b", "feat/x", linked);
    git(linked, "update-ref", "ORIG_HEAD", "HEAD~1");
    run(linked, stub);
    expect(calls(stub)).toEqual([]);
  });

  it("does nothing on a branch other than main in the primary checkout", () => {
    const stub = stubBin();
    const root = pulled({ "wardens/src/a.ts": "x" });
    git(root, "switch", "-q", "-c", "other");
    run(root, stub);
    expect(calls(stub)).toEqual([]);
  });

  it("rebuilds everything when ORIG_HEAD is missing", () => {
    const stub = stubBin();
    const root = primaryRepo();
    run(root, stub);
    expect(calls(stub)).toEqual([
      "install --frozen-lockfile",
      "--filter wardens build",
    ]);
  });

  it("never fails the pull: prints the failure and the next action", () => {
    const stub = stubBin();
    const root = pulled({ "pnpm-lock.yaml": "x", "wardens/src/a.ts": "x" });
    const out = run(root, stub, { FAIL_PNPM: "1" });
    expect(out).toContain("pnpm install failed");
    expect(out).toContain(
      "Run pnpm install && pnpm --filter wardens build in the primary checkout.",
    );
    expect(calls(stub)).toEqual(["install --frozen-lockfile"]);
  });

  it("prints the failure when only the build fails", () => {
    const stub = stubBin();
    const root = pulled({ "wardens/src/a.ts": "x" });
    const out = run(root, stub, { FAIL_PNPM: "1" });
    expect(out).toContain("bundle build failed");
  });
});

describe("real git pulls fire the hooks with a usable ORIG_HEAD", () => {
  function setup() {
    const stub = stubBin();
    const origin = dir("origin");
    git(origin, "init", "-q", "-b", "main");
    commitFile(origin, "README.md", "a");
    const clone = join(dir("clone"), "primary");
    git(base, "clone", "-q", origin, clone);
    for (const hook of ["post-merge", "post-rewrite"]) {
      const file = join(clone, ".git", "hooks", hook);
      const script =
        hook === "post-rewrite"
          ? `if [ "$1" != rebase ]; then exit 0; fi\n${POST_PULL_SCRIPT}`
          : POST_PULL_SCRIPT;
      writeFileSync(file, `#!/bin/sh\n${script}`);
      chmodSync(file, 0o755);
    }
    return { stub, origin, clone };
  }

  function pull(clone: string, stub: { bin: string }, ...args: string[]) {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "pull",
        "-q",
        ...args,
      ],
      {
        cwd: clone,
        stdio: "pipe",
        env: { ...process.env, PATH: `${stub.bin}:${process.env.PATH}` },
      },
    );
  }

  it("fast-forward merge pull", () => {
    const { stub, origin, clone } = setup();
    commitFile(origin, "wardens/src/a.ts", "x");
    pull(clone, stub, "--no-rebase");
    expect(calls(stub)).toEqual(["--filter wardens build"]);
  });

  it("true merge pull", () => {
    const { stub, origin, clone } = setup();
    commitFile(clone, "local.txt", "x");
    commitFile(origin, "pnpm-lock.yaml", "x");
    pull(clone, stub, "--no-rebase");
    expect(calls(stub)).toEqual(["install --frozen-lockfile"]);
  });

  it("rebase pull with local commits (post-rewrite)", () => {
    const { stub, origin, clone } = setup();
    commitFile(clone, "local.txt", "x");
    commitFile(origin, "wardens/src/a.ts", "x");
    pull(clone, stub, "--rebase");
    expect(calls(stub)).toEqual(["--filter wardens build"]);
  });

  it("rebase pull that fast-forwards", () => {
    const { stub, origin, clone } = setup();
    commitFile(origin, "wardens/src/a.ts", "x");
    pull(clone, stub, "--rebase");
    expect(calls(stub)).toEqual(["--filter wardens build"]);
  });
});
