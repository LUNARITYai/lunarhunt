import { lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCharterAt, type WorktreeConfig } from "../charter.ts";
import {
  classifyCwd,
  gitCommonDir,
  gitToplevel,
  primaryCheckout,
} from "../git.ts";
import { trustedHome } from "../home.ts";
import { appendVerdict, type LogLine, logLine } from "../log.ts";
import { wardenMessage } from "../messages.ts";
import { primaryProblem } from "../sync/primary.ts";
import { loadTask, type TaskState } from "../task.ts";
import { forgetTaskHash, taskId } from "../task-integrity.ts";
import { git, listWorktrees, withHardenedGit } from "./git.ts";
import {
  baseBranchOf,
  type Created,
  fill,
  newWorktree,
  removeOne,
} from "./index.ts";
import { installTask } from "./setup.ts";
import {
  type Deps,
  fail,
  firstLine,
  hookDeps,
  msg,
  ok,
  type Result,
} from "./types.ts";

/**
 * `wardens worktree create|remove --tool claude`: the `WorktreeCreate` and
 * `WorktreeRemove` hook entrypoints (spec 2026-11-05-wardens-worktree.md, Tool
 * integration). They call library code directly, never the human-only `new` and
 * `remove` paths, because Claude Code sets `CLAUDECODE` in the hook env.
 *
 * Trust anchor: the payload `cwd` is untrusted. The primary checkout comes from
 * the location of the running bundle, the Charter is read from the primary
 * checkout only, and a `cwd` of another repository is refused. The entrypoints
 * grant an agent nothing it does not already have; `hook-deny.ts` is only a
 * best-effort speed bump against forged payloads.
 */

/** Charset, length cap and no leading `-`: no `/`, no `..`, no uppercase. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_NAME = /^([1-9][0-9]{0,8})-([a-z0-9][a-z0-9-]*)$/;
const DIGITS_PREFIX = /^[0-9]+-/;

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

/**
 * The primary checkout of the repository the running bundle lives in
 * (`<primary>/wardens/dist/wardens.mjs`, or the repository of `src/` when run
 * from source). Never derived from the payload or from `CLAUDE_PROJECT_DIR`.
 */
export function bundleAnchor(): string | null {
  try {
    return primaryCheckout(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

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

function safeReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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

/**
 * Drops what a failed create made. Call it only after `git worktree add`
 * succeeded for this very target and branch (both were proven new before), so
 * it can never touch a path or branch this call did not create.
 */
function cleanup(primary: string, created: Created, home: string): void {
  // The id depends on the physical path, so it is taken before the directory goes.
  const id = taskId(primary, created.target);
  git(primary, ["worktree", "remove", "--force", created.target]);
  try {
    rmSync(created.target, { recursive: true, force: true });
  } catch {
    // The prune below and `wardens doctor` report what is left.
  }
  git(primary, ["worktree", "prune"]);
  git(primary, ["branch", "-D", created.branch]);
  forgetTaskHash(home, id);
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
  /** The payload cwd: where the session runs. Untrusted. */
  cwd: string;
  /** Worktree root of `cwd`, in the same repository as the anchor. */
  toplevel: string;
  /** Primary checkout from the bundle location. */
  primary: string;
  /** Real path of the Charter `location` directory (may not exist yet). */
  locationRoot: string;
};

function context(cwd: string, anchor: string | null): Context | string {
  if (anchor === null) {
    return msg(
      "the location of the Wardens bundle is not inside a git repository",
      "Rebuild the bundle in the primary checkout with pnpm --filter wardens build",
    );
  }
  if (!isAbsolute(cwd)) {
    return msg("the payload cwd is not absolute", "Check the hook payload");
  }
  const toplevel = gitToplevel(cwd);
  const common = gitCommonDir(cwd);
  const anchorCommon = gitCommonDir(anchor);
  if (toplevel === null || common === null || anchorCommon === null) {
    return msg(
      "git toplevel could not be resolved",
      "Run the session inside the repository",
    );
  }
  if (common !== anchorCommon) {
    return msg(
      `the session directory ${cwd} belongs to another repository than the Wardens bundle`,
      "Run the session in a worktree of this repository",
    );
  }
  const primary = dirname(anchorCommon);
  const notPrimary = primaryProblem(primary);
  if (notPrimary !== null) {
    return msg(
      `the primary checkout ${primary} ${notPrimary}`,
      "Rebuild the bundle in the primary checkout with pnpm --filter wardens build",
    );
  }
  // The Charter comes from the primary checkout only: a parent worktree's copy
  // can be changed by shell writes.
  const loaded = loadCharterAt(primary);
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
  const root = join(
    primary,
    dirname(fill(cfg.location.default, { name: "x" })),
  );
  const locationRoot = safeReal(root);
  if (exists(root) && !locationRoot.startsWith(`${safeReal(primary)}${sep}`)) {
    return msg(
      `the worktree location ${root} resolves outside the primary checkout`,
      "Ask Krzysztof to check the location directory",
    );
  }
  return { cfg, cwd, toplevel, primary, locationRoot };
}

function createTask(
  ctx: Context,
  name: string,
  issue: string,
  slug: string,
  deps: Deps,
  home: string,
): Result {
  const res = newWorktree(
    ctx.cfg,
    ctx.primary,
    ctx.primary,
    { sub: "new", arg: issue, slug },
    deps,
    name,
  );
  if (res.exitCode !== 0) {
    if (res.created !== undefined) {
      cleanup(ctx.primary, res.created, home);
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
  "a subagent worktree needs a task worktree or a detached worktree as its parent, but this session runs in the primary checkout or on a protected branch",
  'Create a task worktree with "wardens worktree new <issue>" and start the session there',
);

/**
 * Copies the parent's narrowing into the new worktree and records its hash
 * (#96), the same way `wardens worktree new` does; without the record every
 * guard would deny the subagent as unrecorded.
 */
function copyTask(
  task: Extract<TaskState, { kind: "ok" }>,
  primary: string,
  target: string,
  home: string,
): boolean {
  return (
    installTask(
      target,
      primary,
      home,
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
    ) === null
  );
}

function createSubagent(
  ctx: Context,
  name: string,
  target: string,
  home: string,
): Result {
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
  // The parent's narrowing follows in every case: a valid task.json is copied,
  // an invalid or unverified (no matching recorded hash) one fails closed,
  // none means the Charter scope (OVERSEER).
  const task = loadTask(toplevel, { primary, home });
  if (task.kind === "invalid" || task.kind === "unverified") {
    return fail(
      msg(
        `the parent .panopticon/task.json is ${task.kind === "invalid" ? "invalid" : "unverified"}`,
        "Ask Krzysztof to check the parent worktree",
      ),
    );
  }
  let base: string;
  if (parent.branch === null) {
    // Detached parent (OVERSEER): base is the Charter base after a fetch.
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
  }
  if (exists(target)) {
    return fail(
      msg(
        `the path ${target} already exists`,
        "Pick another worktree name or remove the old worktree",
      ),
    );
  }
  const added = git(primary, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    target,
    base,
  ]);
  if (!added.ok) {
    // Nothing of ours exists yet: no cleanup, so a racing creator's path survives.
    return fail(
      msg(
        `git worktree add failed: ${firstLine(added.out)}`,
        "Remove the clashing branch or directory and start the subagent again",
      ),
    );
  }
  if (task.kind === "ok" && !copyTask(task, primary, target, home)) {
    cleanup(primary, { target, branch }, home);
    return fail(
      msg(
        "the parent task.json could not be copied and recorded safely",
        "Ask Krzysztof to check the parent worktree and HOME",
      ),
    );
  }
  if (task.kind !== "ok") {
    // The target was proven new, so a record under its id is stale.
    forgetTaskHash(home, taskId(primary, target));
  }
  return ok(`${target}\n`);
}

/**
 * One deadline for a whole create, below the 900 s hook timeout: per-call
 * timeouts alone can add up past it (3 steps x 240 s, git, gh), and a killed
 * hook leaves a worktree with a verified task.json. After the deadline no new
 * `gh` call or setup step starts, so the create fails and the clean failure
 * runs. A step may start just before the deadline and run 240 s, so 540 s
 * leaves 120 s of the 900 s for git and the cleanup.
 */
const HOOK_DEADLINE_MS = 540_000;

/** The time source and the limit; only tests pass their own. */
export type Clock = { now: () => number; limitMs: number };

function withDeadline(deps: Deps, clock: Clock): Deps {
  const start = clock.now();
  const over = () => clock.now() - start >= clock.limitMs;
  const note = () =>
    process.stderr.write(
      `${msg("the hook deadline passed, so no further gh call or setup step was started", "Run wardens worktree new <issue> yourself, or retry")}\n`,
    );
  return {
    ...deps,
    gh: (args, cwd) => {
      if (over()) {
        note();
        return { status: 1, stdout: "" };
      }
      return deps.gh(args, cwd);
    },
    step: (command, cwd) => {
      if (over()) {
        note();
        return 1;
      }
      return deps.step(command, cwd);
    },
  };
}

function create(
  stdin: string,
  base: Deps,
  anchor: string | null,
  clock: Clock,
): Result {
  const deps = withDeadline(base, clock);
  const payload = parsePayload(createPayload, stdin, "WorktreeCreate");
  if (!payload.ok) {
    return fail(payload.error);
  }
  const { name, cwd } = payload.data;
  const ctx = context(cwd, anchor);
  if (typeof ctx === "string") {
    return fail(ctx);
  }
  // The parent's task.json is believed only with its recorded hash, and every
  // copy this hook makes is recorded, so HOME must resolve.
  const home = trustedHome(deps.env);
  if (home === null) {
    return fail(
      msg(
        "cannot resolve HOME, so the task.json hashes cannot be read or recorded",
        "Set HOME to an absolute path of an existing directory",
      ),
    );
  }
  if (!NAME_PATTERN.test(name)) {
    return fail(
      msg(
        "the worktree name must use only a-z, 0-9 and -, start with a letter or digit and have at most 64 characters",
        "Use a name like 42-offer-crud",
      ),
    );
  }
  const task = TASK_NAME.exec(name);
  if (task === null && DIGITS_PREFIX.test(name)) {
    return fail(
      msg(
        "names starting with <digits>- are reserved for task worktrees",
        "Use <issue>-<slug> with a positive issue number of at most 9 digits",
      ),
    );
  }
  if (task !== null) {
    // A task name grants the scope of the issue, so a session that is already
    // scoped (it has a task.json) may only ask for its own issue.
    const own = loadTask(ctx.toplevel, { primary: ctx.primary, home });
    if (
      own.kind === "invalid" ||
      own.kind === "unverified" ||
      (own.kind === "ok" && own.issue !== Number(task[1]))
    ) {
      return fail(
        wardenMessage(
          "worktree-guard",
          own.kind === "ok"
            ? `this session is scoped to issue #${own.issue} and cannot create a task worktree for issue #${task[1]}`
            : `this session has an ${own.kind === "invalid" ? "invalid" : "unverified"} .panopticon/task.json and cannot create a task worktree`,
          "Ask Krzysztof to run wardens worktree new <issue> for the other issue",
        ),
      );
    }
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
  try {
    return task === null
      ? createSubagent(ctx, name, target, home)
      : createTask(
          ctx,
          name,
          task[1] ?? "",
          task[2] ?? "",
          { ...deps, cwd: ctx.primary },
          home,
        );
  } catch {
    return fail(
      msg(
        "the worktree could not be created",
        "Check git and the repository, then try again",
      ),
    );
  }
}

/** A worktree this hook made for a subagent: on exactly the branch `worktree-<its directory name>`. */
function isSubagentWorktree(name: string, branch: string | null): boolean {
  return branch === `worktree-${name}`;
}

/** Never deletes work: every refusal exits 0 and keeps the worktree. */
function remove(stdin: string, deps: Deps, anchor: string | null): Result {
  const payload = parsePayload(removePayload, stdin, "WorktreeRemove");
  if (!payload.ok) {
    return fail(payload.error);
  }
  const ctx = context(payload.data.cwd, anchor);
  if (typeof ctx === "string") {
    return fail(ctx);
  }
  const { cfg, primary } = ctx;
  const path = payload.data.worktree_path;
  const keep = (
    why: string,
    next = `Save the work, then run git worktree remove ${path}`,
  ): Result => {
    const message = msg(`kept the worktree ${path}: ${why}`, next);
    record(primary, "deny", "worktree-remove", message, "WorktreeRemove");
    return ok("", `${message}\n`);
  };
  const byHand = "Remove it with git yourself if it is yours";
  if (!isAbsolute(path)) {
    return keep("the path is not absolute", byHand);
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return keep("the path does not exist", byHand);
  }
  const entry = listWorktrees(primary).find(
    (e) => !e.primary && safeReal(e.path) === real,
  );
  if (entry === undefined) {
    return keep("it is not a linked worktree of this repository", byHand);
  }
  if (!real.startsWith(`${ctx.locationRoot}${sep}`)) {
    return keep(
      `it is not under the Charter location ${ctx.locationRoot}`,
      byHand,
    );
  }
  if (!isSubagentWorktree(basename(real), entry.branch)) {
    return DIGITS_PREFIX.test(basename(real))
      ? keep(
          "it is a task worktree, which only a human removes",
          `Run wardens worktree remove ${basename(real)} or wardens worktree prune`,
        )
      : keep(
          `its branch is not worktree-${basename(real)}, so this hook did not make it`,
          byHand,
        );
  }
  const res = removeOne(
    entry,
    cfg,
    primary,
    false,
    { ...deps, cwd: ctx.primary },
    true,
  );
  if ("refused" in res) {
    return keep(res.refused);
  }
  record(primary, "allow", "worktree-remove", res.removed, "WorktreeRemove");
  return ok("", `${res.removed}\n`);
}

/**
 * Entry for `wardens worktree create|remove --tool claude`; `stdin` is the
 * hook payload. `anchor` is the primary checkout the running bundle belongs to;
 * only tests pass it.
 */
export function runWorktreeHook(
  kind: HookKind,
  tool: string,
  stdin: string,
  deps: Deps = hookDeps,
  anchor: string | null = bundleAnchor(),
  clock: Clock = { now: Date.now, limitMs: HOOK_DEADLINE_MS },
): Result {
  if (tool !== "claude") {
    return fail(
      msg(
        `worktree ${kind} --tool ${tool} is not supported`,
        "Use --tool claude; Cursor is tracked in issue 68",
      ),
    );
  }
  return withHardenedGit(() =>
    kind === "create"
      ? create(stdin, deps, anchor, clock)
      : remove(stdin, deps, anchor),
  );
}
