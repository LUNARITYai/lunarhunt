---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0002: Record architecture decisions with MADR 4.0

## Context and Problem Statement

PANOPTICON is built by one human and several AI agents. Agents start every session without memory, so decisions that are not written down get re-litigated or silently violated. We need a format that both humans and agents can read and write, that lives next to the code, and that links each decision to the check that enforces it. Design sessions also produce many small decisions quickly; writing a full ADR for each one during the conversation is too slow.

## Decision Drivers

- Decisions must be readable by agents at the start of a session and reviewable in PRs
- Every decision must be verifiable: "deterministic before probabilistic" (a rule without an enforcing check is only a wish)
- Low ceremony for a one-person team
- Well-known format that recruiters and other engineers recognise
- Fast capture of decisions during design sessions without losing them

## Considered Options

1. MADR 4.0 with a mandatory Confirmation section, plus `docs/decision-log.md` as lightweight intake
2. Nygard-style ADRs (Context / Decision / Consequences only)
3. Decisions kept only in issues, PR descriptions or a wiki
4. Decision log only (no full ADRs)

## Decision Outcome

Chosen option: **MADR 4.0 with a mandatory Confirmation section, plus the decision log as intake**, because MADR 4.0 already has a `Confirmation` section that lets us tie every decision to a Warden or CI check, and the log keeps design sessions fast.

### Rules

- **Location and naming:** `docs/decisions/NNNN-title-with-dashes.md`, four-digit sequential numbers, never reused. `docs/decisions/README.md` is the index.
- **Template:** MADR 4.0 full template. YAML front matter with `status`, `date`, `decision-makers` (MADR 4 name for "deciders"), optional `consulted` and `informed`. Sections: Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome (with Consequences and **Confirmation**), Pros and Cons of the Options, More Information.
- **Statuses:** `proposed` → `accepted` | `rejected`; later `deprecated` or `superseded by ADR-NNNN`. Accepted ADRs are not rewritten; a change is a new ADR that supersedes the old one (typo fixes excepted).
- **Confirmation is mandatory** and must name at least one concrete, automated check (Warden rule ID, CI job, ruleset rule, architecture contract or test). When no automated check is possible, it names the human review step and the ADR is flagged in the index.
- **Decision log as intake:** `docs/decision-log.md` records decisions agreed in design sessions as one-line entries (date, decision, status, target ADR). An entry is promoted to a full ADR when it is implemented or when it needs alternatives documented; the log row then points to the ADR number.
- **Language:** English only (see ADR-0006).
- **Authorship:** agents (OVERSEER, spec-writer role) may draft ADRs with status `proposed`; only Krzysztof changes a status to `accepted`. `docs/decisions/` is covered by CODEOWNERS.

### Consequences

- Good, because every decision has a traceable enforcer, so drift between documentation and behaviour becomes a red check.
- Good, because agents get stable, linkable context (`see ADR-0004`) instead of chat history.
- Good, because the decision log keeps design sessions fast while still ending in full ADRs.
- Bad, because two places hold decisions for a while (log and ADRs); the log must be kept in sync.
- Bad, because writing a meaningful Confirmation section takes effort, especially for process decisions.

### Confirmation

- Warden `adr-check` (run in CI job `docs-check` and in lefthook `pre-commit` for `docs/decisions/**`) fails if:
  - a file name does not match `^\d{4}-[a-z0-9-]+\.md$` or a number is duplicated,
  - front matter lacks `status`, `date` or `decision-makers`, or `status` is not one of the allowed values,
  - any required section is missing, or the `Confirmation` section is empty,
  - `docs/decisions/README.md` does not list every ADR with its current status.
- markdownlint runs on `docs/**` in the same CI job.
- CODEOWNERS requires Krzysztof's review for `docs/decisions/**` and `docs/decision-log.md`.

## Pros and Cons of the Options

### MADR 4.0 + decision log

- Good, because of the explicit Confirmation section and a well-known, lintable structure.
- Good, because the log captures decisions at conversation speed.
- Bad, because of a slightly heavier template than Nygard.

### Nygard-style ADRs

- Good, because they are minimal.
- Bad, because there is no place for alternatives or for the enforcing check.

### Issues, PRs or wiki only

- Good, because there is no extra file format.
- Bad, because decisions are scattered, hard for agents to load and not versioned with the code.

### Decision log only

- Good, because it is the fastest.
- Bad, because rationale and rejected alternatives are lost.

## More Information

- MADR: <https://adr.github.io/madr/>
- Research report `docs/research/0001-fundament-best-practices.md`, section 5.3.
- Related: ADR-0004 (Wardens), ADR-0006 (Covenant, English-only), ADR-0011 (spec process).
- Amended by ADR-0020: an ADR pull request carries the status the ADR will have on `main`, and Krzysztof's merge is the acceptance; agents never change the status of an ADR already on `main`.
