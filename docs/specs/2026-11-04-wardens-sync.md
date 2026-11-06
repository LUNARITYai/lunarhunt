---
status: ready
issue: "#7"
adrs: ["0003", "0004", "0005", "0008", "0009", "0011", "0012", "0013"]
---

# Wardens sync, Definition of Done and doctor

## Goal and context

Issue [#7](https://github.com/LUNARITYai/lunarhunt/issues/7) is the second half of the Wardens entry criteria for PANOPTICON phase 0 ([ADR-0008](../decisions/0008-autonomy-phases-and-risk-based-merge-policy.md)). Issue #6 ([spec](2026-11-04-wardens-core.md)) shipped The Charter, its schema and the ring-0 rules `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard`. Nothing calls them yet: `.claude/settings.json` and `.cursor/hooks.json` do not exist, and `lefthook.yml` is hand-written.

This issue wires the engine into the tools and adds the rules that finish ring 0 and ring 1:

- `wardens sync` generates `.claude/settings.json`, `.cursor/hooks.json` and `lefthook.yml` from The Charter ([ADR-0003](../decisions/0003-the-charter-as-single-source-of-policy.md), [ADR-0005](../decisions/0005-wardens-engine-in-typescript-with-single-cli.md)). `charter-drift` fails when a generated file differs from the generator output (C-04).
- `generated-files-guard` denies hand edits of the generated API contract and client (C-13).
- `definition-of-done` runs on agent `Stop` and keeps the agent working while `pnpm check` is red, within a loop limit (C-12).
- `agent-trailer` fails an agent commit without `Agent: <tool> (<model>)` (C-27).
- `wardens doctor` checks that the generated hooks are fail-closed, breaks a hook on purpose, and warns when Cursor runs the Claude Code hooks a second time (C-03, ADR-0005).
- CI gets the jobs `charter-drift` and `wardens-test`.

Out of scope: ring-2 PR Wardens (`risk-classifier`, `pr-check`, `bug-repro-test`, `test-tampering`, `diff-coverage`), `panopticon/gate`, adding required checks to the `main` ruleset, `worktree-guard` and `wardens worktree *` ([ADR-0012](../decisions/0012-task-isolation-with-git-worktrees.md) follow-up), model routing and escalation ([ADR-0009](../decisions/0009-model-routing-and-escalation-per-role.md)), Ledger writes ([ADR-0010](../decisions/0010-the-ledger-and-observability.md)), security scanners, and the `wardens doctor` checks for effort overrides, stale worktrees and orphan task databases listed in `AGENTS.md`. Those checks belong to the ADR-0009 and ADR-0012 follow-ups.

The tool facts below were read from the Claude Code hooks, settings and permissions docs and the Cursor hooks docs on 2026-11-04. Where the docs were incomplete, the Plan marks the point **unverified**. The implementation must confirm it with a recorded payload or a manual test, or stop with `needs:human`.

## Acceptance criteria (EARS)

### `wardens sync` and `charter-drift`

- WHEN `wardens sync` runs, THE SYSTEM SHALL write `.claude/settings.json`, `.cursor/hooks.json` and `lefthook.yml` at the git toplevel, with the contents defined in Plan (Generated files), and SHALL write no other file.
- WHEN `wardens sync` runs twice on the same Charter, THE SYSTEM SHALL produce byte-identical files.
- WHEN `wardens sync` writes its files, THE SYSTEM SHALL produce output that `biome format` leaves unchanged.
- WHEN `wardens sync --check` runs and a generated file is missing or differs from the generator output, THE SYSTEM SHALL write nothing, print `Blocked by Warden charter-drift: <file> differs from wardens sync output. Ask a human to run wardens sync and commit the result.` for each such file and exit 2.
- WHEN `wardens sync --check` finds no difference, THE SYSTEM SHALL exit 0.
- WHEN `pnpm check` runs, THE SYSTEM SHALL run `wardens sync --check` as part of the `wardens` package `check` script.
- WHEN a pull request is opened or updated, THE CI job `charter-drift` SHALL run `wardens sync --check` and fail on drift.
- IF `wardens sync` (without `--check`) runs while an agent marker is set (see `agent-trailer`), THEN THE SYSTEM SHALL write nothing, print `Blocked by Warden charter-drift: wardens sync writes protected configs and is for humans. Ask Krzysztof to run wardens sync.` and exit 2.
- IF The Charter fails validation, THEN `wardens sync` and `wardens sync --check` SHALL write nothing and exit 2 with the `engine` message.

### Generated tool configs

- THE generated `.claude/settings.json` SHALL contain `SessionStart` (no matcher, `timeout` 10), `PreToolUse` with matcher `^(Bash|PowerShell|Read|Edit|Write|mcp__.*)$`, `PostToolUse` with matcher `^(Edit|Write)$` and `Stop`, each calling the Wardens bundle with `onFailure: "block"` and a `timeout`.
- THE generated `.claude/settings.json` SHALL contain `permissions.deny` for The Charter, the known `.env` variants, `secrets/**`, the generated paths, `NotebookEdit` and every `commands.deny` pattern; `permissions.ask` for every `paths.protected.ask` glob; and `permissions.allow` for every `commands.allow` pattern.
- THE generated `.claude/settings.json` SHALL set `env.PANOPTICON_AGENT` to `claude`.
- THE generated `.cursor/hooks.json` SHALL contain `version: 1` and the events `sessionStart`, `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit` and `stop`, each with `failClosed: true` and a `timeout`; `preToolUse` SHALL use matcher `^(Shell|Read|Write|Delete|MCP:.*)$` and `stop` SHALL set `loop_limit: 3`.
- THE generated hook commands in `.claude/settings.json` and `.cursor/hooks.json` SHALL run the bundle of a trusted primary checkout (`<primary>/wardens/dist/wardens.mjs`), not the bundle of the worktree the session runs in. A primary is trusted when it is listed in the anchor file `$HOME/.config/panopticon/primaries` (see Plan, Bundle location).
- THE generated hook commands SHALL NOT consult git or any data inside a repository to find the bundle.
- IF a generated hook command finds no trusted primary for the session directory, or the anchor file is missing, THEN it SHALL print `Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.` to stderr and exit 2 without running any bundle.
- WHEN `wardens sync` (without `--check`) runs, THE SYSTEM SHALL add its own primary checkout to the anchor file, keep the other entries, and create the directory with mode 0700 and the file with mode 0600. IF that primary cannot be verified structurally from the file system (see Plan, Bundle location), THEN it SHALL write nothing and exit 2. `wardens sync --check` and `charter-drift` SHALL NOT depend on the anchor file.
- THE generated `lefthook.yml` SHALL keep the current `pre-commit` (Biome, Ruff) and `pre-push` (`pnpm check`) commands and SHALL add a `commit-msg` command that runs `agent-trailer`.

### `generated-files-guard`

- WHEN an agent edits, writes or deletes a path matching `paths.generated`, THE SYSTEM SHALL deny via `generated-files-guard` with the next action `Run uv run export-openapi to regenerate it`.
- WHEN an agent edits `packages/contracts/README.md`, THE SYSTEM SHALL NOT object via `generated-files-guard`.
- WHEN an agent runs `uv run export-openapi`, THE SYSTEM SHALL NOT object via `generated-files-guard`.

### Post-edit audit

- WHEN Claude Code `PostToolUse` reports an `Edit` or `Write` of a path that `protected-paths` (deny list only), `scope-guard` or `generated-files-guard` would have denied, THE SYSTEM SHALL return `decision: "block"` with a C-30 reason whose next action is `Revert <path> with git checkout -- <path>`, or `Delete <path>` when the path is untracked in git (a new file from `Write`).
- WHEN Claude Code `PostToolUse` reports an edit of a path on `paths.protected.ask`, THE SYSTEM SHALL NOT object, because a human may have approved it.
- WHEN Cursor `afterFileEdit` fires, THE SYSTEM SHALL run the same audit, append the verdict to the JSONL log and print `{}`.

### `definition-of-done`

- WHEN an agent session stops (Claude Code `Stop`; Cursor `stop` with `status: "completed"`) and the worktree changed since the last green run, THE SYSTEM SHALL run `pnpm check` from the worktree root.
- WHEN `pnpm check` is red and the session has fewer than 3 consecutive red stops, THE SYSTEM SHALL keep the agent working (Claude Code `decision: "block"`; Cursor `followup_message`) with a C-30 message naming the failed tasks, followed by at most 60 lines of `pnpm check` output.
- WHEN `pnpm check` is red for the 3rd consecutive stop in one session, THE SYSTEM SHALL let the session stop and tell the agent `Blocked by Warden definition-of-done: pnpm check is still red after 3 attempts. Label the issue needs:human.`
- WHEN `pnpm check` is green, THE SYSTEM SHALL let the session stop, store the worktree fingerprint as the last green state and reset the session's red streak.
- WHEN the worktree fingerprint equals the last green fingerprint, THE SYSTEM SHALL let the session stop without running `pnpm check`.
- WHEN `HEAD` equals its merge-base with `origin/main` and `git status --porcelain` is empty, THE SYSTEM SHALL let the session stop without running `pnpm check`.
- WHEN Cursor `stop` arrives with `status` `aborted` or `error`, THE SYSTEM SHALL let the session stop without running `pnpm check`.
- IF `pnpm check` does not finish within 840 seconds, or the rule fails internally, THEN THE SYSTEM SHALL treat the stop as red, with rule id `definition-of-done` or `engine`.

### `agent-trailer`

- WHEN `wardens check agent-trailer <message-file>` runs in an agent session and the commit message has no trailer matching `^Agent: (claude|cursor) \(.+\)$`, THE SYSTEM SHALL print `Blocked by Warden agent-trailer: agent commit has no Agent: trailer. Add "Agent: <tool> (<model>)" as the last trailer and commit again.` and exit 2.
- WHEN the trailer names a tool other than the detected agent, THE SYSTEM SHALL fail the same way.
- WHEN no agent marker is present, THE SYSTEM SHALL exit 0 without inspecting the message.
- WHEN lefthook runs `commit-msg`, THE SYSTEM SHALL run `agent-trailer` from the TypeScript source, so a missing bundle does not block human commits.

### Cursor session environment

- WHEN Cursor `sessionStart` fires, THE SYSTEM SHALL return `{"env": {"PANOPTICON_AGENT": "cursor"}}`.

### Bundle freshness (#43)

- WHEN `git pull` (merge or rebase) updates `main` in the primary checkout, THE generated `lefthook.yml` hooks `post-merge` and `post-rewrite` SHALL run `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` changed between `ORIG_HEAD` and `HEAD`, and then `pnpm --filter wardens build` if anything under `wardens/` or the lockfile changed (the bundle inlines its dependencies, so a lockfile change can make it stale while the source hash stays equal).
- IF `ORIG_HEAD` cannot be resolved, THEN the hooks SHALL treat the lockfile and `wardens/` as changed.
- IF the hook runs in a linked worktree (`git rev-parse --git-dir` differs from `--git-common-dir`) or on a branch other than `main`, THEN it SHALL do nothing and exit 0.
- WHEN `post-rewrite` runs for an amend, THE hook SHALL do nothing.
- THE hooks SHALL be plain shell, so they work before dependencies are installed, and SHALL exit 0 when the install or the build fails, after printing the failure and `Run pnpm install && pnpm --filter wardens build in the primary checkout.`
- WHEN `pnpm --filter wardens build` runs, THE previous `wardens/dist/wardens.mjs` SHALL stay in place until the new bundle is complete, and the new bundle SHALL replace it with an atomic rename from a temporary directory inside `wardens/dist/`. IF the build fails, THEN the previous bundle SHALL stay untouched.
- WHEN Claude Code `SessionStart` or Cursor `sessionStart` fires and the running bundle's embedded source hash differs from the hash of `<primary>/wardens/src/**`, THE SYSTEM SHALL allow and log the warning `Wardens bundle is stale. Run pnpm --filter wardens build in the primary checkout.` For Claude Code it SHALL also return the warning as `hookSpecificOutput.additionalContext`; for Cursor it SHALL keep the `env` output only.
- WHEN the hashes match, the bundle has no embedded hash (TypeScript source) or the check fails for any reason, THE SYSTEM SHALL allow with no warning and, for Claude Code, empty output.

### `wardens doctor` and `wardens-test`

- WHEN `wardens doctor` runs, THE SYSTEM SHALL report each check in Plan (Doctor) as `ok`, `warn` or `fail`, exit 0 when no check fails and exit 2 otherwise.
- WHEN a generated hook entry lacks `onFailure: "block"` (Claude Code) or `failClosed: true` (Cursor), or lacks a `timeout`, THE `fail-closed` check SHALL fail.
- WHEN `wardens doctor` runs a generated hook command with the bundle path replaced by a missing file, THE `break-hook` check SHALL fail unless the command exits non-zero.
- WHEN `wardens doctor` runs the real bundle with an invalid Charter or with malformed stdin, THE `break-hook` check SHALL fail unless the engine returns a deny in the tool's format.
- WHEN the JSONL log holds a line with `foreign: true`, or two lines from different tools for the same session, event and target within 2 seconds, THE `duplicates` check SHALL warn `Cursor is running the Claude Code hooks too. Disable third-party hooks in Cursor settings.`
- WHEN a pull request is opened or updated, THE CI job `wardens-test` SHALL build the bundle, run `pnpm --filter wardens test` and run `wardens doctor --ci`.

### Messages and logging

- THE SYSTEM SHALL use the C-30 format for the first line of every new deny, block and drift message.
- WHEN a hook for a new event finishes, THE SYSTEM SHALL append exactly one JSONL line to `.panopticon/wardens.log.jsonl`, as in the core spec, and SHALL NOT log `pnpm check` output.

## Plan

### Approach

The engine already has the shape this issue needs: a normalized event, rules that see only that event, a renderer per tool and a fail-closed wrapper. This issue adds:

1. Engine support for the new events and rules: Claude Code `PostToolUse` and `Stop`; Cursor `afterFileEdit`, `stop` and `sessionStart`. The rules are `generated-files-guard`, the post-edit audit, `definition-of-done` and `agent-trailer`.
2. `wardens sync` and `wardens sync --check`, which render the three files from The Charter.
3. `wardens doctor`, and the CI jobs.

The generated configs call the bundle. If the configs landed before the engine understood `Stop`, every stop would hit an unmapped event and deny. So Task 2 (engine) must merge before Task 3 (sync and generated files).

### Settled conflicts

| Topic | Settlement |
| --- | --- |
| `PreToolUse` matcher | Issue #7 writes `Bash\|Edit\|Write\|mcp__.*`. The core spec maps `Read` (for `secret-read-guard`) and `PowerShell`. The matcher adds both. Without `Read`, Claude Code reads would rely on `permissions.deny` alone, which cannot express the `.env.example` exception. |
| Matcher anchoring | Unanchored regexes match substrings (for example `Read` inside `ReadMcpResourceTool`), and an unmapped tool makes the engine deny with `engine`. Both tools get anchored matchers. |
| `.env.*` in `permissions.deny` | Claude Code permission rules have no negation, so `Read(**/.env.*)` would also block `.env.example` (ADR-0013 exception). Sync expands `.env.*` into a fixed list of known variants. The hook covers every other variant through `secret-read-guard`. |
| `PostToolUse` / `afterFileEdit` purpose | ADR-0005 lists these hooks but gives them no rule. They become an audit that catches an edit the pre-hook should have denied (a bypassed or failed pre-hook). They cannot undo the edit. Claude Code shows the reason next to the tool result. Cursor documents no output for `afterFileEdit`, so it only logs. |
| Interactive bit | A static settings file cannot tell an interactive session from `claude -p`. Sync does not set `PANOPTICON_INTERACTIVE`. A human who wants an `ask` path to prompt instead of being denied exports `PANOPTICON_INTERACTIVE=1` before starting the session. `wardens/AGENTS.md` documents this. |
| DoD gate list | C-12 says `pnpm check` covers the whole Definition of Done. The rule runs `pnpm check`, not a per-gate command list. A unit test maps each Charter `quality_gates.definition_of_done` id to a Turborepo task (`lint`→`lint`, `typecheck`→`typecheck`, `test:affected`→`test`, `contract:drift`→`contract:check`) and asserts each task is in `turbo.json` `check.dependsOn`. An unknown gate id fails that test. |
| Loop limit | ADR-0009 escalates after 3 failed `Stop` hooks. The rule stops blocking after 3 consecutive red stops. In v1 the limit is a constant in the engine, not a Charter key; it moves into The Charter with the ADR-0009 escalation work (Decisions, item 1). Claude Code's own cap is 8 continuations. Cursor gets `loop_limit: 3` as a second line. |
| Agent detection | A git hook cannot see which tool started it. Claude Code gets `env.PANOPTICON_AGENT=claude` from settings. Cursor does not pass the `sessionStart` hook's `env` output to agent shells (recorded 2026-11-05 with `cursor-agent` 2026.10.22 and 2026.11.05, both `-p` and interactive), so Cursor is detected by `CURSOR_AGENT`, which Cursor sets in agent shells. Claude Code also sets `CLAUDECODE=1` in its Bash tool (confirmed 2026-11-04). `PANOPTICON_AGENT` stays the explicit marker and wins when set. The model is not known to a git hook, so the agent writes the trailer and `agent-trailer` only checks it. |
| Who runs `wardens sync` | `AGENTS.md` says humans run it; its output is in protected paths. The engine refuses a writing sync when an agent marker is set. Rings 2 and 3 (`charter-drift`, CODEOWNERS, `risk:high` on `.claude/**`, `.cursor/**`, `lefthook.yml`, `.github/**`) are the backstop. Bootstrap: the Task 3 PR is the first sync. It runs before any settings file exists, so the variable is unset. |
| JSON headers | JSON has no comments, and unknown keys may be rejected by either tool. The generated JSON files carry no "generated" header. `lefthook.yml` gets a YAML comment header. Drift is caught by `charter-drift`, not by a header. |
| Which bundle the hooks run | The draft ran `wardens/dist/wardens.mjs` from the session's own worktree. That has two problems. (1) A fresh task worktree (`git worktree add`, `claude --worktree`, `agent -w`) has no bundle and no `node_modules`, so every tool call is blocked, including the `pnpm install` and build that would fix it; `postCreateCommand` only helps inside the Dev Container. (2) An agent whose task allows `wardens/**` could weaken a rule and rebuild, and its own session would then run the weaker Warden until CI catches it. The hooks therefore run the primary checkout's bundle, which a human builds from `main` (Decisions, item 4). The bundle has no runtime dependencies, so the worktree needs no `node_modules` for the hooks. The engine still loads The Charter and `task.json` from the session's worktree. |
| Third-party hook import | The Cursor third-party-hooks reference returned 404 on 2026-11-04. ADR-0005 already accepts that turning off the import is an editor setting that `doctor` checks rather than guarantees. |

### Generated files

All three files are a pure function of The Charter plus fixed templates in `wardens/src/sync/`. Keys are emitted in the order shown. Arrays keep Charter order, with duplicates dropped after their first occurrence. JSON uses two-space indent and a trailing newline.

#### Bundle location

Every hook command runs the bundle of a trusted primary checkout. The launcher never consults git or any data inside a repository. Trust comes from one file outside every repository, the anchor file `$HOME/.config/panopticon/primaries`: one absolute path per line, the primary checkouts whose bundle may run. `wardens sync` writes it (the directory with mode 0700, the file with mode 0600), adds its own primary and keeps other entries. There is no environment variable that moves it.

The launcher is POSIX `sh` (the same body for every event; the full strings are in the normative blocks below). It:

1. Resolves the session directory physically (`cd -P`). Claude Code: `$CLAUDE_PROJECT_DIR`. Cursor: `$CURSOR_PROJECT_DIR`, or the hook's working directory when it is unset. A value that is not an absolute path is rejected. It never uses the `cwd` field of the hook payload (Cursor sends it empty).
2. Reads the anchor file. It skips empty lines and lines that are not absolute paths, and resolves each listed path physically. A carriage return is not stripped (the path then does not exist). Variables are quoted, so pattern characters in a path are literal.
3. Takes the first primary `r` for which the session directory equals `r` or lies under `r/.claude/worktrees/`. For Cursor it also accepts `$HOME/.cursor/worktrees/<basename of r>/`.
4. Checks that `$r/wardens/dist/wardens.mjs` is a file (otherwise it prints `Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.` and exits 2), then runs `exec node "$r/wardens/dist/wardens.mjs" hook --tool <tool> --event <event>`.

`wardens sync` derives the primary it adds from the file system, never from what git reports, and prints the path it adds. It adds a checkout only when (a) `<primary>/.git` is a directory (checked with `lstat`), (b) the physical path has no `/.claude/worktrees/` or `/.cursor/worktrees/` segment, and (c) when run in a linked worktree, exactly one `<primary>/.git/worktrees/*/gitdir` file names that worktree's `.git` and the worktree lies under `<primary>/.claude/worktrees/` (or the Cursor worktrees directory the launcher accepts). Otherwise it writes nothing and exits 2 with a `charter-drift` message. `wardens doctor` applies the same structural check to every anchor entry and to the primary it runs in.

When no primary matches, or the anchor file is missing or unreadable, the launcher prints `Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.` to stderr and exits 2 (deny in both tools). It never falls back to a bundle in the worktree. If the bundle is missing, the launcher exits 2 and `onFailure: "block"` / `failClosed: true` block the action. An agent cannot edit the primary checkout's bundle with an edit tool, because the core spec denies paths outside the worktree (rule `engine`), and ring 0 denies edits of any `.git` file or directory (`protected-paths`: `Blocked by Warden protected-paths: git metadata is not editable by agents. Label the issue needs:human.`).

Ring 0 also blocks, as built-in rules that are not part of The Charter:

- edits and shell write targets that name a `.git` file or directory, in any worktree, and any shell text or edit that names `.config/panopticon` (`Blocked by Warden protected-paths: ...`);
- a shell write target, or a `cd` argument, that contains a variable, brace, `~user` or an unquoted glob that could match `.git`, unless it provably stays inside the worktree (`Blocked by Warden command-guard: the command could not be parsed safely. Retry with literal paths.`);
- `git init --separate-git-dir`, `git worktree` subcommands other than `list`, `git config` forms other than the read forms (`--get`, `--get-all`, `--get-regexp`, `--list`, `-l`, with `--show-origin`, `--show-scope` and scope flags), and the global options `-c`, `--git-dir` and `--work-tree` (and the matching `GIT_*` variables) in front of a subcommand that writes.

The launcher removes redirection that was derived from a repository's own pointers. Tampering by the same user with the anchor file or the primary's bundle is mitigated in ring 0 only (best effort) and is closed by the OS sandbox (ADR-0015 draft).

Rollout order. The new commands take effect only when the regenerated `.claude/settings.json` and `.cursor/hooks.json` are merged and the anchor exists on that machine. Without the anchor every hook exits 2, so the anchor must exist before the regenerated files reach a checkout:

1. A human runs `wardens sync` from the PR branch, in the primary checkout, before the merge. This writes the anchor and the regenerated configs.
2. Merge the PR with the regenerated files.
3. Rebuild the bundle in the primary checkout (`pnpm install && pnpm --filter wardens build`).
4. Merge `main` into each open worktree.
5. Run `wardens doctor` in each worktree.

Lock-out behaviour: a machine without the anchor (or whose anchor lacks the session's primary) blocks every tool call in every session with the `launcher` message above, until a human runs `wardens sync` there.

#### Glob to permission-rule conversion

| Charter glob | Permission specifier |
| --- | --- |
| No `/` (basename rule, core spec) | `**/<glob>` |
| Contains `/` | `/<glob>` (relative to the project root) |
| `.env.*` | Expanded to the known variants below; the original is not emitted |
| `!*.example` | Dropped (no negation in permission rules) |

Known `.env` variants: `.env`, `.env.local`, `.env.development`, `.env.development.local`, `.env.test`, `.env.test.local`, `.env.production`, `.env.production.local`, `.env.staging`.

`Read(...)` deny also blocks `Edit` on the same path (Claude Code docs), so secrets get only `Read` rules. `Write(...)` path rules never match in Claude Code; sync uses `Edit(...)` for write protection.

#### `.claude/settings.json` (normative for Charter v1 as on `main`)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "PANOPTICON_AGENT": "claude"
  },
  "permissions": {
    "allow": [
      "Bash(pnpm turbo run *)",
      "Bash(pnpm check*)",
      "Bash(uv run pytest *)",
      "Bash(uv run ruff *)"
    ],
    "ask": [
      "Edit(/docs/constitution.md)",
      "Edit(**/AGENTS.md)",
      "Edit(**/CLAUDE.md)",
      "Edit(/apps/api/migrations/**)",
      "Edit(**/.env.example)"
    ],
    "deny": [
      "Edit(**/panopticon.charter.yaml)",
      "Read(**/.env)",
      "Read(**/.env.local)",
      "Read(**/.env.development)",
      "Read(**/.env.development.local)",
      "Read(**/.env.test)",
      "Read(**/.env.test.local)",
      "Read(**/.env.production)",
      "Read(**/.env.production.local)",
      "Read(**/.env.staging)",
      "Read(/secrets/**)",
      "Edit(/packages/api-client/src/**)",
      "Edit(/packages/contracts/openapi.json)",
      "NotebookEdit",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git push +*)",
      "Bash(kubectl * --context prod*)",
      "Bash(npm publish*)",
      "Bash(curl * | sh)",
      "Bash(curl * | bash)",
      "Bash(curl * | zsh)",
      "Bash(curl * | sudo sh)",
      "Bash(curl * | sudo bash)",
      "Bash(curl * | sudo zsh)",
      "Bash(wget * | sh)",
      "Bash(wget * | bash)",
      "Bash(wget * | zsh)",
      "Bash(wget * | sudo sh)",
      "Bash(wget * | sudo bash)",
      "Bash(wget * | sudo zsh)",
      "Bash(git commit --no-verify*)",
      "Bash(git commit -n*)",
      "Bash(git push --no-verify*)",
      "Bash(git merge --no-verify*)",
      "Bash(LEFTHOOK=0 *)",
      "Bash(git -c core.hooksPath=*)",
      "Bash(git config core.hooksPath*)",
      "Bash(wardens worktree remove * --force*)",
      "Bash(gh issue edit * --body*)",
      "Bash(gh issue edit * -b *)",
      "Bash(gh issue edit * --body-file*)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 's=; case \"$CLAUDE_PROJECT_DIR\" in /*) s=$(cd -P -- \"$CLAUDE_PROJECT_DIR\" 2>/dev/null && pwd -P);; esac; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool claude --event SessionStart'",
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "^(Bash|PowerShell|Read|Edit|Write|mcp__.*)$",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 's=; case \"$CLAUDE_PROJECT_DIR\" in /*) s=$(cd -P -- \"$CLAUDE_PROJECT_DIR\" 2>/dev/null && pwd -P);; esac; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool claude --event PreToolUse'",
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Edit|Write)$",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 's=; case \"$CLAUDE_PROJECT_DIR\" in /*) s=$(cd -P -- \"$CLAUDE_PROJECT_DIR\" 2>/dev/null && pwd -P);; esac; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool claude --event PostToolUse'",
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 's=; case \"$CLAUDE_PROJECT_DIR\" in /*) s=$(cd -P -- \"$CLAUDE_PROJECT_DIR\" 2>/dev/null && pwd -P);; esac; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool claude --event Stop'",
            "timeout": 900,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The `Bash(...)` permission rules are a second line (Decisions, item 3); unlike hooks, they still apply under `disableAllHooks`. Claude Code's `*` matches any text, including spaces, so these rules can match differently from `command-guard`'s tokenizer (for example, they miss `git commit -nm x` written as a combined flag after other words). `command-guard` stays authoritative. The permission rules only matter when the hook did not run.

`onFailure` needs Claude Code v2.1.295 or later (docs, 2026-11-04). `doctor` warns on an older `claude`.

#### `.cursor/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event sessionStart'",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "preToolUse": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event preToolUse'",
        "matcher": "^(Shell|Read|Write|Delete|MCP:.*)$",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "beforeShellExecution": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event beforeShellExecution'",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "beforeMCPExecution": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event beforeMCPExecution'",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "beforeReadFile": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event beforeReadFile'",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "afterFileEdit": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event afterFileEdit'",
        "timeout": 10,
        "failClosed": true
      }
    ],
    "stop": [
      {
        "command": "sh -c 'c=${CURSOR_PROJECT_DIR:-.}; s=; case \"$c\" in /*|.) s=$(cd -P -- \"$c\" 2>/dev/null && pwd -P);; esac; h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=/dev/null; a=\"$HOME/.config/panopticon/primaries\"; r=; [ -n \"$HOME\" ] && [ -n \"$s\" ] && [ -r \"$a\" ] && while IFS= read -r p || [ -n \"$p\" ]; do case \"$p\" in /*) ;; *) continue;; esac; p=$(cd -P -- \"$p\" 2>/dev/null && pwd -P) || continue; case \"$s\" in \"$p\"|\"$p\"/.claude/worktrees/*|\"$h/.cursor/worktrees/${p##*/}\"/*) r=$p; break;; esac; done < \"$a\"; [ -n \"$r\" ] || { echo \"Blocked by Warden launcher: this session directory is not under a trusted primary checkout. Ask Krzysztof to run wardens sync.\" >&2; exit 2; }; [ -f \"$r/wardens/dist/wardens.mjs\" ] || { echo \"Blocked by Warden launcher: the Wardens bundle of the trusted primary checkout is missing. Run pnpm --filter wardens build in the primary checkout.\" >&2; exit 2; }; exec node \"$r/wardens/dist/wardens.mjs\" hook --tool cursor --event stop'",
        "timeout": 900,
        "loop_limit": 3,
        "failClosed": true
      }
    ]
  }
}
```

Cursor runs project hooks from the project root (docs), so `git rev-parse` needs no `-C`. Project hooks run only in a trusted workspace; `doctor` cannot check that.

#### `lefthook.yml`

```yaml
# Generated by `wardens sync` from panopticon.charter.yaml (ADR-0003). Do not edit.

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

post-merge:
  commands:
    rebuild-wardens:
      run: |
        gd=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
        common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
        if [ "$gd" != "$common" ]; then exit 0; fi
        if [ "$(git branch --show-current)" != main ]; then exit 0; fi
        if changed=$(git diff --name-only ORIG_HEAD HEAD -- 2>/dev/null); then
          lock=0; wd=0
          if printf '%s\n' "$changed" | grep -qx 'pnpm-lock.yaml'; then lock=1; fi
          if printf '%s\n' "$changed" | grep -q '^wardens/'; then wd=1; fi
        else
          lock=1; wd=1
        fi
        next='Run pnpm install && pnpm --filter wardens build in the primary checkout.'
        if [ "$lock" = 1 ]; then
          if ! pnpm install --frozen-lockfile; then echo "wardens: pnpm install failed. $next"; exit 0; fi
        fi
        if [ "$lock" = 1 ] || [ "$wd" = 1 ]; then
          if ! pnpm --filter wardens build; then echo "wardens: bundle build failed. $next"; exit 0; fi
        fi
        exit 0

post-rewrite:
  commands:
    rebuild-wardens:
      run: |
        if [ "{1}" != rebase ]; then exit 0; fi
        gd=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
        common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
        if [ "$gd" != "$common" ]; then exit 0; fi
        if [ "$(git branch --show-current)" != main ]; then exit 0; fi
        if changed=$(git diff --name-only ORIG_HEAD HEAD -- 2>/dev/null); then
          lock=0; wd=0
          if printf '%s\n' "$changed" | grep -qx 'pnpm-lock.yaml'; then lock=1; fi
          if printf '%s\n' "$changed" | grep -q '^wardens/'; then wd=1; fi
        else
          lock=1; wd=1
        fi
        next='Run pnpm install && pnpm --filter wardens build in the primary checkout.'
        if [ "$lock" = 1 ]; then
          if ! pnpm install --frozen-lockfile; then echo "wardens: pnpm install failed. $next"; exit 0; fi
        fi
        if [ "$lock" = 1 ] || [ "$wd" = 1 ]; then
          if ! pnpm --filter wardens build; then echo "wardens: bundle build failed. $next"; exit 0; fi
        fi
        exit 0
```

The `post-merge` and `post-rewrite` hooks are plain shell on purpose: after a pull the dependencies may not be installed yet. `ORIG_HEAD` is the pre-pull `HEAD` for merge and rebase pulls (tested with real pulls); when it is missing, everything counts as changed. `post-rewrite` receives `rebase` or `amend` as `{1}` and ignores amends.

`commit-msg` runs from the worktree's source, like the package `check` script, so it needs no bundle. It needs `node_modules`, which every worktree setup installs before the first commit. Unlike the agent hooks, it runs the worktree's own code; an agent that edits `wardens/src/trailer.ts` can weaken it in its own worktree. Ring 2 (`pr-check`, C-27) is the backstop for trailers.

### Engine changes

#### Normalized event

The core spec's event gains these fields. All are null when they do not apply. The schema stays `.strict()`.

| Field | Type | Source |
| --- | --- | --- |
| `phase` | `"pre"` \| `"post"` \| null | `pre` for the core spec rows, `post` for `PostToolUse` and `afterFileEdit`, null otherwise |
| `stop_status` | `"completed"` \| `"aborted"` \| `"error"` \| null | Cursor `stop.status`; Claude Code `Stop` is always `completed` |
| `foreign` | boolean | true when a `--tool claude` invocation receives a payload that has `cursor_version` |

`action` gains `stop` and `session_start`.

New mapping rows. Any other combination still denies with rule `engine`.

| Tool | Event | Condition | Action | Path |
| --- | --- | --- | --- | --- |
| claude | `PostToolUse` | `tool_name` `Edit` | edit | `tool_input.file_path` |
| claude | `PostToolUse` | `tool_name` `Write` | write | `tool_input.file_path` |
| claude | `Stop` | — | stop | null |
| claude | `SessionStart` | — | session_start | null |
| cursor | `afterFileEdit` | — | edit | `file_path` (absolute; made repo-relative by the core spec's path preparation) |
| cursor | `stop` | — | stop | null |
| cursor | `sessionStart` | — | session_start | null |

Adapters drop `tool_response`, `edits`, `last_assistant_message` and `transcript_path` before the event is built, like the core spec drops file contents.

#### Rules

| Rule | Actions | Behaviour |
| --- | --- | --- |
| `generated-files-guard` | edit, write, delete (pre) | Path matches `paths.generated` (same glob rules as the core spec) → deny. |
| post-edit audit | edit, write (post) | Runs the deny side of `protected-paths` (deny list only), `scope-guard` and `generated-files-guard`. Any deny → Claude Code `decision: "block"` with the C-30 line from the denying rule and next action `Revert <path> with git checkout -- <path>`, or `Delete <path>` when the path is untracked (`git checkout` cannot restore a file that git does not track). `ask` matches are ignored. |
| `definition-of-done` | stop | See below. |
| session env | session_start | Always allow. Cursor output `{"env": {"PANOPTICON_AGENT": "cursor"}}`. When the running bundle is stale (Bundle freshness), the verdict carries the stale warning: Claude Code adds it as `additionalContext`, Cursor only logs it. |

Precedence among pre-edit rules, same severity: `protected-paths`, `secret-read-guard`, `generated-files-guard`, `command-guard`, `scope-guard`.

Messages:

- `Blocked by Warden generated-files-guard: packages/contracts/openapi.json is generated. Run uv run export-openapi to regenerate it.`
- `Blocked by Warden scope-guard: infra/main.tf was edited outside allowed_paths for this task. Revert infra/main.tf with git checkout -- infra/main.tf.`
- `Blocked by Warden scope-guard: infra/new.tf was edited outside allowed_paths for this task. Delete infra/new.tf.`

#### `definition-of-done`

State lives in `<toplevel>/.panopticon/dod-state.json` (gitignored with `.panopticon/`):

```json
{
  "last_green": "sha256:…",
  "sessions": { "sess_abc": { "red_streak": 1 } }
}
```

Fingerprint: SHA-256 over `git rev-parse HEAD`, `git status --porcelain=v1 -z --untracked-files=all`, `git diff HEAD --binary`, and the bytes of each untracked file in path order. `.panopticon/` is gitignored and never part of it.

Order of decisions on a stop event:

1. Cursor `stop_status` not `completed` → allow.
2. `HEAD` equals `git merge-base HEAD origin/main` and porcelain status is empty → allow (nothing to deliver; covers planning sessions in the primary checkout). If `origin/main` does not resolve, skip this step.
3. Fingerprint equals `last_green` → allow.
4. Run `pnpm check` in the toplevel with `TURBO_TELEMETRY_DISABLED=1`, a 840-second timeout, and stdout and stderr captured together.
5. Green → write `last_green`, set `red_streak` to 0, allow.
6. Red or timeout → increment `red_streak`. If it is now 3 or more → allow, with the needs:human message (Claude Code: `hookSpecificOutput.additionalContext`; Cursor: `followup_message` is not sent, `{}`). Otherwise → block.

Rendering:

| Verdict | Claude Code `Stop` | Cursor `stop` |
| --- | --- | --- |
| allow | exit 0, empty stdout | exit 0, `{}` |
| block | exit 0, `{"decision": "block", "reason": "<C-30 line>\n\n<output tail>"}` | exit 0, `{"followup_message": "<C-30 line>\n\n<output tail>"}` |
| limit reached | exit 0, `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "<needs:human line>"}}` | exit 0, `{}` |

Failed tasks come from Turborepo's `Failed:` summary lines; if none can be parsed, the message says `pnpm check is red`. The output tail is the last 60 lines and at most 4,000 characters. It goes only to the agent, never to the JSONL log (C-18, C-19). The JSONL line for a stop records `rule`, `decision` (`deny` for block, `allow` otherwise), `duration_ms` and the C-30 line.

An engine failure while evaluating a stop renders as a block with the `engine` message and counts toward the streak, so a broken rule cannot trap the agent for more than 3 stops.

#### `agent-trailer`

`wardens check agent-trailer <message-file>`:

1. Agent marker: `PANOPTICON_AGENT` is `claude` or `cursor`; else `CLAUDECODE=1` means `claude`; else a non-empty `CURSOR_AGENT` means `cursor`. No marker → exit 0.
2. Parse trailers with `git interpret-trailers --parse <message-file>`.
3. Require at least one trailer matching `^Agent: (claude|cursor) \(.+\)$` whose tool equals the marker. `Agent: claude (sonnet, high)` passes.
4. Otherwise print the C-30 message and exit 2. Append one JSONL line with `tool` set to the marker, `event` `commit-msg`, `action` `commit` (an `action` value used only by this check).

Ring 2 for C-27 (checking trailers on PR commits in CI) belongs to `pr-check` and is out of scope.

### `wardens sync` CLI

- `wardens sync`: validate The Charter, render, write the three files, then write or refresh the launcher anchor idempotently (see Bundle location). Exit 0, 2 on error. Refuse when an agent marker is set (`agent-trailer` step 1).
- `wardens sync --check`: render in memory and compare. Exit 0 or 2. Never writes and never reads the anchor. Allowed in agent sessions.
- The renderer is pure (`render(charter) → Map<path, string>`), so the tests and `doctor` use it without touching disk.
- The `wardens` package `check` script becomes `node --experimental-strip-types src/cli.ts check charter-validate && node --experimental-strip-types src/cli.ts sync --check`.

### Doctor

`wardens doctor [--ci] [--json]` runs these checks from the git toplevel:

| Id | Check | Result on problem |
| --- | --- | --- |
| `drift` | Generated files equal `render(charter)` | fail |
| `fail-closed` | Every hook in `.claude/settings.json` has `onFailure: "block"` and `timeout` > 0; every hook in `.cursor/hooks.json` has `failClosed: true` and `timeout` > 0 | fail |
| `coverage` | Each subscribed event and matcher alternative has a mapping row; each mapping row the generated configs should cover is subscribed | fail |
| `break-hook` | (a) Each generated hook command, run with the bundle path replaced by a missing file and a sample payload, exits non-zero. (b) The real bundle, run against a temp git repo with an invalid Charter, returns a deny in the tool's format. (c) The real bundle with stdin `not json` returns a deny. | fail |
| `bundle` | The primary checkout's `wardens/dist/wardens.mjs` exists and its embedded source hash (written by tsup at build time) equals the hash of the primary checkout's `wardens/src/**` | fail when missing; warn when stale (`Run pnpm --filter wardens build in the primary checkout.`) |
| `launcher-anchor` | `$HOME/.config/panopticon/primaries` exists and lists this primary checkout; the file and its directory are owned by the user and not writable by group or other; no line holds a carriage return; every entry passes the structural check (`.git` is a directory, not under a `.claude/worktrees` or `.cursor/worktrees` directory, not under another entry's `.claude/worktrees`). The primary is derived from the file system, not from git | fail (not part of `--ci`) |
| `duplicates` | JSONL log: any `foreign: true` line in the last 7 days, or lines from both tools with the same `session_id`, `event` class and target within 2 s | warn |
| `disable-all-hooks` | `.claude/settings.local.json` or `~/.claude/settings.json` sets `disableAllHooks: true` | warn |
| `claude-version` | `claude --version` ≥ 2.1.295 when `claude` is on `PATH` | warn |

`--ci` skips `launcher-anchor`, `duplicates`, `disable-all-hooks` and `claude-version`, which depend on the developer's machine. Output: one line per check, `ok|warn|fail <id>: <message>`. With `--json`, one JSON array.

`break-hook` (a) runs the commands with a throwaway `HOME` whose anchor lists this checkout, so the launcher accepts the session and only the missing bundle can make the command fail. It proves only that our command fails when the bundle is missing. It does not prove Claude Code or Cursor then blocks; that depends on `onFailure` and `failClosed`, which `fail-closed` checks. The manual test in Task 3 closes this gap once with real tools.

### CI

Both jobs are added to `.github/workflows/check.yml` after PR #12 (issue #5) merges, using the same Dev Container image as the `check` job. Actions stay pinned to commit SHAs with `permissions: contents: read` (ADR-0014).

- `charter-drift`: install, then `node --experimental-strip-types wardens/src/cli.ts sync --check`.
- `wardens-test`: install, `pnpm --filter wardens build`, `pnpm --filter wardens test`, `node wardens/dist/wardens.mjs doctor --ci`.

Making them required checks in the `main` ruleset is a human step after merge, and is out of scope.

### Rollout (Krzysztof)

After Task 3 merges, every Claude Code and Cursor session in the repository runs fail-closed hooks against the primary checkout's bundle. If that bundle is missing, every session is blocked on every tool call. Task worktrees need nothing.

0. From the PR branch, before it is merged, run `wardens sync` in the primary checkout. It writes the launcher anchor `$HOME/.config/panopticon/primaries` and regenerates the tool configs; commit the regenerated `.claude/settings.json` and `.cursor/hooks.json`. Merge only then (see Bundle location, Rollout order). Without the anchor every hook exits 2 with `Blocked by Warden launcher: ...`; `wardens doctor` reports `launcher-anchor`.
1. In the primary checkout, on an up-to-date `main`: `pnpm install && pnpm --filter wardens build`. After every pull in the primary checkout the `post-merge` and `post-rewrite` hooks reinstall and rebuild when the lockfile or `wardens/**` changed (#43); if that fails they print the next action, and `wardens doctor` and the `SessionStart` warning report a stale bundle.
2. Add `pnpm --filter wardens build` to `.devcontainer/devcontainer.json` `postCreateCommand` (ADR-0005 already requires the bundle on create). This is a protected path, so it goes in Task 3's PR with your approval.
3. In Cursor settings, turn off loading third-party (Claude Code) hooks, and trust the workspace.
4. Run `pnpm exec lefthook install` again so `commit-msg` is installed.
5. Run `wardens doctor` locally. Expect `ok` for everything except possibly `claude-version`.
6. After a Charter schema change, rebuild the primary bundle before any worktree gets the new Charter. Otherwise the old bundle rejects the new Charter and all sessions there are blocked; `doctor` `bundle` reports it.

### Known limitations

- Shell writes (`echo x > file`, generators) are not edits. `scope-guard` and `generated-files-guard` do not see them. The `contract:check` drift check in `pnpm check` and CI catches hand-made contract changes; `charter-drift` catches hand-made config changes.
- Cursor `Grep` and `Task` are not subscribed (unmapped). Cursor `Grep` can read file contents without `beforeReadFile`.
- `PostToolUse` runs after the edit. The audit reports and the agent must revert; nothing is undone automatically.
- The DoD fingerprint ignores ignored files. An edit to a gitignored file does not trigger a new run.
- Cursor `sessionStart` output `env` does not reach agent shells (recorded 2026-11-05). The engine still returns it, so a later Cursor that honours it needs no change, but detection relies on `CURSOR_AGENT`.
- `CURSOR_AGENT` is empty in the Cursor IDE terminal panel (verified 2026-11-05, #30), so a human commit from that panel needs no `Agent:` trailer.
- Task scope is the Charter `allowed_paths` intersected with `task.json`. Paths outside the Charter `allowed_paths` are human-only, whatever the issue lists.
- Under live Wardens, shell commands cannot reference paths outside the worktree, `paths.external` included, and `command-guard` denies heredocs. Use Write or Edit for files.
- A session whose cwd is not a git worktree (for example after its own worktree was removed) is blocked on every tool call: the git toplevel cannot be resolved. `Stop` and `stop` are allowed and logged to `<os.tmpdir()>/panopticon/wardens.log.jsonl` (#32, #33). The next action that works without tools: move the session into an existing worktree (`EnterWorktree`) or restart it in the primary checkout.
- Cursor `stop` fires only in interactive sessions, not with `cursor-agent -p`. Interrupting a run sends two `stop` events 1 ms apart, `aborted` then `error`, with the same `generation_id`; both are allowed without a DoD run.
- Hooks enforce the Wardens built in the primary checkout. A Wardens change is live only after it merges and Krzysztof pulls and rebuilds there; a Wardens PR is tested with `pnpm --filter wardens test` and explicit runs of its own bundle, not by its own session's hooks. If the primary checkout is on another branch or its bundle is stale, sessions run that code; `doctor` reports a stale bundle.
- Shell commands can still write anywhere the user can, including the primary checkout. `worktree-guard` (ADR-0012 follow-up) narrows this.

### Affected packages

- `wardens/**` (engine, sync templates, doctor, tests, fixtures, `package.json`, `AGENTS.md`)
- `.claude/settings.json`, `.cursor/hooks.json`, `lefthook.yml` (generated)
- `.github/workflows/check.yml`
- `.devcontainer/devcontainer.json` (`postCreateCommand` only)
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` (catalog) only if a dependency is needed. None is expected.

No product API, contract, client or migration. No Charter change.

### ADRs needed

None. This spec follows ADR-0003, ADR-0004, ADR-0005 and ADR-0013 and records the settlements above. The decision log gets one row for the settled conflicts when the spec is accepted.

## Tasks

Each task below becomes its own `agent:ready` issue, linked to #7 as the parent. The last PR closes #7.

1. **This spec.** Land `docs/specs/2026-11-04-wardens-sync.md` at `status: draft`. Krzysztof sets `status: ready`.
   **Allowed paths:** `docs/specs/2026-11-04-wardens-sync.md`

2. **Engine: new events and rules.** Normalized-event fields, the new mapping rows, `generated-files-guard`, the post-edit audit, `definition-of-done` with its state file, the Cursor `sessionStart` env, `wardens check agent-trailer`, the JSONL additions, and tests for each EARS criterion above. Record Cursor `stop`, `afterFileEdit` and `sessionStart` payloads from a real session, and confirm `CLAUDECODE` in a real Claude Code Bash call; if either cannot be done, stop with `needs:human` instead of inventing a payload. No configs are generated yet.
   **Allowed paths:** `wardens/**`
   **Depends on:** 1

3. **`wardens sync` and generated configs.** The renderer, `sync` and `sync --check`, the package `check` script change, the first generated `.claude/settings.json`, `.cursor/hooks.json` and `lefthook.yml`, the CI job `charter-drift`, the `postCreateCommand` build step, and a manual test in a real Claude Code session and a real Cursor session started in a task worktree: with the primary checkout's bundle renamed, an `Edit` is blocked (record the result in the PR). The same test runs `echo "CURSOR_AGENT=$CURSOR_AGENT"` in the Cursor IDE terminal panel and records whether it is set. Task 2 must be merged and built in the primary checkout first. `risk:high`.
   **Allowed paths:** `wardens/**`, `.claude/settings.json`, `.cursor/hooks.json`, `lefthook.yml`, `.github/workflows/check.yml`, `.devcontainer/devcontainer.json`
   **Depends on:** 2, and PR #12 merged

4. **`wardens doctor` and `wardens-test`.** The doctor checks above, the tsup source-hash banner, and the CI job `wardens-test`. Closes #7.
   **Allowed paths:** `wardens/**`, `.github/workflows/check.yml`
   **Depends on:** 3

Expected size: Task 2 is the largest. If its PR passes 600 changed lines, split `definition-of-done` into its own PR under the same issue.

## Decisions

Krzysztof answered the draft's open questions on 2026-11-04:

1. **Loop limit stays an engine constant (3) in v1.** It moves into The Charter with the ADR-0009 escalation work, together with the other escalation thresholds (3 failed `Stop` hooks, 5 Warden blocks), so that The Charter and its schema change once.
2. **`NotebookEdit` is denied.** The repository has no notebooks, and `NotebookEdit` path rules never match in Claude Code, so sync emits the bare tool name in `permissions.deny`.
3. **`Bash(...)` permission rules are generated** from both `commands.deny` and `commands.allow`. `command-guard` stays authoritative. The deny rules still apply when hooks are turned off with `disableAllHooks`, which does not affect `permissions`. The allow rules spare prompts for routine commands such as `pnpm check`.

Krzysztof approved a later change on 2026-11-04, raised in the OVERSEER review before Task 3 started:

4. **Hooks run the primary checkout's bundle**, not the session worktree's. This fixes two problems: fresh task worktrees that were blocked on their first tool call, and agents that could rebuild a weaker Warden for their own session. Settled conflicts ("Which bundle the hooks run") and Generated files ("Bundle location") give the details.

No open questions remain.
