---
status: draft
issue: #6
adrs: [0003, 0004, 0005, 0008, 0011, 0012, 0013]
---

# Wardens core: Charter v1, schema validation and ring-0 guard rules

## Goal and context

Ship the first half of PANOPTICON's phase-0 entry criteria ([ADR-0008](../decisions/0008-autonomy-phases-and-risk-based-merge-policy.md)): **The Charter** as the single source of policy ([ADR-0003](../decisions/0003-the-charter-as-single-source-of-policy.md), amended by [ADR-0013](../decisions/0013-charter-policy-refinements.md)) and the core of the TypeScript Wardens engine ([ADR-0005](../decisions/0005-wardens-engine-in-typescript-with-single-cli.md)) in `wardens/`.

This issue ([#6](https://github.com/LUNARITYai/lunarhunt/issues/6)) covers:

- `panopticon.charter.yaml` (v1) and `wardens/schema/charter.schema.json`
- Charter load + JSON Schema validation (`charter-validate`)
- Hook payload normalization for Claude Code and Cursor into one internal event
- Ring-0 rules: `scope-guard`, `protected-paths`, `command-guard`, `secret-read-guard`
- CLI entry points `wardens hook` and `wardens check` (library: **commander**, per issue Decisions)
- Fail-closed protective behaviour (constitution C-03), C-30 block messages, and a local JSONL verdict log until Ledger v0
- Vitest suite with positive/negative cases per rule and contract fixtures

**Bootstrap exception (binding):** the implementation agent creates `panopticon.charter.yaml` in the implementation PR; Krzysztof reviews and approves it. After merge, The Charter is a deny path for agents.

**Out of scope (follow-up issues):** `wardens sync` and generated tool configs; `charter-drift`; `definition-of-done`; `wardens doctor`; `agent-trailer`; `generated-files-guard`; ring-2 Wardens; writing verdicts to The Ledger; security scanners; phase 1+ routing/budgets/kill-switch behaviour; `worktree-guard` (ADR-0012) — though Charter v1 **includes** the `worktree:` section so later work does not require another Charter schema break.

## Acceptance criteria (EARS)

### Charter and schema

- THE SYSTEM SHALL contain `panopticon.charter.yaml` (v1) with `autonomy.phase: 0`, `autonomy.kill_switch: false`, and sections `roles`, `paths` (`allowed_paths`, `protected.deny`, `protected.ask`, `non_interactive_ask: deny`, `generated`, `secrets_deny_read`), `commands`, `covenant`, `risk`, `require_spec_for`, `specs`, `quality_gates`, `budgets` (placeholder `null` values), `log_access`, `ledger` and `worktree` (per ADR-0012 sketch).
- THE SYSTEM SHALL contain `wardens/schema/charter.schema.json` that requires `paths.protected.deny`, `paths.protected.ask`, `roles.*.model` and `roles.*.effort` (including `debugger`), `risk.high|medium|low`, `require_spec_for` and `covenant.agents_md_exempt`.
- WHEN the Charter is validated, THE SYSTEM SHALL reject any negated glob other than `!*.example` in `paths.protected.deny` and `paths.secrets_deny_read`.
- WHEN the Charter is validated, THE SYSTEM SHALL fail if `panopticon.charter.yaml` is missing from `paths.protected.deny`.
- WHEN `pnpm check` runs, THE SYSTEM SHALL run Charter validation (`charter-validate`), Biome, `tsc` (strict) and Vitest for the `wardens` package so the existing CI job `check` covers it.
- THE SYSTEM SHALL build the `wardens` package with tsup into one file `wardens/dist/wardens.mjs` (not committed) via `pnpm --filter wardens build`.
- THE SYSTEM SHALL list `panopticon.charter.yaml` in `.github/CODEOWNERS` with Krzysztof as owner (if not already covered).
- THE SYSTEM SHALL gitignore `.panopticon/` (add that entry only; no other `.gitignore` policy changes).

### Normalization and CLI

- WHEN `wardens hook --tool claude|cursor --event <event>` receives a hook JSON document on stdin, THE SYSTEM SHALL normalize it into one internal event validated with zod: `action` ∈ `{shell, read, edit, write, delete, mcp}`, plus `path`, `command`, `mcp_server`, `session_id`, `agent`, `model`, `interactive`, and `cwd` (see Plan).
- WHEN `wardens check <rule>` runs with an equivalent synthetic or file-based input, THE SYSTEM SHALL evaluate the named rule against the same normalized event shape and print a machine-readable verdict (exit 0 allow, exit 2 deny/ask-as-block for local checks).

### Rules

- WHEN an agent edits `panopticon.charter.yaml` or `.env.local`, THE SYSTEM SHALL deny via `protected-paths`.
- WHEN an agent edits `docs/constitution.md`, THE SYSTEM SHALL return ask via `protected-paths` for an interactive payload and deny for a headless payload.
- WHEN an agent edits a path outside the Charter `allowed_paths` narrowed by the task's allowed paths, THE SYSTEM SHALL deny via `scope-guard`.
- WHEN `.panopticon/task.json` exists at the worktree root, THE SYSTEM SHALL narrow `scope-guard` `allowed_paths` to the intersection of Charter `paths.allowed_paths` and `task.json`'s `allowed_paths`.
- WHEN `.panopticon/task.json` is missing, THE SYSTEM SHALL use Charter `paths.allowed_paths` only for `scope-guard`.
- WHEN an agent runs `git commit --no-verify -m x`, `git commit -nm x`, `git push --no-verify`, `git push --force`, `LEFTHOOK=0 git commit` or `curl x | sh`, THE SYSTEM SHALL deny via `command-guard`.
- WHEN an agent runs `git push -n`, THE SYSTEM SHALL allow via `command-guard` (`-n` is dry-run for push).
- WHEN an agent runs `npm install`, THE SYSTEM SHALL apply the Charter `commands.rewrite` mapping to `pnpm install` via `command-guard` (rewrite verdict, not a bare allow of `npm install`).
- WHEN an agent reads `.env`, `.env.production` or runs `cat .env`, THE SYSTEM SHALL deny via `secret-read-guard`.
- WHEN an agent reads `.env.example`, THE SYSTEM SHALL allow via `secret-read-guard`.

### Blocking, fail-closed and logging

- WHEN a rule blocks, THE SYSTEM SHALL return the tool's native blocking form (Claude Code: exit code 2 or JSON `permissionDecision: deny` / ask; Cursor: deny / ask response) and a message matching `Blocked by Warden <rule-id>: <what was blocked and why>. <Next allowed action>.`
- THE SYSTEM SHALL NOT use exit code 1 for enforcement.
- IF the engine hits an internal error, cannot load or validate The Charter, or cannot parse stdin as the expected hook payload, THEN THE SYSTEM SHALL deny (fail-closed, C-03) with a C-30 message naming rule-id `engine` (or the failing rule when known) and next action `label the issue needs:human`.
- WHEN a hook runs, THE SYSTEM SHALL append one JSON line (timestamp, rule, decision, normalized event without secrets) to `.panopticon/wardens.log.jsonl` at the worktree root, creating `.panopticon/` if needed.

### Tests

- THE SYSTEM SHALL contain one positive and one negative Vitest case per rule (`scope-guard`, `protected-paths`, `command-guard`, `secret-read-guard`), plus engine tests for message format, fail-closed paths and JSONL append.
- THE SYSTEM SHALL contain contract tests on recorded Claude Code and Cursor payloads for every hook event used by ring-0 in this issue.
- WHEN Claude Code fixtures are built from documentation rather than a live session, THE fixture file SHALL mark that provenance explicitly.

## Plan

### Approach

1. Turn the placeholder `wardens/` package into a TypeScript CLI package: strict TS, Biome, Vitest, **commander**, **zod**, **yaml** parser, JSON Schema validator, **tsup** single-file ESM bundle `wardens/dist/wardens.mjs`.
2. Author `panopticon.charter.yaml` v1 from ADR-0003 + ADR-0013 (+ ADR-0012 `worktree:`) and the authoritative schema `wardens/schema/charter.schema.json`.
3. Implement load → schema-validate → zod-parse Charter once per process invocation.
4. Implement tool adapters (`claude`, `cursor`) that map hook stdin JSON + `--event` into the normalized event; rules see only the normalized event.
5. Implement the four ring-0 rules; wire `wardens hook` (stdin) and `wardens check <rule>` (local/CI helper).
6. Wire package scripts so `pnpm check` / Turborepo `check` runs `charter-validate`, lint, typecheck and tests for `wardens`.
7. Add `.panopticon/` to `.gitignore`; ensure CODEOWNERS covers The Charter.

### Glob matching (paths)

**Library:** `picomatch` (small, micromatch-compatible, no Babel runtime). Match with `{ dot: true }` so patterns like `.env*` hit hidden files.

**Path normalization before match:**

1. Resolve the candidate path relative to the **worktree root** (`git rev-parse --show-toplevel` of event `cwd`, falling back to `process.cwd()`).
2. Convert to POSIX separators; strip a leading `./`.
3. Reject / fail-closed if the resolved path escapes the worktree root (symlink or `..` escape) — treat as deny for protective rules.

**Glob semantics:**

- Patterns are Charter strings as written (`apps/**`, `.env.*`, `**/AGENTS.md`).
- Negation (`!pattern`) is allowed **only** in `paths.protected.deny` and `paths.secrets_deny_read`, and **only** when the negated pattern matches `!*.example` (schema + `charter-validate` custom check). Example: `!.env.example`.
- Evaluation order within a list: last matching pattern wins (gitignore-style). A positive match after a negation re-denies; a trailing `!.env.example` allows that exact basename exception.
- `protected-paths` precedence: if any `deny` list pattern matches (after negation rules), result is **deny**; else if any `ask` list pattern matches, result is **ask** (then degraded per interactivity); else the rule does not fire (other rules may still fire).
- `scope-guard`: path must match **at least one** pattern in the effective allowed list (Charter ∩ task). No negation in `allowed_paths`.

### Flag / command matching (`command-guard`)

**Not** raw string prefix globs on the whole command line. Steps:

1. **Split env assignments** leading the command (`LEFTHOOK=0 git commit` → env `{ LEFTHOOK: "0" }` + argv `["git","commit",...]`). Matching Charter patterns that begin with `LEFTHOOK=0` uses this env view.
2. **Tokenize** the remainder with a POSIX-ish shell tokenizer (dependency: `shell-quote` parse, or equivalent) into `argv[]`. Fail-closed deny if tokenization fails on a candidate deny pattern family (safer than fail-open).
3. Detect pipelines / shell metacharacters for patterns like `curl * | sh` (pipe-to-shell): if the reconstructed command contains a pipe into `sh`/`bash`/`zsh`/`dash`, deny.
4. **Expand combined short flags** for known git subcommands: a token matching `^-[a-zA-Z]{2,}$` (no long-opt, no `--`) is expanded into one flag per character **before** option-value attachment. Example: `-nm` → `-n`, `-m` for `git commit`. Characters that take a value consume the following argv element as their argument after expansion (git commit `-m` takes the next token).
5. **Subcommand-aware long/short meaning:**
   - `git commit`: `-n` / `--no-verify` are deny targets; `-m` is message.
   - `git push`: `-n` / `--dry-run` are **allowed**; `--no-verify` / `--force` / `-f` deny per Charter.
   - `git merge`: `--no-verify` deny.
6. Charter `commands.deny` entries are matched against the parsed form: program + subcommand + flag set + positional wildcards (`*`), not as a single unparsed string. Implementation MAY compile each deny entry into a small matcher; tests lock the examples in the issue AC.
7. `commands.rewrite`: if the normalized argv (or original simple command string) equals a rewrite key (e.g. `npm install`), return decision `rewrite` with `replacement` (e.g. `pnpm install`) and a C-30-style message instructing the agent to run the replacement. Hook response uses the tool's native “deny with message” or rewrite channel when available; until tool rewrite APIs are confirmed, **deny with next action = run the rewritten command** is acceptable and must be tested.
8. `commands.allow` is advisory documentation for humans/`wardens sync` later; ring-0 in this issue only **deny** and **rewrite**. Anything not denied or rewritten is allowed by `command-guard` (other rules still apply).

### `.panopticon/task.json` format

Written by the coordinator when a task starts; **gitignored**; lives at the **worktree root**.

```json
{
  "issue": 6,
  "allowed_paths": [
    "panopticon.charter.yaml",
    "wardens/**",
    "pnpm-lock.yaml"
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `issue` | number | yes | GitHub issue number |
| `allowed_paths` | string[] | yes | Non-empty list of globs; must be a **subset** (narrowing only) of Charter `paths.allowed_paths`. Engine intersects: a path is allowed iff it matches ≥1 Charter allowed glob **and** ≥1 task glob. If a task glob matches nothing under Charter globs (attempted widen), `scope-guard` still cannot widen — effective allow list is the intersection; a task glob outside Charter scope never grants access. |
| `branch` | string | no | Informational; not enforced in this issue (`worktree-guard` is out of scope). |
| `slug` | string | no | Informational. |

Zod schema rejects missing `issue` / `allowed_paths`, non-array paths, or empty `allowed_paths`. **Invalid `task.json`:** fail-closed for `scope-guard` (deny edits/writes/deletes with next action `fix .panopticon/task.json or remove it and use Charter allowed_paths only` / `needs:human`). Reads and unrelated rules are unaffected beyond that deny.

### Internal normalized event schema (zod)

```ts
{
  tool: "claude" | "cursor",
  event: string,                 // tool event name as passed to --event
  action: "shell" | "read" | "edit" | "write" | "delete" | "mcp",
  path: string | null,           // repo-relative POSIX path when applicable
  paths: string[],               // multi-path tools; may be empty
  command: string | null,        // raw shell command when action=shell
  mcp_server: string | null,
  mcp_tool: string | null,
  session_id: string | null,
  agent: string | null,          // role or agent name if present in payload
  model: string | null,
  interactive: boolean,          // false => ask degrades to deny (ADR-0013 A4)
  cwd: string,                   // absolute cwd from payload or process
  raw: unknown                   // original payload retained for contract tests only; never logged
}
```

**Interactivity detection (settled default):** `interactive === false` when any of: CLI flags/env indicate print/headless mode if present on the payload; payload field `interactive: false`; missing TTY hints the adapter documents. If the tool payload does not carry a reliable signal, adapters default to `interactive: true` for local IDE hooks and `false` for documented headless event shapes — see Open questions if live payloads disagree.

**Action mapping (initial):**

| Tool | Typical events (ring-0 this issue) | → action |
|------|--------------------------------------|----------|
| Claude Code | `PreToolUse` with tool `Bash` | shell |
| Claude Code | `PreToolUse` with `Read` | read |
| Claude Code | `PreToolUse` with `Edit` / `Write` | edit / write |
| Claude Code | `PreToolUse` with `mcp__…` | mcp |
| Cursor | `beforeShellExecution` / shell `preToolUse` | shell |
| Cursor | `beforeReadFile` | read |
| Cursor | `preToolUse` write/edit/delete | write / edit / delete |
| Cursor | `beforeMCPExecution` | mcp |

Exact event name list for wiring is fixed by fixtures in the implementation PR; every event used MUST have a contract fixture.

### Block message format (C-30)

```text
Blocked by Warden <rule-id>: <what was blocked and why>. <Next allowed action>.
```

Examples:

- `Blocked by Warden scope-guard: path infra/ not in allowed_paths for this task. Ask for needs:human.`
- `Blocked by Warden protected-paths: panopticon.charter.yaml is deny for agents. Edit via a human-approved PR.`
- `Blocked by Warden protected-paths: docs/constitution.md requires ask and this session is non-interactive. Label the issue needs:human.`
- `Blocked by Warden command-guard: git commit --no-verify is denied. Remove --no-verify and retry.`
- `Blocked by Warden secret-read-guard: reading .env is denied. Use .env.example for non-secret templates.`
- `Blocked by Warden engine: Charter validation failed. Label the issue needs:human.`

Unit test: every deny/ask message matches `/^Blocked by Warden [a-z0-9-]+: .+\. .+\.$/`.

### Fail-closed behaviour (C-03)

| Condition | Hook behaviour |
|-----------|----------------|
| Missing / unreadable Charter | deny, exit 2 (Claude) / deny JSON (Cursor) |
| Charter fails JSON Schema or zod | deny |
| Stdin empty / invalid JSON / adapter cannot map event | deny |
| Rule throws | deny (rule-id `engine` or the rule if identified) |
| Missing `wardens/dist/wardens.mjs` | tool-level `onFailure: "block"` / `failClosed: true` once configs exist; until `wardens sync`, document that hooks are not installed yet — engine itself still fail-closes when invoked |
| Exit code 1 | **never** used for allow/deny enforcement |

Ask results: interactive → tool native ask; non-interactive → deny with needs:human next action.

### JSONL verdict log format

Path: `.panopticon/wardens.log.jsonl` (append-only, gitignored).

One line per hook/`check` invocation that produces a verdict:

```json
{
  "ts": "2026-11-04T02:15:30.123Z",
  "rule": "scope-guard",
  "decision": "deny",
  "tool": "cursor",
  "event": "preToolUse",
  "action": "edit",
  "path": "infra/main.tf",
  "command": null,
  "session_id": "sess_abc",
  "duration_ms": 12,
  "message": "Blocked by Warden scope-guard: path infra/main.tf not in allowed_paths for this task. Ask for needs:human."
}
```

Rules:

- `decision` ∈ `allow` | `deny` | `ask` | `rewrite`
- NEVER log secret file contents, `.env` values, or `raw` payload bodies
- For `secret-read-guard` denies, log the path/command only
- If multiple rules would fire, log one line per evaluated rule that contributed to the final decision (or a single line for the winning rule — implementation MUST pick **winning rule only** for v1 to keep one line per hook as the issue requires). **Settled:** one JSON line per hook run (the decisive verdict).
- Log write failure MUST NOT convert an allow into a silent success without a verdict: if the decision was deny/ask, still return deny/ask even if the log write fails; if the decision was allow and log write fails, still allow (logging is best-effort for allow) but stderr MAY warn. Protective deny paths remain fail-closed on engine errors before logging.

### Fixture sources

| Tool | Source | Marker |
|------|--------|--------|
| Cursor | Recorded from a real `cursor-agent` / Cursor hooks session | fixture file header comment or `_meta.source: "recorded-cursor-session"` |
| Claude Code | Built from the official hooks documentation until a Claude subscription exists | `_meta.source: "claude-docs"` and `_meta.provisional: true` |

Layout (suggested): `wardens/test/fixtures/claude/*.json`, `wardens/test/fixtures/cursor/*.json`. Contract tests load each fixture, run the adapter + engine, and assert normalized fields + expected decision for labelled cases.

### Test plan

| Area | Positive (allow / expected non-block) | Negative (deny / ask) |
|------|----------------------------------------|------------------------|
| `scope-guard` | edit under Charter ∩ task paths | edit outside effective allowed_paths |
| `protected-paths` | edit under `apps/web/**` (not protected) | edit `panopticon.charter.yaml` / `.env.local` → deny; `docs/constitution.md` → ask interactive / deny headless |
| `command-guard` | `git push -n`, `pnpm install` | `git commit --no-verify -m x`, `git commit -nm x`, `git push --no-verify`, `git push --force`, `LEFTHOOK=0 git commit`, `curl x \| sh`; `npm install` → rewrite/deny-with-rewrite message |
| `secret-read-guard` | read `.env.example` | read `.env`, `.env.production`, `cat .env` |
| Message format | — | every deny/ask matches C-30 regex |
| Fail-closed | — | invalid Charter, invalid stdin → deny exit≠1 |
| JSONL | allow appends allow line | deny appends deny line without secrets |
| `task.json` | narrowing applied | missing file → Charter-only; invalid file → fail-closed on edits |
| Contract | each Cursor recorded event maps + decides | each Claude docs fixture maps + decides; provisional fixtures flagged |

`charter-validate` tests: good Charter passes; missing deny entry for The Charter fails; illegal negation fails; missing `roles.debugger.effort` fails.

### Affected packages / files (implementation PR — not this docs PR)

- `panopticon.charter.yaml` (bootstrap create)
- `wardens/**` (engine, schema, tests, package.json scripts)
- `pnpm-lock.yaml` / catalog pins as needed
- `turbo.json` only if required to wire `wardens` into `check`
- `.github/CODEOWNERS`
- `.gitignore` (`.panopticon/` only)

Not touched here or in implementation without a follow-up: `.claude/**`, `.cursor/**`, `lefthook.yml`, `.github/workflows/**`, `AGENTS.md`, `docs/decisions/**`.

### API / data model

No LunarHunt product API or DB migrations. Local files only: Charter, schema, `.panopticon/task.json`, `.panopticon/wardens.log.jsonl`.

### ADRs needed

None new. Implementation follows ADR-0003, 0004, 0005, 0008, 0012, 0013. No constitution change.

## Tasks

1. **Docs PR (this file):** land `docs/specs/2026-11-04-wardens-core.md` with `status: draft`; Krzysztof sets `status: ready` before implementation.  
   **Allowed paths:** `docs/specs/2026-11-04-wardens-core.md`

2. **Charter + schema:** add `panopticon.charter.yaml` v1 and `wardens/schema/charter.schema.json`; `charter-validate` CLI path; CODEOWNERS + `.gitignore` `.panopticon/`.  
   **Allowed paths:** `panopticon.charter.yaml`, `wardens/schema/**`, `wardens/package.json`, `.github/CODEOWNERS`, `.gitignore`

3. **Engine skeleton:** commander CLI (`hook`, `check`), tsup bundle, zod normalized event, Charter loader, fail-closed wrapper, JSONL logger, C-30 helper.  
   **Allowed paths:** `wardens/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (catalog only), `turbo.json` (if needed)

4. **Adapters + fixtures:** Claude (docs/provisional) and Cursor (recorded) adapters; contract tests for every event used.  
   **Allowed paths:** `wardens/**`

5. **Rules:** implement `scope-guard`, `protected-paths`, `command-guard`, `secret-read-guard` with picomatch + flag-aware matching + `task.json` narrowing; positive/negative tests per rule.  
   **Allowed paths:** `wardens/**`

6. **Wire check:** ensure `pnpm check` runs wardens lint, `tsc`, Vitest and charter-validate.  
   **Allowed paths:** `wardens/**`, `turbo.json` (if needed), `pnpm-lock.yaml`

## Open questions

1. **Cursor / Claude native rewrite channel:** for `commands.rewrite` (`npm install` → `pnpm install`), do current hook APIs support an in-place command rewrite, or is deny-plus-message the only portable behaviour? Spec allows deny-with-next-action until confirmed against live Cursor payloads.
2. **Authoritative headless/interactive fields:** exact payload keys for non-interactive Cursor (`agent -p`) and Claude Code (`claude -p`) sessions must be confirmed when recording fixtures; defaults above may need a one-line adapter fix without a Charter change.
3. **Full ring-0 event matrix:** final list of `--event` values wired before `wardens sync` exists (manual hook install vs none) — confirm whether implementation PR installs temporary hook snippets or only ships the CLI for `wardens check` + future sync. Preference: ship CLI + tests only; do not hand-edit `.claude/**` or `.cursor/**` in #6.
4. **Shell tokenizer edge cases:** whether `shell-quote`'s parse is sufficient for `LEFTHOOK=0`, Windows paths, and nested quotes in deny detection, or a thinner argv split is enough for v1 deny patterns listed in The Charter.

**Resolved while writing this spec:** `.github/CODEOWNERS` already lists `panopticon.charter.yaml @koszczapinski`; task 2 only needs a verification no-op unless that line is removed before implementation.
