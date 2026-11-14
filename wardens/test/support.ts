import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

export function normativeCharter(): string {
  return readFileSync(join(repoRoot, "panopticon.charter.yaml"), "utf8");
}

/** The normative Charter without `worktree:`, so `worktree-guard` is off for tests that edit in a primary-checkout temp repo. */
export function charterWithoutWorktree(): string {
  const text = normativeCharter().replace(/^worktree:[\s\S]*?(?=^\S)/m, "");
  if (/^worktree:/m.test(text)) {
    throw new Error(
      "charterWithoutWorktree could not strip the worktree section",
    );
  }
  return text;
}

/**
 * `open` lets every path through `allowed_paths`, for tests of the tokenizer and
 * of the other rules that write to a bare `out.txt`: shell writes are in scope
 * for `scope-guard` since #83, and the Charter's own scope is the repository's.
 */
export function tempRepo(
  options: { worktree?: boolean; open?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "wardens-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  const charter = options.worktree
    ? normativeCharter()
    : charterWithoutWorktree();
  writeFileSync(
    join(dir, "panopticon.charter.yaml"),
    options.open
      ? charter.replace(
          /^ {2}allowed_paths:\n/m,
          '  allowed_paths:\n    - "**"\n',
        )
      : charter,
  );
  return dir;
}

export function writeRepoFile(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Turns `worktree` into a directory whose `.git` file names a gitdir inside
 * itself, which in turn links back to the worktree and belongs to a repository
 * of its own (`<worktree>/.evil`). Returns that fake primary's path.
 */
export function forgePointer(worktree: string): string {
  mkdirSync(worktree, { recursive: true });
  const fake = join(realpathSync(worktree), ".evil");
  const entry = join(fake, ".git/worktrees/x");
  mkdirSync(entry, { recursive: true });
  mkdirSync(join(fake, ".git/objects"), { recursive: true });
  mkdirSync(join(fake, ".git/refs"), { recursive: true });
  writeFileSync(join(fake, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(entry, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(entry, "commondir"), "../..\n");
  writeFileSync(join(entry, "gitdir"), `${realpathSync(worktree)}/.git\n`);
  writeFileSync(join(worktree, ".git"), `gitdir: ${entry}\n`);
  return fake;
}

export const cliPath = join(repoRoot, "wardens/src/cli.ts");
