import { z } from "zod";
import type { Charter } from "./charter.ts";
import { externalAllows } from "./external.ts";
import { resolveRepoPath } from "./paths.ts";

export const normalizedEventSchema = z.strictObject({
  tool: z.enum(["claude", "cursor"]),
  event: z.string().min(1),
  action: z.enum([
    "shell",
    "read",
    "edit",
    "write",
    "delete",
    "mcp",
    "stop",
    "session_start",
  ]),
  path: z.string().nullable(),
  command: z.string().nullable(),
  mcp_server: z.string().nullable(),
  session_id: z.string().nullable(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  interactive: z.boolean(),
  cwd: z.string().min(1),
  phase: z.enum(["pre", "post"]).nullable(),
  stop_status: z.enum(["completed", "aborted", "error"]).nullable(),
  foreign: z.boolean(),
  /** True when `path` is an absolute path outside the worktree that `paths.external` allows. */
  external: z.boolean().optional(),
});

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type Action = NormalizedEvent["action"];
export type ToolName = NormalizedEvent["tool"];

export type NormalizeFailure = { ok: false; message: string };
export type NormalizeSuccess = { ok: true; event: NormalizedEvent };

type Mapped = {
  action: Action;
  path: string | null;
  command: string | null;
  mcp_server: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);
    if (text) {
      return text;
    }
  }
  return null;
}

export function resolveInteractive(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    Object.hasOwn(payload, "interactive") &&
    typeof payload.interactive === "boolean"
  ) {
    return payload.interactive;
  }
  const raw = env.PANOPTICON_INTERACTIVE;
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return false;
}

function filePath(payload: Record<string, unknown>): string | null {
  const input = isRecord(payload.tool_input) ? payload.tool_input : null;
  return firstString(
    payload.file_path,
    input?.file_path,
    payload.path,
    input?.path,
  );
}

function commandOf(
  payload: Record<string, unknown>,
  key: "command" | "tool_input",
): string | null {
  if (key === "command") {
    return asString(payload.command);
  }
  const input = isRecord(payload.tool_input) ? payload.tool_input : null;
  return input ? asString(input.command) : null;
}

const STOP_STATUSES = ["completed", "aborted", "error"] as const;
type StopStatus = (typeof STOP_STATUSES)[number];

function stopStatusOf(value: unknown): StopStatus | null {
  return STOP_STATUSES.find((status) => status === value) ?? null;
}

const NOT_MAPPED = {
  ok: false,
  message: "the hook event is not mapped",
} as const;

function noPath(action: Action): { ok: true; mapped: Mapped } {
  return {
    ok: true,
    mapped: { action, path: null, command: null, mcp_server: null },
  };
}

/** Rows added for post-edit audit, stop and session start. Adapters read only the path and status. */
function mapLifecycle(
  tool: string,
  event: string,
  payload: Record<string, unknown>,
): { ok: true; mapped: Mapped } | NormalizeFailure | null {
  if (tool === "claude" && event === "PostToolUse") {
    const toolName = asString(payload.tool_name);
    const path = filePath(payload);
    if ((toolName !== "Edit" && toolName !== "Write") || !path) {
      return NOT_MAPPED;
    }
    return {
      ok: true,
      mapped: {
        action: toolName === "Edit" ? "edit" : "write",
        path,
        command: null,
        mcp_server: null,
      },
    };
  }
  if (tool === "claude" && event === "Stop") {
    return noPath("stop");
  }
  if (tool === "cursor" && event === "afterFileEdit") {
    const path = asString(payload.file_path);
    if (!path) {
      return NOT_MAPPED;
    }
    return {
      ok: true,
      mapped: { action: "edit", path, command: null, mcp_server: null },
    };
  }
  if (tool === "cursor" && event === "stop") {
    return stopStatusOf(payload.status) ? noPath("stop") : NOT_MAPPED;
  }
  if (tool === "cursor" && event === "sessionStart") {
    return noPath("session_start");
  }
  return null;
}

/** Map a hook payload. File paths are still tool paths; normalization resolves them. */
export function mapPayload(
  tool: string,
  event: string,
  payload: Record<string, unknown>,
): { ok: true; mapped: Mapped } | NormalizeFailure {
  const lifecycle = mapLifecycle(tool, event, payload);
  if (lifecycle) {
    return lifecycle;
  }
  if (tool === "claude" && event === "PreToolUse") {
    const toolName = asString(payload.tool_name);
    if (!toolName) {
      return { ok: false, message: "the hook event is not mapped" };
    }
    if (toolName === "Bash" || toolName === "PowerShell") {
      const command = commandOf(payload, "tool_input");
      if (!command) {
        return { ok: false, message: "the hook event is not mapped" };
      }
      return {
        ok: true,
        mapped: { action: "shell", path: null, command, mcp_server: null },
      };
    }
    if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
      const path = filePath(payload);
      if (!path) {
        return { ok: false, message: "the hook event is not mapped" };
      }
      const action =
        toolName === "Read" ? "read" : toolName === "Edit" ? "edit" : "write";
      return {
        ok: true,
        mapped: { action, path, command: null, mcp_server: null },
      };
    }
    if (toolName.startsWith("mcp__")) {
      const server = isRecord(payload.mcp_server) ? payload.mcp_server : null;
      return {
        ok: true,
        mapped: {
          action: "mcp",
          path: null,
          command: null,
          mcp_server: server ? asString(server.name) : null,
        },
      };
    }
    return { ok: false, message: "the hook event is not mapped" };
  }

  if (tool === "cursor" && event === "beforeShellExecution") {
    const command = commandOf(payload, "command");
    if (!command) {
      return { ok: false, message: "the hook event is not mapped" };
    }
    return {
      ok: true,
      mapped: { action: "shell", path: null, command, mcp_server: null },
    };
  }

  if (tool === "cursor" && event === "beforeReadFile") {
    const path = asString(payload.file_path);
    if (!path) {
      return { ok: false, message: "the hook event is not mapped" };
    }
    return {
      ok: true,
      mapped: { action: "read", path, command: null, mcp_server: null },
    };
  }

  if (tool === "cursor" && event === "beforeMCPExecution") {
    return {
      ok: true,
      mapped: {
        action: "mcp",
        path: null,
        command: null,
        mcp_server: asString(payload.mcp_server_name),
      },
    };
  }

  if (tool === "cursor" && event === "preToolUse") {
    const toolName = asString(payload.tool_name);
    if (!toolName) {
      return { ok: false, message: "the hook event is not mapped" };
    }
    if (toolName === "Shell") {
      const command = commandOf(payload, "tool_input");
      if (!command) {
        return { ok: false, message: "the hook event is not mapped" };
      }
      return {
        ok: true,
        mapped: { action: "shell", path: null, command, mcp_server: null },
      };
    }
    if (toolName === "Read" || toolName === "Write" || toolName === "Delete") {
      const path = filePath(payload);
      if (!path) {
        return { ok: false, message: "the hook event is not mapped" };
      }
      const action =
        toolName === "Read"
          ? "read"
          : toolName === "Write"
            ? "write"
            : "delete";
      return {
        ok: true,
        mapped: { action, path, command: null, mcp_server: null },
      };
    }
    if (toolName.startsWith("MCP:")) {
      return {
        ok: true,
        mapped: {
          action: "mcp",
          path: null,
          command: null,
          mcp_server: asString(payload.mcp_server_name) ?? toolName,
        },
      };
    }
    return { ok: false, message: "the hook event is not mapped" };
  }

  return { ok: false, message: "the hook event is not mapped" };
}

function sessionId(
  tool: ToolName,
  payload: Record<string, unknown>,
): string | null {
  if (tool === "cursor") {
    return asString(payload.session_id) ?? asString(payload.conversation_id);
  }
  return asString(payload.session_id);
}

function agentOf(
  tool: ToolName,
  payload: Record<string, unknown>,
): string | null {
  return tool === "claude" ? asString(payload.agent_type) : null;
}

function modelOf(payload: Record<string, unknown>): string | null {
  return asString(payload.model);
}

function phaseOf(event: string, action: Action): "pre" | "post" | null {
  if (action === "stop" || action === "session_start") {
    return null;
  }
  return event === "PostToolUse" || event === "afterFileEdit" ? "post" : "pre";
}

export function normalizeHook(input: {
  tool: string;
  event: string;
  payload: Record<string, unknown>;
  fallbackCwd: string;
  toplevel: string;
  env: NodeJS.ProcessEnv;
  /** Charter `paths.external` and home dir; without a charter every outside path is denied. */
  external?: { charter: Charter; home: string };
}): NormalizeSuccess | NormalizeFailure {
  if (input.tool !== "claude" && input.tool !== "cursor") {
    return { ok: false, message: "the hook event is not mapped" };
  }
  const mapped = mapPayload(input.tool, input.event, input.payload);
  if (!mapped.ok) {
    return mapped;
  }
  const cwd = asString(input.payload.cwd) ?? input.fallbackCwd;
  let path = mapped.mapped.path;
  let external = false;
  if (path !== null) {
    const resolved = resolveRepoPath(path, cwd, input.toplevel);
    if (resolved.ok) {
      path = resolved.path;
    } else {
      const allowed =
        resolved.reason === "escape" && input.external
          ? externalAllows(
              input.external.charter.paths.external,
              mapped.mapped.action,
              path,
              cwd,
              input.external.home,
            )
          : null;
      if (allowed === null) {
        return { ok: false, message: "path escapes the worktree" };
      }
      path = allowed;
      external = true;
    }
  }
  const parsed = normalizedEventSchema.safeParse({
    tool: input.tool,
    event: input.event,
    action: mapped.mapped.action,
    path,
    command: mapped.mapped.command,
    mcp_server: mapped.mapped.mcp_server,
    session_id: sessionId(input.tool, input.payload),
    agent: agentOf(input.tool, input.payload),
    model: modelOf(input.payload),
    interactive: resolveInteractive(input.payload, input.env),
    cwd,
    phase: phaseOf(input.event, mapped.mapped.action),
    stop_status:
      mapped.mapped.action === "stop"
        ? input.tool === "claude"
          ? "completed"
          : stopStatusOf(input.payload.status)
        : null,
    foreign: input.tool === "claude" && "cursor_version" in input.payload,
    ...(external ? { external } : {}),
  });
  if (!parsed.success) {
    return { ok: false, message: "the hook event is not mapped" };
  }
  return { ok: true, event: parsed.data };
}

export function parseNormalizedEvent(
  data: unknown,
): NormalizeSuccess | NormalizeFailure {
  const parsed = normalizedEventSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      message: "stdin is empty or not the JSON the event requires",
    };
  }
  return { ok: true, event: parsed.data };
}
