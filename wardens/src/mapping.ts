import type { ToolName } from "./event.ts";

/**
 * One row per event and matcher alternative the generated configs subscribe to.
 * `mapPayload` in `event.ts` must map each `sample`; `wardens doctor` (`coverage`) checks both directions.
 * `matcher` is the alternative inside the config matcher regex, or null for an event without one.
 */
export type MappingRow = {
  tool: ToolName;
  event: string;
  matcher: string | null;
  sample: Record<string, unknown>;
};

export const MAPPING_ROWS: readonly MappingRow[] = [
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "Bash",
    sample: { tool_name: "Bash", tool_input: { command: "echo ok" } },
  },
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "PowerShell",
    sample: { tool_name: "PowerShell", tool_input: { command: "echo ok" } },
  },
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "Read",
    sample: { tool_name: "Read", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "Edit",
    sample: { tool_name: "Edit", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "Write",
    sample: { tool_name: "Write", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "claude",
    event: "PreToolUse",
    matcher: "mcp__.*",
    sample: { tool_name: "mcp__server__tool", mcp_server: { name: "server" } },
  },
  {
    tool: "claude",
    event: "PostToolUse",
    matcher: "Edit",
    sample: { tool_name: "Edit", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "claude",
    event: "PostToolUse",
    matcher: "Write",
    sample: { tool_name: "Write", tool_input: { file_path: "README.md" } },
  },
  { tool: "claude", event: "Stop", matcher: null, sample: {} },
  { tool: "cursor", event: "sessionStart", matcher: null, sample: {} },
  {
    tool: "cursor",
    event: "preToolUse",
    matcher: "Shell",
    sample: { tool_name: "Shell", tool_input: { command: "echo ok" } },
  },
  {
    tool: "cursor",
    event: "preToolUse",
    matcher: "Read",
    sample: { tool_name: "Read", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "cursor",
    event: "preToolUse",
    matcher: "Write",
    sample: { tool_name: "Write", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "cursor",
    event: "preToolUse",
    matcher: "Delete",
    sample: { tool_name: "Delete", tool_input: { file_path: "README.md" } },
  },
  {
    tool: "cursor",
    event: "preToolUse",
    matcher: "MCP:.*",
    sample: { tool_name: "MCP:tool", mcp_server_name: "server" },
  },
  {
    tool: "cursor",
    event: "beforeShellExecution",
    matcher: null,
    sample: { command: "echo ok" },
  },
  {
    tool: "cursor",
    event: "beforeMCPExecution",
    matcher: null,
    sample: { mcp_server_name: "server" },
  },
  {
    tool: "cursor",
    event: "beforeReadFile",
    matcher: null,
    sample: { file_path: "README.md" },
  },
  {
    tool: "cursor",
    event: "afterFileEdit",
    matcher: null,
    sample: { file_path: "README.md" },
  },
  {
    tool: "cursor",
    event: "stop",
    matcher: null,
    sample: { status: "completed" },
  },
];
