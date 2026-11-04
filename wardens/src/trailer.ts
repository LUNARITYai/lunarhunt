import { execFileSync } from "node:child_process";
import { gitToplevel } from "./git.ts";
import { appendVerdict, type LogLine } from "./log.ts";
import { engineMessage, wardenMessage } from "./messages.ts";

const TRAILER = /^Agent: (claude|cursor) \(.+\)$/;

export type TrailerResult = { exitCode: 0 | 2; stderr: string };

/** `CLAUDECODE=1` is set by Claude Code in its Bash tool (confirmed 2026-11-04). */
export function detectAgent(
  env: NodeJS.ProcessEnv,
): "claude" | "cursor" | null {
  const marker = env.PANOPTICON_AGENT;
  if (marker === "claude" || marker === "cursor") {
    return marker;
  }
  return env.CLAUDECODE === "1" ? "claude" : null;
}

function trailerLines(file: string, cwd: string): string[] {
  return execFileSync("git", ["interpret-trailers", "--parse", file], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => line.trimEnd());
}

/** `wardens check agent-trailer <message-file>` (C-27). */
export function runAgentTrailer(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  now: () => number = () => Date.now(),
): TrailerResult {
  const agent = detectAgent(env);
  if (agent === null) {
    return { exitCode: 0, stderr: "" };
  }
  const startedAt = now();
  let message: string | null = null;
  try {
    if (!file) {
      throw new Error("no message file");
    }
    const ok = trailerLines(file, cwd).some((line) => {
      const match = TRAILER.exec(line);
      return match !== null && match[1] === agent;
    });
    if (!ok) {
      message = wardenMessage(
        "agent-trailer",
        "agent commit has no Agent: trailer",
        'Add "Agent: <tool> (<model>)" as the last trailer and commit again',
      );
    }
  } catch {
    message = engineMessage("the commit message could not be read");
  }
  const toplevel = gitToplevel(cwd);
  if (toplevel) {
    const finishedAt = now();
    const line: LogLine = {
      ts: new Date(finishedAt).toISOString(),
      rule: message === null ? "none" : "agent-trailer",
      decision: message === null ? "allow" : "deny",
      rendered: message === null ? "allow" : "deny",
      duration_ms: Math.max(0, finishedAt - startedAt),
      tool: agent,
      event: "commit-msg",
      action: "commit",
      path: null,
      command: null,
      mcp_server: null,
      session_id: null,
      agent: null,
      model: null,
      interactive: false,
      phase: null,
      stop_status: null,
      foreign: false,
      message,
      replacement: null,
    };
    try {
      appendVerdict(toplevel, line);
    } catch {
      // The commit is judged on the trailer; a log failure must not hide that.
    }
  }
  return message === null
    ? { exitCode: 0, stderr: "" }
    : { exitCode: 2, stderr: `${message}\n` };
}
