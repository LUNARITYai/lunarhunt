import type { Charter } from "../charter.ts";
import { postPullYaml } from "./post-merge.ts";

/** Paths written by `wardens sync`, relative to the git toplevel. */
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CURSOR_HOOKS_PATH = ".cursor/hooks.json";
export const LEFTHOOK_PATH = "lefthook.yml";

/** Known `.env` variants that replace `.env.*` (permission rules have no negation). */
const ENV_VARIANTS = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
  ".env.staging",
];

const NEGATION = "!*.example";
const ENV_WILDCARD = ".env.*";

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** Charter glob to permission specifier. */
function specifier(glob: string): string {
  if (glob.startsWith("**/")) {
    return glob;
  }
  return glob.includes("/") ? `/${glob}` : `**/${glob}`;
}

function specifiers(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const glob of globs) {
    if (glob === NEGATION) {
      continue;
    }
    if (glob === ENV_WILDCARD) {
      out.push(...ENV_VARIANTS.map(specifier));
      continue;
    }
    out.push(specifier(glob));
  }
  return out;
}

function permissions(charter: Charter): {
  allow: string[];
  ask: string[];
  deny: string[];
} {
  const secrets = new Set(charter.paths.secrets_deny_read);
  const denyEdit = charter.paths.protected.deny.filter((g) => !secrets.has(g));
  const denyRead = charter.paths.protected.deny.filter((g) => secrets.has(g));
  // `Read(...)` deny also blocks `Edit` on the same path, so secrets get only `Read` rules.
  const deny = [
    ...specifiers(denyEdit).map((s) => `Edit(${s})`),
    ...specifiers([...denyRead, ...charter.paths.secrets_deny_read]).map(
      (s) => `Read(${s})`,
    ),
    ...specifiers(charter.paths.generated).map((s) => `Edit(${s})`),
    "NotebookEdit",
    ...charter.commands.deny.map((c) => `Bash(${c})`),
  ];
  return {
    allow: unique(charter.commands.allow.map((c) => `Bash(${c})`)),
    ask: unique(
      specifiers(charter.paths.protected.ask).map((s) => `Edit(${s})`),
    ),
    deny: unique(deny),
  };
}

/** Trusted primary checkouts, one absolute path per line, relative to `$HOME`. Written by `wardens sync`. */
export const ANCHOR_REL = ".config/panopticon/primaries";

export const LAUNCHER_BLOCK_MESSAGE =
  "Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.";

const BUNDLE = "wardens/dist/wardens.mjs";
export const LAUNCHER_BUNDLE_MESSAGE =
  "Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.";

/**
 * Launcher body (POSIX sh, no single quotes so it can sit inside `sh -c '...'`).
 * It never consults git or any repository data: the session directory is
 * resolved physically and must equal a primary listed in the anchor file or lie
 * under `<primary>/.claude/worktrees/` (Cursor: also `~/.cursor/worktrees/<name>/`).
 */
function launcher(tool: "claude" | "cursor", event: string): string {
  const session =
    tool === "claude"
      ? 's=; case "$CLAUDE_PROJECT_DIR" in /*) s=$(cd -P -- "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P);; esac'
      : // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
        'c=${CURSOR_PROJECT_DIR:-.}; s=; case "$c" in /*|.) s=$(cd -P -- "$c" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- "$HOME" 2>/dev/null && pwd -P) || h=/dev/null';
  const patterns = ['"$p"', '"$p"/.claude/worktrees/*'];
  if (tool === "cursor") {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    patterns.push('"$h/.cursor/worktrees/${p##*/}"/*');
  }
  const parts = [
    session,
    `a="$HOME/${ANCHOR_REL}"`,
    "r=",
    `[ -n "$HOME" ] && [ -n "$s" ] && [ -r "$a" ] && while IFS= read -r p || [ -n "$p" ]; do case "$p" in /*) ;; *) continue;; esac; p=$(cd -P -- "$p" 2>/dev/null && pwd -P) || continue; case "$s" in ${patterns.join("|")}) r=$p; break;; esac; done < "$a"`,
    `[ -n "$r" ] || { echo "${LAUNCHER_BLOCK_MESSAGE}" >&2; exit 2; }`,
    `[ -f "$r/${BUNDLE}" ] || { echo "${LAUNCHER_BUNDLE_MESSAGE}" >&2; exit 2; }`,
    `exec node "$r/${BUNDLE}" hook --tool ${tool} --event ${event}`,
  ];
  return parts.join("; ");
}

function claudeCommand(event: string): string {
  return `sh -c '${launcher("claude", event)}'`;
}

function cursorCommand(event: string): string {
  return `sh -c '${launcher("cursor", event)}'`;
}

function claudeHook(event: string, timeout: number) {
  return {
    type: "command",
    command: claudeCommand(event),
    timeout,
    onFailure: "block",
  };
}

function claudeSettings(charter: Charter): string {
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    env: { PANOPTICON_AGENT: "claude" },
    permissions: permissions(charter),
    hooks: {
      SessionStart: [{ hooks: [claudeHook("SessionStart", 10)] }],
      PreToolUse: [
        {
          matcher: "^(Bash|PowerShell|Read|Edit|Write|mcp__.*)$",
          hooks: [claudeHook("PreToolUse", 10)],
        },
      ],
      PostToolUse: [
        {
          matcher: "^(Edit|Write)$",
          hooks: [claudeHook("PostToolUse", 10)],
        },
      ],
      Stop: [{ hooks: [claudeHook("Stop", 900)] }],
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function cursorEntry(
  event: string,
  timeout: number,
  extra: { matcher?: string; loop_limit?: number } = {},
) {
  return {
    command: cursorCommand(event),
    ...(extra.matcher === undefined ? {} : { matcher: extra.matcher }),
    timeout,
    ...(extra.loop_limit === undefined ? {} : { loop_limit: extra.loop_limit }),
    failClosed: true,
  };
}

function cursorHooks(): string {
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [cursorEntry("sessionStart", 10)],
      preToolUse: [
        cursorEntry("preToolUse", 10, {
          matcher: "^(Shell|Read|Write|Delete|MCP:.*)$",
        }),
      ],
      beforeShellExecution: [cursorEntry("beforeShellExecution", 10)],
      beforeMCPExecution: [cursorEntry("beforeMCPExecution", 10)],
      beforeReadFile: [cursorEntry("beforeReadFile", 10)],
      afterFileEdit: [cursorEntry("afterFileEdit", 10)],
      stop: [cursorEntry("stop", 900, { loop_limit: 3 })],
    },
  };
  return `${JSON.stringify(hooks, null, 2)}\n`;
}

const LEFTHOOK = `# Generated by \`wardens sync\` from panopticon.charter.yaml (ADR-0003). Do not edit.

pre-commit:
  commands:
    biome:
      glob: "*.{js,jsx,ts,tsx,json,jsonc,css,yml,yaml}"
      run: pnpm exec biome check --write --no-errors-on-unmatched --files-ignore-unknown=true -- {staged_files}
      stage_fixed: true
    ruff:
      glob: "*.py"
      run: uv run --frozen ruff check --fix {staged_files} && uv run --frozen ruff format {staged_files}
      stage_fixed: true

commit-msg:
  commands:
    agent-trailer:
      run: node --experimental-strip-types wardens/src/cli.ts check agent-trailer {1}

pre-push:
  commands:
    check:
      run: pnpm check

${postPullYaml()}`;

/** Pure function of The Charter plus fixed templates: repo-relative path to file content. */
export function render(charter: Charter): Map<string, string> {
  return new Map([
    [CLAUDE_SETTINGS_PATH, claudeSettings(charter)],
    [CURSOR_HOOKS_PATH, cursorHooks()],
    [LEFTHOOK_PATH, LEFTHOOK],
  ]);
}
