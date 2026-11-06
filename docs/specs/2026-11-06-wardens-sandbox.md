---
status: draft
issue: 69
adrs: ["0003", "0004", "0012", "0013", "0015"]
---

# Wardens sandbox: the Claude Code OS sandbox, generated and checked

## Goal and context

[ADR-0015](../decisions/0015-claude-code-sandbox-beneath-ring-0.md) (proposed) makes the Claude Code sandbox a kernel-level floor beneath ring 0. The tests behind it are in spike [#66](https://github.com/LUNARITYai/lunarhunt/issues/66), in the final report's probe table.

This spec defines how The Charter describes the sandbox, how `wardens sync` renders it, what ring 0 and `doctor` add, and the OVERSEER profile. Issue: [#69](https://github.com/LUNARITYai/lunarhunt/issues/69).

**Out of scope:**
- the Cursor sandbox (ring 0 only until it is tested, see #68 and the #66 retest);
- the Dev Container Cell (ADR-0012, phase 2);
- the network-side OVERSEER CLI ([#64](https://github.com/LUNARITYai/lunarhunt/issues/64));
- the deny-side parser fixes ([#63](https://github.com/LUNARITYai/lunarhunt/issues/63)), which go ahead unchanged.

**Blocking `ready`:** retest item R1, below.

## Acceptance criteria (EARS)

### Charter `sandbox:` section

- THE Charter schema SHALL accept an optional top-level `sandbox:` section, strict, with:
  - `enabled` (bool);
  - `filesystem.extra_write` (absolute or `~/` paths for toolchain caches);
  - `network.allow` (host names, `*.` prefix allowed);
  - `overseer.settings_path` (repository-relative path of the generated OVERSEER profile).
- WHEN the section is absent or `enabled` is false, THE SYSTEM SHALL render no `sandbox` block, and `doctor` SHALL report `sandbox: off` as a warning, not a failure.
- IF `network.allow` contains `*` or an IP literal, THEN Charter validation SHALL fail.

### Rendering (`wardens sync`)

- WHERE `sandbox.enabled` is true, THE generated `.claude/settings.json` SHALL contain a `sandbox` block with:
  - `enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`;
  - no `excludedCommands`;
  - no `allowUnixSockets` entries.
- THE block's `filesystem.allowWrite` SHALL be exactly the Charter `paths.external.write` plus `sandbox.filesystem.extra_write`. The cwd worktree and `$TMPDIR` are writable by default and are not listed.
- THE block's `filesystem.denyRead` SHALL contain every Charter `paths.secrets_deny_read` glob, rendered for the sandbox, with `!*.example` handled as for `Read(...)` rules today.
- THE block's network allowlist SHALL be exactly `sandbox.network.allow`.
- IF a Charter glob cannot be expressed in the sandbox path syntax, THEN `wardens sync` SHALL fail and name the glob. It SHALL NOT silently widen or drop it.
- WHERE `sandbox.overseer.settings_path` is set, `wardens sync` SHALL also render that file: the same `sandbox` block plus `filesystem.denyWrite` on the repository working tree.
  - The writable set then reduces to `paths.external.write` and `$TMPDIR`.
  - The common git dir stays writable, because `git fetch` needs it.

### Ring 0

- WHEN a Bash tool call has `tool_input.dangerouslyDisableSandbox` set to true, THE SYSTEM SHALL deny it with `Blocked by Warden sandbox-guard: commands run only inside the sandbox. Retry without dangerouslyDisableSandbox.`
- WHILE `sandbox.enabled` is true and the session has no recorded canary pass, THE SYSTEM SHALL deny every Bash command except `wardens sandbox canary <nonce>`, with a `sandbox-guard` message that names the command and a fresh nonce.
- WHEN `wardens sandbox canary <nonce>` runs, THE SYSTEM SHALL try to create a file in the primary checkout's `.panopticon/` and outside the repository, and SHALL print `sandbox: enforced <nonce>` only if both writes fail with EPERM.
- WHEN a `PostToolUse` event shows exactly the command `wardens sandbox canary <nonce>`, with the nonce issued to this session and the output `sandbox: enforced <nonce>`, THE SYSTEM SHALL record a canary pass for the session.
  - A pass is recorded only for a command with exactly that one form: no other words, operators or redirects.
  - Any other output SHALL record a failure, and every later Bash command SHALL then be denied with `sandbox-guard: the sandbox is not enforced in this session. Ask Krzysztof (needs:human).`
- `sandbox-guard` SHALL run after `worktree-guard` and before every other rule.
- In Cursor sessions, THE SYSTEM SHALL NOT apply `sandbox-guard`.

### `doctor`

- THE `doctor` SHALL add a `sandbox` check that fails when, with `sandbox.enabled` true:
  - the generated `.claude/settings.json` lacks the rendered block, or differs from it;
  - `.claude/settings.local.json` or `~/.claude/settings.json` sets `sandbox.enabled: false`, `allowUnsandboxedCommands: true`, `failIfUnavailable: false`, or any `excludedCommands`, `allowWrite`, `allowUnixSockets` or network allow entry that is not in the rendered block.

  The exact keys come from retest R1.
- `--ci` SHALL check only the generated file.

## Plan

### Settled points

| Topic | Settlement |
| --- | --- |
| Sandbox vs Wardens | The sandbox enforces no policy rule. Every Warden stays. `sandbox-guard` only keeps the sandbox on and proven. |
| Where hooks run | Outside the sandbox (spike probe). The bundle and logs keep working, and a hook can never probe the sandbox. That is why the canary is a Bash command. |
| Canary forgery | The nonce is unpredictable and issued by the hook. A pass needs the exact command form and output, seen by `PostToolUse`. An agent that fakes the output (an `echo` or an alias) still fails the exact-command check. A shell function named `wardens` is a residual risk: the sandboxed shell inherits no rc files for `-c`. Sentinel to confirm. |
| `.git` carve-out | The shared `.git` stays writable from a worktree; spike probes 10–11 moved local `main`. Backstops are the `main` ruleset (ring 3) and `doctor`'s worktree checks. Retest R3 decides whether `denyWrite` on `refs/heads/main` closes it. |
| Network list | Charter-owned and minimal: `github.com`, `api.github.com`, `objects.githubusercontent.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, plus Anthropic API hosts if the tool needs them. Anything else needs a Charter PR. |
| Toolchain caches | Proposed `extra_write`: the pnpm store (`pnpm store path`), `~/.cache/uv`, `~/Library/Caches/pnpm` and `~/.local/state/pnpm`. R2 confirms the minimal set. |
| OVERSEER profile | A settings file passed at launch (`claude --settings <overseer.settings_path>`). Sandbox settings are per project, not per role, and `doctor` cannot see a running session. The canary prints which profile it found; the profile adds a check that the worktree is read-only. |
| Canary outside task worktrees | `worktree-guard` runs first. The Charter therefore adds the exact form `wardens sandbox canary *` to `worktree.primary_read_only_commands`, or else OVERSEER could never pass the gate. |
| Cursor | No `sandbox-guard`, no rendered `sandbox.json`. Revisit after the Cursor retest. |

### Retest before `ready` (Krzysztof runs it, with the #66 kit extended)

- **R1 (blocks `ready`).** Enable the sandbox through project `.claude/settings.json`, then try to switch it off or widen it through `.claude/settings.local.json` and `~/.claude/settings.json`. Record which keys win. `doctor` checks exactly those.
- **R2 (blocks rollout).** Run `pnpm install --frozen-lockfile`, `uv sync --frozen`, `pnpm check`, `git commit` with lefthook, and a `gh pr view` inside the sandbox, with the proposed `extra_write` and network list. Also writes to the Claude scratchpad and memory.
- **R3 (blocks rollout).** Set `denyWrite` on `<common-git-dir>/refs/heads/main` and `logs/refs/heads/main`. Re-run spike probes 10 and 11, then commit on a task branch.
- **R4 (blocks rollout).** With `allowUnsandboxedCommands: false`, the model retries a denied write with `dangerouslyDisableSandbox`. The write must stay denied.
- **R5 (separate).** Linux (bubblewrap), before any headless or CI agent relies on it.

### Engine and CLI changes

- `charter.ts` and `schema/charter.schema.json` get the optional `sandbox:` section.
- `sync/render.ts` renders the `sandbox` block and the OVERSEER profile, and fails on inexpressible globs.
- A new rule `sandbox-guard` in `rules.ts`, with session state for the nonce and the verdict. The state lives where the other session state lives (`log.ts`/`lifecycle.ts`).
- A new subcommand `wardens sandbox canary <nonce>`.
- `doctor.ts` gets the `sandbox` check.

### Rollout (Krzysztof)

1. Run R1–R4, then accept ADR-0015 and set this spec to `ready`.
2. Merge Tasks 2–3, add the `sandbox:` values to The Charter, rebuild the bundle and run `wardens sync`.
3. Merge Task 4 (`sandbox-guard`). From then on, every Claude Code session starts with the canary.
4. Launch OVERSEER with the profile from Task 3.

## Tasks

Each task becomes its own issue, linked to #69.

1. **This spec and ADR-0015.** Krzysztof decides. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`.
2. **Charter `sandbox:` schema** (accepts the section; no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
3. **Render** the `sandbox` block and the OVERSEER profile, with render tests. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2.
4. **`sandbox-guard` and `wardens sandbox canary`**, with DENIED/ALLOWED tables, including forged canary forms. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2.
5. **`doctor` `sandbox` check.** `risk:high`. **Allowed paths:** `wardens/**`. Depends on 3 and R1.

## Decisions (Krzysztof)

1. **Accept ADR-0015** after R1–R4, or reject it and keep ring 0 alone.
2. **Canary gate:**
   - Option A: hard, every session blocks Bash until the canary passes (proposed).
   - Option B: soft, warn only.
3. **The `.git` carve-out:** if R3 fails, accept it with the ring-3 backstop, or wait for the Dev Container.
4. **Network list:** confirm the initial hosts.
