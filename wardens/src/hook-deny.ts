import type { Pipeline } from "./command.ts";

/**
 * Built-in shell deny for the Claude Code worktree hook entrypoints
 * (`wardens worktree create|remove --tool claude`, issue #51). It does not
 * depend on Charter values: a forged payload on stdin could create a task
 * worktree for any issue or remove worktrees, so an agent must not reach the
 * entrypoints from a shell, in any spelling of the command.
 *
 * Three textual rules, all on text with quotes and backslashes removed, so
 * `--to"ol"` and `cr\eate` read like the plain words:
 *
 * - A: `--tool claude` or `--tool cursor` (also `--tool=...`) anywhere. The
 *   only user of this flag is a tool hook; a hook command in settings.json is
 *   run by the tool, never by the Bash tool, so no legitimate agent command
 *   contains it.
 * - B: `--tool` together with `worktree` anywhere (covers a value built from a
 *   variable, `--tool "$t"`).
 * - C: a segment whose command is not a read-only text tool and that names
 *   `worktree`, a bundle spelling (`wardens`, `cli.ts`) and either `create`,
 *   `remove` or a shell expansion. This closes `node wardens.mjs worktree
 *   create`, `pnpm exec wardens ...`, `bash -c '...'`, `alias w='... worktree
 *   create'` and `wardens worktree "$verb" "$flag"`. Without `--tool` the human
 *   path refuses agents anyway, so this denies nothing a legitimate agent
 *   needs.
 *
 * Known limit, shared by every command deny: a script file the agent first
 * writes and then runs is not parsed here.
 */

/** Commands that only carry text: `git commit -m`, `gh ... --body` and so on. */
const TEXT_COMMANDS = new Set([
  "git",
  "gh",
  "echo",
  "printf",
  "cat",
  "rg",
  "grep",
  "ls",
]);

function normalize(text: string): string {
  return text.replace(/['"\\]/g, "").toLowerCase();
}

function ruleA(text: string): boolean {
  return /--tool(?:=|\s+)(?:claude|cursor)(?![a-z0-9-])/.test(text);
}

function ruleB(text: string): boolean {
  return text.includes("--tool") && /worktree/.test(text);
}

function ruleC(text: string): boolean {
  return (
    /worktree/.test(text) &&
    /wardens|cli\.ts/.test(text) &&
    (/\b(?:create|remove)\b/.test(text) || /[$`]/.test(text)) &&
    !/worktree\s+list\b/.test(text)
  );
}

function commandName(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

/** True when the command would reach a worktree hook entrypoint. `pipelines` are the parsed readings of `command`. */
export function invokesWorktreeHook(
  command: string,
  pipelines: readonly Pipeline[],
): boolean {
  const raw = normalize(command);
  if (ruleA(raw) || ruleB(raw)) {
    return true;
  }
  for (const pipeline of pipelines) {
    if (!pipeline.ok) {
      continue;
    }
    for (const segment of pipeline.segments) {
      if (TEXT_COMMANDS.has(commandName(segment.argv[0]))) {
        continue;
      }
      if (ruleC(normalize(segment.argv.join(" ")))) {
        return true;
      }
    }
  }
  return false;
}
