import { execFileSync } from "node:child_process";

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
