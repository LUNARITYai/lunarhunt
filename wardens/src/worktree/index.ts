import { existsSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { loadCharterAt, type WorktreeConfig } from "../charter.ts";
import { gitToplevel, primaryCheckout } from "../git.ts";
import { engineMessage, wardenMessage } from "../messages.ts";
import { loadTask } from "../task.ts";
import { detectAgent } from "../trailer.ts";
import { git, listWorktrees, type WorktreeEntry } from "./git.ts";
import {
  allowedPaths,
  type IssueInfo,
  parseBranch,
  slugify,
  typeFromLabels,
} from "./issue.ts";
import { portCollision, setupWorktree } from "./setup.ts";
import { type Deps, fail, ok, type Result, realDeps } from "./types.ts";

export type { Deps, Result } from "./types.ts";

export type WorktreeArgs = {
  sub: string;
  arg?: string | undefined;
  slug?: string | undefined;
  force?: boolean | undefined;
};

const AGENT_REFUSAL = wardenMessage(
  "worktree-guard",
  "wardens worktree grants task scope and is for humans",
  "Ask Krzysztof to run it",
);

const HUMAN_ONLY = new Set(["new", "setup", "remove", "prune"]);

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

function fetchIssue(
  deps: Deps,
  cwd: string,
  issue: number,
): IssueInfo | string {
  const res = deps.gh(
    ["issue", "view", String(issue), "--json", "title,labels,body"],
    cwd,
  );
  if (res.status !== 0) {
    return engineMessage(`gh could not read issue #${issue}`);
  }
  try {
    const data = JSON.parse(res.stdout) as {
      title?: unknown;
      labels?: { name?: unknown }[];
      body?: unknown;
    };
    return {
      title: String(data.title ?? ""),
      labels: (data.labels ?? []).map((l) => String(l.name ?? "")),
      body: String(data.body ?? ""),
    };
  } catch {
    return engineMessage(`gh returned unreadable data for issue #${issue}`);
  }
}

function prState(
  deps: Deps,
  cwd: string,
  branch: string | null,
): string | null {
  if (branch === null) {
    return null;
  }
  const res = deps.gh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "state",
      "--limit",
      "1",
    ],
    cwd,
  );
  if (res.status !== 0) {
    return null;
  }
  try {
    const data = JSON.parse(res.stdout) as { state?: unknown }[];
    const state = data[0]?.state;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

function newWorktree(
  cfg: WorktreeConfig,
  cwd: string,
  primary: string,
  args: WorktreeArgs,
  deps: Deps,
): Result {
  const issue = Number(args.arg);
  if (!Number.isInteger(issue) || issue < 1) {
    return fail("usage: wardens worktree new <issue> [--slug <slug>]");
  }
  const info = fetchIssue(deps, cwd, issue);
  if (typeof info === "string") {
    return fail(info);
  }
  const type = typeFromLabels(info.labels);
  if (type === null) {
    return fail(
      wardenMessage(
        "engine",
        `issue #${issue} has no type:* label (missing field: type label)`,
        "Add a type:* label to the issue and run it again",
      ),
    );
  }
  const paths = allowedPaths(info.body);
  if (paths.length === 0) {
    return fail(
      wardenMessage(
        "engine",
        `issue #${issue} has an empty or missing Allowed paths section (missing field: Allowed paths)`,
        "Fill the Allowed paths section of the issue and run it again",
      ),
    );
  }
  const slug = slugify(args.slug ?? info.title, cfg.naming.slug_max_length);
  if (slug.length === 0) {
    return fail(engineMessage("no slug could be derived, pass --slug"));
  }
  const values = { issue: String(issue), slug, type };
  const name = fill(cfg.naming.worktree, values);
  const branch = fill(cfg.naming.branch, values);
  const target = join(primary, fill(cfg.location.default, { name }));
  const collision = portCollision(primary, issue, null, name);
  if (collision !== null) {
    return fail(collision);
  }
  const baseRef = cfg.base_ref;
  const remote = baseRef.includes("/") ? baseRef.split("/")[0] : "origin";
  const baseBranch = baseRef.slice((remote?.length ?? 0) + 1);
  const fetched = git(primary, ["fetch", remote ?? "origin", baseBranch]);
  if (!fetched.ok) {
    return fail(engineMessage(`git fetch ${remote} ${baseBranch} failed`));
  }
  const added = git(primary, [
    "worktree",
    "add",
    "-b",
    branch,
    target,
    baseRef,
  ]);
  if (!added.ok) {
    return fail(engineMessage(`git worktree add failed: ${added.out}`));
  }
  const setup = setupWorktree(
    target,
    cfg,
    { issue, branch, slug, allowedPaths: paths },
    deps,
  );
  if (setup.exitCode !== 0) {
    return {
      ...setup,
      stderr: `${setup.stderr}The worktree stays at ${target}.\n`,
    };
  }
  return ok(`${target}\n`);
}

function setupHere(
  cfg: WorktreeConfig,
  cwd: string,
  primary: string,
  deps: Deps,
): Result {
  const toplevel = gitToplevel(cwd);
  if (toplevel === null || toplevel === primary) {
    return fail(
      engineMessage("wardens worktree setup must run inside a linked worktree"),
    );
  }
  const branch = git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const parsed = parseBranch(branch);
  if (parsed === null) {
    return fail(
      engineMessage(
        `branch ${branch} does not match <type>/<issue>-<slug>, so the issue is unknown`,
      ),
    );
  }
  const info = fetchIssue(deps, toplevel, parsed.issue);
  if (typeof info === "string") {
    return fail(info);
  }
  const paths = allowedPaths(info.body);
  if (paths.length === 0) {
    return fail(
      wardenMessage(
        "engine",
        `issue #${parsed.issue} has an empty or missing Allowed paths section (missing field: Allowed paths)`,
        "Fill the Allowed paths section of the issue and run it again",
      ),
    );
  }
  return setupWorktree(
    toplevel,
    cfg,
    { issue: parsed.issue, branch, slug: parsed.slug, allowedPaths: paths },
    deps,
  );
}

function issueOf(entry: WorktreeEntry): number | null {
  const task = loadTask(entry.path);
  return task.kind === "ok"
    ? task.issue
    : (parseBranch(entry.branch)?.issue ?? null);
}

function list(primary: string, deps: Deps): Result {
  const lines = listWorktrees(primary)
    .filter((e) => !e.primary)
    .map((e) => {
      const issue = issueOf(e);
      const setupOk = existsSync(join(e.path, ".panopticon", "setup.ok"));
      const pr = prState(deps, e.path, e.branch);
      return [
        basename(e.path),
        e.branch ?? "(detached)",
        issue === null ? "-" : `#${issue}`,
        `setup.ok ${setupOk ? "yes" : "no"}`,
        `PR ${pr ?? "none"}`,
      ].join("\t");
    });
  return ok(lines.map((l) => `${l}\n`).join(""));
}

function inside(cwd: string, dir: string): boolean {
  try {
    const a = realpathSync(cwd);
    const b = realpathSync(dir);
    return a === b || a.startsWith(b + sep);
  } catch {
    return false;
  }
}

/** Removes one worktree; a string result is the refusal reason. */
function removeOne(
  entry: WorktreeEntry,
  cfg: WorktreeConfig,
  primary: string,
  force: boolean,
  deps: Deps,
): { removed: string } | { refused: string } {
  const name = basename(entry.path);
  if (inside(deps.cwd, entry.path)) {
    return { refused: `the current directory is inside ${name}` };
  }
  if (!force) {
    if (git(entry.path, ["status", "--porcelain"]).out.length > 0) {
      return { refused: `${name} has uncommitted changes` };
    }
    const unpushed = Number(
      git(entry.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"])
        .out,
    );
    if (unpushed > 0) {
      return { refused: `${name} has ${unpushed} unpushed commit(s)` };
    }
  }
  const removed = git(primary, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    entry.path,
  ]);
  if (!removed.ok) {
    return { refused: `git worktree remove failed: ${removed.out}` };
  }
  let note = `removed ${name}`;
  if (
    entry.branch !== null &&
    git(primary, ["merge-base", "--is-ancestor", entry.branch, cfg.base_ref])
      .ok &&
    git(primary, ["branch", "-D", entry.branch]).ok
  ) {
    note += `, deleted branch ${entry.branch}`;
  }
  return { removed: note };
}

function removeCommand(
  cfg: WorktreeConfig,
  primary: string,
  args: WorktreeArgs,
  deps: Deps,
): Result {
  const entry = listWorktrees(primary).find(
    (e) => !e.primary && basename(e.path) === args.arg,
  );
  if (entry === undefined) {
    return fail(engineMessage(`no linked worktree named ${args.arg ?? ""}`));
  }
  const res = removeOne(entry, cfg, primary, args.force === true, deps);
  if ("refused" in res) {
    return fail(
      wardenMessage(
        "worktree-guard",
        `refused to remove: ${res.refused}`,
        "Commit and push, leave the directory, or pass --force",
      ),
    );
  }
  return ok(`${res.removed}\n`);
}

function prune(
  cfg: WorktreeConfig,
  primary: string,
  args: WorktreeArgs,
  deps: Deps,
): Result {
  const out: string[] = [];
  for (const entry of listWorktrees(primary).filter((e) => !e.primary)) {
    const name = basename(entry.path);
    const state = prState(deps, entry.path, entry.branch);
    if (state !== "MERGED" && state !== "CLOSED") {
      out.push(`kept ${name}: PR ${state ?? "none"}`);
      continue;
    }
    const res = removeOne(entry, cfg, primary, args.force === true, deps);
    out.push("removed" in res ? res.removed : `kept ${name}: ${res.refused}`);
  }
  return ok(out.map((l) => `${l}\n`).join(""));
}

/** `wardens worktree <sub>`. */
export function runWorktree(args: WorktreeArgs, deps: Deps = realDeps): Result {
  if (HUMAN_ONLY.has(args.sub) && detectAgent(deps.env) !== null) {
    return fail(AGENT_REFUSAL);
  }
  const toplevel = gitToplevel(deps.cwd);
  const primary = primaryCheckout(deps.cwd);
  if (toplevel === null || primary === null) {
    return fail(engineMessage("git toplevel could not be resolved"));
  }
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    return fail(
      `${engineMessage("Charter validation failed")}\n${loaded.errors.join("\n")}`,
    );
  }
  const cfg = loaded.charter.worktree;
  if (cfg === undefined) {
    return fail(engineMessage("the Charter has no worktree: section"));
  }
  switch (args.sub) {
    case "new":
      return newWorktree(cfg, toplevel, primary, args, deps);
    case "setup":
      return setupHere(cfg, deps.cwd, primary, deps);
    case "list":
      return list(primary, deps);
    case "remove":
      return removeCommand(cfg, primary, args, deps);
    case "prune":
      return prune(cfg, primary, args, deps);
    default:
      return fail(`unknown worktree command ${args.sub}`);
  }
}
