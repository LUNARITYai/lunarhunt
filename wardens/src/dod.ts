import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineFailure } from "./failures.ts";
import { wardenMessage } from "./messages.ts";
import type { RuleContext } from "./rules.ts";
import { allowVerdict, type Verdict } from "./verdict.ts";

export const RED_LIMIT = 3;
export const CHECK_TIMEOUT_MS = 840_000;
const TAIL_LINES = 60;
const TAIL_CHARS = 4000;

export type CheckResult = {
  status: "green" | "red" | "timeout";
  /** stdout and stderr of `pnpm check`, interleaved. Never logged. */
  output: string;
};

export type DodDeps = {
  runCheck: (root: string) => CheckResult;
};

type State = {
  last_green: string | null;
  sessions: Record<string, { red_streak: number }>;
};

export function defaultRunCheck(root: string): CheckResult {
  const result = spawnSync("sh", ["-c", "exec pnpm check 2>&1"], {
    cwd: root,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") {
    return { status: "timeout", output };
  }
  return { status: result.status === 0 ? "green" : "red", output };
}

function git(root: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitOrNull(root: string, args: string[]): Buffer | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

const EXCLUDE = [".", ":(exclude).panopticon"];

export function fingerprint(root: string): string {
  const hash = createHash("sha256");
  const part = (label: string, data: Buffer | string) => {
    hash.update(`${label}\0${Buffer.byteLength(data)}\0`);
    hash.update(data);
  };
  part("head", gitOrNull(root, ["rev-parse", "HEAD"]) ?? "none");
  part(
    "status",
    git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...EXCLUDE,
    ]),
  );
  part(
    "diff",
    gitOrNull(root, ["diff", "HEAD", "--binary", "--", ...EXCLUDE]) ?? "",
  );
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...EXCLUDE,
  ])
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0)
    .sort();
  for (const rel of untracked) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      bytes = Buffer.from("unreadable");
    }
    part(`file:${rel}`, bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Nothing to deliver: HEAD is the merge-base with origin/main and the tree is clean. */
function nothingToDeliver(root: string): boolean {
  if (!gitOrNull(root, ["rev-parse", "--verify", "-q", "origin/main"])) {
    return false;
  }
  const head = gitOrNull(root, ["rev-parse", "HEAD"])?.toString().trim();
  const base = gitOrNull(root, ["merge-base", "HEAD", "origin/main"])
    ?.toString()
    .trim();
  if (!head || head !== base) {
    return false;
  }
  return git(root, ["status", "--porcelain", "--", ...EXCLUDE]).length === 0;
}

function statePath(root: string): string {
  return join(root, ".panopticon", "dod-state.json");
}

function readState(root: string): State {
  const empty: State = { last_green: null, sessions: {} };
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(root), "utf8"));
    if (typeof raw !== "object" || raw === null) {
      return empty;
    }
    const obj = raw as Record<string, unknown>;
    const sessions: State["sessions"] = {};
    if (typeof obj.sessions === "object" && obj.sessions !== null) {
      for (const [id, value] of Object.entries(obj.sessions)) {
        const streak = (value as { red_streak?: unknown } | null)?.red_streak;
        if (typeof streak === "number" && Number.isFinite(streak)) {
          sessions[id] = { red_streak: streak };
        }
      }
    }
    return {
      last_green: typeof obj.last_green === "string" ? obj.last_green : null,
      sessions,
    };
  } catch {
    return empty;
  }
}

function writeState(root: string, state: State): void {
  try {
    mkdirSync(join(root, ".panopticon"), { recursive: true });
    const tmp = `${statePath(root)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, statePath(root));
  } catch {
    throw new EngineFailure(
      "the definition-of-done state could not be written",
    );
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function outputTail(output: string): string {
  const lines = output.replace(ANSI, "").replace(/\s+$/, "").split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? tail.slice(tail.length - TAIL_CHARS) : tail;
}

export function failedTasks(output: string): string[] {
  const tasks: string[] = [];
  for (const match of output
    .replace(ANSI, "")
    .matchAll(/^[ \t]*Failed:[ \t]+(.+)$/gm)) {
    for (const task of (match[1] ?? "").split(/[,\s]+/)) {
      if (task.length > 0 && !tasks.includes(task)) {
        tasks.push(task);
      }
    }
  }
  return tasks;
}

const LIMIT_MESSAGE = wardenMessage(
  "definition-of-done",
  `pnpm check is still red after ${RED_LIMIT} attempts`,
  "Label the issue needs:human",
);

function limitVerdict(rule: string): Verdict {
  return {
    rule,
    decision: "allow",
    message: LIMIT_MESSAGE,
    replacement: null,
    rendered: "allow",
  };
}

/** Counts one red stop. At the limit the stop is allowed with the needs:human line. */
function red(
  root: string,
  sessionId: string,
  rule: string,
  message: string,
  detail: string | null,
): Verdict {
  const state = readState(root);
  const streak = (state.sessions[sessionId]?.red_streak ?? 0) + 1;
  state.sessions[sessionId] = { red_streak: streak };
  writeState(root, state);
  if (streak >= RED_LIMIT) {
    return limitVerdict(rule);
  }
  return {
    rule,
    decision: "deny",
    message,
    replacement: null,
    rendered: "deny",
    ...(detail ? { detail } : {}),
  };
}

/** A failing rule on a stop is red too, so it traps the agent for at most 3 stops. */
export function stopEngineFailure(
  root: string,
  sessionId: string | null,
  message: string,
): Verdict {
  try {
    return red(root, sessionId ?? "unknown", "engine", message, null);
  } catch {
    return {
      rule: "engine",
      decision: "deny",
      message,
      replacement: null,
      rendered: "deny",
    };
  }
}

export function definitionOfDone(ctx: RuleContext, deps: DodDeps): Verdict {
  const { root, event } = ctx;
  if (event.stop_status !== null && event.stop_status !== "completed") {
    return allowVerdict();
  }
  if (nothingToDeliver(root)) {
    return allowVerdict();
  }
  const before = fingerprint(root);
  if (readState(root).last_green === before) {
    return allowVerdict();
  }
  const sessionId = event.session_id ?? "unknown";
  const result = deps.runCheck(root);
  if (result.status === "green") {
    const state = readState(root);
    state.last_green = fingerprint(root);
    state.sessions[sessionId] = { red_streak: 0 };
    writeState(root, state);
    return allowVerdict();
  }
  const tasks = failedTasks(result.output);
  const what =
    result.status === "timeout"
      ? `pnpm check did not finish within ${CHECK_TIMEOUT_MS / 1000} seconds`
      : tasks.length > 0
        ? `pnpm check is red: ${tasks.join(", ")} failed`
        : "pnpm check is red";
  return red(
    root,
    sessionId,
    "definition-of-done",
    wardenMessage(
      "definition-of-done",
      what,
      "Fix the failures and stop again",
    ),
    outputTail(result.output) || null,
  );
}
