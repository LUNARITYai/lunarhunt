---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0008: Autonomy phases, risk-based merge policy and agent identity

## Context and Problem Statement

PANOPTICON aims at agents that eventually work unattended (night shift) and merge low-risk changes on their own. Granting that autonomy on day one would be reckless; never granting it would defeat the purpose. We need explicit phases with measurable entry criteria, a merge policy that depends on the risk of a change, safety mechanisms (auto-revert, kill switch, budgets) and an agent identity model that keeps authorship traceable and lets the human approve PRs.

## Decision Drivers

- Autonomy is earned with data from The Ledger, not assumed
- Every phase change is explicit and reviewable
- Risky changes (auth, secrets, CI, policy) always reach a human
- Production is never changed without a human
- Fast, reliable stop and rollback
- Traceable authorship of every agent commit
- GitHub does not let an account approve its own PR

## Considered Options

1. Phased autonomy (0–3) with Ledger-based entry criteria and risk classes
2. Always human merge (no autonomy)
3. Full autonomy behind green CI from the start

For agent identity:

A. Krzysztof's account with an `Agent:` trailer in phases 0–1, a dedicated GitHub App from phase 2
B. Machine user account (or fine-grained PAT) from the start
C. GitHub App from the start

## Decision Outcome

Chosen options: **phased autonomy (1)** and **identity model A**. The current phase is `autonomy.phase` in The Charter (ADR-0003). A phase starts only when The Ledger shows its entry criteria are met, and the switch is a PR to The Charter approved by Krzysztof. Thresholds are initial proposals, tuned with real data.

### Phases

| Phase | Enabled | Entry criteria |
|-------|---------|----------------|
| 0 — Supervised (start) | Local agents only, under Krzysztof's account with `Agent:` trailer. Every PR reviewed and merged by a human. | Skeleton, Wardens (scope guard, command guard, Definition of Done), CI gates and branch ruleset in place. |
| 1 — Assisted | OVERSEER plans and splits tasks; implementer and reviewer roles with model routing and escalation (ADR-0009); Sentinel review on every PR. Human merge. | ≥ 20 agent PRs merged; CI first-pass green rate ≥ 70%; no Warden bypass found; Ledger dashboard live. |
| 2 — Night shift | Dedicated **GitHub App** identity for cloud/autonomous agents; scheduled overnight runs (Nightwatch, implementation of `agent:ready` issues); per-task and per-night budgets; kill switch. Human merge for everything. | Phase 1 for ≥ 4 weeks; ≥ 50 agent PRs; human rework rate < 20%; zero high-severity security findings from agent code; budget alerts tested. |
| 3 — Auto-merge low risk | Auto-merge to `main` (deploys to **staging**) for `risk:low` PRs with all gates green, including Sentinel, bug-reproduction test and coverage on changed lines; auto-revert on failed post-deploy checks. Medium risk: one-click human approval. High risk and production: always human. | Phase 2 for ≥ 4 weeks; revert rate of agent PRs < 5%; Infiltrator red-team runs active with no open critical findings. |

### Risk classes

The `risk-classifier` Warden (ADR-0004) labels every PR from Charter rules:

- **`risk:high`**: touches auth, secrets, CI (`.github/**`), The Charter, Covenant files, agent configs, `deploy/` or migrations; or has `test:waived` or `needs:human`. Always human approval, in every phase.
- **`risk:medium`**: the default for product code changes. Human approval (one click in phase 3).
- **`risk:low`**: documentation, tests only, or small changes in non-protected paths under the Charter's size limit. Eligible for auto-merge in phase 3 only.

Sentinel findings block auto-merge for any class.

### Safety mechanisms

- **Production is always human:** promotion to production is a separate, human-approved step; agents never hold production credentials.
- **Auto-revert (phase 3):** a failed post-deploy check on staging triggers an automatic revert PR of the auto-merged change and records it in The Ledger.
- **Kill switch:** `autonomy.kill_switch: true` in The Charter (plus a documented procedure) stops scheduled runs, disables auto-merge and revokes agent tokens / suspends the GitHub App installation.
- **Budgets:** per-task and per-night cost and turn limits in The Charter; exceeding a budget stops the run and labels the issue `needs:human`.

### Agent identity

- **Phases 0–1:** local agents (Claude Code, Cursor) commit under Krzysztof's git identity. Warden `agent-trailer` appends `Agent: <tool> (<model>)` to every agent commit.
- **Phase 2+:** autonomous and cloud agents use a dedicated **GitHub App** installed only on PANOPTICON repositories, with `contents: write`, `pull_requests: write`, `issues: write` and **no** administration or ruleset permissions. Because the App opens the PR, Krzysztof can approve it as reviewer.

### Consequences

- Good, because autonomy grows only with evidence, and each step is reversible by a Charter PR.
- Good, because high-risk changes and production always stay human-controlled.
- Good, because authorship is traceable from day one and the identity model is simple until autonomy needs more.
- Bad, because in phases 0–1 GitHub shows Krzysztof as the author; separation relies on the trailer and The Ledger.
- Bad, because the entry criteria depend on Ledger metrics that must be built first.
- Bad, because thresholds are guesses until real data exists.

### Confirmation

- Warden `autonomy-gate` (CI, required in `panopticon/gate`): refuses auto-merge unless `autonomy.phase == 3`, the PR is `risk:low`, all gates and the Sentinel review are green, and `kill_switch` is false.
- Warden `charter-phase-change`: a PR changing `autonomy.phase` must link a Ledger report showing the entry criteria; it is `risk:high` and needs CODEOWNERS approval.
- Warden `agent-trailer` (lefthook `commit-msg` and CI): agent commits without an `Agent:` trailer fail; The Ledger cross-checks sessions against trailers.
- Ruleset on `main`: PR, required checks and CODEOWNERS review for every PR. How phase-3 auto-merge satisfies the review rule (e.g. a narrowly scoped bypass for the auto-merge workflow) is decided in a follow-up ADR before phase 3 starts. Production promotion requires a protected environment with Krzysztof as required reviewer.
- A scheduled `kill-switch-drill` workflow (from phase 2) verifies that setting the kill switch stops runs.

## Pros and Cons of the Options

### Phased autonomy

- Good, because it is evidence-based and safe.
- Bad, because there is metric and process overhead.

### Always human merge

- Good, because it is the safest.
- Bad, because there is no autonomy to learn from or showcase.

### Full autonomy from the start

- Good, because it is the fastest.
- Bad, because there is no evidence of agent reliability and a high blast radius.

### Identity A / B / C

- A: simple start, App only when needed; but shared authorship early on.
- B: separate identity immediately; but a machine account is less scoped than an App and its token is long-lived.
- C: cleanest separation; but setup effort before any autonomy exists.

## More Information

- Source: `docs/decision-log.md`, "Autonomy roadmap and entry criteria".
- Research report, sections 7.4, 11.3.
- Related: ADR-0001 (identities, ruleset), ADR-0003 (The Charter), ADR-0004 (risk classifier, Sentinel), ADR-0009 (routing, budgets), ADR-0010 (Ledger metrics).
- Amended by ADR-0013: risk classes encoded in the Charter `risk:` schema; high-risk paths extended with `wardens/**`, `docs/decisions/**` and `docs/decision-log.md` (A1).
- Amended by ADR-0017 (proposed): in phases 0–2 local agent roles run in Claude Code only; "local agents (Claude Code, Cursor)" is read as Claude Code.
- See also ADR-0014: Renovate PRs follow these risk and auto-merge rules.
