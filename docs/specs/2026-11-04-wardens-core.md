---
status: ready
issue: "#6"
adrs: ["0003", "0004", "0005", "0008", "0009", "0011", "0012", "0013"]
---

# Wardens core: Charter v1, schema validation and ring-0 guard rules

## Goal and context

Issue [#6](https://github.com/LUNARITYai/lunarhunt/issues/6) is the first half of PANOPTICON phase 0 ([ADR-0008](../decisions/0008-autonomy-phases-and-risk-based-merge-policy.md)): put **The Charter** on disk and ship the ring-0 core of the TypeScript Wardens engine. Phase 0 still needs Definition of Done, CI gates and the branch ruleset; those are later issues. This issue delivers the policy file and the four guards an agent hits before a tool call.

The Charter (`panopticon.charter.yaml`) is the only policy source ([ADR-0003](../decisions/0003-the-charter-as-single-source-of-policy.md), amended by [ADR-0013](../decisions/0013-charter-policy-refinements.md)). The engine in `wardens/` ([ADR-0005](../decisions/0005-wardens-engine-in-typescript-with-single-cli.md)) loads it, checks it against `wardens/schema/charter.schema.json`, and evaluates `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard` ([ADR-0004](../decisions/0004-four-rings-of-wardens.md)). Claude Code and Cursor payloads are normalized into one event so each rule is written once. Verdicts follow constitution C-30. A protective failure denies the action (C-03). Exit code 1 is never an enforcement result.

Krzysztof's decisions on the issue are binding. The implementation agent creates `panopticon.charter.yaml` in the implementation PR; Krzysztof reviews it. After that PR merges, The Charter is a deny path for agents. This spec lands first, with `status: draft`. Implementation starts only after Krzysztof sets `status: ready`. The CLI library is **commander**. Per-task scope is read from `.panopticon/task.json` at the worktree root. Until The Ledger exists ([ADR-0010](../decisions/0010-the-ledger-and-observability.md) is out of scope), every hook run appends one JSON line to `.panopticon/wardens.log.jsonl`.

`wardens sync`, generated `.claude/**` and `.cursor/**` configs, lefthook, `charter-drift`, `definition-of-done`, `wardens doctor`, `agent-trailer`, `generated-files-guard`, `worktree-guard`, every ring-2 Warden, Ledger writes, security scanners, and phase 1+ routing, budgets and kill-switch behaviour are out of scope. This issue ships the CLI and tests only. It does not edit `.claude/**`, `.cursor/**`, `lefthook.yml`, `.github/workflows/**`, root `AGENTS.md` or `docs/decisions/**`.

Path globs for these rules are resolved from the worktree root (`git rev-parse --show-toplevel` of the hook `cwd`), as [ADR-0012](../decisions/0012-task-isolation-with-git-worktrees.md) requires for `scope-guard` and `protected-paths`. The Charter `worktree:` section and `worktree-guard` are not part of this issue; they land together in the ADR-0012 implementation. ADR-0009 role `allowed_paths` are stored on the `spec-writer` role and are not enforced here. Narrowing comes only from `task.json`.

## Acceptance criteria (EARS)

### Charter and schema

- THE SYSTEM SHALL contain `panopticon.charter.yaml` at version 1 with `autonomy.phase: 0`, `autonomy.kill_switch: false`, and the sections `roles`, `paths`, `commands`, `covenant`, `risk`, `require_spec_for`, `specs`, `quality_gates`, `budgets`, `log_access` and `ledger`, with the values in Plan (Charter v1).
- THE SYSTEM SHALL contain `wardens/schema/charter.schema.json` (JSON Schema draft 2020-12) that requires `paths.protected.deny`, `paths.protected.ask`, `roles.*.engine`, `roles.*.model`, `roles.*.effort` (including `debugger`), `risk.high`, `risk.medium`, `risk.low`, `require_spec_for` and `covenant.agents_md_exempt`.
- WHEN `panopticon.charter.yaml` is validated, THE SYSTEM SHALL reject a negated glob other than the exact string `!*.example` in `paths.protected.deny` and `paths.secrets_deny_read`.
- WHEN `panopticon.charter.yaml` is validated, THE SYSTEM SHALL fail when `paths.protected.deny` does not contain `panopticon.charter.yaml`.
- WHEN `pnpm check` runs, THE SYSTEM SHALL run `charter-validate`, Biome, `tsc --noEmit` with the repository strict TypeScript settings, and Vitest for the `wardens` package, using the existing CI job `check`.
- THE SYSTEM SHALL build `@lunarhunt/wardens` with tsup into one file `wardens/dist/wardens.mjs` via `pnpm --filter wardens build`, and that file SHALL stay uncommitted.
- WHEN `panopticon.charter.yaml` is not already owned by `@koszczapinski` in `.github/CODEOWNERS`, THE SYSTEM SHALL add that ownership line. The current file already has it, so the implementation PR makes no CODEOWNERS edit unless the line is gone.
- THE SYSTEM SHALL append `.panopticon/` to `.gitignore` and SHALL NOT change any other gitignore rule.

### Normalization and CLI

- WHEN `wardens hook --tool claude|cursor --event <event>` receives a hook JSON document on stdin, THE SYSTEM SHALL normalize it with zod into the event in Plan (Normalized event) before any rule runs.
- WHEN `wardens check <rule>` receives that normalized event on stdin, THE SYSTEM SHALL print one JSON verdict and exit 0 for `allow` and 2 for `deny`, `ask`, `rewrite` or an engine failure.
- THE SYSTEM SHALL expose `wardens check charter-validate`, which validates `panopticon.charter.yaml` at the git toplevel and uses the same exit codes.

### Rules

- WHEN an agent edits, writes or deletes `panopticon.charter.yaml` or `.env.local`, THE SYSTEM SHALL deny via `protected-paths`.
- WHEN an agent edits `docs/constitution.md` inside the task scope in an interactive event, THE SYSTEM SHALL return `ask` via `protected-paths`.
- WHEN an agent edits `docs/constitution.md` inside the task scope in a non-interactive event, THE SYSTEM SHALL deny via `protected-paths`.
- WHEN an agent edits `docs/constitution.md` inside the task scope from `claude -p` or `agent -p`, the payload omits `interactive`, and `PANOPTICON_INTERACTIVE` is not `1`, THE SYSTEM SHALL deny via `protected-paths`.
- WHEN an agent edits, writes or deletes a path outside the Charter `allowed_paths` narrowed by `.panopticon/task.json`, THE SYSTEM SHALL deny via `scope-guard`.
- WHEN an agent edits a path outside the task scope that is not on `paths.protected.deny`, including root `AGENTS.md`, root `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`, `.gitignore` or root `.env.example`, THE SYSTEM SHALL deny via `scope-guard` and SHALL NOT return `ask`.
- WHEN `.panopticon/task.json` is absent, THE SYSTEM SHALL apply `scope-guard` using Charter `paths.allowed_paths` only.
- WHEN `.panopticon/task.json` is present but invalid, THE SYSTEM SHALL deny edit, write and delete actions via `scope-guard`.
- WHEN an agent runs `git commit --no-verify -m x`, `git commit -nm x`, `git push --no-verify`, `git push --force`, `git push --force-with-lease`, `git push origin +main` or `LEFTHOOK=0 git commit`, THE SYSTEM SHALL deny via `command-guard`.
- WHEN an agent runs `curl` or `wget` piped into `sh`, `bash` or `zsh`, including `sudo` before the shell, THE SYSTEM SHALL deny via `command-guard`. Denied commands include `curl x | sh`, `curl x | bash`, `curl x | zsh`, `curl x | sudo sh`, `wget -qO- x | bash` and `wget x | sudo zsh`.
- WHEN an agent runs `git push -n`, `git commit -m "ship it"` or `echo ok | cat`, THE SYSTEM SHALL allow via `command-guard`.
- WHEN an agent runs `npm install` with no extra arguments, THE SYSTEM SHALL return `rewrite` via `command-guard` with replacement `pnpm install`.
- WHEN an agent reads `.env` or `.env.production`, or runs `cat .env`, `cat < .env`, `source .env`, `. .env` or `curl --config=.env`, THE SYSTEM SHALL deny via `secret-read-guard`.
- WHEN an agent reads `.env.example`, THE SYSTEM SHALL allow via `secret-read-guard`.

### Blocking, fail-closed and logging

- WHEN a rule denies, asks or rewrites, THE SYSTEM SHALL show a message matching `Blocked by Warden <rule-id>: <what was blocked and why>. <Next allowed action>.`
- THE SYSTEM SHALL NOT exit 1 for an allow, deny, ask, rewrite or engine failure.
- WHEN a Claude Code decision is allow, THE SYSTEM SHALL exit 0 with empty stdout and SHALL NOT emit `permissionDecision: "allow"`.
- WHEN a Claude Code decision is deny or ask, THE SYSTEM SHALL exit 0 and emit `hookSpecificOutput.permissionDecision` of `deny` or `ask` with the C-30 text in `permissionDecisionReason`.
- IF the engine cannot load or validate The Charter, cannot parse stdin, cannot map the event, resolves a path outside the worktree, or throws, THE SYSTEM SHALL deny with rule id `engine`.
- WHEN a hook or `wardens check` invocation finishes with a verdict, THE SYSTEM SHALL append exactly one JSON object to `<worktree>/.panopticon/wardens.log.jsonl`.
- THE SYSTEM SHALL omit file contents, `user_email` and absolute `cwd` from that log line.
- IF the verdict line cannot be appended, THE SYSTEM SHALL deny with rule id `engine`.

### Tests

- THE SYSTEM SHALL contain at least one allowing Vitest case and one denying Vitest case for each of `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard`.
- THE SYSTEM SHALL contain contract tests for every hook event in the mapping table, using Cursor payloads recorded from a real `cursor-agent` session and Claude Code payloads built from the official hooks documentation.
- WHEN a Claude Code fixture was built from documentation, THE SYSTEM SHALL require `_meta.source` `claude-docs` and `_meta.provisional` true, and SHALL fail the suite if a Cursor fixture uses that marker.

## Plan

### Approach

1. Replace the placeholder `wardens/` package with a strict TypeScript package: Biome, Vitest (node environment), commander, zod, the `yaml` package, Ajv (draft 2020-12), picomatch and tsup. New packages go in the `pnpm-workspace.yaml` catalog and are referenced as `catalog:`.
2. Write `panopticon.charter.yaml` v1 as specified below. The JSON Schema is the structural check; `charter-validate` adds the negation check and the required deny entry.
3. Normalize hook stdin into one event. Rules receive only that event plus the parsed Charter and the optional task file.
4. Implement the four rules, `wardens hook` and `wardens check`.
5. Give the package `lint` (`biome check .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`) and `check` scripts. `check` runs `node --experimental-strip-types src/cli.ts check charter-validate`. Turborepo already runs `lint`, `typecheck` and `test` before `check` for every package that defines `check` (same pattern as `apps/web`). No workflow file changes.
6. tsup writes a single ESM bundle `wardens/dist/wardens.mjs` with dependencies inlined. `package.json` `bin.wardens` points at that file. Hooks are not installed in this issue; the follow-up `wardens sync` will call `node <bundle> hook …` with `onFailure: "block"` / `failClosed: true`.
7. Append `.panopticon/` to `.gitignore`. Confirm CODEOWNERS. Do not edit it while `panopticon.charter.yaml @koszczapinski` is present (it is, today).

Package layout: `wardens/src/**` for the engine, `wardens/test/**` for Vitest and fixtures, `wardens/tsconfig.json` extending `tsconfig.base.json` (no DOM lib), `wardens/vitest.config.ts` with `environment: "node"`. Tests call pure functions with an explicit root. They must not read a developer `.panopticon/task.json` from the real worktree. CLI tests use a temporary git repository.

`wardens/AGENTS.md` may be updated because `wardens/**` is an allowed path. Root `AGENTS.md` stays unchanged.

### Settled conflicts

These disagree inside the source ADRs or with issue #6. The issue acceptance criteria win.

| Topic | Settlement |
| --- | --- |
| Negated globs | Issue #6 and the ADR-0013 confirmation allow only the exact pattern `!*.example`. The ADR-0013 YAML sketch writes `!.env.example`. Charter v1 uses `!*.example`. `charter-validate` rejects `!.env.example`. picomatch 4 with `{ dot: true }` matches `.env.example` against `*.example` (checked 2026-11-04). |
| `escalate_to` | ADR-0009: object `{ model, effort }`, either field optional. Charter v1 requires `{ engine, model, effort }` on every role and on `escalate_to`. The ADR-0003 sketch's bare `opus` string is not valid v1. |
| Role routing | ADR-0009 stores tool-neutral aliases (`opus`, `sonnet`) and no engine. Charter v1 gives every role and `escalate_to` an `engine` (`claude` or `cursor`), a base `model`, and a separate `effort`. An engine adapter composes the invocation: Cursor model ids are `${model}-${effort}` plus `-fast` when `fast` is true; Claude Code passes the documented `--effort` flag. v1 roles all use `cursor` and `grok-4.7`. Overseer, spec-writer, sentinel and debugger use effort `high`; implementer and reviewer use `medium`; implementer `escalate_to` uses effort `high`. `grok-4.7-high` is not a legal `model`. Optional `fast` defaults to false. This updates ADR-0009 routing and will be recorded in the decision log. |
| `worktree:` | Not in the issue's section list, and `worktree-guard` is out of scope. The schema rejects unknown top-level keys. The ADR-0012 follow-up adds the section and the guard together. |
| `commands.allow` | ADR-0004: `command-guard` denies `commands.deny` and applies `commands.rewrite`. ADR-0005: hard allow/deny in the generated permission system belongs to `wardens sync`. Ring 0 does not treat `commands.allow` as an allowlist. |
| Pipe-to-shell | Krzysztof decided Charter v1 denies `curl` or `wget` piped into `sh`, `bash` or `zsh`, including `sudo` before the shell (`curl x \| sudo sh`, `wget -qO- x \| bash`). Each pair is its own `commands.deny` pattern. `echo ok \| cat` stays allowed. |
| `git push --force*` | The pattern matches `--force` and `--force-with-lease`. Krzysztof confirmed `--force-with-lease` stays denied; the matcher must not special-case it. A refspec with a leading `+` is denied too (`git push origin +main` matches `git push +*`). |
| Hook install | Issue allowed paths forbid `.claude/**` and `.cursor/**`. This issue does not install hooks. |
| Headless bit | Claude Code and Cursor hook docs (2026-11-04) do not document a headless flag on `PreToolUse` / `beforeShellExecution`. `interactive` defaults to false unless the payload sets it or `PANOPTICON_INTERACTIVE=1`. A `-p` run without that variable is non-interactive, so `ask` denies. `wardens sync` (out of scope) sets `PANOPTICON_INTERACTIVE=1` only for an interactive session. |
| `protected.ask` outside scope | `ask` is returned only for a path inside the task scope. Root `AGENTS.md`, root `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`, `.gitignore` and root `.env.example` are outside `paths.allowed_paths`, and a task cannot widen scope (C-11), so those edits are denied and `ask` does not fire. Charter v1 omits ask globs that cannot match any `allowed_paths` entry (`.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`). Basename globs `AGENTS.md`, `CLAUDE.md` and `.env.example` stay, because they also match in-scope copies. `panopticon.charter.yaml` stays on the deny list. |

### Charter v1

Normative contents. `charter-validate` accepts this document and rejects the cases in the test plan.

```yaml
version: 1
project: lunarhunt

autonomy:
  phase: 0
  kill_switch: false

roles:
  overseer: { engine: cursor, model: grok-4.7, effort: high }
  spec-writer:
    engine: cursor
    model: grok-4.7
    effort: high
    allowed_paths: ["docs/specs/**", "docs/decisions/**"]
  implementer:
    engine: cursor
    model: grok-4.7
    effort: medium
    escalate_to: { engine: cursor, model: grok-4.7, effort: high }
  reviewer: { engine: cursor, model: grok-4.7, effort: medium, read_only: true }
  sentinel: { engine: cursor, model: grok-4.7, effort: high, read_only: true }
  debugger: { engine: cursor, model: grok-4.7, effort: high, read_only: true }

paths:
  allowed_paths:
    - "apps/**"
    - "packages/**"
    - "wardens/**"
    - "docs/**"
    - "pnpm-lock.yaml"
    - "pnpm-workspace.yaml"
    - "turbo.json"
  protected:
    deny:
      - "panopticon.charter.yaml"
      - ".env"
      - ".env.*"
      - "!*.example"
      - "secrets/**"
    ask:
      - "docs/constitution.md"
      - "AGENTS.md"
      - "**/AGENTS.md"
      - "CLAUDE.md"
      - "apps/api/migrations/**"
      - ".env.example"
    non_interactive_ask: deny
  generated:
    - "packages/api-client/src/**"
    - "packages/contracts/openapi.json"
  secrets_deny_read:
    - ".env"
    - ".env.*"
    - "!*.example"
    - "secrets/**"

commands:
  deny:
    - "git push --force*"
    - "git push -f*"
    - "git push +*"
    - "kubectl * --context prod*"
    - "npm publish*"
    - "curl * | sh"
    - "curl * | bash"
    - "curl * | zsh"
    - "curl * | sudo sh"
    - "curl * | sudo bash"
    - "curl * | sudo zsh"
    - "wget * | sh"
    - "wget * | bash"
    - "wget * | zsh"
    - "wget * | sudo sh"
    - "wget * | sudo bash"
    - "wget * | sudo zsh"
    - "git commit --no-verify*"
    - "git commit -n*"
    - "git push --no-verify*"
    - "git merge --no-verify*"
    - "LEFTHOOK=0 *"
    - "git -c core.hooksPath=*"
    - "git config core.hooksPath*"
    - "wardens worktree remove * --force*"
  allow:
    - "pnpm turbo run *"
    - "pnpm check*"
    - "uv run pytest *"
    - "uv run ruff *"
  rewrite:
    npm install: pnpm install

covenant:
  agents_md_exempt: ["packages/contracts", "packages/api-client"]

risk:
  high:
    paths:
      - "**/auth/**"
      - ".env*"
      - "secrets/**"
      - ".github/**"
      - "panopticon.charter.yaml"
      - "docs/constitution.md"
      - "AGENTS.md"
      - "**/AGENTS.md"
      - "CLAUDE.md"
      - ".claude/**"
      - ".cursor/**"
      - "lefthook.yml"
      - "deploy/**"
      - "apps/api/migrations/**"
      - "wardens/**"
      - "docs/decisions/**"
      - "docs/decision-log.md"
    labels: ["test:waived", "needs:human"]
  medium: { default: true }
  low:
    paths: ["docs/**", "**/*.test.*", "**/tests/**"]
    all_files_must_match: true
    max_changed_lines: 200

require_spec_for:
  - issue_types: ["type:feature"]
    paths: ["apps/**"]

specs:
  non_spec_files:
    - "docs/specs/AGENTS.md"
    - "docs/specs/TEMPLATE.md"
    - "docs/specs/**/README.md"

quality_gates:
  definition_of_done: ["lint", "typecheck", "test:affected", "contract:drift"]
  diff_coverage_min: 80
  max_pr_changed_lines: 600

budgets:
  per_task: { max_cost_usd: null, max_turns: null }
  per_night: { max_cost_usd: null }

log_access:
  local: { roles: all }
  preview: { roles: all }
  staging: { roles: [debugger] }
  production: { requires: human_approval }
  limits: { max_time_range: "24h", max_results: 500 }
  redact: [secrets, pii, cv_data]

ledger:
  sink: [postgres, otlp]
  capture_content: false
```

`paths.allowed_paths` starts from the ADR-0003 sketch and adds `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `turbo.json`, which issue #6 already permits, so a later `task.json` can narrow to them. An issue may narrow this list and cannot widen it (C-11).

`paths.protected.ask` applies only to a path inside the task scope (Charter `allowed_paths`, narrowed by `task.json` when that file is present and valid). An edit outside that scope is denied regardless, and the ask list is not consulted for it. Root `AGENTS.md`, root `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`, `.gitignore`, root `.env.example` and `panopticon.charter.yaml` are outside `paths.allowed_paths`. `panopticon.charter.yaml` is also on the deny list, so `protected-paths` denies it. `.claude/**`, `.cursor/**`, `.github/**` and `deploy/**` are omitted from `ask` because no `allowed_paths` glob can match them. `AGENTS.md`, `CLAUDE.md` and `.env.example` remain: with no `/` they match a basename, including in-scope files such as `wardens/AGENTS.md`, `apps/web/CLAUDE.md` and `apps/api/.env.example`. The root copies of those names stay outside scope, so editing them is `scope-guard` deny.

Schema rules beyond "required keys exist":

- `version` is `1`. `project` is a non-empty string. `autonomy.phase` is an integer 0 through 3. `autonomy.kill_switch` is a boolean. The file's values are `0` and `false`; the schema allows a later phase change.
- `roles` requires `overseer`, `spec-writer`, `implementer`, `reviewer`, `sentinel` and `debugger`. Every role has `engine` (`claude` or `cursor`), `model` (a non-empty base model id; an engine that embeds effort in the id rejects a value that already ends with an effort suffix or `-fast`) and `effort` (a level that engine accepts: `low`, `medium`, `high` or `xhigh` for `cursor`; `low`, `medium` or `high` for `claude`). `engine` is an enum equal to the adapter registry keys. `model` is not an enum. Optional `fast` is a boolean and defaults to false. `escalate_to`, when present, uses the same `engine`, `model` and `effort` rules. A missing `engine` fails validation. An unknown `engine` fails validation.
- `paths.protected.non_interactive_ask` is the const `deny`.
- `budgets` numeric fields allow JSON `null`.
- Unknown top-level keys fail validation, including `worktree`.
- A `!` prefix is legal only as the exact item `!*.example`, and only inside `paths.protected.deny` and `paths.secrets_deny_read`. Any other `!` fails validation, including inside `allowed_paths`.
- `paths.protected.deny` must contain the item `panopticon.charter.yaml`.

After Ajv succeeds, a zod parser accepts the same document. A test feeds the normative YAML through both and expects both to accept it. Zod must not reject a schema-valid Charter.

`risk`, `quality_gates`, `budgets`, `log_access`, `ledger`, `specs` and `covenant` are validated and stored. No Warden in this issue enforces them. `generated-files-guard` does not run, so `paths.generated` is not enforced here.

### Glob matching

Library: **picomatch** with `{ dot: true }`. A leading `!` is not passed to picomatch. The engine strips it and treats `*.example` as an exception pattern.

Path preparation, before any glob:

1. Take `cwd` from the hook payload. If it is missing, use `process.cwd()`.
2. `git rev-parse --show-toplevel` from that directory. If git fails, deny with rule `engine`.
3. Turn `\` into `/`. Resolve the candidate against the toplevel.
4. If the file exists, use its realpath. If it does not, resolve the parent lexically and keep the final segment un-resolved, so a not-yet-created file still works.
5. If the result is outside the toplevel, deny with rule `engine`.
6. Store the repo-relative POSIX path with no leading `./` on the event as `path`.

Match rules:

- A pattern that contains no `/` is matched against the path's basename. `.env.*` then matches `.env.local` in any directory, and `*.example` matches `.env.example`.
- A pattern that contains `/` is matched against the full repo-relative path. `**/AGENTS.md` matches `AGENTS.md` and `docs/specs/AGENTS.md`. `apps/**` matches `apps/web/a.ts`.
- Deny-list evaluation is last-match-wins, starting from "not denied". A normal match sets denied. The exception `!*.example` clears denied when the basename matches `*.example`. A later match can deny again. `secrets/foo.example` matches `!*.example` and then `secrets/**`, so it stays denied. `.env.example` matches `.env.*` and then `!*.example`, so the deny list does not catch it.
- `protected.ask`, `allowed_paths` and task globs use "any pattern matches". They have no exceptions. An ask match is returned only when the path is also inside the task scope.
- `deny` wins over `ask` when both match (ADR-0013 D1).

### Command matching

`command-guard` does not glob the raw command string. ADR-0013 D2 requires parsed flags, including a combined short flag such as `-nm`.

Tokenizer (no shell library):

- Split words on unquoted whitespace. Single quotes are literal. Double quotes honour `\\` and `\"`. A backslash outside quotes escapes the next character.
- In the normal state, `&&`, `||`, `;`, `|` and newline split pipeline segments. `|` is a pipe only when it is not part of `||`.
- Words before the program that match `^[A-Za-z_][A-Za-z0-9_]*=` are environment assignments (`LEFTHOOK=0`). Later `NAME=value` words stay in argv.
- An unclosed quote, a trailing backslash, an unquoted `` ` ``, or an unquoted `$(` is a tokenization failure. `command-guard` then denies (C-03). The engine does not expand variables. `cat "$ENV_FILE"` is best effort, as ADR-0013 D5 says, and is not required to deny.

Git short flags, only when `argv[0]` is `git`:

- A token matching `^-[a-zA-Z]{2,}$` splits into one `-letter` token per character, in order. `-nm` becomes `-n`, `-m`. `--long` tokens and single-letter tokens stay as written.
- These options consume the following token as a value, so it is not a flag: global `-c`, `--config`, `-C`; `commit` `-m`, `--message`, `-F`, `--file`.
- `git commit -m "ship it"` has no `-n` flag and is allowed. `git commit -nm x` still has `-n` and is denied. `git commit -m --no-verify` stores the message `--no-verify` and is allowed. `git push -n` is dry-run and is allowed. `git push -nf` still has `-f` and is denied.

A `commands.deny` pattern matches if any segment matches it. Patterns that contain ` | ` match only a real pipe: the left pattern matches one segment and the right pattern matches the next segment. There is no alternation, so each downloader and each shell is its own pattern. `curl *` and `wget *` require at least one argument, which covers flags such as `wget -qO- x`. The right-hand side is `sh`, `bash` or `zsh`, or `sudo` immediately followed by one of those names. `curl x | sh`, `curl x | bash`, `curl x | zsh`, `curl x | sudo sh`, `wget -qO- x | bash` and `wget x | sudo zsh` deny. `echo ok | cat` does not. `echo ok && git commit --no-verify` denies because the second segment matches `git commit --no-verify*`.

Pattern tokens against one segment's argv, in order, as a subsequence (not a string prefix):

- The first token equals `argv[0]`, except an environment pattern.
- A token that is only `*` and is not last consumes one or more argv tokens, backtracking so a later token can match. A final `*` consumes zero or more. `kubectl * --context prod*` therefore matches `kubectl get pods --context prod`. `LEFTHOOK=0 *` matches any argv when that environment variable's value is `0`.
- Any other token containing `*` matches exactly one argv token, and `*` matches any characters, including `/` and the empty string. This is not picomatch: picomatch's `*` does not match `/`, so `core.hooksPath=*` would miss `core.hooksPath=/dev/null`. `--force*` matches `--force` and `--force-with-lease`. The matcher must not special-case `--force-with-lease`. `+*` matches one argv token that starts with `+`. `-n*` matches `-n` and does not match `--no-verify`.
- Any other token equals exactly one argv token.
- `git commit -n*` matches when some token is `commit` and a later token matches `-n*`. It does not match `git push -n`.
- `git push +*` matches when some token is `push` and a later token matches `+*`. `git push origin +main` denies. `git push origin main` does not.
- `git -c core.hooksPath=*` matches the separate argv words `-c` and `core.hooksPath=…`.

`commands.rewrite` matches only a single segment with no environment assignments whose argv is exactly `["npm", "install"]`. `npm install left-pad` is not rewritten. Rewrite loses to any `deny` from another rule or from `commands.deny`.

### `.panopticon/task.json`

The coordinator writes this file at the worktree root. It is gitignored. The engine only reads it.

```json
{
  "issue": 6,
  "allowed_paths": ["wardens/**", "docs/specs/2026-11-04-wardens-core.md"],
  "branch": "feat/6-wardens-core-charter",
  "slug": "wardens-core"
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `issue` | yes | Integer ≥ 1 |
| `allowed_paths` | yes | Non-empty array of non-empty strings. No entry may start with `!` |
| `branch` | no | Non-empty string. Not enforced (`worktree-guard` is out of scope) |
| `slug` | no | Non-empty string. Not enforced |

Zod `.strict()` rejects missing required fields, an empty `allowed_paths`, a `!` glob and unknown keys.

A path is in scope when it matches at least one Charter `allowed_paths` glob and, if the task file exists and is valid, at least one task glob. A task glob outside the Charter matches nothing. An empty intersection denies every edit. A missing file means Charter globs only. An invalid file denies edit, write and delete, and does not affect read or shell rules.

### Normalized event

zod `.strict()` object. Adapters copy these fields and nothing else. Claude `tool_input.content`, `old_string`, `new_string` and Cursor `beforeReadFile.content` and `user_email` are dropped before the object is built.

| Field | Type | Source |
| --- | --- | --- |
| `tool` | `"claude"` \| `"cursor"` | `--tool` |
| `event` | string | `--event` |
| `action` | `shell` \| `read` \| `edit` \| `write` \| `delete` \| `mcp` | mapping table |
| `path` | string \| null | repo-relative POSIX path, or null |
| `command` | string \| null | raw command string for `shell`, else null |
| `mcp_server` | string \| null | server name, else null |
| `session_id` | string \| null | Claude `session_id`. Cursor `session_id`, else `conversation_id` |
| `agent` | string \| null | Claude `agent_type`, else null |
| `model` | string \| null | Cursor `model`. Claude `model` only when the payload has a string `model` |
| `interactive` | boolean | see below |
| `cwd` | string | payload `cwd`, else `process.cwd()` |

`interactive` defaults to false. It is true only when the payload boolean `interactive` is true, or when that field is absent and `PANOPTICON_INTERACTIVE` is `1` or `true`. The value is the first match of:

1. A boolean `interactive` on the payload, when that field is present.
2. `PANOPTICON_INTERACTIVE` set to `1` or `true` → true, or to `0` or `false` → false.
3. Otherwise `false`, including when the variable is unset.

A `claude -p` or `agent -p` run that omits `interactive` and does not set `PANOPTICON_INTERACTIVE=1` is non-interactive, so `ask` becomes `deny`. Headless fixtures may set `"interactive": false` on the payload. Non-interactive `ask` becomes `deny` inside `protected-paths` before precedence, with next action `Label the issue needs:human.`

Mapping. `--tool` plus `--event` plus `tool_name` selects the row. Any other combination denies with rule `engine`, so an unmapped tool cannot fail open. `wardens sync` must later match only these tools.

| Tool | Event | Condition | Action | Path | Command | MCP server |
| --- | --- | --- | --- | --- | --- | --- |
| claude | `PreToolUse` | `tool_name` `Bash` or `PowerShell` | shell | null | `tool_input.command` | null |
| claude | `PreToolUse` | `Read` | read | `tool_input.file_path` | null | null |
| claude | `PreToolUse` | `Edit` | edit | `tool_input.file_path` | null | null |
| claude | `PreToolUse` | `Write` | write | `tool_input.file_path` | null | null |
| claude | `PreToolUse` | `tool_name` starts with `mcp__` | mcp | null | null | `mcp_server.name` |
| cursor | `beforeShellExecution` | — | shell | null | `command` | null |
| cursor | `beforeReadFile` | — | read | `file_path` | null | null |
| cursor | `preToolUse` | `tool_name` `Shell` | shell | null | `tool_input.command` | null |
| cursor | `preToolUse` | `Read` | read | `file_path`, else `path` | null | null |
| cursor | `preToolUse` | `Write` | write | `file_path`, else `path` | null | null |
| cursor | `preToolUse` | `Delete` | delete | `file_path`, else `path` | null | null |
| cursor | `beforeMCPExecution` | — | mcp | null | null | `mcp_server_name` |
| cursor | `preToolUse` | `tool_name` starts with `MCP:` | mcp | null | null | `mcp_server_name` if present, else the tool name |

Cursor's public `preToolUse` example shows `Shell` only. Recorded fixtures are authoritative for Read, Write and Delete field names. The adapter tries `file_path` then `path`. If a recorded fixture uses another key, the adapter follows the fixture in the same PR. A fixture labelled `recorded-cursor-session` that was not recorded is a test failure; do not invent one.

Which rules run:

| Rule | Actions | Behaviour |
| --- | --- | --- |
| `protected-paths` | edit, write, delete | deny list, else ask list when the path is inside the task scope, else no objection. Non-interactive ask becomes deny. A null path denies. Outside the task scope, `ask` does not apply. |
| `scope-guard` | edit, write, delete | in-scope check above. A null path denies. |
| `secret-read-guard` | read, shell | read: `path` against `secrets_deny_read`. shell: the path scan below. A null read path denies. |
| `command-guard` | shell | deny patterns, else rewrite, else no objection. |

On `shell`, `secret-read-guard` tokenizes the command and denies if any resolved path matches `secrets_deny_read`. These are paths:

- an argv word that does not start with `-` (`cat .env` denies; `cat .env.example` allows)
- the value after the first `=` in a `--opt=value` word (`curl --config=.env` denies)
- the target of an input redirection `<`, either the word after a `<` token or the remainder of a `<file` token (`cat < .env` and `cat <.env` deny)
- the operand of `source`, and the operand of a command whose `argv[0]` is `.` (`source .env` and `. .env` deny)

#### Known limitations

The shell secret scan does not expand variables, so `cat "$ENV_FILE"` and `source "$ENV_FILE"` are not denied here. It does not re-parse a script passed to `sh -c` or `bash -c`. It does not treat environment assignments (`FOO=.env cat`), process substitution, here-documents, here-strings, output redirections (`>` and `>>`) or a short option with an attached value (`-f=.env`) as secret paths.

`mcp` is normalized and does not by itself trip these four rules. A follow-up owns MCP policy.

Precedence when several rules object: `deny` beats `rewrite`, then `ask`, then allow. Same severity: `protected-paths`, `secret-read-guard`, `command-guard`, `scope-guard`. One winner. `cat .env` is `secret-read-guard`. An edit of `.env.local` that is also outside the task is `protected-paths`, not `scope-guard`. `ask` applies only inside the task scope. An edit outside that scope is denied regardless: root `AGENTS.md`, root `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`, `.gitignore` and root `.env.example` are `scope-guard` deny, including when a basename glob would otherwise ask. `panopticon.charter.yaml` is `protected-paths` deny. An interactive edit of `docs/constitution.md` inside the task is `protected-paths` ask; the same edit outside the task is `scope-guard` deny.

### Hook responses

Stdout is either empty or one JSON object. No log lines on stdout. Exit 0 when the process produced a decision, including deny and engine deny. Exit 2 only when the process cannot write that JSON; the C-30 line goes to stderr. Never exit 1.

| Verdict | Claude Code `PreToolUse` | Cursor |
| --- | --- | --- |
| allow | exit 0, empty stdout | exit 0, `{"permission":"allow"}` |
| deny | exit 0, `permissionDecision: "deny"`, reason is the C-30 line | exit 0, `permission: "deny"`, `agent_message` and `user_message` are the C-30 line |
| ask | exit 0, `permissionDecision: "ask"`, reason is the C-30 line | `beforeShellExecution`: `permission: "ask"` with the same messages. `preToolUse`: Cursor does not enforce `ask`, so emit `permission: "deny"` (ADR-0013: no native ask degrades to deny) |
| rewrite | exit 0, `updatedInput` is the original `tool_input` with `command` set to `pnpm install`, no `permissionDecision`. `additionalContext` is the C-30 line | `preToolUse`: `permission: "allow"` and `updated_input` with `command: "pnpm install"`. `beforeShellExecution` has no updated-input field: `permission: "deny"` and the C-30 line whose next action is `Run pnpm install.` |

`wardens check` does not render a tool. It prints `{ "rule", "decision", "message", "replacement", "rendered" }` and exits 0 or 2 as in the acceptance criteria. `wardens check` exits 2 on deny; `wardens hook` exits 0 and carries the deny in JSON. `rendered` equals `decision` except for a Cursor `preToolUse` ask, where `decision` stays `ask` and `rendered` is `deny`.

Message shape, locked by a unit test:

```text
/^Blocked by Warden [a-z0-9-]+: .+\. .+\.$/
```

Examples the tests assert as substrings (rule id, the blocked thing, and the next action):

- `Blocked by Warden scope-guard: path infra/main.tf not in allowed_paths for this task. Ask for needs:human.`
- `Blocked by Warden protected-paths: panopticon.charter.yaml is deny for agents. A human must change it in a reviewed PR.`
- `Blocked by Warden protected-paths: docs/constitution.md requires approval. Ask Krzysztof to approve this edit in the session.`
- `Blocked by Warden protected-paths: docs/constitution.md requires ask and this session is non-interactive. Label the issue needs:human.`
- `Blocked by Warden protected-paths: docs/constitution.md requires ask and this hook cannot prompt. Label the issue needs:human.`
- `Blocked by Warden command-guard: git commit --no-verify is denied. Remove --no-verify and retry.`
- `Blocked by Warden command-guard: npm install is rewritten to pnpm install. Run pnpm install.`
- `Blocked by Warden secret-read-guard: reading .env is denied. Use .env.example for non-secret templates.`
- `Blocked by Warden engine: Charter validation failed. Label the issue needs:human.`

### Fail-closed

| Condition | Result |
| --- | --- |
| Charter missing, unreadable, invalid YAML, schema failure or zod failure | deny, rule `engine` |
| Stdin empty, not JSON, or not the object the event requires | deny, rule `engine` |
| Unknown tool, event or tool name | deny, rule `engine` |
| Path escapes the worktree | deny, rule `engine` |
| A rule throws | deny, rule `engine` |
| Log append throws | deny, rule `engine`, and do not try to log again |
| Invalid `task.json` | deny edit/write/delete via `scope-guard`; reads and shell commands still run the other rules |
| Exit code 1 | not used |

Tool-level `onFailure: "block"` and `failClosed: true` are generated by `wardens sync`, not by this issue. The engine still denies when it is actually invoked.

### JSONL verdict log

Path: `<toplevel>/.panopticon/wardens.log.jsonl`. Create `.panopticon/` if needed. Append one line per `wardens hook` or `wardens check` invocation, the winning verdict only. `JSON.stringify` the object so a newline inside a string cannot break the file.

```json
{
  "ts": "2026-11-04T02:15:30.123Z",
  "rule": "secret-read-guard",
  "decision": "deny",
  "rendered": "deny",
  "duration_ms": 4,
  "tool": "cursor",
  "event": "beforeReadFile",
  "action": "read",
  "path": ".env",
  "command": null,
  "mcp_server": null,
  "session_id": "sess_abc",
  "agent": null,
  "model": null,
  "interactive": true,
  "message": "Blocked by Warden secret-read-guard: reading .env is denied. Use .env.example for non-secret templates.",
  "replacement": null
}
```

`ts` is UTC with milliseconds. `duration_ms` is an integer ≥ 0. `rule` is `none` when every rule allows, and `decision` is then `allow`, `message` null, `replacement` null. `replacement` is `pnpm install` only for rewrite. `decision` is the rule verdict (`allow`, `deny`, `ask`, `rewrite`). `rendered` is what the tool was sent. No other keys. A test fixture that puts a sentinel in `content` and `user_email` must not find that sentinel in the log line.

### Fixtures and test plan

Fixture files:

```text
wardens/test/fixtures/claude/*.json
wardens/test/fixtures/cursor/*.json
```

```json
{
  "_meta": {
    "source": "claude-docs",
    "provisional": true,
    "tool": "claude",
    "event": "PreToolUse"
  },
  "stdin": {}
}
```

The harness strips `_meta` and passes `stdin` to the adapter. Cursor files use `"source": "recorded-cursor-session"` and `"provisional": false`. Each mapping-table row has at least one fixture. The contract test asserts the normalized `action`, `path`, `command` and `mcp_server`, and the engine verdict for that payload against the normative Charter.

| Area | Allow / expected pass | Deny / ask / rewrite |
| --- | --- | --- |
| `scope-guard` | edit `wardens/src/cli.ts` inside Charter ∩ task | edit `infra/main.tf`; task glob `infra/**` still denies; missing task file allows `docs/specs/x.md` and denies `infra/main.tf`; invalid task file denies the edit and still allows a read of `.env.example` |
| `protected-paths` | edit `apps/web/app.tsx` | edit or delete `panopticon.charter.yaml`, and edit `.env.local`, deny; interactive in-scope edit of `docs/constitution.md` or `apps/api/.env.example` is ask; the same edit with `interactive: false` denies; a `-p` payload that omits `interactive` and has no `PANOPTICON_INTERACTIVE=1` denies; root `AGENTS.md`, root `CLAUDE.md`, `.github/**`, `.claude/**`, `.cursor/**`, `deploy/**`, `.gitignore` and root `.env.example` are `scope-guard` deny |
| `command-guard` | `git push -n`, `git commit -m "ship it"`, `pnpm install`, `echo ok \| cat`, `git push origin main` | the six issue deny strings; `git push -nf` denies; `git -c core.hooksPath=/dev/null status` denies; `npm install` rewrites; `npm install left-pad` does not; `git push --force-with-lease` denies; `git push origin +main` denies; `curl x \| bash`, `curl x \| zsh`, `curl x \| sudo sh`, `wget -qO- x \| bash` and `wget x \| sudo zsh` deny |
| `secret-read-guard` | read `.env.example`; `cat .env.example` | read `.env`, `.env.production`; `cat .env`; `cat .env.example .env` denies; `cat < .env`, `source .env`, `. .env` and `curl --config=.env` deny |
| Charter | normative YAML passes Ajv and zod; `engine: cursor, model: grok-4.7, effort: medium` passes | `!.env.example` rejected; charter filename removed from deny rejected; `debugger.effort` removed rejected; top-level `worktree` rejected; an empty `model` rejected; missing `engine` rejected; an unknown `engine` rejected; `model: grok-4.7-high` rejected; effort `xhigh` on `claude` rejected |
| Messages | — | every deny, ask and rewrite matches the regex; engine failures do too |
| Fail-closed | — | missing Charter, broken YAML, empty stdin, unknown `tool_name` → deny, exit not 1 |
| JSONL | an allow appends one `allow` line | a deny appends one line; sentinel file contents and `user_email` are absent; a throwing writer yields `engine` deny |
| Hooks | Claude allow has empty stdout | Claude deny/ask JSON; Cursor `preToolUse` ask rendered as deny with `decision` still `ask`; `npm install` `updatedInput.command` is `pnpm install` |
| Contract | each recorded Cursor event maps | each provisional Claude event maps and is marked `claude-docs` |

### Known limitations

- Shell redirections and variable indirection are not path writes. `echo x >> infra/main.tf` is not a `scope-guard` edit. ADR-0013 D5 calls the shell scan best effort.
- `worktree-guard` does not run, so an agent in the primary checkout is not stopped by this issue.
- Claude auto mode can drop `updatedInput` on the first call and ask the model to send the rewritten command again (Claude Code hooks docs, 2026-11-04). The original `npm install` is not approved. `beforeShellExecution` denies it outright.
- Grep and Glob are unmapped, so a hook that receives them denies with `engine`. The sync follow-up must not subscribe those tools.
- `risk-classifier` does not run. The `risk:` keys are stored so the later Warden reads the same file.

### Affected packages

Implementation PR, not this docs PR:

- `panopticon.charter.yaml`
- `wardens/**` (including `wardens/schema/charter.schema.json`, source, tests, `package.json`)
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml` (catalog entries only)
- `turbo.json` only if `check` does not already pull the package in
- `.gitignore` (the `.panopticon/` line only)
- `.github/CODEOWNERS` only if the Charter owner line is missing

No product API, OpenAPI client or database migration.

### ADRs needed

None. No constitution change. The implementation follows ADR-0003, ADR-0004, ADR-0005, ADR-0008, ADR-0009, ADR-0012 (path root only) and ADR-0013.

## Tasks

1. **This spec.** Land `docs/specs/2026-11-04-wardens-core.md` at `status: draft`. Krzysztof sets `status: ready` before any implementation commit.
   **Allowed paths:** `docs/specs/2026-11-04-wardens-core.md`

2. **Package, Charter and schema.** Add the normative `panopticon.charter.yaml`, `wardens/schema/charter.schema.json`, Ajv + zod validation, `wardens check charter-validate`, package scripts, tsconfig, Vitest, tsup bundle, the `.panopticon/` gitignore line, and a CODEOWNERS check that does not edit the file while the owner line exists.
   **Allowed paths:** `panopticon.charter.yaml`, `wardens/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json` (only if needed), `.gitignore`, `.github/CODEOWNERS`

3. **CLI, adapters, log, fail-closed.** commander `hook` and `check`, the normalized event, the mapping table, C-30 messages, the JSONL writer, and hook response rendering.
   **Allowed paths:** `wardens/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`

4. **Rules and tests.** `scope-guard`, `protected-paths`, `command-guard`, `secret-read-guard`, the test-plan cases, and contract fixtures. Record Cursor fixtures from a real session. Claude fixtures cite the docs and set `provisional: true`. If a Cursor session cannot be recorded, stop and label the issue `needs:human` rather than inventing a recorded payload.
   **Allowed paths:** `wardens/**`

## Open questions

None. Krzysztof decided the pipe-to-shell patterns and the force-push patterns; they are Charter v1, not left open. Pipe-to-shell denial covers `curl` and `wget` piped into `sh`, `bash` or `zsh`, including `sudo` before the shell. `git push --force-with-lease` stays denied, and so does a refspec with a leading `+` (`git push origin +main`). The issue left glob matching, combined short flags, `task.json`, the normalized event, the block message, fail-closed behaviour, the JSONL line, fixture sources and the test plan unspecified. Those are fixed in the Plan. The conflicts between ADR sketches and issue #6 are fixed in Settled conflicts.
