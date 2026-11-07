---
status: draft
issue: 69
adrs: ["0003", "0004", "0012", "0013", "0015"]
---

# Wardens sandbox: the Claude Code OS sandbox, generated and checked

## Goal and context

[ADR-0015](../decisions/0015-claude-code-sandbox-beneath-ring-0.md) (proposed) makes the Claude Code sandbox a kernel-level floor beneath ring 0. The tests behind it are in spike [#66](https://github.com/LUNARITYai/lunarhunt/issues/66), in the final report's probe table, P01–P24.

This spec defines how The Charter describes the sandbox, how `wardens sync` renders it, what ring 0 and `doctor` add, and the OVERSEER profile. Issue: [#69](https://github.com/LUNARITYai/lunarhunt/issues/69). Labels U1–U10 refer to the ultrareview findings on PR #70.

**What the sandbox covers:** Bash commands and their child processes, for filesystem writes, filesystem reads (only where `denyRead` applies) and network egress.

**What it does not cover:**
- the Read, Edit and Write tools, WebFetch, WebSearch, MCP servers and hooks;
- network intent towards an allowlisted host;
- the shared `.git` of a linked worktree.

Ring 0 stays responsible for all of these (see "Known gaps").

**Already on `main`, and built on here:**
- The launcher trust anchor `~/.config/panopticon/primaries` and a hook launcher that never consults git or repository data (sync spec `2026-11-04-wardens-sync.md`, "Bundle location"; GHSA-6phq-wv5j-xq2f, merged as 46b6792).
- Hook runs load The Charter from the trusted primary, the checkout the running bundle sits in, confirmed against that anchor (`bundlePrimary` in `wardens/src/trusted.ts`, #74). Every home lookup goes through `trustedHome` (`wardens/src/home.ts`).
- Ring 0 denies Edit, Write and parsed shell writes to git metadata and to the anchor directory (`protected-paths`, "the Wardens launcher configuration is not editable by agents"). It also applies the protected-path and generated-file rules to every write target it can parse from a shell command, `key=path` values included (#76).
- Subshells, groups and compound commands are denied on the deny side (#63, shipped in #71).

This spec adds no second anchor (see "Launcher and anchor").

**Out of scope:**
- the Cursor sandbox (ring 0 only until it is tested, see #68 and the #66 retest);
- the Dev Container Cell (ADR-0012, phase 2);
- the network-side OVERSEER CLI ([#64](https://github.com/LUNARITYai/lunarhunt/issues/64)).

**Gating:**
- `status: ready` needs R1, R6 and R7, because their answers change this design.
- Rollout needs R2–R4 and Decision 8.
- ADR-0015 is accepted together with `ready`.

## Acceptance criteria (EARS)

### Charter `sandbox:` section

- THE Charter schema SHALL accept an optional top-level `sandbox:` section, strict, with these keys:
  - `enabled` (bool) and `required` (bool, default false);
  - `filesystem.extra_write`, for sandbox-only toolchain caches (`~/` paths);
  - `filesystem.deny_read`, for credential locations outside the repository;
  - `network.allow`, for host names; a `*.` prefix is allowed;
  - `overseer.settings_path`, the repository-relative path of the generated OVERSEER profile, under `.claude/`.
- WHEN the section is absent or `enabled` is false, THE SYSTEM SHALL render no `sandbox` block. `doctor` SHALL then report `sandbox: off`: as a failure when `required` is true, otherwise as a warning.
- IF `network.allow` contains any of the following, THEN Charter validation SHALL fail:
  - `*`, an IP literal or a TLD wildcard (`*.com`);
  - a wildcard on a user-content or object-store domain (`*.githubusercontent.com`, `*.amazonaws.com`);
  - `*.github.com`, because `github.com` already covers that sink;
  - an Anthropic or Claude host: `anthropic.com`, `claude.ai`, `claude.com`, any subdomain of them, or a wildcard that covers them. The tool calls the API from outside the sandbox. An allowlisted API inside it would let a nested, unguarded `claude` session run under the sandbox and bypass ring 0 for Edit and Write.
- IF a `filesystem.extra_write` entry is not `~/.cache/panopticon-sandbox/` or a path below it, or contains a `..` segment, THEN Charter validation SHALL fail. This is an allowlist; it replaces the earlier list of forbidden locations.
  - The validation tests SHALL keep a rejected row for each location that would let sandboxed Bash change what runs unsandboxed later: `~` and every parent of `~`, `~/.local/bin`, shell rc files, `~/.claude/`, `~/.claude.json`, `~/.gitconfig`, `~/.config/git/`, `~/.config` itself, the launcher anchor directory `~/.config/panopticon/`, the canary state directory `~/.local/state/panopticon/` and any part of the repository.
- `doctor` SHALL check at runtime, because these depend on the machine, that every `extra_write` entry, resolved physically, still lies under the physical `~/.cache/panopticon-sandbox/` (a symlinked cache root or entry would not), and that no entry covers a `PATH` directory or `PNPM_HOME`.
- IF `filesystem.deny_read` lacks any entry of the minimum default set (Settled points, "Credential reads") while `enabled` is true, THEN Charter validation SHALL fail. Decision 8 may change that set; the minimum and R2 change together.

### Rendering (`wardens sync`)

- WHERE `sandbox.enabled` is true, THE generated `.claude/settings.json` SHALL contain a `sandbox` block with:
  - `enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false`;
  - no `excludedCommands` and no `allowUnixSockets`;
  - no weaker-isolation, local-binding or proxy-port key.
- `autoAllowBashIfSandboxed: false` keeps today's approval prompts: a sandboxed command outside `commands.allow` still asks, or is denied in headless runs. The only exception is the issued canary command, which `sandbox-guard` lets through with an explicit hook `allow` (Ring 0 below).
- THE block's `filesystem.allowWrite` SHALL be exactly the Charter `filesystem.extra_write`, plus the session's own scratchpad location (see R2).
  - It SHALL NOT include the memory glob from `paths.external.write`. Memory stays writable through the Write tool, which ring 0 guards, and not through the shell.
  - The cwd worktree and `$TMPDIR` are writable by default and are not listed.
- THE generated settings' `env` SHALL point the toolchains at the sandbox-only caches from `extra_write` (`UV_CACHE_DIR`, `npm_config_store_dir`), never at the human's own caches.
- THE block's `filesystem.denyRead` SHALL contain:
  - every Charter `paths.secrets_deny_read` glob **at any depth under the primary checkout** (for example `<primary>/**/.env`). That one rendering covers the primary, the cwd worktree and every sibling task worktree under `<primary>/.claude/worktrees/` (U10);
  - the same globs under the cwd worktree, for a worktree that does not lie under the primary;
  - `filesystem.deny_read`;
  - WHERE R1 shows that `.env.*` cannot be rendered as a glob, the fixed `.env` variants (as the permission rules use them) plus the canary decoy pattern `.env.canary-*`, so that the decoy is covered by construction.
- THE block's `filesystem.denyWrite` SHALL contain:
  - the worktree's `panopticon.charter.yaml`, `.panopticon/**` and `.claude/**`;
  - the worktree's git pointer file `.git`;
  - the launcher anchor directory `~/.config/panopticon/` and the canary state directory `~/.local/state/panopticon/`;
  - the primary's `wardens/dist/` (it matters for a session whose cwd is the primary; R6 decides whether `denyWrite` can override the cwd write there);
  - if R3 succeeds, the protected-branch ref set from R3.

  This is defence in depth. Ring 0 already denies the shell writes to these paths that it can parse (#74, #76); `denyWrite` covers every other spelling. The controls that must hold are the launcher anchor and the canary binding below.
- THE block's network allowlist SHALL be exactly `sandbox.network.allow`.
- IF a Charter glob or path cannot be expressed in the sandbox path syntax (R1), THEN `wardens sync` SHALL fail and name it. It SHALL NOT silently widen or drop it.
- WHERE `sandbox.overseer.settings_path` is set, `wardens sync` SHALL also render that file:
  - the same `sandbox` block plus `filesystem.denyWrite` on the repository working tree, with the git common dir left writable for `git fetch`, if R6 shows that this is expressible;
  - IF R6 shows that it is not expressible, THEN the profile SHALL NOT be rendered, and the spec returns to `draft`.
- This amends the sync spec (`2026-11-04-wardens-sync.md`), which says sync writes exactly three files. The profile is a fourth generated file, covered by `sync --check` and `charter-drift`. It sits under `.claude/`, so it inherits that path's protection.

### Launcher and anchor

- THE rendered hook commands SHALL keep the shipped launcher unchanged (sync spec, "Bundle location"). It never consults git or repository data. It runs `<primary>/wardens/dist/wardens.mjs` only for a session directory that equals a primary listed in `~/.config/panopticon/primaries`, or lies under that primary's `.claude/worktrees/`. Otherwise it fails closed with the `launcher` message. The render tests of the sync spec pin it; Task 3 keeps them byte-equal.
- THE anchor SHALL stay the single trust anchor: a list of primary checkouts, written only by `wardens sync`, a human step. This spec SHALL NOT add a second anchor file or a bundle content hash (U7, U9).
  - Why no hash: a hash protects against a writer who can change `<primary>/wardens/dist/` but not `~/.config/panopticon/`. In this design those two sets are the same. Sandboxed Bash can write neither: P02, P04, the OVERSEER profile and the `denyWrite` entries above. The Edit and Write tools can write neither (ring 0). Code that runs unsandboxed can write both: the DoD hook (Decision 7) and human git hooks. A hash would close no attack, and every rebuild path would have to refresh it.
  - One case depends on retests and decisions: a primary-cwd session launched without the OVERSEER profile. If R6 shows that the `<primary>/wardens/dist/` `denyWrite` cannot override the cwd write, its Bash can write the bundle. Under the hard gate (Decision 2 option A) it never passes the canary, so it runs no such command. Under a soft gate (option B) only `worktree-guard`'s parser stops it, and this spec is revised to add a hash, with the refresh requirement below.
  - So no rebuild path touches the anchor. The `post-merge` and `post-rewrite` rebuilds and a manual `pnpm --filter wardens build` stay as in the sync spec. The stale-bundle and missing-bundle messages keep `Run pnpm --filter wardens build in the primary checkout.`, which stays correct.
  - IF a later revision adds a bundle hash, THEN every one of these rebuild paths SHALL refresh it, and the messages SHALL name the refresh step.
- The canary state directory `~/.local/state/panopticon/` holds no trust anchor, only nonces and verdicts (Canary state, below).
- Every consumer that resolves the primary checkout SHALL take it from the anchor, never from git metadata:
  - shipped: the launcher (the anchor itself); hook-run policy, that is The Charter and every rule that reads it (`bundlePrimary`, #74); `wardens worktree` and the `doctor` worktree checks (`structuralPrimary`, from the file system, #74);
  - new: `sandbox-guard` and the canary SHALL use `bundlePrimary` and SHALL fail closed when it returns null;
  - changed: `classifyCwd` SHALL classify the cwd relative to that primary. It is `primary` when the cwd's physical path equals the primary, `linked` when it lies under `<primary>/.claude/worktrees/<name>` (or, for Cursor, under the `~/.cursor/worktrees/` directory the launcher accepts), and null (fail closed) otherwise. `worktree-guard` is its only caller today and gets the same classification. Today it compares `--git-dir` with `--git-common-dir`, which a worktree agent can influence. Git metadata may still be read for the branch name.
- Ring 0 tables SHALL show that Edit, Write and parsed shell writes on the anchor directory, the state directory, the worktree's `.git` and the git metadata are DENIED. These tools run outside the sandbox. The rows for the anchor directory and the git metadata exist (#74, #76). The state directory is new: the built-in launcher-configuration deny in `gitMetadataDeny` SHALL extend to `~/.local/state/panopticon/`.

### Ring 0: `sandbox-guard`

- WHEN a Bash tool call has `tool_input.dangerouslyDisableSandbox` set to true, THE SYSTEM SHALL deny it with `Blocked by Warden sandbox-guard: commands run only inside the sandbox. Retry without dangerouslyDisableSandbox.`
- `sandbox-guard` SHALL read `sandbox.enabled` and `sandbox.required` from the Charter that the hook run already loads from the trusted primary (#74), never from the worktree's.
- WHILE `sandbox.enabled` is true and the session has no valid canary pass, THE SYSTEM SHALL deny every Bash command except the exact canary command it issued. The message is `Blocked by Warden sandbox-guard: prove the sandbox first. Run exactly: <command>.`
  - `<command>` is `<node> <bundle> sandbox canary <nonce>`. `<node>` is the absolute path of the Node binary running the hook (`process.execPath`), and `<bundle>` is the absolute primary bundle path. No `PATH` lookup decides what runs.
- WHEN a `PreToolUse` Bash command is string-equal to the command issued for an outstanding nonce, and no other rule denies or asks, `sandbox-guard` SHALL return an explicit `allow` (`hookSpecificOutput.permissionDecision: "allow"`) (U2).
  - This is the only explicit allow that ring 0 emits; every other allow stays silent, as today.
  - Why: the canary is not in `permissions.allow`, and `autoAllowBashIfSandboxed` is false. Without the hook allow, the canary would prompt in interactive sessions and be denied in `-p`, headless and subagent runs. No `PostToolUse` would follow, so no pass could ever be recorded, and the hard gate would remove Bash for good.
  - R4 confirms that a hook `allow` skips the prompt in `-p` and in subagents. IF it does not, THEN the fallback is a `permissions.allow` rule `Bash(<node> <bundle> sandbox canary *)` in the per-machine settings file (R1). Its prefix is machine-specific, so it cannot go into the committed settings. Decision 2 is then revisited before rollout.
- Nonces:
  - a nonce SHALL be random (at least 128 bits, lowercase hex, so it is safe in file names and in the command), single-use, valid for 10 minutes and bound to `session_id`;
  - several outstanding nonces SHALL be allowed (a set), so that parallel Bash calls do not race;
  - a stale or unknown nonce SHALL get a fresh issue, not a pass.
- Probe fixtures (U1, U4). WHEN the hook issues a nonce, it SHALL first create, outside the sandbox, every fixture the canary needs, each named by that nonce:
  - the probe directories `~/.local/state/panopticon/canary/<nonce>/` and `<primary>/.panopticon/canary/<nonce>/`, mode 0700;
  - the decoys `<cwd>/.env.canary-<nonce>` and `<primary>/.claude/worktrees/.canary-<nonce>/.env`. The second stands for a sibling task worktree (U10). The leading dot keeps it apart from task worktree names (`<issue>-<slug>`);
  - for the `.panopticon/` `denyWrite` class, the file `<cwd>/.panopticon/canary-<nonce>`. The other `denyWrite` classes probe the real files: the worktree Charter, `.claude/settings.json` and the `.git` pointer.

  IF any fixture cannot be created, THEN the hook SHALL NOT issue the nonce. It SHALL deny with `Blocked by Warden sandbox-guard: the canary fixtures could not be created. Run wardens doctor.` The hook SHALL remove a nonce's fixtures when it consumes or expires the nonce. Names never repeat, so parallel canaries never touch each other's fixtures.
- WHEN the canary runs, THE SYSTEM SHALL check the boundary that fits the session's cwd class (`classifyCwd`).
  - **Linked worktree on a task branch:**
    - creating `<cwd>/.canary-<nonce>` with `O_CREAT|O_EXCL` succeeds (positive control);
    - creating a file in `<primary>/.panopticon/canary/<nonce>/` fails;
    - creating a file in `~/.local/state/panopticon/canary/<nonce>/` fails. This replaces the earlier `~/.panopticon-canary/`, which nothing created (U1), and also proves that the canary state is out of the shell's reach;
    - reading each decoy fails;
    - for each `denyWrite` class, opening the existing file with `O_WRONLY|O_APPEND` fails, and nothing is written;
    - a direct connection to a non-allowlisted host fails.
  - **Primary checkout or detached `HEAD`** (OVERSEER): the same checks, except that creating a file in the cwd SHALL fail, which needs the OVERSEER profile. The positive control is creating `$TMPDIR/panopticon-canary-<nonce>`. The failure message SHALL name the missing profile.
  - Each probe has one of three outcomes:
    - a negative probe **passes** only with the platform's sandbox errno (EPERM on macOS; R5 gives the Linux values);
    - it is **enforcement-negative** when a negative probe succeeds, or when the positive control fails with the sandbox errno;
    - every other outcome is a **harness error**: ENOENT or EEXIST on a fixture, EROFS, EACCES, any other errno, or a timeout. A harness error is never a pass and never enforcement-negative (U4).
  - The canary SHALL delete every probe file it created.
  - The canary SHALL print exactly one result line:
    - `sandbox: enforced <nonce> <cwd-class>`, only when every check passes;
    - `sandbox: NOT enforced <nonce> <check>` on the first enforcement-negative check;
    - `sandbox: canary-error <nonce> <check> <code>` on a harness error.
- WHEN a `PostToolUse` Bash event has a `tool_input.command` that is **string-equal** to the command issued for an outstanding nonce, and its output contains the line `sandbox: enforced <nonce> <cwd-class>` for the session's actual cwd class, THE SYSTEM SHALL record a pass and consume the nonce.
  - The match is string equality, never tokenizer argv equality.
  - The pass SHALL be bound to a hash of the effective sandbox settings: the rendered block of the settings files in force, and the OVERSEER profile if used. WHEN that hash changes, THE SYSTEM SHALL drop the pass and require a new canary.
- WHEN the canary output carries `sandbox: NOT enforced <nonce> <check>`, THE SYSTEM SHALL record a failure. Every later Bash command SHALL then be denied with `Blocked by Warden sandbox-guard: the sandbox is not enforced in this session. Ask Krzysztof (needs:human).`
- WHEN the canary output carries `sandbox: canary-error`, or the canary errors or times out without any result line, THE SYSTEM SHALL issue one fresh nonce, with fresh fixtures, for a retry. A second such result in the same session SHALL count as a failure. Its message is `Blocked by Warden sandbox-guard: the sandbox canary could not run. Run wardens doctor, then ask Krzysztof (needs:human).`
- Canary state:
  - THE SYSTEM SHALL keep nonces and verdicts outside every sandbox-writable location, in `~/.local/state/panopticon/sessions/<session_id>.json` (directory mode 0700);
  - `session_id` SHALL be validated as a UUID before it is used in a path;
  - `doctor` SHALL remove state files older than 7 days and canary fixtures older than 1 day;
  - Edit, Write and parsed shell writes to this directory SHALL be denied by ring 0 (Launcher and anchor, above);
  - hooks can write there, but sandboxed Bash cannot (P04, and the canary's own state-directory probe);
  - the `extra_write` allowlist cannot cover it;
  - a test SHALL assert that a sandboxed Bash write to the state file fails (part of R2).
- WHEN a `SessionStart` event arrives with any source (`startup`, `resume`, `clear`, `compact`), THE SYSTEM SHALL drop the session's pass. Settings can differ after a relaunch.
- `worktree-guard` SHALL allow the issued canary command as a built-in exception, matched by whole-string equality of `tool_input.command`. It SHALL NOT use a Charter glob, and `primary_read_only_commands` does not grow. The canary command SHALL also pass `command-guard` and `scope-guard`, with a table row for each.
- `sandbox-guard` gives an independent verdict, and deny wins (`engine.ts` ranks verdicts; rule order has no effect).
- `sandbox-guard` SHALL apply only when the hook's real tool identity is Claude Code. Cursor can load `.claude/settings.json` hooks, and there the canary cannot pass. The identity SHALL come from the payload's shape, because Cursor payloads carry Cursor-only fields. The `--tool` argument alone does not count, since a Cursor session that loads Claude hooks still passes `--tool claude`. The identity is carried through `event.ts` normalization.

### Sandboxed toolchains: task config and credentials

- THE worktree's `.env` SHALL stay in `denyRead`, because it is a Charter secret path. Sandboxed tests and dev servers therefore cannot read it (U5).
- WHEN `wardens worktree new` or `setup` writes a task's `.env`, THE SYSTEM SHALL also write `.panopticon/task.env`. It holds the same non-secret values and nothing else: `TASK_ISSUE`, `WEB_PORT`, `API_PORT`, and `DATABASE_URL` when `resources.database` is set. Like `.env`, it never takes a value from the primary's `.env`. It is readable inside the sandbox, because it is not a secret path, and not writable, because `.panopticon/**` is in `denyWrite`.
- WHEN a Claude Code `SessionStart` event arrives in a worktree that has `.panopticon/task.env`, THE SYSTEM SHALL append its values to the file named by `CLAUDE_ENV_FILE` as shell-quoted `export` lines. Only the keys listed above are exported. Sandboxed Bash commands then get the task config from the environment. IF R2 shows that `CLAUDE_ENV_FILE` does not reach sandboxed or subagent Bash, THEN the package scripts load `.panopticon/task.env` explicitly instead.
- Toolchains and app config SHALL take task values from the environment, and SHALL treat an unreadable `.env` like a missing one. R2 records how each loader behaves on EPERM: pydantic-settings, python-dotenv, Next.js `@next/env`, Vitest and pytest. A loader that fails is a follow-up issue under `apps/**`, outside this spec's tasks.
- A secret that a test needs is not available inside the sandbox, by design.
- GitHub credentials (U6): the minimum `deny_read` removes the default `gh` and git HTTPS credential stores (`~/.config/gh`, `~/Library/Keychains`), so sandboxed `gh pr create` and `git push` lose their credential. Decision 8 chooses the mechanism. Whichever option it picks, THE minimum `deny_read` and R2 SHALL agree with it in the same revision.
- SSH remotes do not work inside the sandbox under any option: `~/.ssh` is denied, and the agent socket would need `allowUnixSockets`. Task worktrees push over HTTPS.

### `doctor`

- THE `doctor` SHALL add a `sandbox` check that fails when, with `sandbox.enabled` true:
  - the generated `.claude/settings.json` or the OVERSEER profile lacks the rendered block, or differs from it;
  - `.claude/settings.local.json` or `~/.claude/settings.json` contains any `sandbox.*` key outside the allowed set (allowlist, not denylist). The allowed set is the rendered keys with the rendered values; R1 decides whether those files can override them at all.
- THE `doctor` `launcher-anchor` check SHALL keep its shipped checks (sync spec). With `sandbox.enabled` true, it SHALL also fail in these cases (U9):
  - an `extra_write` entry or a rendered `allowWrite` path, resolved physically, covers `~/.config/panopticon/` or `~/.local/state/panopticon/`;
  - the state directory is not mode 0700, or is not owned by the current user.
- THE `doctor` SHALL add a `protected-refs` check that fails when a local `worktree.protected_branches` ref is neither equal to its `origin/` counterpart nor an ancestor of it.
  - This is the only detector for a locally moved `main` (P10, P11). The `main` ruleset only stops such a ref from reaching origin.
- THE `doctor` `worktrees` check SHALL warn on a task worktree whose generated `.claude/settings.json` differs from the primary's. A worktree on an old branch would otherwise run with old settings. It SHALL treat a `.claude/worktrees/.canary-<nonce>/` directory as a canary fixture, not as a worktree.
- THE `doctor` `coverage` check SHALL keep both directions: the Bash `PostToolUse` matcher and its mapping row ship in the same task (Task 4a, U3).
- `--ci` SHALL check only the generated files.

## Plan

### Settled points

| Topic | Settlement |
| --- | --- |
| Sandbox vs Wardens | The sandbox enforces no policy rule. Every Warden stays. `sandbox-guard` only keeps the sandbox on and proven. Ring 0 keeps parsing shell writes for its own rules (#71, #76); the sandbox catches the spellings the parser misses. |
| Where hooks run | Outside the sandbox (#66 hook probe). The bundle and logs keep working, and a hook can never probe the sandbox, which is why the canary is a Bash command. Because hooks run with the user's privileges, the launcher trusts only the human-written anchor (shipped, GHSA-6phq). |
| Launcher and anchor | One anchor, `~/.config/panopticon/primaries` (shipped). No bundle hash: it would close no attack and would need a refresh on every rebuild path (see Launcher and anchor). The canary state directory is not an anchor. |
| Canary trust | Every anchor sits outside the agent's reach: <br>- the state file in `~` (not writable by the shell, and probed by the canary); <br>- the gate read from the Charter that hooks load from the trusted primary (#74); <br>- the canary pinned to the absolute Node and primary bundle paths, with string equality; <br>- single-use nonces with per-nonce fixtures; <br>- a reset on every `SessionStart`. <br>The nonce gives replay resistance only. Unforgeability comes from `PostToolUse` seeing the real command and its real output. |
| Canary permission | The canary is let through by `sandbox-guard`'s explicit hook `allow`, not by `permissions.allow` and not by `autoAllowBashIfSandboxed`. R4 confirms that this works in `-p` and subagents. |
| `.git` carve-out | The shared `.git` is writable from a worktree (P10, P11 moved local `main`). The ruleset stops that ref from reaching origin, and `doctor protected-refs` detects it locally. R3 decides whether `denyWrite` closes it. |
| Network list | Charter-owned and minimal: `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. No Anthropic hosts. Anything else needs a Charter PR. |
| Credential reads | Proposed `deny_read`: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.claude.json`, `~/.claude/.credentials*`, `~/Library/Keychains`, browser profile dirs. Env tokens are a known gap. Decision 8 decides how `gh` and git authenticate with these denied. |
| Secret reads across worktrees | The secret globs are rendered at any depth under the primary, so a worktree cannot read a sibling's `.env` (U10). |
| Task config | Non-secret task values come from `.panopticon/task.env`, exported through `CLAUDE_ENV_FILE` at `SessionStart`. The worktree's `.env` stays unreadable to the shell (U5). |
| Toolchain caches | `extra_write` may name only paths under `~/.cache/panopticon-sandbox/` (for example `{uv,pnpm}`), set through the rendered `env`. A poisoned cache cannot reach the human's own tools. `lefthook install` writes `.git/hooks`, so it is expected to fail inside the sandbox: run it at setup time (a hook or a human), never by widening `allowWrite`. |
| `$TMPDIR` | On macOS it is the per-user temp dir, shared with all of the user's apps. It is writable by default and stays a staging area. Documented as a known gap. |
| OVERSEER profile | A settings file passed at launch: `claude --settings .claude/overseer.settings.json`. Sandbox settings are per project, not per role. The canary detects a missing profile, because a cwd-class mismatch fails the canary. |
| Read-only roles | Reviewer, Sentinel and debugger use the implementer floor and rely on instructions for read-only behaviour. Per-role profiles are a follow-up. |
| Cursor | No `sandbox-guard`, no rendered `sandbox.json`. Revisit after the Cursor retest. |

### Known gaps (not closed by this spec)

- **WebFetch, WebSearch and MCP servers** run outside the sandbox. The network allowlist does not apply to them, and ring 0 has no MCP rule. Follow-up: a Charter per-role MCP and WebFetch policy.
- **Allowlisted hosts are sinks.** With a GitHub token, data can leave through github.com (gists, comments, pushes). Decision 8 sets which token that is. Follow-up: a GitHub App per role (phase 2, C-27).
- **Environment tokens** are inherited by sandboxed commands. Decision 8 option A puts a GitHub token there on purpose.
- **`--setting-sources` without the project source** drops the sandbox and the hooks together. No hook can see this, and only the Ledger's "sessions without hook events" signal (ADR-0004) can.
- **`$TMPDIR`** is shared across the user's apps (above).
- **`definition-of-done` runs worktree code outside the sandbox.** The Stop hook runs `pnpm check` (`dod.ts`), so agent-written scripts, tests, configs and the shared caches execute with the user's privileges, with no human step. Such code can also write the anchor and the primary's bundle. Decision 7 picks between closing this in Task 4c and accepting it.
- **The sandbox-only caches are shared across tasks.** Task A can poison the cache task B uses. Accepted for phase 0; a cache per task is a follow-up.

### Retest (Krzysztof runs it, with the #66 kit extended)

- **R1 (blocks `ready`).** Settings precedence and path syntax:
  - enable the sandbox through project `.claude/settings.json`, then try to switch it off or widen it through `.claude/settings.local.json`, `~/.claude/settings.json` and `--settings`;
  - record which keys win;
  - test the path semantics of `allowWrite`, `denyRead` and `denyWrite` (`/`, `~/`, `./`, `**`, globs), so that paths outside the cwd can be expressed portably;
  - check whether `.env.*` works as a `denyRead` glob, and whether `<primary>/**/.env` denies a sibling task worktree's `.env` read from another task worktree (U10);
  - check whether settings `env` values expand `~/` or stay literal;
  - IF a portable form does not exist, THEN machine-specific paths go to a per-machine file rendered at setup time, and this spec is revised.
- **R2 (blocks rollout).** Toolchain inside the sandbox, on the real layout (task worktrees nested at `.claude/worktrees/<name>`):
  - `pnpm install --frozen-lockfile`, `uv sync --frozen`, `pnpm check`, `git commit` with lefthook, and `gh pr view`;
  - `gh pr create` and an HTTPS `git push` on a task branch, with the credential mechanism Decision 8 chose. Under option A, also check that the token cannot merge a PR or push to `main`. Check whether Keychain-backed credentials work inside the sandbox at all;
  - task config (U5): with the worktree's `.env` unreadable, a test and a dev server get their ports and database from the environment exported through `CLAUDE_ENV_FILE`. Check that those exports reach sandboxed and subagent Bash, and record how each loader treats EPERM on `.env`;
  - Postgres on localhost;
  - writes to the session scratchpad. Check whether Claude Code exposes the session's own temp path. If it does not, the shell gets no scratchpad `allowWrite` at all (the Write tool still has it), never the all-sessions glob;
  - a sandboxed write to `~/.local/state/panopticon/` fails.
- **R3 (blocks rollout).** `denyWrite` on the protected-branch ref set:
  - the set: `<common>/refs/heads/<branch>`, `logs/refs/heads/<branch>`, `refs/remotes/origin/<branch>`, `packed-refs`, the primary `HEAD` and `index`, `worktrees/*/HEAD`, and their `*.lock` siblings;
  - re-run P10 and P11, then commit, fetch and push on a task branch.
- **R4 (blocks rollout).**
  - With `allowUnsandboxedCommands: false`, the model retries a denied write with `dangerouslyDisableSandbox`, and the write must stay denied.
  - With `autoAllowBashIfSandboxed: false`, a command outside `commands.allow` still prompts, or is denied in `-p`.
  - A `PreToolUse` hook that returns `permissionDecision: "allow"` for one exact command skips the prompt in an interactive session, in `-p` and in a subagent (U2). A throwaway hook in the #66 kit is enough, so this item does not wait for Task 4a.
  - Check that `-p` honours `failIfUnavailable`, that subagent Bash calls run under the same settings, and whether subagent hook payloads carry the parent's `session_id`.
- **R5 (separate).** Linux (bubblewrap), including its errno values, before any headless or CI agent relies on it.
- **R6 (blocks `ready`).** Profile and pointer protection:
  - Can `denyWrite` on the repository override the default cwd write? The same question decides the `<primary>/wardens/dist/` entry for a primary-cwd session.
  - Can the common git dir stay writable inside a denied tree?
  - Does `git fetch` still work, and what does `claude --worktree` do under the profile?
  - Is the worktree's `.git` pointer file write-protected by the sandbox by default, against in-place writes and against replacement (rename, unlink and recreate)? The same question applies to every other git input that a consumer still reads (the branch name for `classifyCwd`).
  - Is the worktree's `.claude/settings.json` write-protected?

  The shipped anchor-based launcher holds whatever R6 shows. R6 decides only the defence-in-depth `denyWrite` entries.
- **R7 (blocks `ready`).** Record a real `PostToolUse` Bash payload, including `tool_response`, and the violation text the sandbox appends to the output.

### Engine and CLI changes

- `charter.ts` and `schema/charter.schema.json`: the `sandbox:` section and its validation rules, including the `extra_write` allowlist.
- `sync/render.ts`: the `sandbox` block, the generated `env` cache entries and the OVERSEER profile. The launcher stays unchanged. The `PostToolUse` matcher is **not** extended here (U3). `SessionStart` is already rendered.
- `sync/render.ts` and `mapping.ts`, together with `event.ts` (Task 4a): the `PostToolUse` matcher extended from `^(Edit|Write)$` to `^(Bash|Edit|Write)$`, a `MAPPING_ROWS` row for it, and a `mapLifecycle` branch that maps Bash `PostToolUse` (`tool_input.command`, `tool_response`). They ship in one PR. A matcher without the mapping makes `mapLifecycle` return NOT_MAPPED, which the engine turns into a block after every Bash call. Normalization also carries `dangerouslyDisableSandbox` and the real tool identity. Use a recorded fixture from R7.
- `render.ts` (hook output): an explicit `permissionDecision: "allow"` for the one canary verdict.
- `rules.ts`: the `sandbox-guard` rule and the built-in canary exception in `worktree-guard`.
- `guards.ts`: the built-in launcher-configuration deny extended to `~/.local/state/panopticon/`.
- `git.ts`: `classifyCwd` relative to the trusted primary.
- New `sandbox/` module: the state store in `~/.local/state/panopticon/`, the per-nonce fixtures, and the `wardens sandbox canary <nonce>` subcommand.
- `worktree/`: `.panopticon/task.env` next to `.env`; the `SessionStart` export through `CLAUDE_ENV_FILE`.
- `doctor.ts`: the `sandbox` and `protected-refs` checks, the `launcher-anchor` additions, fixture and state cleanup, and the settings-drift warning in `worktrees`.

### Rollout (Krzysztof)

1. Run R1, R6 and R7, then revise this spec, set it to `ready` and accept ADR-0015. Run the R4 hook-allow item with the #66 kit, then take Decisions 2 and 8.
2. Merge Tasks 2–3, add the `sandbox:` values to The Charter, rebuild the bundle and run `wardens sync`. The Bash `PostToolUse` matcher is not rendered yet, so no unmapped event reaches the engine (U3). Run R2–R4 with the generated files.
3. Merge Tasks 4a, 4b and 6. Task 4a brings the matcher and its mapping together. From then on, every Claude Code session starts with the canary.
4. Launch OVERSEER with `--settings .claude/overseer.settings.json`.
5. Set `sandbox.required: true`.

## Tasks

Each task becomes its own issue, linked to #69.

1. **This spec and ADR-0015.** Krzysztof decides. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`, `docs/decision-log.md`.
2. **Charter `sandbox:` schema and validation** (no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
3. **Render:** the `sandbox` block, the `env` cache entries and the OVERSEER profile, with render tests. The launcher stays byte-equal, and the `PostToolUse` matcher is not extended. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2, R1 and R6.
4. **`sandbox-guard`:**
   - **4a.** The rule, with the Bash `PostToolUse` matcher, its mapping row and its `mapLifecycle` mapping shipped together (U3). It also brings the explicit canary `allow`, the state store and fixtures, the `SessionStart` reset, `classifyCwd` relative to the trusted primary, the state-directory deny and the `worktree-guard` exception. It comes with DENIED/ALLOWED tables, including forged canary forms.
   - **4b.** The `wardens sandbox canary` subcommand and its cwd-class checks, with per-nonce fixtures and the three result lines.
   - **4c** (if Decision 7 chooses it). The DoD runs `pnpm check` under the rendered sandbox profile.

   `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2 and R7. 4a also depends on 3.
5. **`doctor`:** the `sandbox` and `protected-refs` checks, the `launcher-anchor` additions, fixture and state cleanup, and the settings-drift warning. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 3 and R1.
6. **Task config for sandboxed toolchains:** `.panopticon/task.env` in `wardens worktree new` and `setup`, and the `SessionStart` export through `CLAUDE_ENV_FILE`. `risk:high`. **Allowed paths:** `wardens/**`. Depends on R2. Loader fixes under `apps/**` that R2 finds are separate issues.

## Decisions (Krzysztof)

1. **Accept ADR-0015** after R1, R6 and R7, or reject it and keep ring 0 alone.
2. **Canary gate.** *Changed facts (U2, U4):* the canary is not in `permissions.allow` and `autoAllowBashIfSandboxed` is false, so it prompts, or is denied in `-p`, headless and subagent runs. With fixed probe names, parallel canaries could also lock a sandboxed session out. This revision adds the explicit hook `allow` and per-nonce fixtures. Option A's cost and feasibility now depend on R4.
   - Option A: hard gate. Every session blocks Bash until the canary passes, and `sandbox-guard` lets the canary through with an explicit hook `allow` (proposed, if R4 confirms the hook allow).
     - *Before:* "one extra turn per session, subagents and `-p` runs included".
     - *After:* one denied Bash call plus the canary call per session. That includes each subagent when its hook payloads carry their own `session_id` (R4).
     - It works in `-p` and subagents only if R4 shows that a hook `allow` skips the prompt there. If not, the fallback is a per-machine `permissions.allow` prefix rule (R1 file). Without either, A removes Bash for good from every `-p`, headless and subagent session, so it is not workable.
   - Option B: soft gate, warn only. Bash runs before any canary; the hook asks for the canary through `additionalContext` and logs unproven sessions to the Ledger.
     - No turn cost and no lock-out.
     - A session with the sandbox switched off is not stopped.
     - A primary-cwd session launched without the OVERSEER profile can write the primary checkout by Bash, including the bundle the launcher runs, unless R6 shows the `wardens/dist/` `denyWrite` holds. Otherwise only `worktree-guard`'s parser stands in the way, and B brings back the bundle hash and its refresh on every rebuild path (Launcher and anchor).
   - Option C (new): the hook runs the canary itself. Outside the session, it wraps the canary in the open-source sandbox runtime that Claude Code uses (`@anthropic-ai/sandbox-runtime`, `srt`), with the rendered profile.
     - No Bash turn and no permission rule, so it works in `-p`, headless and subagent runs.
     - It proves only that the rendered profile is enforceable on this machine, not that this session's Bash runs under it. Local settings, `--settings` or `--setting-sources` that switch the sandbox off would pass.
     - It adds a dependency, and its profile must match Claude Code's. The session-level proof falls back to `doctor` and the Ledger.
3. **The `.git` carve-out:** if R3 fails, accept it with the ruleset and `doctor protected-refs`, or wait for the Dev Container.
4. **Network list and `deny_read` set:** confirm the initial values. *Changed facts (U6, U10):* the minimum `deny_read` removes the default `gh` and git HTTPS credentials, which Decision 8 has to settle before R2. The secret globs are now rendered at any depth under the primary, which also denies sibling worktrees' secrets.
5. **`commands.deny` additions** (Charter, human): `gh pr merge*` and the mutating `gh api` forms. The latter overlaps with #61.
6. **B3 on `main` today: resolved.** It was handled as GHSA-6phq-wv5j-xq2f, merged as 46b6792, and #74 added the anchored primary for policy. This spec keeps that anchor and adds no hash (Launcher and anchor).
7. **DoD outside the sandbox:** close it in Task 4c (run `pnpm check` under the sandbox profile) or accept it as a known gap for phase 0. *Changed facts (U5, U7):*
   - The hook runs outside the session's sandbox, so Task 4c needs a sandbox runner of its own (`srt`, as in Decision 2 option C).
   - Inside it, `pnpm check` cannot read `.env` and takes its task config from `.panopticon/task.env` (Task 6).
   - Unsandboxed DoD code can write the anchor and the primary's bundle. That is why a bundle hash would not help, and why accepting the gap now also accepts that exposure.
8. **GitHub credentials inside the sandbox (new, U6).** With the minimum `deny_read`, sandboxed `gh` and HTTPS `git push` have no credential. SSH is out under every option.
   - Option A: a fine-grained personal access token for this repository only, exported as `GH_TOKEN` in the environment that launches the session. Its permissions are contents, pull requests and issues (read and write), with no administration, workflows or secrets. git uses `gh`'s credential helper (`gh auth setup-git`, a human setup step), which reads `GH_TOKEN`. The minimum `deny_read` stays as it is (proposed).
     - The token is in every sandboxed command's environment (the "environment tokens" gap, with a narrower token).
     - It is still Krzysztof's identity. If his ruleset bypass applies to it, it can merge and push to `main`, which R2 checks and which makes Decision 5 more important.
     - It is rotated by hand and never committed.
   - Option B: exempt the `gh` credential store. Drop `~/.config/gh` from the minimum and keep the token in `hosts.yml` (`gh auth login --insecure-storage`), since the Keychain is denied or unreachable (R2).
     - Sandboxed Bash can read Krzysztof's full token, with every scope and the bypass, and github.com is allowlisted. This removes the point of the credential deny for GitHub and conflicts with the spirit of C-18.
   - Option C: no GitHub credential inside the sandbox. `git push`, `gh pr create` and the other `gh` writes run outside it: by Krzysztof, or later through #64's fixed operations run by a hook. Reads keep working unauthenticated, because the repository is public.
     - Until #64 lands, agents cannot push or open PRs, and step 7 of the `AGENTS.md` workflow changes. R2 then checks that these commands fail cleanly instead of working.
