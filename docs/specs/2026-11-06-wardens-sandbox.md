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
- `doctor` SHALL check at runtime, because these depend on the machine:
  - that every `extra_write` entry, resolved physically, lies under the physical `~/.cache` joined with the literal `panopticon-sandbox`. Comparing with the physical `~/.cache/panopticon-sandbox` itself would pass trivially when that directory is a symlink. It SHALL also fail when `~/.cache/panopticon-sandbox` is a symlink (`lstat`) (F10);
  - that no entry covers a `PATH` directory or `PNPM_HOME`.
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
  - `filesystem.deny_read`.
- `denyRead` has no negation, so `secrets_deny_read`'s `!*.example` cannot be rendered as written (F8). THE renderer SHALL handle it the way the permission rules already do (`sync/render.ts`):
  - it drops the `!*.example` entry;
  - it replaces `.env.*` with the fixed `.env` variants (`.env.local`, `.env.development`, …) plus the canary decoy pattern `.env.canary-*`;
  - it never lists `.env.example`, which therefore stays readable (ADR-0013 D5).

  It does this even if R1 shows that `.env.*` works as a glob, because that glob would also cover `.env.example`. A `.env` variant outside the fixed list is not denied by the sandbox; only `secret-read-guard` (a parser) covers it (Known gaps). Any other negated entry in `secrets_deny_read` SHALL make `wardens sync` fail and name it.
- THE block's `filesystem.denyWrite` SHALL contain:
  - the worktree's `panopticon.charter.yaml`, `.panopticon/**` and `.claude/**`;
  - the worktree's git pointer file `.git`;
  - the launcher anchor directory `~/.config/panopticon/` and the canary state directory `~/.local/state/panopticon/`;
  - the primary's `wardens/dist/` and the primary's `panopticon.charter.yaml`. These matter for a session whose cwd is the primary, because a linked session cannot reach them anyway. R6 decides whether `denyWrite` can override the cwd write there (F12);
  - if R3 succeeds, the protected-branch ref set from R3.

  How much of this ring 0 also covers differs per class (B2):
  - **Defence in depth** for the Charter (`protected.deny`), the `.git` pointer and the git metadata, and the anchor and state directories (`gitMetadataDeny`). Ring 0 denies the shell writes to them that it can parse (#76). A parsed shell write outside the worktree, to the primary or to `~`, fails the escape check. `denyWrite` covers every other spelling.
  - **The only control** for `.panopticon/**` and `.claude/**`. Neither glob is in the Charter's `protected` lists, `gitMetadataDeny` does not cover them, and `scope-guard` ignores shell events. Ring 0 therefore does not deny a shell write to them in any spelling; only `denyWrite` does (Known gaps).

  The controls that must hold are the launcher anchor and the canary binding below.
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
  - shipped: the launcher (the anchor itself); hook-run policy, that is The Charter and every rule that reads it (`bundlePrimary`, #74); the `doctor` worktree checks (`structuralPrimary`, from the file system, #74);
  - partly shipped: `wardens worktree` takes only its Charter source from `structuralPrimary`. Its create and remove paths still use the git-derived `primaryCheckout` (`worktree/index.ts`). Those subcommands (`new`, `setup`, `remove`, `prune`) are human-only (`HUMAN_ONLY`), so no agent runs that resolution, but it is not anchored (F11);
  - new: `sandbox-guard` and the canary SHALL use `bundlePrimary` and SHALL fail closed when it returns null;
  - changed: `classifyCwd` SHALL classify the cwd relative to that primary. It is `primary` when the cwd's physical path equals the primary, `linked` when it lies under `<primary>/.claude/worktrees/<name>` (or, for Cursor, under the `~/.cursor/worktrees/` directory the launcher accepts), and null (fail closed) otherwise. `worktree-guard` is its only caller today and gets the same classification. Today it compares `--git-dir` with `--git-common-dir`, which a worktree agent can influence. Git metadata may still be read for the branch name.
- Ring 0 tables SHALL show that Edit, Write and parsed shell writes on the anchor directory, the state directory, the worktree's `.git` and the git metadata are DENIED. These tools run outside the sandbox. The rows for the anchor directory and the git metadata exist (#74, #76). The state directory is new: the built-in launcher-configuration deny in `gitMetadataDeny` SHALL extend to `~/.local/state/panopticon/`.

### Ring 0: `sandbox-guard`

- WHEN a Bash tool call has `tool_input.dangerouslyDisableSandbox` set to true, THE SYSTEM SHALL deny it with `Blocked by Warden sandbox-guard: commands run only inside the sandbox. Retry without dangerouslyDisableSandbox.`
- `sandbox-guard` SHALL read `sandbox.enabled` and `sandbox.required` from the Charter that the hook run already loads from the trusted primary (#74), never from the worktree's.
- WHILE `sandbox.enabled` is true and the session has no valid canary pass, THE SYSTEM SHALL deny every Bash command except the exact canary command it issued. The message is `Blocked by Warden sandbox-guard: prove the sandbox first. Run exactly: <command>.`
  - `<command>` is `<node> <bundle> sandbox canary <nonce>`. `<node>` is the absolute path of the Node binary running the hook (`process.execPath`), and `<bundle>` is the absolute primary bundle path. No `PATH` lookup decides what runs.
  - Quoting (F4): a path that consists only of `A–Z a–z 0–9 _ @ % + = : , . / -` is written bare. Any other path is written in single quotes. IF a path contains a single quote, a newline, a control character or bytes that are not UTF-8, THEN the hook SHALL NOT issue a nonce. It SHALL deny with `Blocked by Warden sandbox-guard: the canary command cannot be written for this Node or checkout path. Ask Krzysztof (needs:human).` The issued command is stored byte for byte, so the quoting never has to be parsed back.
- **Canary short-circuit (B1).** WHEN a Claude Code `PreToolUse` Bash command is byte-equal to the command issued for the session's outstanding nonce, THE engine SHALL evaluate `sandbox-guard` only, and SHALL skip every other rule.
  - Skipped rules: `command-guard`, `secret-read-guard`, `protected-paths` (with `gitMetadataDeny` and the expansion checks), `generated-files-guard`, `worktree-guard` and `scope-guard`.
  - Why: those rules parse argv. The canary names an absolute bundle path outside a linked worktree that matches no `paths.external` glob, so `secret-read-guard` throws "path escapes the worktree" (`guards.ts`), and `evaluateRules` turns that throw into an engine deny that beats any allow. Sentinel reproduced this from a linked worktree. The command is fully determined by the hook (absolute paths, fixed words, a hex nonce), so these rules have nothing in it to judge.
  - `sandbox-guard` still applies its `dangerouslyDisableSandbox` deny on the short-circuit path.
  - The match is byte equality on `tool_input.command`, with no trimming and no normalization: a trailing space or newline, an env prefix, `;` or any other change makes it an ordinary command for the full rule list.
  - IF the session state cannot be read, THEN there is no short-circuit, and the normal rule list (and so a deny) applies.
  - This replaces the earlier built-in `worktree-guard` exception and the `command-guard`/`scope-guard` rows.
- WHEN the short-circuit applies and `dangerouslyDisableSandbox` is not true, `sandbox-guard` SHALL return an explicit `allow` (`hookSpecificOutput.permissionDecision: "allow"`) (U2).
  - For Claude Code, this is the only explicit allow that ring 0 emits; every other Claude Code allow stays silent, as today. Cursor already emits `permission: allow` for every allow (`render.ts`), but `sandbox-guard` never applies to Cursor (F7).
  - `RANK` in `engine.ts` gets an allow level below `ask`. An explicit allow loses to deny, rewrite and ask, and it is rendered only when it is the winning verdict (F7).
  - The allow stays reusable until `PostToolUse` consumes the nonce or the nonce expires. That is harmless: it lets through only the same fixed command, for one session, for at most 10 minutes (F4).
  - Why: the canary is not in `permissions.allow`, and `autoAllowBashIfSandboxed` is false. Without the hook allow, the canary would prompt in interactive sessions and be denied in `-p`, headless and subagent runs. No `PostToolUse` would follow, so no pass could ever be recorded, and the hard gate would remove Bash for good.
  - R4 confirms that a hook `allow` skips the prompt in `-p` and in subagents, and that it does not override a settings `deny` or `ask` rule. IF the first does not hold, THEN the fallback is a `permissions.allow` rule `Bash(<node> <bundle> sandbox canary *)` in the per-machine settings file (R1). Its prefix is machine-specific, so it cannot go into the committed settings. Decision 2 is then revisited before rollout.
- Nonces (F1):
  - a nonce SHALL be random (at least 128 bits, lowercase hex, so it is safe in file names and in the command), single-use, valid for 10 minutes and bound to `session_id`;
  - a session SHALL have at most one outstanding nonce. While it is outstanding, every denied Bash call SHALL repeat the same command in its message, and no new fixtures are created. Parallel calls therefore share one nonce instead of racing;
  - a proof cycle SHALL issue at most two nonces: the first and one retry. A cycle starts at `SessionStart`, or when a pass is dropped because the settings hash changed. Once the cap is reached without a pass, the session has failed with the "could not run" message below;
  - a nonce that expires without a consumed result (no `PostToolUse`, a `PostToolUseFailure`, a timeout or an abandoned call) counts as a harness error and uses the retry;
  - WHEN a pass or a failure is recorded, THE SYSTEM SHALL drop every outstanding nonce and its fixtures (F4);
  - a result line for a nonce that is not outstanding SHALL be ignored, and an unknown nonce SHALL never pass.
- Probe fixtures (U1, U4). WHEN the hook issues a nonce, it SHALL first create, outside the sandbox, every fixture the canary needs, each named by that nonce:
  - the probe directories `~/.local/state/panopticon/canary/<nonce>/` and `<primary>/.panopticon/canary/<nonce>/`, mode 0700;
  - the decoys `<cwd>/.env.canary-<nonce>` and `<primary>/.claude/worktrees/.canary-<nonce>/.env`. The second stands for a sibling task worktree (U10). The leading dot keeps it apart from task worktree names (`<issue>-<slug>`);
  - for the `.panopticon/` `denyWrite` class, the file `<cwd>/.panopticon/canary-<nonce>`. The other `denyWrite` classes probe the real files: the worktree Charter, `.claude/settings.json` and the `.git` pointer.

  Every directory leaf is created with `mkdir`, and every file with `O_CREAT|O_EXCL`; EEXIST is a failure. The nonce is unknown until the fixtures exist, and Bash is gated until a pass, so nobody can pre-create or symlink a fixture. IF any fixture cannot be created, THEN the hook SHALL NOT issue the nonce. It SHALL deny with `Blocked by Warden sandbox-guard: the canary fixtures could not be created. Run wardens doctor.` The hook SHALL remove a nonce's fixtures when it consumes, drops or expires the nonce. Names never repeat across nonces. A repeated run of the same canary uses run-unique probe names (with the process id) inside the nonce's directories, and it only reads the shared decoys.
- WHEN the canary runs, THE SYSTEM SHALL check the boundary that fits the session's cwd class (`classifyCwd`).
  - **Linked worktree on a task branch:**
    - creating `<cwd>/.canary-<nonce>-<pid>` with `O_CREAT|O_EXCL` succeeds (positive control);
    - creating a file in `<primary>/.panopticon/canary/<nonce>/` fails;
    - creating a file in `~/.local/state/panopticon/canary/<nonce>/` fails. This replaces the earlier `~/.panopticon-canary/`, which nothing created (U1), and also proves that the canary state is out of the shell's reach;
    - reading each decoy fails;
    - for each `denyWrite` class, opening the existing file with `O_WRONLY|O_APPEND` fails, and nothing is written;
    - a direct connection to a non-allowlisted host fails.
  - **Primary checkout or detached `HEAD`** (OVERSEER): the same checks, except that creating a file in the cwd SHALL fail, which needs the OVERSEER profile. The positive control is creating `$TMPDIR/panopticon-canary-<nonce>-<pid>`. The failure message SHALL name the missing profile.
  - Each probe has one of three outcomes:
    - a negative probe **passes** only with the platform's sandbox errno (EPERM on macOS; R5 gives the Linux values);
    - it is **enforcement-negative** when a negative probe succeeds, or when the positive control fails with the sandbox errno;
    - every other outcome is a **harness error**: ENOENT or EEXIST on a fixture, EROFS, EACCES, any other errno, or a timeout. A harness error is never a pass and never enforcement-negative (U4).
  - The canary SHALL delete every probe file it created.
  - The canary SHALL print exactly one result line and SHALL exit 0 in every case, including its own internal errors, so that a `PostToolUse` event, not a `PostToolUseFailure`, follows (F1):
    - `sandbox: enforced <nonce> <cwd-class>`, only when every check passes;
    - `sandbox: NOT enforced <nonce> <check>` on the first enforcement-negative check;
    - `sandbox: canary-error <nonce> <check> <code>` on a harness error, or on any internal error.
- Bash post events (F2, F3):
  - Every Claude Code `PostToolUse` Bash event SHALL go to `sandbox-guard` only. `evaluateLifecycle` SHALL NOT route it through `postEditAudit`, which would run `worktree-guard` a second time and could turn an approved command into a block after the fact.
  - `Mapped` gets a new field `tool_output: string | null`: the Bash `tool_response` text, in the shape R7 records. It is null for every other event.
  - WHEN `sandbox.enabled` is false or the section is absent, a Bash post event SHALL be a no-op allow.
- WHEN a `PostToolUse` Bash event has a `tool_input.command` that is **byte-equal** (no trimming) to the command issued for the outstanding nonce, and its `tool_output` contains **exactly one** line that starts with `sandbox: `, and that line is `sandbox: enforced <nonce> <cwd-class>` for the session's actual cwd class, THE SYSTEM SHALL record a pass and consume the nonce (F4).
  - The match is byte equality, never tokenizer argv equality.
  - Output with no `sandbox: ` line, or with more than one, counts as `canary-error`. So does an `enforced` line for the wrong cwd class.
  - The pass SHALL be bound to a hash of the effective sandbox settings: the rendered block of the settings files in force, and the OVERSEER profile if used. WHEN that hash changes, THE SYSTEM SHALL drop the pass and require a new canary.
- WHEN the canary output carries `sandbox: NOT enforced <nonce> <check>`, THE SYSTEM SHALL record a failure. Every later Bash command SHALL then be denied with `Blocked by Warden sandbox-guard: the sandbox is not enforced in this session. Ask Krzysztof (needs:human).`
- WHEN the canary output carries `sandbox: canary-error`, has no single result line, or the nonce expires without a consumed result, THE SYSTEM SHALL drop that nonce and issue one fresh nonce, with fresh fixtures, for a retry. A second such result in the same proof cycle SHALL count as a failure. Its message is `Blocked by Warden sandbox-guard: the sandbox canary could not run. Run wardens doctor, then ask Krzysztof (needs:human).`
- Canary state:
  - THE SYSTEM SHALL keep nonces and verdicts outside every sandbox-writable location, in `~/.local/state/panopticon/sessions/<session_id>.json` (directory mode 0700);
  - `session_id` SHALL be validated as a UUID before it is used in a path;
  - `doctor` SHALL remove state files older than 7 days and canary fixtures older than 1 day;
  - Edit, Write and parsed shell writes to this directory SHALL be denied by ring 0 (Launcher and anchor, above);
  - hooks can write there, but sandboxed Bash cannot (P04, and the canary's own state-directory probe);
  - the `extra_write` allowlist cannot cover it;
  - a test SHALL assert that a sandboxed Bash write to the state file fails (part of R2).
- WHEN a `SessionStart` event arrives with any source (`startup`, `resume`, `clear`, `compact`), THE SYSTEM SHALL start a new proof cycle: it drops the session's pass, verdicts, nonces and fixtures. Settings can differ after a relaunch, so a session that was not enforced must prove itself again, and fails again if nothing changed.
- No Charter glob grants the canary: `primary_read_only_commands` and `commands.allow` do not grow. The short-circuit above is the only path that lets it through.
- Tests for the short-circuit (B1). Each rule gets a table row:
  - the issued canary string, from a linked worktree and from the primary, is ALLOWED by the engine as a whole. That holds although `secret-read-guard` alone denies it (escape), and `worktree-guard` alone would deny it in the primary;
  - the same string with one byte changed, a trailing space or newline, an env prefix, an appended `; true`, or after the nonce was consumed or expired, goes through the full rule list. Each rule then gives its normal verdict, and `secret-read-guard` denies it;
  - the issued string with `dangerouslyDisableSandbox: true` is DENIED by `sandbox-guard`;
  - a test SHALL run the **real built bundle** (`wardens/dist/wardens.mjs hook --tool claude --event PreToolUse`) on a recorded `PreToolUse` payload of the issued canary command, with its cwd in a linked worktree under `<primary>/.claude/worktrees/`. The test uses a throwaway `HOME` whose anchor lists a throwaway primary and whose state file holds the outstanding nonce. It SHALL assert the explicit `allow`, and a deny for the same payload with one byte changed.
- Outside the short-circuit, `sandbox-guard` gives an independent verdict, and deny wins (`engine.ts` ranks verdicts; rule order has no effect).
- `sandbox-guard` SHALL apply only when the hook's real tool identity is Claude Code (F9). Cursor can load `.claude/settings.json` hooks, and there the canary cannot pass.
  - The identity SHALL come from top-level payload markers only: a top-level `cursor_version`, which `event.ts` already uses to mark a `foreign` event, means Cursor. Nested fields never count.
  - A payload without a known marker SHALL count as Claude Code, so that a misread payload can never skip `sandbox-guard`.
  - The `--tool` argument alone does not count, since a Cursor session that loads Claude hooks still passes `--tool claude`. The identity is carried through `event.ts` normalization.

### Sandboxed toolchains: task config and credentials

- THE worktree's `.env` SHALL stay in `denyRead`, because it is a Charter secret path. Sandboxed tests and dev servers therefore cannot read it (U5).
- WHEN `wardens worktree new` or `setup` writes a task's `.env`, THE SYSTEM SHALL also write `.panopticon/task.env`. It holds the same non-secret values and nothing else: `TASK_ISSUE`, `WEB_PORT`, `API_PORT`, and `DATABASE_URL` when `resources.database` is set. Like `.env`, it never takes a value from the primary's `.env`. Only those human-only subcommands write it (`HUMAN_ONLY` in `worktree/index.ts`). It is readable inside the sandbox, because it is not a secret path. Only the sandbox's `denyWrite` on `.panopticon/**` keeps the shell from writing it (B2, Known gaps).
- WHEN a Claude Code `SessionStart` event arrives in a worktree that has `.panopticon/task.env`, THE SYSTEM SHALL parse it strictly and append its values to the file named by `CLAUDE_ENV_FILE` as `export` lines (F5).
  - Accepted lines are `KEY=value` with no spaces around `=` and no blank or comment lines. Each of the four keys may appear at most once.
  - `TASK_ISSUE` is 1–9 decimal digits. `WEB_PORT` and `API_PORT` are decimal integers in 1–65535.
  - `DATABASE_URL` starts with `postgresql://`, has at most 512 bytes, and uses only `A–Z a–z 0–9 : / @ . _ % + - ? = &`.
  - Values are written in single quotes, with `'` escaped as `'\''`. The charset above excludes the quote, so the escape is a second line of defence.
  - IF any line fails, THEN nothing is exported, and the `SessionStart` verdict carries a warning that names `.panopticon/task.env`. It does not block.
  - The allowlist keeps `HOME`, `PATH`, `NODE_OPTIONS`, `GIT_*` and every other key out of the sourced file.
  - Sandboxed Bash commands then get the task config from the environment. IF R2 shows that `CLAUDE_ENV_FILE` does not reach sandboxed or subagent Bash, or that it is sourced outside the sandbox from a file that sandboxed Bash can write, THEN the package scripts load `.panopticon/task.env` explicitly instead.
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
| Canary trust | Every anchor sits outside the agent's reach: <br>- the state file in `~` (not writable by the shell, and probed by the canary); <br>- the gate read from the Charter that hooks load from the trusted primary (#74); <br>- the canary pinned to the absolute Node and primary bundle paths, with byte equality; <br>- single-use nonces, at most one outstanding, with per-nonce fixtures; <br>- a reset on every `SessionStart`. <br>The nonce gives replay resistance only. Unforgeability comes from `PostToolUse` seeing the real command and its real output. |
| Canary permission | A command byte-equal to the issued canary is judged by `sandbox-guard` alone (the short-circuit), which lets it through with an explicit hook `allow`. Neither `permissions.allow` nor `autoAllowBashIfSandboxed` is involved. R4 confirms that this works in `-p` and subagents. |
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
- **Shell writes to `.panopticon/**` and `.claude/**` are stopped only by the sandbox (B2).** Ring 0 does not deny them in any spelling (Rendering, `denyWrite`). Those paths hold `task.json` (whose absence widens scope to the Charter's `allowed_paths`), `task.env` (which feeds the session environment), the DoD state, the logs and the generated `.claude/settings.json` (the hooks and the sandbox block, applied at the next reload). Where the sandbox does not hold, an agent can rewrite them:
  - **Decision 2 option B (soft gate):** Bash runs before the sandbox is proven. A session whose sandbox is switched off can write them, and its next reload can run without hooks or sandbox.
  - **Cursor:** it has no sandbox floor (ADR-0015), so Cursor shell commands can write both trees today, and still could after this spec.
  - **`required: false`, `enabled: false` and the rollout window before step 5:** sessions without a rendered sandbox have no control on these paths, as today.
  - **Recommendation (a human Charter change, C-23):** Krzysztof adds `.panopticon/**` to `paths.protected.deny`. Then ring 0's shell-write rule (#76) and the generated `Edit(...)` deny cover it. Hooks and the human-only `wardens worktree` subcommands still write there, because ring 0 does not apply to them.
  - The same recommendation applies to `.claude/**`, with one caveat: C-24 classifies agent configs (`.claude/**`) as `ask`. The constitution-conformant form is therefore `paths.protected.ask`, which is denied in non-interactive sessions. A `deny` entry would need a C-24 amendment (C-32).
  - Ring 0 then still misses unparsed spellings; the sandbox stays the full control.
- **`.env` variants outside the fixed list** (for example `.env.foo`) are not in `denyRead`, because `denyRead` has no negation and `.env.*` would also hide `.env.example` (F8). Only `secret-read-guard` covers them, by parsing.

### Retest (Krzysztof runs it, with the #66 kit extended)

- **R1 (blocks `ready`).** Settings precedence and path syntax:
  - enable the sandbox through project `.claude/settings.json`, then try to switch it off or widen it through `.claude/settings.local.json`, `~/.claude/settings.json` and `--settings`;
  - record which keys win;
  - test the path semantics of `allowWrite`, `denyRead` and `denyWrite` (`/`, `~/`, `./`, `**`, globs), so that paths outside the cwd can be expressed portably;
  - check that the fixed `.env` variants and `.env.canary-*` are denied while `.env.example` stays readable (F8), and whether `<primary>/**/.env` denies a sibling task worktree's `.env` read from another task worktree (U10);
  - check whether settings `env` values expand `~/` or stay literal;
  - IF a portable form does not exist, THEN machine-specific paths go to a per-machine file rendered at setup time, and this spec is revised.
- **R2 (blocks rollout).** Toolchain inside the sandbox, on the real layout (task worktrees nested at `.claude/worktrees/<name>`):
  - `pnpm install --frozen-lockfile`, `uv sync --frozen`, `pnpm check`, `git commit` with lefthook, and `gh pr view`;
  - `gh pr create` and an HTTPS `git push` on a task branch, with the credential mechanism Decision 8 chose. Check whether Keychain-backed credentials work inside the sandbox at all;
  - under Decision 8 option A, check what the token can do and record each result (F6): merge a PR, push to `main`, edit a label (`risk:*`, `needs:human`), and edit an issue body. Try each through `gh` and through `curl` or `gh api` to `api.github.com`; the `curl` and `gh api` forms are not covered by `commands.deny`. The token gets a short expiry (at most 7 days) for the test and for use;
  - task config (U5, F5): use a throwaway `SessionStart` hook in the #66 kit that writes an export to `CLAUDE_ENV_FILE`, because Task 6 merges after R2. With the worktree's `.env` unreadable, a test and a dev server get their ports and database from that export. Check that the export reaches sandboxed and subagent Bash, where `CLAUDE_ENV_FILE` lies and whether sandboxed Bash can write it, and whether the file is sourced inside the sandbox. Record how each loader treats EPERM on `.env`;
  - Postgres on localhost;
  - writes to the session scratchpad. Check whether Claude Code exposes the session's own temp path. If it does not, the shell gets no scratchpad `allowWrite` at all (the Write tool still has it), never the all-sessions glob;
  - a sandboxed write to `~/.local/state/panopticon/` fails.
- **R3 (blocks rollout).** `denyWrite` on the protected-branch ref set:
  - the set: `<common>/refs/heads/<branch>`, `logs/refs/heads/<branch>`, `refs/remotes/origin/<branch>`, `packed-refs`, the primary `HEAD` and `index`, `worktrees/*/HEAD`, and their `*.lock` siblings;
  - re-run P10 and P11, then commit, fetch and push on a task branch.
- **R4 (blocks rollout).**
  - With `allowUnsandboxedCommands: false`, the model retries a denied write with `dangerouslyDisableSandbox`, and the write must stay denied.
  - With `autoAllowBashIfSandboxed: false`, a command outside `commands.allow` still prompts, or is denied in `-p`.
  - A `PreToolUse` hook that returns `permissionDecision: "allow"` for one exact command skips the prompt in an interactive session, in `-p` and in a subagent (U2). The same hook `allow` must not override a settings `permissions.deny` or `permissions.ask` rule that matches the command (F7). A throwaway hook in the #66 kit is enough, so this item does not wait for Task 4a.
  - Check that `-p` honours `failIfUnavailable`, that subagent Bash calls run under the same settings, and whether subagent hook payloads carry the parent's `session_id`.
- **R5 (separate).** Linux (bubblewrap), including its errno values, before any headless or CI agent relies on it.
- **R6 (blocks `ready`).** Profile and pointer protection:
  - Can `denyWrite` on the repository override the default cwd write? The same question decides the `<primary>/wardens/dist/` and `<primary>/panopticon.charter.yaml` entries for a primary-cwd session (F12).
  - Can the common git dir stay writable inside a denied tree?
  - Does `git fetch` still work, and what does `claude --worktree` do under the profile?
  - Is the worktree's `.git` pointer file write-protected by the sandbox by default, against in-place writes and against replacement (rename, unlink and recreate)? The same question applies to every other git input that a consumer still reads (the branch name for `classifyCwd`).
  - Is the worktree's `.claude/settings.json` write-protected?

  The shipped anchor-based launcher holds whatever R6 shows. R6 decides only the defence-in-depth `denyWrite` entries.
- **R7 (blocks `ready`).** Record real Bash payloads for the post phase, including `tool_response` and the violation text the sandbox appends to the output (F1):
  - a successful command (`PostToolUse`);
  - a command that exits non-zero;
  - a command that hits the Bash timeout;
  - a call the user interrupts or abandons.

  For each, record which event fires (`PostToolUse`, `PostToolUseFailure` or none) and in what shape. The canary's exit-0 rule and the nonce-expiry path rely on these answers.

### Engine and CLI changes

- `charter.ts` and `schema/charter.schema.json`: the `sandbox:` section and its validation rules, including the `extra_write` allowlist.
- `sync/render.ts`: the `sandbox` block, the generated `env` cache entries and the OVERSEER profile. The launcher stays unchanged. The `PostToolUse` matcher is **not** extended here (U3). `SessionStart` is already rendered.
- `sync/render.ts` and `mapping.ts`, together with `event.ts` (Task 4a): the `PostToolUse` matcher extended from `^(Edit|Write)$` to `^(Bash|Edit|Write)$`, a `MAPPING_ROWS` row for it, and a `mapLifecycle` branch that maps Bash `PostToolUse` (`tool_input.command`, and `tool_response` into the new `Mapped.tool_output`). They ship in one PR. A matcher without the mapping makes `mapLifecycle` return NOT_MAPPED, which the engine turns into a block after every Bash call. Normalization also carries `dangerouslyDisableSandbox` and the real tool identity (top-level markers only). Use recorded fixtures from R7.
- `engine.ts`:
  - the canary short-circuit before the rule loop;
  - an allow level in `RANK`, below `ask`;
  - in `evaluateLifecycle`, Bash post events routed to `sandbox-guard` only, never to `postEditAudit`, and a no-op allow when `sandbox.enabled` is false.
- `render.ts` (hook output): an explicit `permissionDecision: "allow"` for the one canary verdict (Claude Code only).
- `rules.ts`: the `sandbox-guard` rule. There is no Charter or `worktree-guard` exception for the canary; the short-circuit replaces it.
- `guards.ts`: the built-in launcher-configuration deny extended to `~/.local/state/panopticon/`.
- `git.ts`: `classifyCwd` relative to the trusted primary.
- New `sandbox/` module: the state store in `~/.local/state/panopticon/`, the per-nonce fixtures, and the `wardens sandbox canary <nonce>` subcommand.
- `worktree/`: `.panopticon/task.env` next to `.env`; the strict parser and the `SessionStart` export through `CLAUDE_ENV_FILE`.
- `doctor.ts`: the `sandbox` and `protected-refs` checks, the `launcher-anchor` additions, fixture and state cleanup, and the settings-drift warning in `worktrees`.

### Rollout (Krzysztof)

1. Run R1, R6 and R7, then revise this spec, set it to `ready` and accept ADR-0015. Run the R4 hook-allow item with the #66 kit, then take Decisions 2 and 8.
2. Merge Tasks 2–3, add the `sandbox:` values to The Charter, rebuild the bundle and run `wardens sync`. The Bash `PostToolUse` matcher is not rendered yet, so no unmapped event reaches the engine (U3). Run R2–R4 with the generated files.
3. Merge Tasks 4a, 4b and 6. Task 4a brings the matcher and its mapping together. **Rebuild the primary first** (F3): pull the merged `main` and rebuild in the primary checkout, then run `wardens doctor` (`bundle`, `coverage`). Only after that may any task worktree rebase onto it or start a session with the new settings. A worktree whose settings carry the Bash matcher while the primary's bundle is still old would turn every Bash call into NOT_MAPPED. From then on, every Claude Code session starts with the canary.
4. Launch OVERSEER with `--settings .claude/overseer.settings.json`.
5. Set `sandbox.required: true`.

## Tasks

Each task becomes its own issue, linked to #69.

1. **This spec and ADR-0015.** Krzysztof decides. **Allowed paths:** `docs/specs/**`, `docs/decisions/**`, `docs/decision-log.md`.
2. **Charter `sandbox:` schema and validation** (no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
3. **Render:** the `sandbox` block, the `env` cache entries and the OVERSEER profile, with render tests. The launcher stays byte-equal, and the `PostToolUse` matcher is not extended. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2, R1 and R6.
4. **`sandbox-guard`:**
   - **4a.** The rule, with the Bash `PostToolUse` matcher, its mapping row and its `mapLifecycle` mapping shipped together (U3). It also brings the canary short-circuit and its explicit `allow`, the `RANK` allow level, the Bash post routing and `Mapped.tool_output`, the nonce cap, the state store and fixtures, the `SessionStart` reset, `classifyCwd` relative to the trusted primary and the state-directory deny. It comes with DENIED/ALLOWED tables per rule, including forged canary forms, and the real-bundle test from a linked worktree (B1).
   - **4b.** The `wardens sandbox canary` subcommand and its cwd-class checks, with per-nonce fixtures, run-unique probe names, the three result lines and exit 0 in every case.
   - **4c** (if Decision 7 chooses it). The DoD runs `pnpm check` under the rendered sandbox profile.

   `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2 and R7. 4a also depends on 3.
5. **`doctor`:** the `sandbox` and `protected-refs` checks, the `launcher-anchor` additions, fixture and state cleanup, and the settings-drift warning. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 3 and R1.
6. **Task config for sandboxed toolchains:** `.panopticon/task.env` in `wardens worktree new` and `setup`, its strict parser, and the `SessionStart` export through `CLAUDE_ENV_FILE`. `risk:high`. **Allowed paths:** `wardens/**`. Depends on R2. Loader fixes under `apps/**` that R2 finds are separate issues.

## Decisions (Krzysztof)

1. **Accept ADR-0015** after R1, R6 and R7, or reject it and keep ring 0 alone.
2. **Canary gate.** *Changed facts (U2, U4):* the canary is not in `permissions.allow` and `autoAllowBashIfSandboxed` is false, so it prompts, or is denied in `-p`, headless and subagent runs. With fixed probe names, parallel canaries could also lock a sandboxed session out. *Changed facts (Sentinel B1, B2):* in a linked worktree, `secret-read-guard` denied the canary command itself, so under the hard gate no linked session could ever pass. The canary short-circuit fixes that. Separately, `.panopticon/**` and `.claude/**` have no ring-0 shell-write control. This revision adds the explicit hook `allow`, the short-circuit, the nonce cap and per-nonce fixtures. Option A's cost and feasibility now depend on R4.
   - Option A: hard gate. Every session blocks Bash until the canary passes, and `sandbox-guard` lets the canary through with an explicit hook `allow` (proposed, if R4 confirms the hook allow).
     - *Before:* "one extra turn per session, subagents and `-p` runs included".
     - *After:* one denied Bash call plus the canary call per session. That includes each subagent when its hook payloads carry their own `session_id` (R4). At most two nonces are issued per proof cycle, then the session fails closed.
     - It works in `-p` and subagents only if R4 shows that a hook `allow` skips the prompt there. If not, the fallback is a per-machine `permissions.allow` prefix rule (R1 file). Without either, A removes Bash for good from every `-p`, headless and subagent session, so it is not workable.
   - Option B: soft gate, warn only. Bash runs before any canary; the hook asks for the canary through `additionalContext` and logs unproven sessions to the Ledger.
     - No turn cost and no lock-out.
     - A session with the sandbox switched off is not stopped.
     - A primary-cwd session launched without the OVERSEER profile can write the primary checkout by Bash, including the bundle the launcher runs, unless R6 shows the `wardens/dist/` `denyWrite` holds. Otherwise only `worktree-guard`'s parser stands in the way, and B brings back the bundle hash and its refresh on every rebuild path (Launcher and anchor).
     - Under B, a session whose sandbox is off can write `.panopticon/**` (`task.json`, `task.env`) and `.claude/settings.json`, and ring 0 does not stop it in any spelling (Known gaps, B2). B therefore also needs the recommended Charter change (`.panopticon/**` in `protected.deny`, `.claude/**` in `protected.ask`), and even then only parsed spellings are covered.
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
     - It is still Krzysztof's identity. If his ruleset bypass applies to it, it can merge and push to `main`; R2 checks this.
     - `commands.deny` does not contain it (F6). That list is a parser over command text. With `GH_TOKEN` in the environment, `curl` or `gh api` to the allowlisted `api.github.com` can merge, comment or change settings that the token permits, whatever Decision 5 adds. Decision 5 narrows only the `gh` spellings it names.
     - The issues permission lets it edit labels (`risk:*`, `needs:human`) and issue bodies. #38's scope control (`gh issue edit … --body` in `commands.deny`) is also only a parser deny, so the token can widen a task's allowed paths through the API.
     - The agent can publish the token itself, in a public comment or a gist, for example after a prompt injection. github.com is allowlisted, so the sandbox does not stop it.
     - It needs a short expiry (at most 7 days, proposed), is rotated by hand, and is never committed.
   - Option B: exempt the `gh` credential store. Drop `~/.config/gh` from the minimum and keep the token in `hosts.yml` (`gh auth login --insecure-storage`), since the Keychain is denied or unreachable (R2).
     - Sandboxed Bash can read Krzysztof's full token, with every scope and the bypass, and github.com is allowlisted. This removes the point of the credential deny for GitHub and conflicts with the spirit of C-18.
   - Option C: no GitHub credential inside the sandbox. `git push`, `gh pr create` and the other `gh` writes run outside it: by Krzysztof, or later through #64's fixed operations run by a hook. Reads keep working unauthenticated, because the repository is public.
     - Until #64 lands, agents cannot push or open PRs, and step 7 of the `AGENTS.md` workflow changes. R2 then checks that these commands fail cleanly instead of working.
