---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0003: The Charter (`panopticon.charter.yaml`) as the single source of policy

## Context and Problem Statement

Policy for agents is spread across many tool-specific files: Claude Code `permissions` and hooks in `.claude/settings.json`, Cursor `.cursor/hooks.json` and `.cursor/sandbox.json`, `lefthook.yml`, GitHub Actions workflows, CODEOWNERS and rulesets. If each file is edited by hand, they drift apart and an agent can find the weakest one. We need one place that states what agents may do (paths, commands, models, budgets, log access, autonomy phase) and from which every enforcement point reads or is generated.

## Decision Drivers

- One source of truth for every rule that Wardens enforce
- Machine-readable and schema-validated, so a typo fails loudly instead of disabling a guard
- Human-reviewable diffs: every policy change is visible in a PR
- Agents must not be able to weaken their own guards
- Works for both Claude Code and Cursor, and for CI

## Considered Options

1. A single YAML policy file, **The Charter** (`panopticon.charter.yaml`), validated by JSON Schema, read by the Wardens engine and used to generate tool configs
2. Hand-maintained tool configs (`.claude/settings.json`, `.cursor/hooks.json`, `lefthook.yml`, workflows) with no shared source
3. Policy written only as prose in `AGENTS.md`
4. A general policy engine (e.g. OPA/Rego)

## Decision Outcome

Chosen option: **The Charter**, because it gives one reviewable, validated file that the Wardens engine (ADR-0005) reads at runtime and from which tool configs are generated, while prose in the Covenant (ADR-0006) only explains the rules.

The name *Charter* replaces the earlier working name "Codex" / `panopticon.policy.yaml` to avoid confusion with OpenAI Codex.

### Schema outline (v1)

```yaml
version: 1
project: lunarhunt

autonomy:
  phase: 0                     # 0 supervised | 1 assisted | 2 night shift | 3 auto-merge low risk (ADR-0008)
  kill_switch: false           # true = all autonomous runs stop, agent tokens revoked (ADR-0008)

roles:                         # agent roles and model routing (ADR-0009)
  overseer:    { model: opus }
  spec-writer: { model: opus, allowed_paths: ["docs/specs/**", "docs/decisions/**"] }
  implementer: { model: sonnet, escalate_to: opus }
  reviewer:    { model: sonnet, read_only: true }
  sentinel:    { model: sonnet, read_only: true }
  debugger:    { read_only: true }          # model to be decided

paths:
  allowed_paths: ["apps/**", "packages/**", "wardens/**", "docs/**"]  # default; an issue may only narrow it
  protected:                   # agent edit = deny or ask; human review required
    - "panopticon.charter.yaml"
    - "AGENTS.md"
    - "**/AGENTS.md"
    - "CLAUDE.md"
    - "docs/constitution.md"
    - ".claude/**"
    - ".cursor/**"
    - ".github/**"
    - "deploy/**"
    - "apps/api/migrations/**"
  generated: ["packages/api-client/src/**", "packages/contracts/openapi.json"]
  secrets_deny_read: [".env", ".env.*", "secrets/**"]

commands:
  deny: ["git push --force*", "git push -f*", "kubectl * --context prod*", "npm publish*", "curl * | sh"]
  allow: ["pnpm turbo run *", "pnpm check*", "uv run pytest *", "uv run ruff *"]
  rewrite: { "npm install": "pnpm install" }

risk:                          # risk classes (ADR-0008)
  high:
    paths: ["**/auth/**", "secrets/**", ".github/**", "panopticon.charter.yaml"]
  medium: { default: true }
  low:
    paths: ["docs/**", "**/*.test.*", "**/tests/**"]
    max_changed_lines: 200

quality_gates:
  definition_of_done: ["lint", "typecheck", "test:affected", "contract:drift"]
  diff_coverage_min: 80
  max_pr_changed_lines: 600

budgets:                       # values are placeholders, tuned from The Ledger
  per_task:  { max_cost_usd: null, max_turns: null }
  per_night: { max_cost_usd: null }

log_access:                    # agent read-only log/trace access (ADR-0010)
  local:      { roles: all }
  preview:    { roles: all }
  staging:    { roles: [debugger] }
  production: { requires: human_approval }
  limits:     { max_time_range: "24h", max_results: 500 }
  redact: [secrets, pii, cv_data]

ledger:
  sink: [postgres, otlp]
  capture_content: false
```

The outline above is the intended shape, not a frozen schema. Values marked as placeholders and the exact glob lists are set in the first implementation PR. The authoritative definition is the JSON Schema at `wardens/schema/charter.schema.json`.

### Rules

- **Single source.** The Wardens engine reads The Charter at runtime. Tool configs (`.claude/settings.json` permissions and hook wiring, `.cursor/hooks.json`, `lefthook.yml`, the list of required checks) are generated from it by `wardens sync`, never edited by hand.
- **Narrowing only.** An issue's *allowed paths* field (ADR-0001) can narrow `paths.allowed_paths` for one task, never widen it.
- **Changes only via PR approved by Krzysztof.** The Charter is a protected path: agent hooks deny edits, CODEOWNERS requires Krzysztof's review, and any PR touching it is `risk:high` (ADR-0008).
- **Autonomy phase and kill switch live here**, so moving between phases is an explicit, reviewable PR.

### Consequences

- Good, because there is one place to read and review policy; agents and humans see the same rules.
- Good, because schema validation turns config typos into failing checks instead of silently disabled guards.
- Good, because generated configs cannot drift unnoticed.
- Bad, because we must build and maintain the `wardens sync` generator and the schema.
- Bad, because some tool features (e.g. Claude Code sandbox settings) may not map cleanly and need tool-specific sections.
- Neutral: OPA can be adopted later behind the same Charter if rules become too complex for YAML plus TypeScript.

### Confirmation

- CI job `charter-validate`: validates `panopticon.charter.yaml` against `wardens/schema/charter.schema.json`.
- CI job `charter-drift`: runs `wardens sync` and fails on `git diff --exit-code` (generated configs out of date).
- Warden `protected-paths` (agent hook ring) denies agent edits to The Charter.
- `.github/CODEOWNERS` lists `panopticon.charter.yaml` with Krzysztof as owner; the `main` ruleset requires CODEOWNERS review.
- Warden `risk-classifier` labels any PR touching The Charter as `risk:high`.

## Pros and Cons of the Options

### The Charter (YAML + JSON Schema + generator)

- Good, because it is single-source, validated and reviewable.
- Bad, because it needs a generator and a schema.

### Hand-maintained tool configs

- Good, because there is nothing to build.
- Bad, because rules drift between tools, and the weakest config defines the real policy.

### Prose in `AGENTS.md`

- Good, because it is easy to write.
- Bad, because a prompt is a request, not a barrier; nothing is enforced.

### OPA/Rego

- Good, because it is a powerful, standard policy language.
- Bad, because it is a new language and runtime for a one-person team, overkill for the MVP.

## More Information

- Research report, sections 1, 7.2–7.4 (the original Polish draft called the file "Codex" / `panopticon.policy.yaml`; the English version uses The Charter and marks the schema sketch in 7.3 as superseded by this ADR).
- Related: ADR-0004 (rings of Wardens), ADR-0005 (Wardens engine), ADR-0008 (autonomy and risk), ADR-0009 (model routing), ADR-0010 (log access).
- Amended by ADR-0013 (Charter policy refinements): `paths.protected` split into `deny`/`ask`, `.env.example` read exception, `--no-verify` in `commands.deny`, `covenant.agents_md_exempt`, `risk:` aligned with ADR-0008, `require_spec_for`, `roles.debugger`.
- Amended by ADR-0019: in the schema outline, `.claude/**`, `.cursor/**` and `.github/**` outside `workflows/` are human-only through `allowed_paths`, not protected `ask` paths.
