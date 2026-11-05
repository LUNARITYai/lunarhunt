import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type CwdClass = {
  kind: "primary" | "linked";
  /** Current branch, or null on a detached HEAD. */
  branch: string | null;
};

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Absolute, realpath'd common git dir shared by the primary checkout and its linked worktrees. */
export function gitCommonDir(cwd: string): string | null {
  const out = gitOut(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return out ? real(out) : null;
}

/**
 * Primary checkout (`--git-dir` equals `--git-common-dir`) or linked worktree,
 * plus the current branch (null when detached). Null when git cannot say.
 * A submodule or a bare repository also has `--git-dir` equal to its common
 * dir, so it classifies as primary: the guard then blocks, which fails closed.
 */
export function classifyCwd(cwd: string): CwdClass | null {
  const gitDir = gitOut(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  const common = gitCommonDir(cwd);
  if (!gitDir || !common) {
    return null;
  }
  const branch = gitOut(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    kind: real(gitDir) === common ? "primary" : "linked",
    branch: branch && branch.length > 0 ? branch : null,
  };
}

/**
 * Worktree root of the nearest existing directory of an absolute `target`, when
 * it belongs to the same repository (same common git dir) as `cwd`; else null.
 */
export function siblingToplevel(cwd: string, target: string): string | null {
  let dir = target;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  if (!statSync(dir).isDirectory()) {
    dir = dirname(dir);
  }
  const own = gitCommonDir(cwd);
  const theirs = gitCommonDir(dir);
  if (!own || own !== theirs) {
    return null;
  }
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"]);
  return top ? real(top) : null;
}

/** The primary checkout: parent of the common git dir, the same resolution the generated hook commands use. */
export function primaryCheckout(cwd: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return out.length > 0 ? dirname(out) : null;
  } catch {
    return null;
  }
}

/** Worktree root for `cwd`, or null when git cannot resolve it. */
export function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** True when `path` (repo-relative or absolute) is tracked by git in `root`. */
export function gitTracked(root: string, path: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", root, "ls-files", "--error-unmatch", "--", path],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}
