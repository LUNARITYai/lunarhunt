import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { loadCharterAt, type WorktreeConfig } from "../charter.ts";
import { classifyCwd, gitToplevel, primaryCheckout } from "../git.ts";
import { appendVerdict, type LogLine, logLine } from "../log.ts";
import { wardenMessage } from "../messages.ts";
import { loadTask } from "../task.ts";
import { git, listWorktrees } from "./git.ts";
import {
  baseBranchOf,
  type Created,
  fill,
  newWorktree,
  removeOne,
} from "./index.ts";
import { isSymlink, writeFresh } from "./setup.ts";
import {
  type Deps,
  fail,
  firstLine,
  msg,
  ok,
  type Result,
  realDeps,
} from "./types.ts";

/**
 * `wardens worktree create|remove --tool claude`: the `WorktreeCreate` and
 * `WorktreeRemove` hook entrypoints (spec 2026-11-05-wardens-worktree.md, Tool
 * integration). They call library code directly, never the human-only `new` and
 * `remove` paths, because Claude Code sets `CLAUDECODE` in the hook env. The
 * shell deny in `hook-deny.ts` keeps agents from invoking them with a forged
 * payload.
 */

/** Charset, length cap and no leading `-`: no `/`, no `..`, no uppercase. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_NAME = /^([1-9][0-9]{0,8})-([a-z0-9][a-z0-9-]*)$/;

const createPayload = z.looseObject({
  hook_event_name: z.literal("WorktreeCreate"),
  cwd: z.string().min(1),
  name: z.string(),
});

const removePayload = z.looseObject({
  hook_event_name: z.literal("WorktreeRemove"),
  cwd: z.string().min(1),
  worktree_path: z.string().min(1),
});

export type HookKind = "create" | "remove";

function parsePayload<T extends z.ZodType>(
  schema: T,
  stdin: string,
  event: string,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch {
    return {
      ok: false,
      error: msg(
        `the ${event} payload is not valid JSON`,
        "Check the hook configuration",
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: msg(
        `the ${event} payload is missing or has a wrong field: ${parsed.error.issues
          .map((i) => i.path.join(".") || "(root)")
          .join(", ")}`,
        "Check the hook configuration and the Claude Code version",
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function branchExists(primary: string, branch: string): boolean {
  return git(primary, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).ok;
}

/** Drops what a failed create made. Safe to repeat: the caller proved the target and branch were new. */
function cleanup(primary: string, created: Created): void {
  git(primary, ["worktree", "remove", "--force", created.target]);
  try {
    rmSync(created.target, { recursive: true, force: true });
  } catch {
    // The prune below and `wardens doctor` report what is left.
  }
  git(primary, ["worktree", "prune"]);
  git(primary, ["branch", "-D", created.branch]);
}

function record(
  primary: string,
  decision: "allow" | "deny",
  rule: string,
  message: string | null,
  eventName: string,
): void {
  try {
    const now = Date.now();
    const line: LogLine = logLine({
      verdict: {
        rule,
        decision,
        message,
        replacement: null,
        rendered: decision,
      },
      event: null,
      tool: "claude",
      eventName,
      finishedAt: now,
      startedAt: now,
    });
    appendVerdict(primary, line);
  } catch {
    // The log is best effort; the stderr message is the record of last resort.
  }
}

type Context = {
  cfg: WorktreeConfig;
  cwd: string;
  toplevel: string;
  primary: string;
};

function context(cwd: string): Context | string {
  if (!isAbsolute(cwd)) {
    return msg("the payload cwd is not absolute", "Check the hook payload");
  }
  const toplevel = gitToplevel(cwd);
  const primary = primaryCheckout(cwd);
  if (toplevel === null || primary === null) {
    return msg(
      "git toplevel could not be resolved",
      "Run the session inside the repository",
    );
  }
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    return `${msg("Charter validation failed", "Fix panopticon.charter.yaml")}\n${loaded.errors.join("\n")}`;
  }
  const cfg = loaded.charter.worktree;
  if (cfg === undefined) {
    return msg(
      "the Charter has no worktree: section",
      "Ask Krzysztof to add the worktree: section",
    );
  }
  return { cfg, cwd, toplevel, primary };
}

function createTask(
  ctx: Context,
  name: string,
  issue: string,
  slug: string,
  deps: Deps,
): Result {
  const res = newWorktree(
    ctx.cfg,
    ctx.toplevel,
    ctx.primary,
    { sub: "new", arg: issue, slug },
    deps,
    name,
  );
  if (res.exitCode !== 0) {
    if (res.created !== undefined) {
      cleanup(ctx.primary, res.created);
    }
    return {
      ...res,
      stderr: res.stderr.replace(/The worktree stays at .*\n$/, ""),
    };
  }
  return res;
}

const PARENT_REFUSAL = wardenMessage(
  "worktree-guard",
  "a subagent worktree needs a task worktree as its parent, but this session runs in the primary checkout or on a protected branch",
  'Create a task worktree with "wardens worktree new <issue>" and start the session there',
);

function createSubagent(ctx: Context, name: string, target: string): Result {
  const { cfg, primary, toplevel } = ctx;
  const parent = classifyCwd(ctx.cwd);
  if (parent === null) {
    return fail(
      msg(
        "the git state of the session directory could not be resolved",
        "Run the session inside the repository",
      ),
    );
  }
  if (
    parent.kind === "primary" ||
    (parent.branch !== null && cfg.protected_branches.includes(parent.branch))
  ) {
    return fail(PARENT_REFUSAL);
  }
  const branch = `worktree-${name}`;
  if (branchExists(primary, branch)) {
    return fail(
      msg(
        `the branch ${branch} already exists`,
        "Pick another worktree name or remove the branch",
      ),
    );
  }
  let base: string;
  let task: ReturnType<typeof loadTask> = { kind: "missing" };
  if (parent.branch === null) {
    // Detached parent (OVERSEER): base is the Charter base, scope is the Charter's.
    const remote = cfg.base_ref.slice(
      0,
      Math.max(0, cfg.base_ref.indexOf("/")),
    );
    const baseBranch = baseBranchOf(cfg);
    if (baseBranch === null || remote.length === 0) {
      return fail(
        msg(
          "worktree.base_ref must look like <remote>/<branch>",
          "Ask Krzysztof to fix the Charter",
        ),
      );
    }
    const fetched = git(primary, ["fetch", remote, baseBranch]);
    if (!fetched.ok) {
      return fail(
        msg(
          `git fetch ${remote} ${baseBranch} failed: ${firstLine(fetched.out)}`,
          "Check the network and the remote, then start the subagent again",
        ),
      );
    }
    base = cfg.base_ref;
  } else {
    const head = git(toplevel, ["rev-parse", "--verify", "HEAD"]);
    if (!head.ok) {
      return fail(
        msg(
          "the parent HEAD could not be resolved",
          "Commit in the parent worktree and start the subagent again",
        ),
      );
    }
    base = head.out;
    task = loadTask(toplevel);
    if (task.kind === "invalid") {
      return fail(
        msg(
          "the parent .panopticon/task.json is invalid",
          "Ask Krzysztof to check the parent worktree",
        ),
      );
    }
  }
  const created: Created = { target, branch };
  const added = git(primary, ["worktree", "add", "-b", branch, target, base]);
  if (!added.ok) {
    cleanup(primary, created);
    return fail(
      msg(
        `git worktree add failed: ${firstLine(added.out)}`,
        "Remove the clashing branch or directory and start the subagent again",
      ),
    );
  }
  if (task.kind === "ok") {
    try {
      const dir = join(target, ".panopticon");
      if (isSymlink(dir)) {
        throw new Error("symlink");
      }
      mkdirSync(dir, { recursive: true });
      writeFresh(
        join(dir, "task.json"),
        `${JSON.stringify(
          {
            issue: task.issue,
            ...(task.branch === undefined ? {} : { branch: task.branch }),
            ...(task.slug === undefined ? {} : { slug: task.slug }),
            allowed_paths: task.allowed_paths,
          },
          null,
          2,
        )}\n`,
        0o644,
      );
    } catch {
      cleanup(primary, created);
      return fail(
        msg(
          "the parent task.json could not be copied safely",
          "Ask Krzysztof to check the parent worktree",
        ),
      );
    }
    if (loadTask(target).kind !== "ok") {
      cleanup(primary, created);
      return fail(
        msg(
          "the copied task.json is not valid",
          "Ask Krzysztof to check the parent worktree",
        ),
      );
    }
  }
  return ok(`${target}\n`);
}

function create(stdin: string, deps: Deps): Result {
  const payload = parsePayload(createPayload, stdin, "WorktreeCreate");
  if (!payload.ok) {
    return fail(payload.error);
  }
  const { name, cwd } = payload.data;
  const ctx = context(cwd);
  if (typeof ctx === "string") {
    return fail(ctx);
  }
  if (!NAME_PATTERN.test(name)) {
    return fail(
      msg(
        "the worktree name must use only a-z, 0-9 and -, start with a letter or digit and have at most 64 characters",
        "Use a name like 42-offer-crud",
      ),
    );
  }
  const target = join(ctx.primary, fill(ctx.cfg.location.default, { name }));
  if (exists(target)) {
    return fail(
      msg(
        `the path ${target} already exists`,
        "Pick another worktree name or remove the old worktree",
      ),
    );
  }
  const dep = { ...deps, cwd };
  const task = TASK_NAME.exec(name);
  try {
    return task === null
      ? createSubagent(ctx, name, target)
      : createTask(ctx, name, task[1] ?? "", task[2] ?? "", dep);
  } catch {
    return fail(
      msg(
        "the worktree could not be created",
        "Check git and the repository, then try again",
      ),
    );
  }
}

/** Never deletes work: every refusal exits 0 and keeps the worktree. */
function remove(stdin: string, deps: Deps): Result {
  const payload = parsePayload(removePayload, stdin, "WorktreeRemove");
  if (!payload.ok) {
    return fail(payload.error);
  }
  const ctx = context(payload.data.cwd);
  if (typeof ctx === "string") {
    return fail(ctx);
  }
  const { cfg, primary } = ctx;
  const keep = (why: string): Result => {
    const message = msg(
      `kept the worktree ${payload.data.worktree_path}: ${why}`,
      "Remove it with wardens worktree remove or wardens worktree prune",
    );
    record(primary, "deny", "worktree-remove", message, "WorktreeRemove");
    return ok("", `${message}\n`);
  };
  if (!isAbsolute(payload.data.worktree_path)) {
    return keep("the path is not absolute");
  }
  let real: string;
  try {
    real = realpathSync(payload.data.worktree_path);
  } catch {
    return keep("the path does not exist");
  }
  const root = safeReal(
    join(primary, dirname(fill(cfg.location.default, { name: "x" }))),
  );
  const entry = listWorktrees(primary).find(
    (e) => !e.primary && safeReal(e.path) === real,
  );
  if (entry === undefined) {
    return keep("it is not a linked worktree of this repository");
  }
  if (!real.startsWith(root + sep)) {
    return keep(`it is not under the Charter location ${root}`);
  }
  const res = removeOne(
    entry,
    cfg,
    primary,
    false,
    { ...deps, cwd: ctx.cwd },
    true,
  );
  if ("refused" in res) {
    return keep(res.refused);
  }
  record(primary, "allow", "worktree-remove", res.removed, "WorktreeRemove");
  return ok("", `${res.removed}\n`);
}

function safeReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Entry for `wardens worktree create|remove --tool claude`; `stdin` is the hook payload. */
export function runWorktreeHook(
  kind: HookKind,
  tool: string,
  stdin: string,
  deps: Deps = realDeps,
): Result {
  if (tool !== "claude") {
    return fail(
      msg(
        `worktree ${kind} --tool ${tool} is not supported`,
        "Use --tool claude; Cursor is tracked in issue 68",
      ),
    );
  }
  return kind === "create" ? create(stdin, deps) : remove(stdin, deps);
}
