---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0009: Model and effort routing and escalation per agent role

## Context and Problem Statement

Different agent roles need different capabilities. Planning, architecture and specification benefit from the strongest model; routine implementation and review are usually fine on a cheaper, faster model. Always using the strongest model wastes budget; always using the cheaper one wastes time on tasks it cannot solve. Without explicit rules, an agent stuck in a loop (red Definition of Done, repeated Warden blocks) burns tokens without progress. We need per-role defaults, deterministic escalation triggers, a hard stop that hands the task to a human, and budgets.

## Decision Drivers

- Quality where it matters (planning, specs), cost efficiency where possible (implementation, review)
- Deterministic, observable escalation instead of ad-hoc model switching
- Bounded cost per task and per night
- Data-driven tuning from The Ledger
- Routing defined in The Charter, not in prompts
- Reasoning effort is a separate, cheaper lever than switching models and must be configurable per role

## Considered Options

1. Per-role default model **and effort level** in The Charter, with deterministic escalation triggers and a single escalation step
2. One strong model (Opus) for every role
3. One cheaper model (Sonnet) for every role
4. Agent decides itself when to switch models

## Decision Outcome

Chosen option: **per-role routing with deterministic escalation (option 1)**.

### Roles (in The Charter `roles:`)

| Role | Default model | Default effort | Escalation |
|------|---------------|----------------|------------|
| `overseer` (OVERSEER, orchestrator/architect) | Opus | `high` | — |
| `spec-writer` | Opus | `high` | — |
| `implementer` | Sonnet | `medium` | `escalate_to: { model: opus, effort: high }` |
| `reviewer` | Sonnet | `medium` | — |
| `sentinel` (security reviewer) | Sonnet | `high` | — |

Effort values are placeholders, tuned with Ledger data like the thresholds below.

Model names in The Charter are aliases (`opus`, `sonnet`) mapped to concrete model versions in one place, so upgrades are a one-line Charter PR.

### Effort level

Every role has an `effort` field with a tool-neutral scale `low | medium | high | xhigh` (plus `max` where the model supports it). Lower levels are faster and cheaper on scoped tasks; higher levels reason more deeply. `wardens sync` (ADR-0005) translates the Charter value into each tool's native form:

- **Claude Code:** `effort:` in the subagent frontmatter (`.claude/agents/<role>.md`), and `--effort <level>` for headless runs started by OVERSEER. The project settings set `maxEffortLevel` from The Charter `budgets:` as a hard cap. `CLAUDE_CODE_EFFORT_LEVEL` overrides everything, so the Cell environment must not set it; `wardens doctor` checks this.
- **Cursor:** effort is part of the model variant slug (for example a `-high` / `-extra-high` / `-thinking-high` suffix) passed with `--model` in the Cursor CLI or picked in the IDE. The alias table maps `(model, effort)` to the concrete slug per tool. Which models (including Grok in Cursor) offer effort variants is checked with `agent --list-models` when the alias table is written; a role whose model has no variants runs at the model default and the Ledger records `effort: default`.

Escalation may raise effort, switch model, or both, in one step (`escalate_to` takes `model` and/or `effort`). A cheaper first step such as `{ effort: xhigh }` on the same model is allowed and is compared against model escalation in the routing report.

### Escalation

- **Triggers** (any one, evaluated by the Wardens engine from Ledger events):
  - 3 consecutive failed `Stop` hooks (Definition of Done still red),
  - 5 Warden blocks within one task,
  - the issue has the label `complexity:high` (starts directly on the escalated model).
- **Maximum one escalation per task.** If the escalated run hits a trigger again, the run stops and the issue is labelled `needs:human` with a summary of what failed.
- **Budgets:** per-task and per-night limits (cost and turns) in The Charter `budgets:`. Exceeding a budget stops the run and labels the issue `needs:human`, regardless of escalation state. Initial values are set when phase 1 starts.

### Tuning

The Ledger records model, effort level, role, escalations, cost, Warden blocks and outcome for every run (ADR-0010). Routing and thresholds are reviewed with Ledger reports (e.g. escalation rate per task class, first-pass green rate per model, cost per merged PR) and changed only via Charter PRs.

### Consequences

- Good, because strong models are used where they pay off and loops are capped.
- Good, because every routing decision is visible in The Ledger and reproducible.
- Good, because a stuck task reaches a human quickly instead of burning budget.
- Bad, because the thresholds (3 and 5) are initial guesses and may be wrong for some task classes.
- Bad, because model capabilities and prices change; aliases and budgets need regular review.
- Bad, because effort is configured differently per tool (frontmatter in Claude Code, model slug in Cursor) and the mapping must be kept in sync by `wardens sync`.
- Neutral: per-role routing depends on tool support for selecting a model per agent or subagent (e.g. the `model` field in Claude Code subagent definitions); where a tool cannot switch, the run is restarted on the escalated model.

### Confirmation

- CI job `charter-validate` (ADR-0003): every role has a `model` and an `effort`; `escalate_to`, if present, refers to a known alias and a valid effort level; no role exceeds the effort cap.
- Wardens engine tests (`wardens-test`): simulated Ledger event sequences trigger escalation at exactly 3 failed `Stop` hooks and 5 Warden blocks, never escalate twice, and add `needs:human` on the second trigger or budget overrun.
- Warden `model-guard` (agent hook ring): a session whose model or effort does not match the Charter role (or its escalation) is blocked with an actionable message.
- Ledger report `routing-report` (weekly) is required input for any PR that changes `roles:` or `budgets:`.

## Pros and Cons of the Options

### Per-role routing with escalation

- Good, because of a balanced cost and quality and predictable behaviour.
- Bad, because there are more rules to maintain.

### Opus everywhere

- Good, because of maximum quality.
- Bad, because of high cost and slower runs, especially at night.

### Sonnet everywhere

- Good, because of the lowest cost.
- Bad, because planning and hard tasks suffer, causing more human rework.

### Agent self-selects

- Good, because it is flexible.
- Bad, because it is non-deterministic, hard to audit and easy to abuse.

## More Information

- Claude Code effort: <https://code.claude.com/docs/en/model-config> and subagent `effort` field: <https://code.claude.com/docs/en/sub-agents>; Cursor CLI `--model` with variant slugs: <https://cursor.com/docs/cli/reference/parameters>
- Related: ADR-0003 (The Charter `roles:` and `budgets:`), ADR-0004 (Definition of Done, Warden blocks), ADR-0008 (phases; routing starts in phase 1), ADR-0010 (Ledger metrics).
- Labels `complexity:high` and `needs:human` are managed in `.github/labels.yml` (ADR-0001).
- Amended by ADR-0013: `debugger` role on Sonnet with effort `high`, read-only, no escalation.
- Amended by ADR-0017: every role runs in Claude Code; the Cursor effort-slug mapping is frozen; `roles.*.engine` stays as the seam; D5 records a human-started, time-boxed exception to the `overseer` model until 2026-11-17, which `model-guard` would block once built.
