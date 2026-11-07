import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  CHARTER_FILENAME,
  loadCharterAt,
  type WorktreeConfig,
} from "./charter.ts";
import type { CheckResult, CheckStatus } from "./doctor.ts";
import { checkIntegrity } from "./task-integrity.ts";
import { git, listWorktrees } from "./worktree/git.ts";
import { GH_FAILED_STATE, issueOf, prState } from "./worktree/index.ts";
import { type Deps, realDeps } from "./worktree/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUDED_DIR = ".claude/worktrees";
const EXCLUSION_FILES = [
  ".gitignore",
  "biome.json",
  "tsconfig.base.json",
  "pyproject.toml",
] as const;

/** Why the database names could not be read. */
export type DatabasesUnavailable = {
  unavailable: "psql-missing" | "unreachable";
};

/** Side effects of the worktree checks; tests inject them. */
export type WorktreeCheckDeps = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Runs `gh <args>`, like `worktree/types.ts`. */
  gh: Deps["gh"];
  /** Names of every database on the server, or the reason they cannot be read. */
  listDatabases: (env: NodeJS.ProcessEnv) => string[] | DatabasesUnavailable;
};

type Spawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/** Reads database names with `psql`; `spawn` is injected for tests. */
export function psqlDatabases(
  env: NodeJS.ProcessEnv,
  spawn: Spawn = spawnSync,
): string[] | DatabasesUnavailable {
  const res = spawn(
    "psql",
    [
      "-X",
      "-w",
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
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { unavailable: "psql-missing" };
  }
  if (res.status !== 0 || typeof res.stdout !== "string") {
    return { unavailable: "unreachable" };
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

/**
 * The Charter's worktree section, or the skipped result that explains its
 * absence. Read from the primary checkout: a task branch's own Charter must
 * not be able to silence these checks (#73).
 */
function worktreeConfig(
  id: string,
  primary: string,
): { cfg: WorktreeConfig } | { skipped: CheckResult } {
  const loaded = loadCharterAt(primary);
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
  return { reasons, ghFailed: state === GH_FAILED_STATE };
}

export function checkWorktrees(
  primary: string,
  deps: WorktreeCheckDeps,
): CheckResult {
  const config = worktreeConfig("worktrees", primary);
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
        `${problems.join("; ")}. Run wardens worktree prune for merged/closed PRs; set up or remove the others with wardens worktree setup/remove${note}`,
      )
    : result(
        "worktrees",
        "ok",
        `${linked.length} linked ${linked.length === 1 ? "worktree is" : "worktrees are"} in use${note}`,
      );
}

export function checkTaskDatabases(
  primary: string,
  deps: WorktreeCheckDeps,
): CheckResult {
  const config = worktreeConfig("task-databases", primary);
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
  if ("unavailable" in names) {
    return result(
      "task-databases",
      "warn",
      names.unavailable === "psql-missing"
        ? "psql is not installed, so orphan task databases were not checked"
        : "the database server is unreachable, so orphan task databases were not checked",
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

function listDatabaseNames(
  deps: WorktreeCheckDeps,
): string[] | DatabasesUnavailable {
  try {
    return deps.listDatabases(deps.env);
  } catch {
    return { unavailable: "unreachable" };
  }
}

function charterText(root: string): string | null {
  try {
    return readFileSync(join(root, CHARTER_FILENAME), "utf8");
  } catch {
    return null;
  }
}

/**
 * Advisory (#73): the hooks apply the primary's Charter, so a session's own
 * copy that differs is not in force. Expected while a PR changes the Charter.
 */
export function checkCharterDrift(
  toplevel: string,
  primary: string,
): CheckResult {
  if (realpathOr(toplevel) === realpathOr(primary)) {
    return result("charter-drift", "ok", "this is the primary checkout");
  }
  return charterText(toplevel) === charterText(primary)
    ? result(
        "charter-drift",
        "ok",
        "this worktree's Charter equals the primary's",
      )
    : result(
        "charter-drift",
        "warn",
        `${CHARTER_FILENAME} of this worktree differs from the primary's (the primary is behind origin/main, or this branch edits it), and the hooks apply the primary's. Pull the primary if it is behind`,
      );
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Per linked worktree with a task.json: `verified`, `unrecorded` (warn: set up
 * before hashes existed) or `mismatch` (fail: changed after setup). Both
 * non-verified states make the hooks deny edits there until a human runs
 * `wardens worktree setup`.
 */
export function checkTaskIntegrity(primary: string, home: string): CheckResult {
  const unrecorded: string[] = [];
  const mismatched: string[] = [];
  let checked = 0;
  for (const entry of listWorktrees(primary).filter((e) => !e.primary)) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(entry.path, ".panopticon", "task.json"));
    } catch {
      continue;
    }
    checked += 1;
    const state = isAbsolute(home)
      ? checkIntegrity(raw, entry.path, { primary, home })
      : "unrecorded";
    if (state === "unrecorded") {
      unrecorded.push(basename(entry.path));
    } else if (state === "mismatch") {
      mismatched.push(basename(entry.path));
    }
  }
  const next = "Ask Krzysztof to run wardens worktree setup in it";
  if (mismatched.length > 0) {
    return result(
      "task-integrity",
      "fail",
      `task.json changed after setup in ${mismatched.join(", ")}${unrecorded.length > 0 ? `; no recorded hash in ${unrecorded.join(", ")}` : ""}. ${next}`,
    );
  }
  if (unrecorded.length > 0) {
    return result(
      "task-integrity",
      "warn",
      `no recorded task.json hash in ${unrecorded.join(", ")}. ${next}`,
    );
  }
  return result(
    "task-integrity",
    "ok",
    `${checked} task.json ${checked === 1 ? "file matches" : "files match"} the recorded hash`,
  );
}

const PRIMARY_WATCHED = [CHARTER_FILENAME, "wardens/"];

/**
 * Advisory: the hooks run the primary's bundle and Charter. Compares the
 * primary's working tree with the already-fetched `origin/main` (no network).
 */
export function checkPrimaryBehind(primary: string): CheckResult {
  const ref = "refs/remotes/origin/main";
  if (!git(primary, ["rev-parse", "--verify", "--quiet", ref]).ok) {
    return result(
      "primary-behind",
      "ok",
      "skipped: origin/main is not fetched in the primary checkout",
    );
  }
  const diff = git(primary, [
    "diff",
    "--name-only",
    ref,
    "--",
    ...PRIMARY_WATCHED,
  ]);
  if (!diff.ok) {
    return result(
      "primary-behind",
      "ok",
      "skipped: the primary checkout could not be compared with origin/main",
    );
  }
  return diff.out.length > 0
    ? result(
        "primary-behind",
        "warn",
        `${PRIMARY_WATCHED.join(" and ")} in the primary checkout differ from origin/main (${diff.out.split("\n").slice(0, 3).join(", ")}). The hooks run the primary's copy against the last fetched ref). Run git pull in the primary`,
      )
    : result(
        "primary-behind",
        "ok",
        "the primary's Charter and wardens/ equal origin/main",
      );
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
