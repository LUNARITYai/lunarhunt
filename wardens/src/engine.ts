import { homedir, tmpdir } from "node:os";
import { type Charter, loadCharterAt } from "./charter.ts";
import { type DodDeps, stopEngineFailure } from "./dod.ts";
import {
  type NormalizedEvent,
  normalizeHook,
  parseNormalizedEvent,
  type ToolName,
} from "./event.ts";
import { EngineFailure } from "./failures.ts";
import { gitToplevel, siblingToplevel } from "./git.ts";
import { evaluateStop, postEditAudit } from "./lifecycle.ts";
import { appendFallback, appendVerdict, type LogLine, logLine } from "./log.ts";
import {
  CHARTER_INVALID_MESSAGE,
  engineMessage,
  NO_PRIMARY_MESSAGE,
  TOPLEVEL_UNRESOLVED,
} from "./messages.ts";
import { finalizeVerdict, knownTool, renderHook } from "./render.ts";
import {
  isRuleId,
  type Objection,
  RULE_IDS,
  RULES,
  type Rule,
  type RuleContext,
  type RuleId,
} from "./rules.ts";
import { type BundleProbe, staleWarning } from "./stale.ts";
import { loadTask, type TaskState } from "./task.ts";
import { allowVerdict, checkExitCode, type Verdict } from "./verdict.ts";
import { crossWorktreeDeny } from "./worktree-guard.ts";

export type RunResult = {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
};

export type EngineDeps = {
  append: (toplevel: string, line: LogLine) => void;
  now: () => number;
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  dod?: DodDeps;
  /** Bundle hash probe for the stale check; tests inject it. */
  bundle?: BundleProbe;
  /** Home dir for `~/` in `paths.external`; tests inject it. */
  home?: string;
  /** Base dir of the fallback log used without a git toplevel; tests inject it. */
  tmpDir?: string;
  /**
   * Where the Charter comes from (#73). A path: the trusted primary checkout,
   * resolved by the CLI from the running bundle and the launcher anchor.
   * `null`: a hook run with no resolvable primary, which fails closed.
   * Absent: not a hook run (tests, direct engine calls), which reads the
   * Charter of the session's own toplevel. Only `runHook` reads this.
   */
  primary?: string | null;
};

const defaultDeps: EngineDeps = {
  append: appendVerdict,
  now: () => Date.now(),
  cwd: () => process.cwd(),
  env: process.env,
};

function depsOf(partial?: Partial<EngineDeps>): EngineDeps {
  return { ...defaultDeps, ...partial };
}

/** The only messages that already carry their own next action. */
const PRE_RENDERED = new Set([CHARTER_INVALID_MESSAGE, NO_PRIMARY_MESSAGE]);

export function engineDeny(what: string): Verdict {
  return {
    rule: "engine",
    decision: "deny",
    message: PRE_RENDERED.has(what) ? what : engineMessage(what),
    replacement: null,
    rendered: "deny",
  };
}

const RANK: Record<Exclude<Verdict["decision"], "allow">, number> = {
  deny: 3,
  rewrite: 2,
  ask: 1,
};

function objectionVerdict(objection: Objection): Verdict {
  return {
    rule: objection.rule,
    decision: objection.decision,
    message: objection.message,
    replacement: objection.replacement,
    rendered: objection.decision,
  };
}

/** Lifecycle events (stop, session start, post-edit audit) skip the pre-edit rule list. */
function evaluateLifecycle(ctx: RuleContext): Verdict | null {
  try {
    if (ctx.event.action === "session_start") {
      const warning = staleWarning(ctx.root, ctx.bundle);
      return warning
        ? { ...allowVerdict(), rule: "bundle-stale", message: warning }
        : allowVerdict();
    }
    if (ctx.event.action === "stop") {
      return evaluateStop(ctx);
    }
    if (ctx.event.phase === "post") {
      const objection = postEditAudit(ctx);
      return objection ? objectionVerdict(objection) : allowVerdict();
    }
  } catch (err) {
    if (ctx.event.action === "stop") {
      return stopEngineFailure(
        ctx.root,
        ctx.event.session_id,
        engineDeny(err instanceof EngineFailure ? err.what : "a rule threw")
          .message ?? "",
      );
    }
    return caught(err);
  }
  return null;
}

export function evaluateRules(
  ctx: RuleContext,
  rules: Record<RuleId, Rule> = RULES,
): Verdict {
  const lifecycle = evaluateLifecycle(ctx);
  if (lifecycle) {
    return lifecycle;
  }
  let winner: Objection | null = null;
  for (const id of RULE_IDS) {
    // Repo-relative rules do not apply to an allowed external path.
    if (ctx.event.external && id !== "secret-read-guard") {
      continue;
    }
    let objection: Objection | null;
    try {
      objection = rules[id](ctx);
    } catch (err) {
      return caught(err);
    }
    if (!objection) {
      continue;
    }
    if (!winner || RANK[objection.decision] > RANK[winner.decision]) {
      winner = objection;
    }
  }
  return winner ? objectionVerdict(winner) : allowVerdict();
}

export function evaluateRule(
  id: RuleId,
  ctx: RuleContext,
  rules: Record<RuleId, Rule> = RULES,
): Verdict {
  if (ctx.event.external && id !== "secret-read-guard") {
    return allowVerdict();
  }
  try {
    const objection = rules[id](ctx);
    if (!objection) {
      return allowVerdict();
    }
    return {
      rule: objection.rule,
      decision: objection.decision,
      message: objection.message,
      replacement: objection.replacement,
      rendered: objection.decision,
    };
  } catch (err) {
    return caught(err);
  }
}

function caught(err: unknown): Verdict {
  if (err instanceof EngineFailure) {
    return engineDeny(err.what);
  }
  return engineDeny("a rule threw");
}

function commit(input: {
  toplevel: string | null;
  verdict: Verdict;
  event: NormalizedEvent | null;
  tool: ToolName | null;
  eventName: string | null;
  startedAt: number;
  deps: EngineDeps;
}): Verdict {
  const finished = finalizeVerdict(input.verdict, input.event);
  if (!input.toplevel) {
    return finished;
  }
  const line = logLine({
    verdict: finished,
    event: input.event,
    tool: input.tool,
    eventName: input.eventName,
    finishedAt: input.deps.now(),
    startedAt: input.startedAt,
  });
  try {
    input.deps.append(input.toplevel, line);
    return finished;
  } catch {
    return engineDeny("the verdict log could not be written");
  }
}

function checkBody(verdict: Verdict): RunResult {
  return {
    exitCode: checkExitCode(verdict.decision),
    stdout: `${JSON.stringify(verdict)}\n`,
    stderr: "",
  };
}

function hookBody(
  tool: string,
  event: string,
  verdict: Verdict,
  raw: Record<string, unknown>,
): RunResult {
  return {
    exitCode: 0,
    stdout: renderHook({ tool, event, verdict, raw }),
    stderr: "",
  };
}

function readJson(stdin: string): { ok: true; value: unknown } | { ok: false } {
  const text = stdin.trim();
  if (text.length === 0) {
    return { ok: false };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/** The Charter comes from `charterRoot` (the trusted primary); the task file stays the session worktree's own. */
function loadPolicy(
  toplevel: string,
  charterRoot: string,
):
  | { ok: true; charter: Charter; task: TaskState }
  | { ok: false; verdict: Verdict } {
  const loaded = loadCharterAt(charterRoot);
  if (!loaded.ok) {
    return { ok: false, verdict: engineDeny(CHARTER_INVALID_MESSAGE) };
  }
  return { ok: true, charter: loaded.charter, task: loadTask(toplevel) };
}

export function runCheck(
  rule: string,
  stdin: string,
  partial?: Partial<EngineDeps>,
): RunResult {
  const deps = depsOf(partial);
  const startedAt = deps.now();
  const cwd = deps.cwd();
  const toplevel = gitToplevel(cwd);

  if (rule === "charter-validate") {
    const verdict = commit({
      toplevel,
      verdict: toplevel
        ? charterVerdict(toplevel)
        : engineDeny(CHARTER_INVALID_MESSAGE),
      event: null,
      tool: null,
      eventName: null,
      startedAt,
      deps,
    });
    return checkBody(verdict);
  }

  if (!isRuleId(rule)) {
    const verdict = commit({
      toplevel,
      verdict: engineDeny(`unknown rule ${rule}`),
      event: null,
      tool: null,
      eventName: null,
      startedAt,
      deps,
    });
    return checkBody(verdict);
  }

  if (!toplevel) {
    return checkBody(
      commit({
        toplevel: null,
        verdict: engineDeny(TOPLEVEL_UNRESOLVED),
        event: null,
        tool: null,
        eventName: null,
        startedAt,
        deps,
      }),
    );
  }

  const payload = readJson(stdin);
  if (!payload.ok) {
    const verdict = commit({
      toplevel,
      verdict: engineDeny("stdin is empty or not the JSON the event requires"),
      event: null,
      tool: null,
      eventName: null,
      startedAt,
      deps,
    });
    return checkBody(verdict);
  }
  const normalized = parseNormalizedEvent(payload.value);
  if (!normalized.ok) {
    const verdict = commit({
      toplevel,
      verdict: engineDeny(normalized.message),
      event: null,
      tool: null,
      eventName: null,
      startedAt,
      deps,
    });
    return checkBody(verdict);
  }

  // `wardens check` is not a hook run: it judges the checkout it runs in.
  const policy = loadPolicy(toplevel, toplevel);
  const event = normalized.event;
  const verdict = commit({
    toplevel,
    verdict: policy.ok
      ? evaluateRule(rule, {
          event,
          charter: policy.charter,
          task: policy.task,
          root: toplevel,
        })
      : policy.verdict,
    event,
    tool: event.tool,
    eventName: event.event,
    startedAt,
    deps,
  });
  return checkBody(verdict);
}

function charterVerdict(toplevel: string): Verdict {
  const loaded = loadCharterAt(toplevel);
  return loaded.ok ? allowVerdict() : engineDeny(CHARTER_INVALID_MESSAGE);
}

/**
 * Without a toplevel there is no DoD state, so a blocked Stop would repeat
 * forever. Allow it and record the reason in the fallback log; a logging
 * failure must not turn the allow into a block.
 */
function allowUnresolvedStop(
  hintedTool: ToolName | null,
  eventName: string,
  raw: Record<string, unknown>,
  startedAt: number,
  deps: EngineDeps,
): RunResult {
  const allowed: Verdict = {
    ...allowVerdict(),
    rule: "engine",
    message: TOPLEVEL_UNRESOLVED,
  };
  const verdict = finalizeVerdict(allowed, null);
  try {
    appendFallback(
      deps.tmpDir ?? tmpdir(),
      logLine({
        verdict,
        event: null,
        tool: hintedTool,
        eventName,
        finishedAt: deps.now(),
        startedAt,
      }),
    );
  } catch {
    // Best effort only.
  }
  // The reason goes to the log only; the rendered allow stays empty.
  return hookBody(
    hintedTool ?? "cursor",
    eventName,
    { ...verdict, message: null },
    raw,
  );
}

export function runHook(
  tool: string,
  eventName: string,
  stdin: string,
  partial?: Partial<EngineDeps>,
): RunResult {
  const deps = depsOf(partial);
  const startedAt = deps.now();
  const fallbackCwd = deps.cwd();
  const rawResult = readJson(stdin);
  const raw = rawResult.ok
    ? (rawResult.value as Record<string, unknown>)
    : null;
  const hintedTool = knownTool(tool) ? tool : null;

  const fail = (
    message: string,
    toplevel: string | null,
    event: NormalizedEvent | null,
  ): RunResult => {
    const denied =
      message === CHARTER_INVALID_MESSAGE
        ? engineDeny(CHARTER_INVALID_MESSAGE)
        : engineDeny(message);
    const isStop = eventName === "Stop" || eventName === "stop";
    const verdict = commit({
      toplevel,
      verdict:
        isStop && toplevel
          ? stopEngineFailure(
              toplevel,
              typeof raw?.session_id === "string"
                ? raw.session_id
                : typeof raw?.conversation_id === "string"
                  ? raw.conversation_id
                  : null,
              denied.message ?? "",
            )
          : denied,
      event,
      tool: hintedTool,
      eventName,
      startedAt,
      deps,
    });
    return hookBody(hintedTool ?? "cursor", eventName, verdict, raw ?? {});
  };

  if (!raw) {
    const toplevel = gitToplevel(fallbackCwd);
    return fail(
      "stdin is empty or not the JSON the event requires",
      toplevel,
      null,
    );
  }

  const cwd =
    typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : fallbackCwd;
  const toplevel = gitToplevel(cwd);
  if (!toplevel) {
    if (eventName === "Stop" || eventName === "stop") {
      return allowUnresolvedStop(hintedTool, eventName, raw, startedAt, deps);
    }
    return fail(TOPLEVEL_UNRESOLVED, null, null);
  }
  if (!hintedTool) {
    return fail("the hook event is not mapped", toplevel, null);
  }

  // A real hook run reads the Charter from the trusted primary only; without
  // one, nothing the session's own worktree says can be believed.
  if (deps.primary === null) {
    return fail(NO_PRIMARY_MESSAGE, toplevel, null);
  }
  const policy = loadPolicy(toplevel, deps.primary ?? toplevel);
  if (!policy.ok) {
    return fail(CHARTER_INVALID_MESSAGE, toplevel, null);
  }

  const normalized = normalizeHook({
    tool: hintedTool,
    event: eventName,
    payload: raw,
    fallbackCwd,
    toplevel,
    env: deps.env,
    external: { charter: policy.charter, home: deps.home ?? homedir() },
  });
  if (!normalized.ok) {
    if (
      normalized.escape &&
      policy.charter.worktree?.required_for_agents &&
      siblingToplevel(cwd, normalized.escape.absolute) !== null
    ) {
      return hookBody(
        hintedTool,
        eventName,
        commit({
          toplevel,
          verdict: objectionVerdict(
            crossWorktreeDeny(normalized.escape.absolute),
          ),
          event: null,
          tool: hintedTool,
          eventName,
          startedAt,
          deps,
        }),
        raw,
      );
    }
    return fail(normalized.message, toplevel, null);
  }

  const verdict = commit({
    toplevel,
    verdict: evaluateRules({
      event: normalized.event,
      charter: policy.charter,
      task: policy.task,
      root: toplevel,
      home: deps.home ?? homedir(),
      ...(deps.dod ? { dod: deps.dod } : {}),
      ...(deps.bundle ? { bundle: deps.bundle } : {}),
    }),
    event: normalized.event,
    tool: hintedTool,
    eventName,
    startedAt,
    deps,
  });
  return hookBody(hintedTool, eventName, verdict, raw);
}
