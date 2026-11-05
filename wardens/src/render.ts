import type { NormalizedEvent, ToolName } from "./event.ts";
import { wardenMessage } from "./messages.ts";
import type { Verdict } from "./verdict.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cursor preToolUse has no ask. The rule decision stays ask; the tool sees deny. */
export function finalizeVerdict(
  verdict: Verdict,
  event: NormalizedEvent | null,
): Verdict {
  if (
    verdict.decision === "ask" &&
    event?.tool === "cursor" &&
    event.event === "preToolUse"
  ) {
    const target = event.path ?? "the path";
    return {
      ...verdict,
      rendered: "deny",
      message: wardenMessage(
        verdict.rule,
        `${target} requires ask and this hook cannot prompt`,
        "Label the issue needs:human",
      ),
    };
  }
  return { ...verdict, rendered: verdict.decision };
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Output for PostToolUse, Stop, afterFileEdit, stop and sessionStart; null for the pre-edit events. */
function renderLifecycle(
  tool: string,
  event: string,
  verdict: Verdict,
): string | null {
  const allowed = verdict.decision === "allow";
  const reason = verdict.detail
    ? `${verdict.message}\n\n${verdict.detail}`
    : verdict.message;
  if (tool === "claude" && event === "Stop" && allowed && verdict.message) {
    return json({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: verdict.message,
      },
    });
  }
  if (tool === "claude" && event === "SessionStart" && allowed) {
    return verdict.message
      ? json({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: verdict.message,
          },
        })
      : "";
  }
  if (tool === "claude" && (event === "PostToolUse" || event === "Stop")) {
    return allowed ? "" : json({ decision: "block", reason });
  }
  if (tool === "cursor" && event === "sessionStart") {
    return json(allowed ? { env: { PANOPTICON_AGENT: "cursor" } } : {});
  }
  if (tool === "cursor" && event === "stop") {
    return json(allowed ? {} : { followup_message: reason });
  }
  if (tool === "cursor" && event === "afterFileEdit") {
    return json({});
  }
  return null;
}

export function renderHook(input: {
  tool: string;
  event: string;
  verdict: Verdict;
  raw: Record<string, unknown>;
}): string {
  const { verdict } = input;
  const lifecycle = renderLifecycle(input.tool, input.event, verdict);
  if (lifecycle !== null) {
    return lifecycle;
  }
  if (input.tool === "claude") {
    if (verdict.decision === "allow") {
      return "";
    }
    if (verdict.decision === "rewrite") {
      const toolInput = isRecord(input.raw.tool_input)
        ? input.raw.tool_input
        : {};
      return `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.event,
          updatedInput: { ...toolInput, command: verdict.replacement },
          additionalContext: verdict.message,
        },
      })}\n`;
    }
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.event,
        permissionDecision: verdict.rendered === "ask" ? "ask" : "deny",
        permissionDecisionReason: verdict.message,
      },
    })}\n`;
  }

  if (verdict.decision === "rewrite" && input.event === "preToolUse") {
    const toolInput = isRecord(input.raw.tool_input)
      ? input.raw.tool_input
      : {};
    return `${JSON.stringify({
      permission: "allow",
      updated_input: { ...toolInput, command: verdict.replacement },
    })}\n`;
  }
  if (verdict.decision === "rewrite") {
    return `${JSON.stringify({
      permission: "deny",
      agent_message: verdict.message,
      user_message: verdict.message,
    })}\n`;
  }
  if (verdict.decision === "allow") {
    return `${JSON.stringify({ permission: "allow" })}\n`;
  }
  const permission = verdict.rendered === "ask" ? "ask" : "deny";
  return `${JSON.stringify({
    permission,
    agent_message: verdict.message,
    user_message: verdict.message,
  })}\n`;
}

export function knownTool(tool: string): tool is ToolName {
  return tool === "claude" || tool === "cursor";
}
