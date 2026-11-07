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
import { integrityOf, listRecords, real } from "./task-integrity.ts";
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

function readTaskFile(worktree: string): Buffer | null {
  try {
    return readFileSync(join(worktree, ".panopticon", "task.json"));
  } catch {
    return null;
  }
}

/**
 * Per linked worktree: `fail` when task.json changed after setup or is gone
 * although setup recorded it, `warn` when it has no record (set up before
 * records existed) or when a record has no worktree. The hooks deny edits in
 * the failing and unrecorded ones until a human runs `wardens worktree setup`.
 */
export function checkTaskIntegrity(primary: string, home: string): CheckResult {
  if (!isAbsolute(home)) {
    return result(
      "task-integrity",
      "warn",
      "HOME could not be resolved, so recorded task.json hashes cannot be read and the hooks deny task worktrees. Set HOME to an absolute path of an existing directory",
    );
  }
  const integrity = { primary, home };
  const linked = listWorktrees(primary).filter((e) => !e.primary);
  const changed: string[] = [];
  const gone: string[] = [];
  const unrecorded: string[] = [];
  let verified = 0;
  for (const entry of linked) {
    const state = integrityOf(readTaskFile(entry.path), entry.path, integrity);
    const name = basename(entry.path);
    if (state === "mismatch") {
      changed.push(name);
    } else if (state === "deleted") {
      gone.push(name);
    } else if (state === "unrecorded") {
      unrecorded.push(name);
    } else if (state === "verified") {
      verified += 1;
    }
  }
  const present = new Set(linked.map((e) => real(e.path)));
  const orphans = listRecords(home)
    .filter((r) => r.primary === real(primary) && !present.has(r.worktree))
    .map((r) => basename(r.worktree));
  const parts = [
    ...(changed.length > 0
      ? [`task.json changed after setup in ${changed.join(", ")}`]
      : []),
    ...(gone.length > 0
      ? [`task.json is missing but recorded in ${gone.join(", ")}`]
      : []),
    ...(unrecorded.length > 0
      ? [`no recorded task.json hash in ${unrecorded.join(", ")}`]
      : []),
  ];
  const next = "Ask Krzysztof to run wardens worktree setup in it";
  const orphanNote =
    orphans.length > 0
      ? `orphan records of removed worktrees: ${orphans.join(", ")} (delete them under ~/.config/panopticon/tasks)`
      : null;
  if (changed.length > 0 || gone.length > 0) {
    return result(
      "task-integrity",
      "fail",
      `${[...parts, ...(orphanNote ? [orphanNote] : [])].join("; ")}. ${next}`,
    );
  }
  if (parts.length > 0) {
    return result(
      "task-integrity",
      "warn",
      `${[...parts, ...(orphanNote ? [orphanNote] : [])].join("; ")}. ${next}`,
    );
  }
  if (orphanNote !== null) {
    return result("task-integrity", "warn", orphanNote);
  }
  return result(
    "task-integrity",
    "ok",
    verified === 0
      ? "no task worktree has a task.json"
      : `${verified} task.json ${verified === 1 ? "file matches" : "files match"} the recorded hash`,
  );
}

const PRIMARY_WATCHED = [CHARTER_FILENAME, "wardens/"];

/**
 * Advisory: the hooks run the primary's bundle and Charter. Compares the
 * primary's working tree with the already-fetched `origin/main` (no network).
 * `refs/remotes/origin/main` is shared with every worktree, so a same-UID
 * agent could rewrite it; `command-guard` denies `git update-ref` and
 * `git remote` changes, but this check cannot prove the ref is genuine.
 */
export function checkPrimaryBehind(primary: string): CheckResult {
  const ref = "refs/remotes/origin/main";
  const unknown = (why: string): CheckResult =>
    result(
      "primary-behind",
      "warn",
      `${why}, so the primary's Charter and wardens/ cannot be compared. Run git fetch origin in the primary`,
    );
  if (!git(primary, ["rev-parse", "--verify", "--quiet", ref]).ok) {
    return unknown("origin/main is not fetched in the primary checkout");
  }
  const diff = git(primary, [
    "diff",
    "--name-only",
    ref,
    "--",
    ...PRIMARY_WATCHED,
  ]);
  if (!diff.ok) {
    return unknown(
      "the primary checkout could not be compared with origin/main",
    );
  }
  if (diff.out.length === 0) {
    return result(
      "primary-behind",
      "ok",
      "the primary's Charter and wardens/ equal origin/main",
    );
  }
  const files = diff.out.split("\n").slice(0, 3).join(", ");
  const behind = git(primary, [
    "log",
    "-1",
    "--format=%h",
    `HEAD..${ref}`,
    "--",
    ...PRIMARY_WATCHED,
  ]);
  if (behind.ok && behind.out.length > 0) {
    return result(
      "primary-behind",
      "warn",
      `the primary checkout is behind origin/main in ${files}. The hooks run the primary's copy: run git pull in the primary`,
    );
  }
  const dirty = git(primary, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--",
    ...PRIMARY_WATCHED,
  ]);
  return result(
    "primary-behind",
    "warn",
    dirty.ok && dirty.out.length > 0
      ? `the primary checkout has uncommitted changes in ${files} against origin/main. Review them with git status in the primary`
      : `the primary checkout is ahead of origin/main or on another branch in ${files}. Review it with git log origin/main..HEAD in the primary`,
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
