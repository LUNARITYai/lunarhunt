# AGENTS.md — `docs/specs/`

How to write a spec. Local rules only; global rules live in the root [`AGENTS.md`](../../AGENTS.md) and [`docs/constitution.md`](../constitution.md). Process decided in [ADR-0011](../decisions/0011-spec-driven-process.md).

> **Status:** stub. `TEMPLATE.md` and the `spec-check` Warden are planned.

## When a spec is required

- When the issue matches a rule in the Charter's `require_spec_for` (initially: `type:feature` changing `apps/**`, [ADR-0013](../decisions/0013-charter-policy-refinements.md)). See C-10.
- Not needed for `type:chore`, `type:docs` and small `type:bug` changes, unless a `require_spec_for` rule matches.
- Implementation starts only after Krzysztof sets `status: ready`.

## Files and folders

- Active specs: `docs/specs/YYYY-MM-DD-<slug>.md` (date the spec was started; slug lowercase kebab-case), one per feature. `AGENTS.md`, `TEMPLATE.md` and `README.md` here are not specs and are exempt from the date prefix (ADR-0013 A5).
- Finished specs (`status: implemented`) move to `docs/specs/implemented/` unchanged.
- Research and analysis that is not a spec: `docs/specs/analysis/`.
- Start from `docs/specs/TEMPLATE.md` *(planned)*.

## Front matter

```yaml
---
status: draft            # draft | ready | in-progress | implemented
issue: 42                # GitHub issue number in LUNARITYai/lunarhunt
adrs: [0007]             # related ADRs, may be empty
---
```

## Sections (in this order)

1. **Goal and context** — what and why, in a few paragraphs. Link the issue.
2. **Acceptance criteria (EARS)** — one criterion per line, each one testable:
   - `THE SYSTEM SHALL …` (ubiquitous)
   - `WHEN <trigger>, THE SYSTEM SHALL …`
   - `WHILE <state>, THE SYSTEM SHALL …`
   - `IF <unwanted condition>, THE SYSTEM SHALL …`
   - `WHERE <feature is enabled>, THE SYSTEM SHALL …`
3. **Plan** — approach, API contract changes, data model and migrations, affected packages, ADRs needed.
4. **Tasks** — numbered, each small enough for one PR, each with its **allowed paths**. OVERSEER turns them into `agent:ready` issues.

## Rules for the `spec-writer` role

- Write only under `docs/specs/**` and `docs/decisions/**` (`scope-guard`). ADRs you draft carry the status they will have on `main` (ADR-0020); Krzysztof's merge accepts them.
- Never set `status: ready`; only Krzysztof does.
- Respect the constitution; if the feature needs to break a principle, propose an ADR instead.
- No personal data or real CV content in examples; use synthetic data (C-19).
- Do not add Spec Kit files (`.specify/`, `toolchain-guard`).
