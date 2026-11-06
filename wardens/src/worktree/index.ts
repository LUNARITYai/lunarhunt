import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { loadCharterAt, type WorktreeConfig } from "../charter.ts";
import { gitToplevel, primaryCheckout } from "../git.ts";
import { wardenMessage } from "../messages.ts";
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
import {
  type Deps,
  fail,
  firstLine,
  msg,
  ok,
  type Result,
  realDeps,
} from "./types.ts";

export type { Deps, Result } from "./types.ts";

export type WorktreeArgs = {
  sub: string;
  arg?: string | undefined;
  slug?: string | undefined;
  force?: boolean | undefined;
  refresh?: boolean | undefined;
};

const AGENT_REFUSAL = wardenMessage(
  "worktree-guard",
  "wardens worktree grants task scope and is for humans",
  "Ask Krzysztof to run it",
);

const HUMAN_ONLY = new Set(["new", "setup", "remove", "prune"]);

const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/** The branch part of `base_ref` (`origin/main` gives `main`), or null without a remote prefix. */
export function baseBranchOf(cfg: WorktreeConfig): string | null {
  const i = cfg.base_ref.indexOf("/");
  return i > 0 && i < cfg.base_ref.length - 1
    ? cfg.base_ref.slice(i + 1)
    : null;
}

function fetchIssue(
  deps: Deps,
  cwd: string,
  issue: number,
): IssueInfo | string {
  const res = deps.gh(
    ["issue", "view", String(issue), "--json", "title,labels,body,state,url"],
    cwd,
  );
  if (res.status !== 0) {
    return msg(
      `gh could not read issue #${issue}`,
      "Check gh auth status and the issue number",
    );
  }
  try {
    const data = JSON.parse(res.stdout) as {
      title?: unknown;
      labels?: { name?: unknown }[];
      body?: unknown;
      state?: unknown;
      url?: unknown;
    };
    if (data.state !== "OPEN") {
      return msg(
        `issue #${issue} is not open`,
        "Reopen the issue or pick an open one",
      );
    }
    if (!String(data.url ?? "").includes("/issues/")) {
      return msg(
        `#${issue} is not an issue (pull request?)`,
        "Pass the number of an issue",
      );
    }
    return {
      title: String(data.title ?? ""),
      labels: (data.labels ?? []).map((l) => String(l.name ?? "")),
      body: String(data.body ?? ""),
    };
  } catch {
    return msg(
      `gh returned unreadable data for issue #${issue}`,
      "Check gh auth status and try again",
    );
  }
}

type PrItem = { state?: string; headRefOid?: string; baseRefName?: string };

/** `gh pr list` for a branch; `null` when gh failed or returned garbage. */
function prList(
  deps: Pick<Deps, "gh">,
  cwd: string,
  branch: string,
  state: "all" | "merged",
): PrItem[] | null {
  const res = deps.gh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      state,
      "--json",
      "state,headRefOid,baseRefName",
      "--limit",
      "1",
    ],
    cwd,
  );
  if (res.status !== 0) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(res.stdout);
    return Array.isArray(data) ? (data as PrItem[]) : null;
  } catch {
    return null;
  }
}

/** What `prState` returns when gh failed. */
export const GH_FAILED_STATE = "unknown (gh failed)";

/** PR state of a branch: a state, `none`, or `GH_FAILED_STATE` when gh failed. */
export function prState(
  deps: Pick<Deps, "gh">,
  cwd: string,
  branch: string | null,
): string {
  if (branch === null) {
    return "none";
  }
  const items = prList(deps, cwd, branch, "all");
  if (items === null) {
    return GH_FAILED_STATE;
  }
  return items[0]?.state ?? "none";
}

/**
 * True when the branch's PR is MERGED into the Charter base branch and the
 * local tip is the PR's head commit (or an ancestor of it).
 */
function mergedMatch(
  deps: Deps,
  primary: string,
  cfg: WorktreeConfig,
  branch: string | null,
): boolean {
  if (branch === null) {
    return false;
  }
  const pr = prList(deps, primary, branch, "merged")?.[0];
  if (
    pr?.state !== "MERGED" ||
    pr.baseRefName !== baseBranchOf(cfg) ||
    typeof pr.headRefOid !== "string"
  ) {
    return false;
  }
  const tip = git(primary, ["rev-parse", `refs/heads/${branch}`]);
  return (
    tip.ok &&
    (tip.out === pr.headRefOid ||
      git(primary, ["merge-base", "--is-ancestor", tip.out, pr.headRefOid]).ok)
  );
}

function grantedNote(paths: string[]): string {
  return `granted allowed_paths: ${paths.join(", ")}\n`;
}

/** What `newWorktree` made, so the hook can clean up after a failed setup. */
export type Created = { target: string; branch: string };

/**
 * `expectName` (the hook): the derived worktree name must equal it exactly, so
 * the name Claude Code asked for is the directory it gets.
 */
export function newWorktree(
  cfg: WorktreeConfig,
  cwd: string,
  primary: string,
  args: WorktreeArgs,
  deps: Deps,
  expectName?: string,
): Result & { created?: Created } {
  if (!ISSUE_NUMBER.test(args.arg ?? "")) {
    return fail(
      msg(
        "usage: wardens worktree new <issue> [--slug <slug>], the issue is a positive integer",
        "Pass a plain issue number",
      ),
    );
  }
  const issue = Number(args.arg);
  const base = baseBranchOf(cfg);
  if (base === null) {
    return fail(
      msg(
        "worktree.base_ref must look like <remote>/<branch>",
        "Ask Krzysztof to fix the Charter",
      ),
    );
  }
  const info = fetchIssue(deps, cwd, issue);
  if (typeof info === "string") {
    return fail(info);
  }
  const typed = typeFromLabels(info.labels);
  if ("error" in typed) {
    return fail(
      msg(
        `issue #${issue} ${typed.error}`,
        "Fix the type:* label of the issue and run it again",
      ),
    );
  }
  const paths = allowedPaths(info.body);
  if ("error" in paths) {
    return fail(
      msg(
        `issue #${issue} ${paths.error}`,
        "Fix the Allowed paths section of the issue and run it again",
      ),
    );
  }
  const slug = slugify(args.slug ?? info.title, cfg.naming.slug_max_length);
  if (slug.length === 0) {
    return fail(
      msg("no slug could be derived", "Pass --slug with letters or digits"),
    );
  }
  const values = { issue: String(issue), slug, type: typed.type };
  const name = fill(cfg.naming.worktree, values);
  const branch = fill(cfg.naming.branch, values);
  if (expectName !== undefined && name !== expectName) {
    return fail(
      msg(
        `the worktree name ${expectName} is not the canonical ${name} for issue #${issue}`,
        `Use the name ${name}`,
      ),
    );
  }
  const target = join(primary, fill(cfg.location.default, { name }));
  const collision = portCollision(primary, issue, null, name);
  if (collision !== null) {
    return fail(collision);
  }
  const remote = cfg.base_ref.slice(0, cfg.base_ref.indexOf("/"));
  const fetched = git(primary, ["fetch", remote, base]);
  if (!fetched.ok) {
    return fail(
      msg(
        `git fetch ${remote} ${base} failed: ${firstLine(fetched.out)}`,
        "Check the network and the remote, then run it again",
      ),
    );
  }
  const added = git(primary, [
    "worktree",
    "add",
    "-b",
    branch,
    target,
    cfg.base_ref,
  ]);
  if (!added.ok) {
    return fail(
      msg(
        `git worktree add failed: ${firstLine(added.out)}`,
        "Remove the clashing branch or directory and run it again",
      ),
    );
  }
  const created = { target, branch };
  const setup = setupWorktree(
    target,
    cfg,
    { issue, branch, slug, allowedPaths: paths.paths },
    deps,
  );
  if (setup.exitCode !== 0) {
    return {
      ...setup,
      stderr: `${setup.stderr}The worktree stays at ${target}.\n`,
      created,
    };
  }
  return { ...ok(`${target}\n`, grantedNote(paths.paths)), created };
}

function setupHere(
  cfg: WorktreeConfig,
  cwd: string,
  primary: string,
  args: WorktreeArgs,
  deps: Deps,
): Result {
  const toplevel = gitToplevel(cwd);
  if (toplevel === null || toplevel === primary) {
    return fail(
      msg(
        "wardens worktree setup must run inside a linked worktree",
        "Change into the task worktree and run it again",
      ),
    );
  }
  const branch = git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const parsed = parseBranch(branch);
  if (parsed === null) {
    return fail(
      msg(
        `branch ${firstLine(branch)} does not match <type>/<issue>-<slug>, so the issue is unknown`,
        "Switch the worktree to its convention branch and run it again",
      ),
    );
  }
  if (!basename(toplevel).startsWith(`${parsed.issue}-`)) {
    return fail(
      msg(
        `the worktree directory ${basename(toplevel)} does not start with ${parsed.issue}- like the branch`,
        "Create the worktree with wardens worktree new",
      ),
    );
  }
  const existing = loadTask(toplevel);
  if (existing.kind === "ok" && args.refresh !== true) {
    if (existing.issue !== parsed.issue) {
      return fail(
        msg(
          `task.json is for issue ${existing.issue} but the branch is for ${parsed.issue}`,
          "Ask Krzysztof to check the worktree",
        ),
      );
    }
    const res = setupWorktree(
      toplevel,
      cfg,
      {
        issue: existing.issue,
        branch: existing.branch ?? branch,
        slug: existing.slug ?? parsed.slug,
        allowedPaths: existing.allowed_paths,
      },
      deps,
    );
    return res.exitCode === 0
      ? ok("", grantedNote(existing.allowed_paths))
      : res;
  }
  const info = fetchIssue(deps, toplevel, parsed.issue);
  if (typeof info === "string") {
    return fail(info);
  }
  const paths = allowedPaths(info.body);
  if ("error" in paths) {
    return fail(
      msg(
        `issue #${parsed.issue} ${paths.error}`,
        "Fix the Allowed paths section of the issue and run it again",
      ),
    );
  }
  const res = setupWorktree(
    toplevel,
    cfg,
    {
      issue: parsed.issue,
      branch,
      slug: parsed.slug,
      allowedPaths: paths.paths,
    },
    deps,
  );
  return res.exitCode === 0 ? ok("", grantedNote(paths.paths)) : res;
}

export function issueOf(entry: WorktreeEntry): number | null {
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
      return [
        basename(e.path),
        e.branch ?? "(detached)",
        issue === null ? "-" : `#${issue}`,
        `setup.ok ${setupOk ? "yes" : "no"}`,
        `PR ${prState(deps, e.path, e.branch)}`,
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

/** Under `<primary>/<location root>`, with a task.json or a convention name. */
function isTaskWorktree(
  entry: WorktreeEntry,
  cfg: WorktreeConfig,
  primary: string,
): boolean {
  const root = join(
    primary,
    dirname(fill(cfg.location.default, { name: "x" })),
  );
  return (
    entry.path.startsWith(root + sep) &&
    (loadTask(entry.path).kind === "ok" ||
      /^[1-9][0-9]*-[a-z0-9-]+$/.test(basename(entry.path)))
  );
}

type Refusal = { refused: string; next: string };

const FORCE_NEXT = "Commit and push, or pass --force";

/** Cannot verify the worktree is safe to drop: fail closed. */
function unverified(name: string): Refusal {
  return {
    refused: `could not verify that ${name} has no uncommitted or unpushed work`,
    next: "Check the worktree by hand or pass --force",
  };
}

/** `worktree-<name>`: the branch of a worktree the `WorktreeCreate` hook made for a subagent. */
export const HOOK_BRANCH = /^worktree-[a-z0-9][a-z0-9-]*$/;

/**
 * Removes one worktree. `hook` is the `WorktreeRemove` mode: any linked
 * worktree under the location root qualifies (subagent worktrees are not
 * task worktrees), the caller's cwd is not checked (Claude Code's own session
 * may sit inside it), and commits that another local branch or a remote also
 * holds do not count as unpushed.
 */
export function removeOne(
  entry: WorktreeEntry,
  cfg: WorktreeConfig,
  primary: string,
  force: boolean,
  deps: Deps,
  hook = false,
): { removed: string } | Refusal {
  const name = basename(entry.path);
  if (!hook && !isTaskWorktree(entry, cfg, primary)) {
    return {
      refused: `${name} is not a task worktree`,
      next: "Remove it with git yourself if it is yours",
    };
  }
  if (!hook && inside(deps.cwd, entry.path)) {
    return {
      refused: `the current directory is inside ${name}`,
      next: "Change out of the worktree and run it again",
    };
  }
  const merged = mergedMatch(deps, primary, cfg, entry.branch);
  if (!force) {
    const status = git(entry.path, ["status", "--porcelain"]);
    if (!status.ok) {
      return unverified(name);
    }
    if (status.out.length > 0) {
      return { refused: `${name} has uncommitted changes`, next: FORCE_NEXT };
    }
    if (!merged) {
      const count = git(entry.path, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
        ...(hook && entry.branch !== null
          ? [`--exclude=${entry.branch}`, "--branches"]
          : []),
      ]);
      if (!count.ok || !/^\d+$/.test(count.out)) {
        return unverified(name);
      }
      if (Number(count.out) > 0) {
        return {
          refused: `${name} has ${count.out} unpushed commit(s)`,
          next: FORCE_NEXT,
        };
      }
    }
  }
  const removed = git(primary, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    entry.path,
  ]);
  if (!removed.ok) {
    return {
      refused: `git worktree remove failed: ${firstLine(removed.out)}`,
      next: "Fix the cause or pass --force",
    };
  }
  let note = `removed ${name}`;
  const branch = entry.branch;
  if (
    hook &&
    branch !== null &&
    HOOK_BRANCH.test(branch) &&
    !cfg.protected_branches.includes(branch) &&
    git(primary, [
      "rev-list",
      "--count",
      branch,
      "--not",
      "--remotes",
      `--exclude=${branch}`,
      "--branches",
    ]).out === "0" &&
    git(primary, ["branch", "-D", branch]).ok
  ) {
    note += `, deleted branch ${branch}`;
  } else if (
    branch !== null &&
    parseBranch(branch) !== null &&
    !cfg.protected_branches.includes(branch) &&
    (merged ||
      git(primary, ["merge-base", "--is-ancestor", branch, cfg.base_ref]).ok) &&
    git(primary, ["branch", "-D", branch]).ok
  ) {
    note += `, deleted branch ${branch}`;
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
    return fail(
      msg(
        `no linked worktree named ${args.arg ?? ""}`,
        "Run wardens worktree list for the names",
      ),
    );
  }
  const res = removeOne(entry, cfg, primary, args.force === true, deps);
  if ("refused" in res) {
    return fail(msg(`refused to remove: ${res.refused}`, res.next));
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
    if (!isTaskWorktree(entry, cfg, primary)) {
      out.push(`kept ${name}: not a task worktree`);
      continue;
    }
    const state = prState(deps, entry.path, entry.branch);
    if (state !== "MERGED" && state !== "CLOSED") {
      out.push(`kept ${name}: PR ${state}`);
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
    return fail(
      msg(
        "git toplevel could not be resolved",
        "Run the command inside the repository",
      ),
    );
  }
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    return fail(
      `${msg("Charter validation failed", "Fix panopticon.charter.yaml")}\n${loaded.errors.join("\n")}`,
    );
  }
  const cfg = loaded.charter.worktree;
  if (cfg === undefined) {
    return fail(
      msg(
        "the Charter has no worktree: section",
        "Ask Krzysztof to add the worktree: section",
      ),
    );
  }
  switch (args.sub) {
    case "new":
      return newWorktree(cfg, toplevel, primary, args, deps);
    case "setup":
      return setupHere(cfg, deps.cwd, primary, args, deps);
    case "list":
      return list(primary, deps);
    case "remove":
      return removeCommand(cfg, primary, args, deps);
    case "prune":
      return prune(cfg, primary, args, deps);
    default:
      return fail(
        msg(
          `unknown worktree command ${args.sub}`,
          "Use new, setup, list, remove or prune",
        ),
      );
  }
}
