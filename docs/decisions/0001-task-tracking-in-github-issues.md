---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0001: Track work in GitHub Issues and Projects within the LUNARITY organization

## Context and Problem Statement

PANOPTICON is an agentic software development platform where AI agents (Claude Code, Cursor) and a human owner deliver software under deterministic guards (Wardens). We need a single place for tasks that:

- humans and agents can both read and update reliably,
- links tasks to specs, branches, pull requests and The Ledger,
- is publicly visible, because the project doubles as a portfolio piece for recruiters.

The repository will live in the **LUNARITY** GitHub organization. Changes are made by Krzysztof's personal GitHub account and by AI agents.

## Decision Drivers

- Visibility of the whole delivery process without requiring an account
- Native linking between issues, branches, PRs and CI
- Best tool support for AI agents (GitHub MCP, `gh` CLI, cloud agents reacting to issues)
- Ability to enforce task structure deterministically (Wardens)
- Minimal number of tools for a one-person team

## Considered Options

1. GitHub Issues + GitHub Projects
2. Linear
3. Jira
4. Linear with GitHub sync (hybrid)

## Decision Outcome

Chosen option: **GitHub Issues + GitHub Projects**, because it is public, lives next to the code, links natively to PRs (`Closes #123`) and has the best agent tooling. Its weaker planning features are acceptable for a one-person team.

### Task structure

- **Labels (managed as code)**, defined in `.github/labels.yml` and synced by CI; agents must not create ad-hoc labels:
  - `type:feature`, `type:bug`, `type:chore`, `type:spike`, `type:docs`
  - `area:web`, `area:api`, `area:worker`, `area:wardens`, `area:ledger`, `area:infra`, `area:docs`
  - `priority:p0`, `priority:p1`, `priority:p2`
  - `agent:ready`, `agent:in-progress`, `needs:human`, `blocked`
  - `risk:low`, `risk:medium`, `risk:high` (see ADR-0008)
  - `test:waived`, `complexity:high`, `security`
- **Issue Forms** in `.github/ISSUE_TEMPLATE/` (feature, bug, chore, spike) with required fields: goal, acceptance criteria (EARS notation), linked spec (`docs/specs/YYYY-MM-DD-<slug>.md`, see ADR-0011), and **allowed paths** for agents.
- **GitHub Project** board (org-level, public): Backlog → Ready → In Progress → In Review → Done, with custom fields Priority, Size and Milestone.
- **Conventions:** branch `<type>/<issue-number>-<slug>` (e.g. `feat/42-offer-crud`), commit `feat(api): add offer CRUD (#42)`, PR body contains `Closes #42`.

### Identities and permissions

- **Organization:** LUNARITY owns the repository; Krzysztof is an organization owner.
- **Human:** Krzysztof's personal account is the CODEOWNER for protected paths and the only account that approves PRs and merges to `main`.
- **Local agents** (Claude Code, Cursor on Krzysztof's machine) act through his git identity, so their commits must carry a trailer such as `Co-authored-by` / `Agent: claude-code` written by a Warden, to keep authorship traceable in The Ledger.
- **Autonomous and cloud agents** act through a dedicated **GitHub App** installed only on PANOPTICON repositories, with `contents: write`, `pull_requests: write`, `issues: write`, and **no** administration or ruleset permissions. Their PRs are approved by Krzysztof. Detailed setup is deferred to the agent identity ADR.
- **Ruleset on `main`:** PR required, required status checks, CODEOWNERS review, no force pushes or deletions.

### Consequences

- Good, because recruiters can see the full process: issues, board, PRs, CI and reviews.
- Good, because agents work with one API and one source of truth.
- Good, because issue structure (labels, forms, allowed paths) can be validated by Wardens.
- Bad, because planning (cycles, roadmaps) is weaker than in Linear.
- Bad, because a public tracker means nothing sensitive may be written in issues.
- Neutral: Linear stays available for private planning later if needed; it would sync one way into GitHub.

### Confirmation

- CI job `labels-sync` fails if labels in the repository differ from `.github/labels.yml`.
- Warden `pr-check` fails if a PR does not reference an issue (`Closes #N`) or its branch name does not match the convention.
- Warden `scope-guard` reads the allowed paths from the linked issue and blocks agent edits outside them.
- Ruleset on `main` lists the required checks and CODEOWNERS review.

## Pros and Cons of the Options

### GitHub Issues + Projects
- Good, because it is public, next to the code and natively linked to PRs.
- Good, because of the strongest agent tooling.
- Bad, because of simpler planning features.

### Linear
- Good, because of the best day-to-day UX and native agent sessions.
- Bad, because it is invisible to recruiters and adds a tool.

### Jira
- Good, because it is an enterprise standard.
- Bad, because it is heavy for one person and invisible from outside.

### Linear + GitHub sync
- Good, because of combined strengths.
- Bad, because of two sources of truth and sync complexity at the start.

## More Information

- Related: research report `docs/research/0001-fundament-best-practices.md`, sections 5, 7.4, 11.3 (written before this ADR; its Linear-based recommendations are marked as superseded).
- Follow-up ADRs: agent identities and GitHub App setup; Wardens engine; spec-driven process.
