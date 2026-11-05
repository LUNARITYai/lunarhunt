import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedEvent } from "./event.ts";
import type { Verdict } from "./verdict.ts";

export type LogLine = {
  ts: string;
  rule: string;
  decision: Verdict["decision"];
  rendered: Verdict["decision"];
  duration_ms: number;
  tool: NormalizedEvent["tool"] | null;
  event: string | null;
  action: NormalizedEvent["action"] | "commit" | null;
  path: string | null;
  command: string | null;
  mcp_server: string | null;
  session_id: string | null;
  agent: string | null;
  model: string | null;
  interactive: boolean;
  phase: NormalizedEvent["phase"];
  stop_status: NormalizedEvent["stop_status"];
  foreign: boolean;
  message: string | null;
  replacement: string | null;
};

export function logLine(input: {
  verdict: Verdict;
  event: NormalizedEvent | null;
  tool: NormalizedEvent["tool"] | null;
  eventName: string | null;
  finishedAt: number;
  startedAt: number;
}): LogLine {
  const event = input.event;
  return {
    ts: new Date(input.finishedAt).toISOString(),
    rule: input.verdict.rule,
    decision: input.verdict.decision,
    rendered: input.verdict.rendered,
    duration_ms: Math.max(0, input.finishedAt - input.startedAt),
    tool: event?.tool ?? input.tool,
    event: event?.event ?? input.eventName,
    action: event?.action ?? null,
    path: event?.path ?? null,
    command: event?.command ?? null,
    mcp_server: event?.mcp_server ?? null,
    session_id: event?.session_id ?? null,
    agent: event?.agent ?? null,
    model: event?.model ?? null,
    interactive: event?.interactive ?? false,
    phase: event?.phase ?? null,
    stop_status: event?.stop_status ?? null,
    foreign: event?.foreign ?? false,
    message: input.verdict.message,
    replacement: input.verdict.replacement,
  };
}

export function appendVerdict(toplevel: string, line: LogLine): void {
  const dir = join(toplevel, ".panopticon");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "wardens.log.jsonl"),
    `${JSON.stringify(line)}\n`,
    "utf8",
  );
}
