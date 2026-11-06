---
status: draft
issue: 69
adrs: ["0003", "0004", "0012", "0013", "0015"]
---

# Wardens sandbox: the Claude Code OS sandbox, generated and checked

## Goal and context

[ADR-0015](../decisions/0015-claude-code-sandbox-beneath-ring-0.md) (proposed) makes the Claude Code sandbox a kernel-level floor beneath ring 0. The tests behind it are in spike [#66](https://github.com/LUNARITYai/lunarhunt/issues/66), in the final report's probe table, P01–P24.

This spec defines how The Charter describes the sandbox, how `wardens sync` renders it, what ring 0 and `doctor` add, and the OVERSEER profile. Issue: [#69](https://github.com/LUNARITYai/lunarhunt/issues/69).

**What the sandbox covers:** Bash commands and their child processes, for filesystem writes, filesystem reads (only where `denyRead` applies) and network egress.

**What it does not cover:**
- the Read, Edit and Write tools, WebFetch, WebSearch, MCP servers and hooks;
- network intent towards an allowlisted host;
- the shared `.git` of a linked worktree.

Ring 0 stays responsible for all of these (see "Known gaps").

**Out of scope:**
- the Cursor sandbox (ring 0 only until it is tested, see #68 and the #66 retest);
- the Dev Container Cell (ADR-0012, phase 2);
- the network-side OVERSEER CLI ([#64](https://github.com/LUNARITYai/lunarhunt/issues/64));
- the deny-side parser fixes ([#63](https://github.com/LUNARITYai/lunarhunt/issues/63)), which go ahead unchanged.

**Gating:**
- `status: ready` needs R1, R6 and R7, because their answers change this design.
- Rollout needs R2–R4.
- ADR-0015 is accepted together with `ready`.

## Acceptance criteria (EARS)

### Charter `sandbox:` section

- THE Charter schema SHALL accept an optional top-level `sandbox:` section, strict, with these keys:
  - `enabled` (bool) and `required` (bool, default false);
  - `filesystem.extra_write`, for sandbox-only toolchain caches (absolute or `~/` paths);
  - `filesystem.deny_read`, for credential locations outside the repository;
  - `network.allow`, for host names; a `*.` prefix is allowed;
  - `overseer.settings_path`, the repository-relative path of the generated OVERSEER profile, under `.claude/`.
- WHEN the section is absent or `enabled` is false, THE SYSTEM SHALL render no `sandbox` block. `doctor` SHALL then report `sandbox: off`: as a failure when `required` is true, otherwise as a warning.
- IF `network.allow` contains any of the following, THEN Charter validation SHALL fail:
  - `*`, an IP literal or a TLD wildcard (`*.com`);
  - a wildcard on a user-content or object-store domain (`*.githubusercontent.com`, `*.amazonaws.com`);
  - an Anthropic API host. The tool calls the API from outside the sandbox. An allowlisted API inside it would let a nested, unguarded `claude` session run under the sandbox and bypass ring 0 for Edit and Write.
- IF `filesystem.extra_write` contains a directory on `PATH`, `PNPM_HOME`, `~/.local/bin`, a shell rc location, `~` itself or any parent of `~`, THEN Charter validation SHALL fail.
- IF `filesystem.deny_read` is empty while `enabled` is true, THEN Charter validation SHALL fail.

### Rendering (`wardens sync`)

- WHERE `sandbox.enabled` is true, THE generated `.claude/settings.json` SHALL contain a `sandbox` block with:
  - `enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false`;
  - no `excludedCommands` and no `allowUnixSockets`;
  - no weaker-isolation, local-binding or proxy-port key.
- `autoAllowBashIfSandboxed: false` keeps today's approval prompts: a sandboxed command outside `commands.allow` still asks, or is denied in headless runs.
- THE block's `filesystem.allowWrite` SHALL be exactly the Charter `filesystem.extra_write`, plus the session's own scratchpad location (see R2).
  - It SHALL NOT include the memory glob from `paths.external.write`. Memory stays writable through the Write tool, which ring 0 guards, and not through the shell.
  - The cwd worktree and `$TMPDIR` are writable by default and are not listed.
- THE block SHALL set `env` so that the toolchains use the sandbox-only caches from `extra_write` (`UV_CACHE_DIR`, `npm_config_store_dir`), never the human's own caches.
- THE block's `filesystem.denyRead` SHALL contain every Charter `paths.secrets_deny_read` glob, for the cwd worktree and for the primary checkout, plus `filesystem.deny_read`.
- THE block's `filesystem.denyWrite` SHALL contain the worktree's `panopticon.charter.yaml`, `.panopticon/**`, the worktree's git pointer file `.git`, and, if R3 succeeds, the protected-branch ref set from R3.
- THE block's network allowlist SHALL be exactly `sandbox.network.allow`.
- IF a Charter glob or path cannot be expressed in the sandbox path syntax (R1), THEN `wardens sync` SHALL fail and name it. It SHALL NOT silently widen or drop it.
- WHERE `sandbox.overseer.settings_path` is set, `wardens sync` SHALL also render that file:
  - the same `sandbox` block plus `filesystem.denyWrite` on the repository working tree, with the git common dir left writable for `git fetch`, if R6 shows that this is expressible;
  - IF R6 shows that it is not expressible, THEN the profile SHALL NOT be rendered, and the spec returns to `draft`.
- This amends the sync spec (`2026-11-04-wardens-sync.md`), which says sync writes exactly three files. The profile is a fourth generated file, covered by `sync --check` and `charter-drift`. It sits under `.claude/`, so it inherits that path's protection.
- THE hook launcher in every rendered hook command SHALL locate the Wardens bundle only from data that the agent cannot write, or SHALL verify the result and fail closed. In particular, it SHALL refuse a bundle path inside the session's worktree. Render tests SHALL pin this. (Class-level; details are with Krzysztof.)

### Ring 0: `sandbox-guard`

- WHEN a Bash tool call has `tool_input.dangerouslyDisableSandbox` set to true, THE SYSTEM SHALL deny it with `Blocked by Warden sandbox-guard: commands run only inside the sandbox. Retry without dangerouslyDisableSandbox.`
- `sandbox-guard` SHALL read `sandbox.enabled` and `sandbox.required` from the **primary checkout's** Charter, never from the worktree's. This uses the same verified bundle and primary resolution as the launcher.
- WHILE `sandbox.enabled` is true and the session has no valid canary pass, THE SYSTEM SHALL deny every Bash command except the exact canary command it issued. The message is `Blocked by Warden sandbox-guard: prove the sandbox first. Run exactly: <command>.`, where `<command>` is `node <absolute primary bundle path> sandbox canary <nonce>`.
- Nonces:
  - a nonce SHALL be random (at least 128 bits), single-use, valid for 10 minutes and bound to `session_id`;
  - several outstanding nonces SHALL be allowed (a set), so that parallel Bash calls do not race;
  - a stale or unknown nonce SHALL get a fresh issue, not a pass.
- WHEN the canary runs, THE SYSTEM SHALL check the boundary that fits the session's cwd class (`classifyCwd`).
  - **Linked worktree on a task branch:**
    - creating a file with `O_EXCL` in the worktree succeeds (positive control);
    - creating one in the primary checkout's `.panopticon/` fails;
    - creating one in `~/.panopticon-canary/` fails;
    - reading a decoy file under a `denyRead` location fails;
    - a direct connection to a non-allowlisted host fails.
  - **Primary checkout or detached `HEAD`** (OVERSEER): the same checks, but creating a file in the cwd SHALL fail, which needs the OVERSEER profile. The failure message SHALL name the missing profile.
  - Only the platform's sandbox errno counts as a pass (EPERM on macOS; R5 gives the Linux values). ENOENT, EROFS or a timeout counts as a failure.
  - Any probe file that was created SHALL be deleted.
  - The canary SHALL print one line, `sandbox: enforced <nonce> <cwd-class>`, only when every check matches.
- WHEN a `PostToolUse` Bash event shows exactly the command string issued for an outstanding nonce, and its output contains the line `sandbox: enforced <nonce> <cwd-class>` for the session's actual cwd class, THE SYSTEM SHALL record a pass and consume the nonce.
  - Any other result SHALL record a failure.
  - After a failure, every later Bash command SHALL be denied with `Blocked by Warden sandbox-guard: the sandbox is not enforced in this session. Ask Krzysztof (needs:human).`
- Canary state:
  - THE SYSTEM SHALL keep nonces and verdicts outside every sandbox-writable location, in `~/.local/state/panopticon/sessions/<session_id>.json`;
  - hooks can write there, but sandboxed Bash cannot (P04);
  - `extra_write` validation forbids covering it;
  - a test SHALL assert that a sandboxed Bash write to the state file fails (part of R2).
- WHEN a `SessionStart` event arrives with any source (`startup`, `resume`, `clear`, `compact`), THE SYSTEM SHALL drop the session's pass. Settings can differ after a relaunch.
- `worktree-guard` SHALL allow the exact issued canary command as a built-in exception, matched by argv equality. It SHALL NOT use a Charter glob, and `primary_read_only_commands` does not grow.
- Order: `sandbox-guard` SHALL run after `worktree-guard` and before every other rule.
- `sandbox-guard` SHALL apply only when the hook's real tool identity is Claude Code. Cursor can load `.claude/settings.json` hooks, and there the canary cannot pass.

### `doctor`

- THE `doctor` SHALL add a `sandbox` check that fails when, with `sandbox.enabled` true:
  - the generated `.claude/settings.json` or the OVERSEER profile lacks the rendered block, or differs from it;
  - `.claude/settings.local.json` or `~/.claude/settings.json` contains any `sandbox.*` key outside the allowed set (allowlist, not denylist). The allowed set is the rendered keys with the rendered values; R1 decides whether those files can override them at all.
- THE `doctor` SHALL add a `protected-refs` check that fails when a local `worktree.protected_branches` ref is neither equal to its `origin/` counterpart nor an ancestor of it.
  - This is the only detector for a locally moved `main` (P10, P11). The `main` ruleset only stops such a ref from reaching origin.
- THE `doctor` `worktrees` check SHALL warn on a task worktree whose generated `.claude/settings.json` differs from the primary's. A worktree on an old branch would otherwise run with old settings.
- `--ci` SHALL check only the generated files.

## Plan

### Settled points

| Topic | Settlement |
| --- | --- |
| Sandbox vs Wardens | The sandbox enforces no policy rule. Every Warden stays. `sandbox-guard` only keeps the sandbox on and proven. |
| Where hooks run | Outside the sandbox (#66 hook probe). The bundle and logs keep working, and a hook can never probe the sandbox, which is why the canary is a Bash command. Hooks running outside the sandbox is also why the launcher must not trust agent-writable data (B3, class level). |
| Canary trust | Every anchor sits outside the agent's reach: <br>- the state file in `~` (not writable by the shell); <br>- the gate read from the primary Charter; <br>- the canary pinned to the absolute primary bundle path, with argv equality; <br>- single-use nonces; <br>- a reset on every `SessionStart`. <br>The nonce gives replay resistance only. Unforgeability comes from `PostToolUse` seeing the real command and its real output. |
| `.git` carve-out | The shared `.git` is writable from a worktree (P10, P11 moved local `main`). The ruleset stops that ref from reaching origin, and `doctor protected-refs` detects it locally. R3 decides whether `denyWrite` closes it. |
| Network list | Charter-owned and minimal: `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. No Anthropic hosts. Anything else needs a Charter PR. |
| Credential reads | Proposed `deny_read`: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.claude.json`, `~/.claude/.credentials*`, `~/Library/Keychains`, browser profile dirs. Env tokens are a known gap. |
| Toolchain caches | Sandbox-only caches under `~/.cache/panopticon-sandbox/{uv,pnpm}`, set through the rendered `env`. A poisoned cache cannot reach the human's own tools. `lefthook install` writes `.git/hooks`, so it is expected to fail inside the sandbox: run it at setup time (a hook or a human), never by widening `allowWrite`. |
| `$TMPDIR` | On macOS it is the per-user temp dir, shared with all of the user's apps. It is writable by default and stays a staging area. Documented as a known gap. |
| OVERSEER profile | A settings file passed at launch: `claude --settings .claude/overseer.settings.json`. Sandbox settings are per project, not per role. The canary detects a missing profile, because a cwd-class mismatch fails the canary. |
| Read-only roles | Reviewer, Sentinel and debugger use the implementer floor and rely on instructions for read-only behaviour. Per-role profiles are a follow-up. |
| Cursor | No `sandbox-guard`, no rendered `sandbox.json`. Revisit after the Cursor retest. |

### Known gaps (not closed by this spec)

- **WebFetch, WebSearch and MCP servers** run outside the sandbox. The network allowlist does not apply to them, and ring 0 has no MCP rule. Follow-up: a Charter per-role MCP and WebFetch policy.
- **Allowlisted hosts are sinks.** With the user's GitHub token, data can leave through github.com (gists, comments, pushes). Follow-up: a GitHub App or fine-grained token per role (phase 2).
- **Environment tokens** are inherited by sandboxed commands.
- **`--setting-sources` without the project source** drops the sandbox and the hooks together. No hook can see this, and only the Ledger's "sessions without hook events" signal (ADR-0004) can.
- **`$TMPDIR`** is shared across the user's apps (above).

### Retest (Krzysztof runs it, with the #66 kit extended)

- **R1 (blocks `ready`).** Settings precedence and path syntax:
  - enable the sandbox through project `.claude/settings.json`, then try to switch it off or widen it through `.claude/settings.local.json`, `~/.claude/settings.json` and `--settings`;
  - record which keys win;
  - test the path semantics of `allowWrite`, `denyRead` and `denyWrite` (`/`, `~/`, `./`, `**`, globs), so that paths outside the cwd can be expressed portably;
  - IF a portable form does not exist, THEN machine-specific paths go to a per-machine file rendered at setup time, and this spec is revised.
- **R2 (blocks rollout).** Toolchain inside the sandbox, on the real layout (task worktrees nested at `.claude/worktrees/<name>`):
  - `pnpm install --frozen-lockfile`, `uv sync --frozen`, `pnpm check`, `git commit` with lefthook, and `gh pr view`;
  - a test that loads the worktree's `.env`;
  - Postgres on localhost;
  - writes to the session scratchpad. Check whether Claude Code exposes the session's own temp path; otherwise narrow the glob;
  - a sandboxed write to `~/.local/state/panopticon/` fails.
- **R3 (blocks rollout).** `denyWrite` on the protected-branch ref set:
  - the set: `<common>/refs/heads/<branch>`, `logs/refs/heads/<branch>`, `refs/remotes/origin/<branch>`, `packed-refs`, the primary `HEAD` and `index`, `worktrees/*/HEAD`, and their `*.lock` siblings;
  - re-run P10 and P11, then commit, fetch and push on a task branch.
- **R4 (blocks rollout).**
  - With `allowUnsandboxedCommands: false`, the model retries a denied write with `dangerouslyDisableSandbox`, and the write must stay denied.
  - With `autoAllowBashIfSandboxed: false`, a command outside `commands.allow` still prompts, or is denied in `-p`.
  - Check that `-p` honours `failIfUnavailable`, and that subagent Bash calls run under the same settings.
- **R5 (separate).** Linux (bubblewrap), including its errno values, before any headless or CI agent relies on it.
- **R6 (blocks `ready`).** Profile and pointer protection:
  - Can `denyWrite` on the repository override the default cwd write?
  - Can the common git dir stay writable inside a denied tree?
  - Does `git fetch` still work, and what does `claude --worktree` do under the profile?
  - Is the worktree's `.git` pointer file write-protected by the sandbox by default (B3)?
- **R7 (blocks `ready`).** Record a real `PostToolUse` Bash payload, including `tool_response`, and the violation text the sandbox appends to the output.

### Engine and CLI changes

- `charter.ts` and `schema/charter.schema.json`: the `sandbox:` section and its validation rules.
- `sync/render.ts`:
  - the `sandbox` block, the OVERSEER profile and the hardened launcher;
  - the `PostToolUse` matcher extended from `^(Edit|Write)$` to include `Bash`;
  - a `SessionStart` hook if one is not rendered yet.
- `event.ts` and `mapping.ts`: map Bash `PostToolUse` (`tool_response`) and carry `dangerouslyDisableSandbox` through normalization. Use a recorded fixture from R7.
- `rules.ts`: the `sandbox-guard` rule and the built-in canary exception in `worktree-guard`.
- New `sandbox/` module: the state store in `~/.local/state/panopticon/`, and the `wardens sandbox canary <nonce>` subcommand.
- `doctor.ts`: the `sandbox` and `protected-refs` checks, and the settings-drift warning in `worktrees`.

### Rollout (Krzysztof)

1. Run R1, R6 and R7, then revise this spec, set it to `ready` and accept ADR-0015.
2. Merge Tasks 2–3, add the `sandbox:` values to The Charter, rebuild the bundle and run `wardens sync`. Run R2–R4 with the generated files.
3. Merge Tasks 4a–4b. From then on, every Claude Code session starts with the canary.
4. Launch OVERSEER with `--settings .claude/overseer.settings.json`.
5. Set `sandbox.required: true`.

## Tasks

Each task becomes its own issue, linked to #69.

1. **This spec and ADR-0015.** Krzysztof decides. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`, `docs/decision-log.md`.
2. **Charter `sandbox:` schema and validation** (no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
3. **Render:** the `sandbox` block, the OVERSEER profile, the hardened launcher and the hook matchers, with render tests. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2, R1 and R6.
4. **`sandbox-guard`:**
   - **4a.** The rule, the Bash `PostToolUse` mapping, the state store, the `SessionStart` reset and the `worktree-guard` exception, with DENIED/ALLOWED tables including forged canary forms.
   - **4b.** The `wardens sandbox canary` subcommand and its cwd-class checks.

   `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2 and R7.
5. **`doctor`:** the `sandbox` and `protected-refs` checks, and the settings-drift warning. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 3 and R1.

## Decisions (Krzysztof)

1. **Accept ADR-0015** after R1, R6 and R7, or reject it and keep ring 0 alone.
2. **Canary gate:**
   - Option A: hard, every session blocks Bash until the canary passes. It costs one extra turn per session, subagents and `-p` runs included (proposed).
   - Option B: soft, warn only.
3. **The `.git` carve-out:** if R3 fails, accept it with the ruleset and `doctor protected-refs`, or wait for the Dev Container.
4. **Network list and `deny_read` set:** confirm the initial values.
5. **`commands.deny` additions** (Charter, human): `gh pr merge*` and the mutating `gh api` forms. The latter overlaps with #61.
6. **B3 on `main` today:** how to handle the launcher gap now, independently of this spec (private advisory, hotfix issue, or the Task 3 change).
