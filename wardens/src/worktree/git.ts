import { execFileSync } from "node:child_process";

export type GitResult = { ok: boolean; out: string };

/** Runs git in `cwd`; never throws. */
export function git(cwd: string, args: string[]): GitResult {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String(err.stderr).trim()
        : "";
    return { ok: false, out: stderr };
  }
}

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  primary: boolean;
};

/** `git worktree list --porcelain`; the first entry is the primary checkout. */
export function listWorktrees(cwd: string): WorktreeEntry[] {
  const res = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!res.ok) {
    return [];
  }
  const entries: WorktreeEntry[] = [];
  for (const block of res.out.split("\n\n")) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      }
    }
    if (path !== null) {
      entries.push({ path, branch, primary: entries.length === 0 });
    }
  }
  return entries;
}
