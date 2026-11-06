import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export type PrimaryResult =
  | { ok: true; primary: string }
  | { ok: false; reason: string };

const WORKTREE_DIR = /\/\.(claude|cursor)\/worktrees\//;

/** True when a path has a `/.claude/worktrees/` or `/.cursor/worktrees/` segment. */
export function underWorktreeDir(path: string): boolean {
  return WORKTREE_DIR.test(`${path}/`);
}

function kindOf(path: string): "dir" | "file" | "none" {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      return "dir";
    }
    return stat.isFile() ? "file" : "none";
  } catch {
    return "none";
  }
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Structural check of one primary checkout, without git: its physical path has
 * a `.git` directory (not a file, which marks a linked worktree) and does not
 * lie under a `.claude/worktrees` or `.cursor/worktrees` directory.
 * Returns the reason it is not a primary, or null.
 */
export function primaryProblem(path: string): string | null {
  const physical = real(path);
  if (physical === null) {
    return "does not exist";
  }
  const git = kindOf(join(physical, ".git"));
  if (git === "file") {
    return "is a linked worktree, not a primary checkout";
  }
  if (git === "none") {
    return "has no .git directory";
  }
  return underWorktreeDir(physical) ? "lies under a worktrees directory" : null;
}

function gitdirOf(worktreeGit: string): string | null {
  try {
    const first = readFileSync(worktreeGit, "utf8").split("\n")[0] ?? "";
    const match = /^gitdir: (.+)$/.exec(first.trim());
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Entries `<primary>/.git/worktrees/<name>` whose `gitdir` file names `<toplevel>/.git`. */
function linkedBackEntries(primary: string, worktreeGit: string): string[] {
  const root = join(primary, ".git", "worktrees");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    try {
      const target = readFileSync(join(root, name, "gitdir"), "utf8").trim();
      if (real(target) === worktreeGit) {
        found.push(join(root, name));
      }
    } catch {
      // Not a worktree entry.
    }
  }
  return found;
}

/**
 * The primary checkout of `toplevel`, derived from the file system and not
 * from git. A `.git` directory makes it its own primary. A `.git` file points
 * at `<primary>/.git/worktrees/<name>`; that is accepted only when
 * exactly one entry there links back to this worktree, the primary passes
 * `primaryProblem`, and the worktree lies in a location the launcher accepts
 * (`<primary>/.claude/worktrees/` or `<home>/.cursor/worktrees/<name>/`).
 */
export function structuralPrimary(
  toplevel: string,
  home: string,
): PrimaryResult {
  const top = real(toplevel);
  if (top === null) {
    return { ok: false, reason: "does not exist" };
  }
  const git = join(top, ".git");
  const kind = kindOf(git);
  if (kind === "dir") {
    const problem = primaryProblem(top);
    return problem === null
      ? { ok: true, primary: top }
      : { ok: false, reason: problem };
  }
  if (kind === "none") {
    return { ok: false, reason: "has no .git entry" };
  }
  const pointer = gitdirOf(git);
  const entry = pointer === null ? null : real(resolve(top, pointer));
  if (
    entry === null ||
    basename(dirname(entry)) !== "worktrees" ||
    basename(dirname(dirname(entry))) !== ".git"
  ) {
    return {
      ok: false,
      reason: "its .git file does not name a worktree entry",
    };
  }
  const primary = dirname(dirname(dirname(entry)));
  const problem = primaryProblem(primary);
  if (problem !== null) {
    return { ok: false, reason: `its primary ${primary} ${problem}` };
  }
  const back = linkedBackEntries(primary, git);
  if (back.length !== 1 || real(back[0] ?? "") !== entry) {
    return {
      ok: false,
      reason: `${primary} does not link back to this worktree exactly once`,
    };
  }
  const homeWorktrees = join(home, ".cursor", "worktrees", basename(primary));
  const homeReal = real(homeWorktrees) ?? homeWorktrees;
  const inPlace =
    top.startsWith(join(primary, ".claude", "worktrees") + sep) ||
    top.startsWith(homeReal + sep);
  return inPlace
    ? { ok: true, primary }
    : {
        ok: false,
        reason: `this worktree is not under ${join(primary, ".claude", "worktrees")}`,
      };
}
