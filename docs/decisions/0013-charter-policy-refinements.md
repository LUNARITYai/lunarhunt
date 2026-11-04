---
status: accepted
date: 2026-11-04
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0013: Charter policy refinements

## Context and Problem Statement

Writing `docs/constitution.md` and the root `AGENTS.md` on top of the accepted ADRs 0001–0011 exposed gaps and inconsistencies between them:

- ADR-0003, ADR-0004 and ADR-0006 say Covenant files and The Charter are "denied or require `ask`" without saying which. A hard deny on the Covenant would stop agents from even proposing a constitution change in a PR, although ADR-0006 and C-32 allow exactly that.
- `git commit --no-verify` skips ring 1 (lefthook). Today only CI notices; `commands.deny` in The Charter does not list it.
- The Charter's `definition_of_done` already contains `contract:drift` (ADR-0003), but ADR-0007 runs the contract drift check only in the CI job `contract`, not in `pnpm check`. An agent can stop with a green `pnpm check` and a red PR.
- ADR-0006 requires an `AGENTS.md` in every package. `packages/contracts` and `packages/api-client` are generated; a hand-written `AGENTS.md` there would be noise.
- `secrets_deny_read: [".env", ".env.*", ...]` also blocks `.env.example`, the template that ADR-0012 worktree setup reads.
- The `debugger` role exists in The Charter outline (ADR-0003) and in `log_access` (ADR-0010) but has no model or effort, which violates the ADR-0009 Confirmation ("every role has a `model` and an `effort`").
- The `risk:` section in the ADR-0003 outline lists fewer high-risk paths than ADR-0008, and `require_spec_for` (ADR-0011) is missing from the outline.

Krzysztof decided the open points on 2026-11-04. This ADR records them in one place and amends the affected accepted ADRs, as required by ADR-0002. Dependency updates (Renovate) are a separate decision: ADR-0014.

## Decision Drivers

- The Charter must be the single, complete source of policy (C-04); every rule in the Covenant must map to a Charter key or a Warden
- Agents may propose changes to their own instructions, but never apply them without Krzysztof
- Secrets and The Charter are never writable by agents, in any phase
- `pnpm check` green locally must predict `panopticon/gate` green in CI (C-12)
- No noise files; generated code is clearly marked
- Fail-closed when in doubt (C-03)

## Considered Options

1. One consolidating ADR that amends ADR-0003, 0004, 0006, 0007, 0008, 0009 and 0011 point by point
2. One superseding ADR per affected ADR (five new ADRs)
3. Edit the accepted ADRs in place

## Decision Outcome

Chosen option: **one consolidating ADR (1)**, because the decisions are small, interdependent (they all land in the same Charter schema) and were made together. Option 3 is not allowed by ADR-0002 for substantive changes; option 2 would duplicate context five times. Amended ADRs keep their status `accepted` and get an "Amended by ADR-0013" note in More Information.

### D1. Protected paths: `ask` for the Covenant, `deny` for secrets and The Charter

`paths.protected` is split into two explicit lists:

- **`deny`** (agents can never edit; humans only): The Charter (`panopticon.charter.yaml`) and secrets (`.env`, `.env.*` except `.env.example`, `secrets/**`).
- **`ask`** (an agent may edit only after Krzysztof approves the action in the session; the PR is `risk:high` and needs CODEOWNERS review): Covenant files (`docs/constitution.md`, `AGENTS.md`, `**/AGENTS.md`, `CLAUDE.md`), agent configs (`.claude/**`, `.cursor/**`), and, unchanged in intent, `.github/**`, `deploy/**`, `apps/api/migrations/**` and `.env.example`.
- `deny` wins over `ask` when both match.
- **Non-interactive sessions** (headless `claude -p`, `agent -p`, OVERSEER background runs, nightly Cells): nobody can answer `ask`, so `ask` resolves to **deny** with the next action "label the issue `needs:human`". Where a tool has no native `ask` for an action, `ask` also degrades to deny and The Ledger records it.
- Generated tool configs inside `ask` paths (`.claude/settings.json`, `.claude/agents/*.md`, `.cursor/hooks.json`, `.cursor/worktrees.json`, and `lefthook.yml`) remain "generated, never edited by hand" (ADR-0003): even an approved hand edit fails `charter-drift`. To change them, change The Charter (a human) and run `wardens sync`.

### D2. `--no-verify` is a denied command

`commands.deny` gains: `git commit --no-verify*`, `git commit -n*` (short form of `--no-verify` for `git commit` only; for `git push`, `-n` means `--dry-run` and stays allowed), `git push --no-verify*` and `git merge --no-verify*`. `command-guard` matches flags anywhere in the parsed argument list (including combined short flags such as `-nm`), not only as a string prefix.

### D3. Contract drift is part of `pnpm check`

`pnpm check` (Turborepo) runs a `contract:check` task when files under `apps/api/**`, `packages/contracts/**` or `packages/api-client/**` are affected: `uv run export-openapi` and hey-api generation into a temporary directory, compared with the working-tree files of `packages/contracts/openapi.json` and `packages/api-client/src/**`. Comparing with the working tree (not with `HEAD`) lets an agent regenerate, check and commit in any order. CI job `contract` keeps the same drift check plus `oasdiff` (which needs the base branch and stays CI-only). The Definition of Done (`quality_gates.definition_of_done`) therefore holds locally and in CI.

### D4. Generated packages are exempt from per-package `AGENTS.md`

`packages/contracts` and `packages/api-client` do not get an `AGENTS.md`. Instead:

- each has a `README.md` that starts with `Generated by <command>. Do not edit by hand.`;
- every generated source file starts with a header comment `// Generated by @hey-api/openapi-ts from packages/contracts/openapi.json. Do not edit; regenerate (see AGENTS.md, "uv run export-openapi").` (JSON files, which cannot carry comments, rely on the README);
- the exemption list is a Charter key (`covenant.agents_md_exempt`), so adding another exempt package is a Charter PR.

### D5. `.env.example` is readable

`.env.example` is an explicit exception to `secrets_deny_read`. Agents may read it (ADR-0012 worktree setup builds `.env` from it). It must contain only variable names, comments and non-secret local defaults; gitleaks (lefthook and CI) scans it like any other file. Editing it stays `ask` (D1).

`secret-read-guard` applies to file read actions (Claude Code `Read`, Cursor `beforeReadFile`) and to shell commands whose arguments resolve to a denied path (for example `cat .env`, `grep -r KEY .env.local`). Shell parsing is best effort; gitleaks and log redaction remain the backstops.

### D6. `debugger` role: Sonnet, effort `high`, read-only

`debugger` runs on `sonnet` with effort `high`, no escalation, `read_only: true`. Its only privilege is log access per ADR-0010: local and preview like every role, staging only for this role, production only with Krzysztof's approval per request. It produces a diagnosis and a reproduction plan; the fix is an `implementer` task with a failing reproduction test (C-15).

### D7. Risk classes and `require_spec_for` in the Charter schema

The `risk:` section mirrors ADR-0008 exactly; `require_spec_for` implements ADR-0011.

### Additions A1–A5 (confirmed 2026-11-04)

Found while applying D1–D7 and confirmed by Krzysztof on 2026-11-04 together with the rest of this ADR:

- **A1. More high-risk paths:** `wardens/**` (the engine that enforces every rule; a PR weakening a Warden is a policy change) and `docs/decisions/**` plus `docs/decision-log.md` (otherwise they match the low-risk `docs/**` rule and could be auto-merged in phase 3, contradicting ADR-0002 "only Krzysztof sets `accepted`"). This amends the ADR-0008 risk list.
- **A2. Other ways to skip git hooks:** `LEFTHOOK=0 *`, `git -c core.hooksPath=*`, `git config core.hooksPath*` in `commands.deny`.
- **A3. `wardens worktree remove * --force*`** in `commands.deny`, which ADR-0012 already assumes ("`--force` is for humans only").
- **A4. `ask` resolves to deny in non-interactive sessions** (D1, last bullets).
- **A5. `spec-check` dated-filename rule applies to specs only:** the pattern `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$` (ADR-0011) is not applied to `docs/specs/AGENTS.md`, `docs/specs/TEMPLATE.md` or any `README.md` under `docs/specs/**`; these files are also exempt from the spec front-matter and EARS checks. The exemption list is a Charter key (`specs.non_spec_files`). This amends the ADR-0011 Confirmation.

### Charter schema changes (v1, amends the ADR-0003 outline)

```yaml
roles:
  debugger: { model: sonnet, effort: high, read_only: true }      # D6 (ADR-0009, ADR-0010)

paths:
  protected:                                     # D1 (was a flat list)
    deny:                                        # agents never; humans only
      - "panopticon.charter.yaml"
      - ".env"
      - ".env.*"
      - "!.env.example"                          # D5; edit is "ask" below
      - "secrets/**"
    ask:                                         # explicit human approval in session; PR is risk:high
      - "docs/constitution.md"
      - "AGENTS.md"
      - "**/AGENTS.md"
      - "CLAUDE.md"
      - ".claude/**"
      - ".cursor/**"
      - ".github/**"
      - "deploy/**"
      - "apps/api/migrations/**"
      - ".env.example"
    non_interactive_ask: deny                    # A4
  generated: ["packages/api-client/src/**", "packages/contracts/openapi.json"]
  secrets_deny_read: [".env", ".env.*", "!.env.example", "secrets/**"]   # D5

commands:
  deny: ["git push --force*", "git push -f*", "kubectl * --context prod*", "npm publish*", "curl * | sh",
         "git commit --no-verify*", "git commit -n*", "git push --no-verify*", "git merge --no-verify*",  # D2
         "LEFTHOOK=0 *", "git -c core.hooksPath=*", "git config core.hooksPath*",                      # A2
         "wardens worktree remove * --force*"]                                                           # A3

covenant:                                        # D4
  agents_md_exempt: ["packages/contracts", "packages/api-client"]

risk:                                            # D7, mirrors ADR-0008; highest matching class wins
  high:
    paths: ["**/auth/**", ".env*", "secrets/**", ".github/**", "panopticon.charter.yaml",
            "docs/constitution.md", "AGENTS.md", "**/AGENTS.md", "CLAUDE.md",
            ".claude/**", ".cursor/**", "lefthook.yml", "deploy/**", "apps/api/migrations/**",
            "wardens/**", "docs/decisions/**", "docs/decision-log.md"]   # last three: A1
    labels: ["test:waived", "needs:human"]
  medium: { default: true }
  low:
    paths: ["docs/**", "**/*.test.*", "**/tests/**"]
    all_files_must_match: true                   # every changed file in a low path
    max_changed_lines: 200

require_spec_for:                                # D7, ADR-0011; spec required if any rule matches
  - issue_types: ["type:feature"]
    paths: ["apps/**"]                           # changed paths; initial value, tuned via Charter PR
  # type:chore, type:docs and small type:bug need no spec unless a rule above matches

specs:                                           # A5, amends ADR-0011 spec-check
  non_spec_files: ["docs/specs/AGENTS.md", "docs/specs/TEMPLATE.md", "docs/specs/**/README.md"]

quality_gates:
  definition_of_done: ["lint", "typecheck", "test:affected", "contract:drift"]  # unchanged; now all in pnpm check (D3)
```

Negated globs (`!`) are allowed only in `paths.protected.deny` and `paths.secrets_deny_read`, and only for files ending in `.example`; `charter-validate` rejects any other negation.

### Amended points per ADR

| ADR | Amended point | By |
|-----|---------------|----|
| ADR-0003 | Schema outline: `paths.protected` becomes `deny` / `ask` lists with `non_interactive_ask`; `secrets_deny_read` excepts `.env.example`; `commands.deny` gains no-verify and hook-skip patterns; new `covenant.agents_md_exempt`; `risk:` mirrors ADR-0008 with precedence and `all_files_must_match`; new `require_spec_for`; `roles.debugger` gets model and effort. Rule "agent hooks deny edits" to The Charter is confirmed as hard `deny`. | D1, D2, D4, D5, D6, D7, A1–A5 |
| ADR-0004 | `protected-paths`: Charter and secrets are `deny`, Covenant files and agent configs are `ask` (deny in non-interactive sessions). `command-guard`: also denies `--no-verify` and hook-skipping commands, matching parsed flags. `secret-read-guard`: excepts `.env.example`, also inspects shell commands. `risk-classifier`: uses the D7 rules. Security tools row: "Renovate or Dependabot" is decided by ADR-0014. | D1, D2, D5, D7 |
| ADR-0006 | "Agents may propose changes only through a PR" is implemented as `ask`, not deny. `covenant-check` skips packages in `covenant.agents_md_exempt`, and instead checks their `README.md` "Generated … Do not edit" note. Confirmation line "`protected-paths` denies agent edits to … Covenant" reads "requires `ask`". | D1, D4 |
| ADR-0007 | `pnpm check` includes the `contract:check` drift task (working-tree comparison); CI job `contract` keeps drift plus `oasdiff`. Generated packages carry README and header notes instead of `AGENTS.md`. | D3, D4 |
| ADR-0008 | High-risk path list extended with `wardens/**`, `docs/decisions/**`, `docs/decision-log.md`. | A1 |
| ADR-0009 | Roles table gains `debugger`: Sonnet, `high`, no escalation, read-only. | D6 |
| ADR-0011 | `spec-check` applies the dated-filename, front-matter and EARS rules only to spec files; `docs/specs/AGENTS.md`, `docs/specs/TEMPLATE.md` and `README.md` files are excluded (Charter `specs.non_spec_files`). | A5 |

### Consequences

- Good, because agents can propose Covenant improvements (a valuable feedback loop) while Krzysztof keeps the final word, and secrets and The Charter stay out of reach.
- Good, because `pnpm check` now predicts the CI gate for API contract changes, saving PR round trips.
- Good, because every rule in the constitution maps to a Charter key; the outline in ADR-0003 and the classes in ADR-0008 no longer disagree.
- Good, because worktree setup can read `.env.example` without weakening the secrets rule.
- Bad, because `ask` relies on each tool's permission prompt; tools without an `ask` path for some action fall back to deny, which may block legitimate approved edits until a human makes them.
- Bad, because `contract:check` adds OpenAPI export and client generation (seconds) to `pnpm check` when the API is affected.
- Bad, because flag-aware command matching is more complex than string globs and needs its own tests.
- Neutral: Claude Code `permissions.deny` has no negation, so `wardens sync` writes explicit deny rules for known `.env` variants (`.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.test`) and the `secret-read-guard` hook covers the rest with the negation logic.

### Confirmation

- `charter-validate`: the JSON Schema `wardens/schema/charter.schema.json` requires `paths.protected.deny` and `paths.protected.ask`, `roles.*.model` and `roles.*.effort` (including `debugger`), `risk.high|medium|low`, `require_spec_for` and `covenant.agents_md_exempt`; it rejects negations other than `!*.example`; `panopticon.charter.yaml` must be in `deny`.
- Wardens unit tests (`wardens-test`):
  - `protected-paths`: edit of `panopticon.charter.yaml` and `.env.local` → deny; edit of `docs/constitution.md` → ask in an interactive payload, deny in a headless payload;
  - `command-guard`: `git commit --no-verify -m x`, `git commit -nm x`, `git push --no-verify`, `LEFTHOOK=0 git commit` → deny; `git push -n` → allow;
  - `secret-read-guard`: read of `.env.example` → allow; read of `.env`, `.env.production`, `cat .env` → deny;
  - `risk-classifier`: a PR touching `docs/README.md` and `AGENTS.md` → `risk:high` (precedence); docs-only under 200 lines → `risk:low`.
- `spec-check` (CI job `docs-check`): `docs/specs/AGENTS.md`, `docs/specs/TEMPLATE.md` and `docs/specs/README.md` pass without a date prefix or front matter; `docs/specs/offer-crud.md` fails.
- `covenant-check` (CI job `docs-check`): no `AGENTS.md` required in `covenant.agents_md_exempt` packages; their `README.md` must start with `Generated by`.
- CI job `check`: `turbo.json` declares `contract:check` as a dependency of `check`; a fixture test that changes a FastAPI route without regenerating makes `pnpm check` fail.
- `charter-drift`: `.claude/settings.json` contains `permissions.ask` for Covenant paths and `permissions.deny` for The Charter and `.env` variants, matching `wardens sync` output.

## Pros and Cons of the Options

### One consolidating ADR

- Good, because related changes to one schema are reviewed together.
- Bad, because readers of ADR-0003/0004/0006/0007/0009 must follow the amendment note.

### One superseding ADR per affected ADR

- Good, because each ADR has exactly one successor.
- Bad, because five ADRs for one design session is heavy and repeats context.

### Edit accepted ADRs in place

- Good, because each ADR stays self-contained.
- Bad, because it breaks ADR-0002 and loses the history of what changed and why.

## More Information

- Decisions made by Krzysztof on 2026-11-04 (design session), including A1–A5; ADR accepted on 2026-11-04. Recorded in `docs/decision-log.md`.
- Related: ADR-0002 (amendment rules), ADR-0003, ADR-0004, ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0011 (amended), ADR-0010 (log access), ADR-0012 (worktree setup reads `.env.example`), ADR-0014 (Renovate).
- Constitution principles updated under this ADR: C-12, C-13, C-18, C-21, C-22, C-24, C-26.
