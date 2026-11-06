import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCharterAt, type WorktreeConfig } from "./charter.ts";
import type { CheckResult, CheckStatus } from "./doctor.ts";
import { git, listWorktrees } from "./worktree/git.ts";
import { issueOf, prState } from "./worktree/index.ts";
import { type Deps, realDeps } from "./worktree/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUDED_DIR = ".claude/worktrees";
const EXCLUSION_FILES = [
  ".gitignore",
  "biome.json",
  "tsconfig.base.json",
  "pyproject.toml",
] as const;
const GH_FAILED = "unknown (gh failed)";

/** Side effects of the worktree checks; tests inject them. */
export type WorktreeCheckDeps = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Runs `gh <args>`, like `worktree/types.ts`. */
  gh: Deps["gh"];
  /** Names of every database on the server, or null when it is unreachable. */
  listDatabases: (env: NodeJS.ProcessEnv) => string[] | null;
};

/** Reads database names with `psql`; null when `psql` or the server is unavailable. */
export function psqlDatabases(env: NodeJS.ProcessEnv): string[] | null {
  const res = spawnSync(
    "psql",
    [
      "-X",
      "-A",
      "-t",
      "-d",
      "postgres",
      "-c",
      "select datname from pg_database",
    ],
    {
      env: { PGCONNECT_TIMEOUT: "5", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    },
  );
  if (res.status !== 0 || typeof res.stdout !== "string") {
    return null;
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function defaultWorktreeDeps(
  env: NodeJS.ProcessEnv,
  now: () => number,
): WorktreeCheckDeps {
  return { env, now, gh: realDeps.gh, listDatabases: psqlDatabases };
}

const result = (
  id: string,
  status: CheckStatus,
  message: string,
): CheckResult => ({ id, status, message });

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The Charter's worktree section, or the skipped result that explains its absence. */
function worktreeConfig(
  id: string,
  toplevel: string,
): { cfg: WorktreeConfig } | { skipped: CheckResult } {
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    return {
      skipped: result(id, "ok", "skipped: The Charter could not be loaded"),
    };
  }
  const cfg = loaded.charter.worktree;
  return cfg === undefined
    ? {
        skipped: result(
          id,
          "ok",
          "skipped: the Charter has no worktree: section",
        ),
      }
    : { cfg };
}

/** Why one linked worktree needs attention; an empty list means it is fine. */
function worktreeReasons(
  path: string,
  branch: string | null,
  cfg: WorktreeConfig,
  deps: WorktreeCheckDeps,
): { reasons: string[]; ghFailed: boolean } {
  const reasons: string[] = [];
  if (!existsSync(join(path, ".panopticon", "setup.ok"))) {
    reasons.push("no setup.ok");
  }
  const state = prState(deps, path, branch);
  if (state === "MERGED" || state === "CLOSED") {
    reasons.push(`PR ${state.toLowerCase()}`);
  }
  const committed = git(path, ["log", "-1", "--format=%ct", "HEAD"]);
  if (committed.ok && /^\d+$/.test(committed.out)) {
    const days = Math.floor(
      (deps.now() - Number(committed.out) * 1000) / DAY_MS,
    );
    if (days > cfg.cleanup.stale_after_days) {
      reasons.push(
        `no commit for ${days} days (stale after ${cfg.cleanup.stale_after_days})`,
      );
    }
  }
  return { reasons, ghFailed: state === GH_FAILED };
}

export function checkWorktrees(
  toplevel: string,
  primary: string,
  deps: WorktreeCheckDeps,
): CheckResult {
  const config = worktreeConfig("worktrees", toplevel);
  if ("skipped" in config) {
    return config.skipped;
  }
  const linked = listWorktrees(primary).filter((e) => !e.primary);
  const problems: string[] = [];
  let ghFailed = false;
  for (const entry of linked) {
    const res = worktreeReasons(entry.path, entry.branch, config.cfg, deps);
    ghFailed ||= res.ghFailed;
    if (res.reasons.length > 0) {
      problems.push(`${basename(entry.path)}: ${res.reasons.join(", ")}`);
    }
  }
  const note = ghFailed ? " (PR state not checked: gh failed)" : "";
  return problems.length > 0
    ? result(
        "worktrees",
        "warn",
        `${problems.join("; ")}. Run wardens worktree prune or remove them${note}`,
      )
    : result(
        "worktrees",
        "ok",
        `${linked.length} linked worktrees are in use${note}`,
      );
}

export function checkTaskDatabases(
  toplevel: string,
  primary: string,
  deps: WorktreeCheckDeps,
): CheckResult {
  const config = worktreeConfig("task-databases", toplevel);
  if ("skipped" in config) {
    return config.skipped;
  }
  const template = config.cfg.resources.database;
  if (template === undefined) {
    return result(
      "task-databases",
      "ok",
      "skipped: worktree.resources.database is not set",
    );
  }
  const names = listDatabaseNames(deps);
  if (names === null) {
    return result(
      "task-databases",
      "warn",
      "the database server is unreachable, so orphan task databases were not checked",
    );
  }
  const [head = "", ...rest] = template.split("{issue}");
  const pattern = new RegExp(
    `^${escapeRegExp(head)}([1-9][0-9]*)${escapeRegExp(rest.join("{issue}"))}$`,
  );
  const open = new Set(
    listWorktrees(primary)
      .filter((e) => !e.primary)
      .map(issueOf),
  );
  const orphans = names.filter((name) => {
    const issue = pattern.exec(name)?.[1];
    return issue !== undefined && !open.has(Number(issue));
  });
  return orphans.length > 0
    ? result(
        "task-databases",
        "warn",
        `orphan task databases without an open worktree: ${orphans.join(", ")}`,
      )
    : result(
        "task-databases",
        "ok",
        "every task database has an open worktree",
      );
}

function listDatabaseNames(deps: WorktreeCheckDeps): string[] | null {
  try {
    return deps.listDatabases(deps.env);
  } catch {
    return null;
  }
}

export function checkWorktreeExclusions(toplevel: string): CheckResult {
  const missing = EXCLUSION_FILES.filter((file) => {
    try {
      return !readFileSync(join(toplevel, file), "utf8").includes(EXCLUDED_DIR);
    } catch {
      return true;
    }
  });
  return missing.length > 0
    ? result(
        "worktree-exclusions",
        "fail",
        `${EXCLUDED_DIR} is missing from ${missing.join(", ")}`,
      )
    : result(
        "worktree-exclusions",
        "ok",
        `${EXCLUDED_DIR} is excluded in ${EXCLUSION_FILES.join(", ")}`,
      );
}
