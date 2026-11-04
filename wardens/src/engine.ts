import { type Charter, loadCharterAt } from "./charter.ts";
import {
  type NormalizedEvent,
  normalizeHook,
  parseNormalizedEvent,
  type ToolName,
} from "./event.ts";
import { gitToplevel } from "./git.ts";
import { appendVerdict, type LogLine, logLine } from "./log.ts";
import { CHARTER_INVALID_MESSAGE, engineMessage } from "./messages.ts";
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
import { loadTask, type TaskState } from "./task.ts";
import { allowVerdict, checkExitCode, type Verdict } from "./verdict.ts";

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

export function engineDeny(what: string): Verdict {
  return {
    rule: "engine",
    decision: "deny",
    message: what === CHARTER_INVALID_MESSAGE ? what : engineMessage(what),
    replacement: null,
    rendered: "deny",
  };
}

const RANK: Record<Exclude<Verdict["decision"], "allow">, number> = {
  deny: 3,
  rewrite: 2,
  ask: 1,
};

export function evaluateRules(
  ctx: RuleContext,
  rules: Record<RuleId, Rule> = RULES,
): Verdict {
  let winner: Objection | null = null;
  for (const id of RULE_IDS) {
    let objection: Objection | null;
    try {
      objection = rules[id](ctx);
    } catch {
      return engineDeny("a rule threw");
    }
    if (!objection) {
      continue;
    }
    if (!winner || RANK[objection.decision] > RANK[winner.decision]) {
      winner = objection;
    }
  }
  if (!winner) {
    return allowVerdict();
  }
  return {
    rule: winner.rule,
    decision: winner.decision,
    message: winner.message,
    replacement: winner.replacement,
    rendered: winner.decision,
  };
}

export function evaluateRule(
  id: RuleId,
  ctx: RuleContext,
  rules: Record<RuleId, Rule> = RULES,
): Verdict {
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
  } catch {
    return engineDeny("a rule threw");
  }
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

function loadPolicy(
  toplevel: string,
):
  | { ok: true; charter: Charter; task: TaskState }
  | { ok: false; verdict: Verdict } {
  const loaded = loadCharterAt(toplevel);
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
        verdict: engineDeny("git toplevel could not be resolved"),
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

  const policy = loadPolicy(toplevel);
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
    const verdict = commit({
      toplevel,
      verdict:
        message === CHARTER_INVALID_MESSAGE
          ? engineDeny(CHARTER_INVALID_MESSAGE)
          : engineDeny(message),
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
    return fail("git toplevel could not be resolved", null, null);
  }
  if (!hintedTool) {
    return fail("the hook event is not mapped", toplevel, null);
  }

  const policy = loadPolicy(toplevel);
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
  });
  if (!normalized.ok) {
    return fail(normalized.message, toplevel, null);
  }

  const verdict = commit({
    toplevel,
    verdict: evaluateRules({
      event: normalized.event,
      charter: policy.charter,
      task: policy.task,
      root: toplevel,
    }),
    event: normalized.event,
    tool: hintedTool,
    eventName,
    startedAt,
    deps,
  });
  return hookBody(hintedTool, eventName, verdict, raw);
}
