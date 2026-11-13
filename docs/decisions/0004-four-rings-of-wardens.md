---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0004: Enforce policy with four rings of Wardens

## Context and Problem Statement

The core principle of PANOPTICON is: **rules that must hold are enforced by code, not by prompts**. A prompt is a request; a hook, linter, test or branch rule is a barrier. No single enforcement point is sufficient: agent hooks give the fastest feedback but can be disabled locally (e.g. `disableAllHooks`, and there are no managed settings in a one-person project); git hooks can be skipped with `--no-verify`; CI cannot stop a dangerous command before it runs on a developer machine. We need layered, deterministic guards (Wardens) and a clear answer to which layer has the final word.

## Decision Drivers

- Defense in depth: the same rule checked at several points
- Fast feedback to agents while they work, not only after a PR
- A final authority that neither an agent nor a local config change can bypass
- Fail-closed for security-relevant guards
- Deterministic tools first; probabilistic (LLM) reviewers only on top
- One rule definition (The Charter, ADR-0003), many enforcement points

## Considered Options

1. Four rings: agent hooks → git hooks (lefthook) → required CI checks → GitHub rulesets + CODEOWNERS
2. CI only
3. Agent hooks only
4. LLM reviewers (e.g. Bugbot, a review agent) as the main gate

## Decision Outcome

Chosen option: **four rings of Wardens**, with **CI and rulesets as the final authority**. Earlier rings exist for fast feedback; anything they enforce that matters is repeated in CI.

| Ring | Mechanism | Latency | Role |
|------|-----------|---------|------|
| 0 | Agent hooks in Claude Code (`.claude/settings.json`) and Cursor (`.cursor/hooks.json`) calling the Wardens CLI (ADR-0005) | ms–s | Block forbidden actions before they happen; Definition of Done on `Stop` |
| 1 | Git hooks via **lefthook** (`pre-commit`, `commit-msg`, `pre-push`) | s | Same checks for humans and agents before code leaves the machine |
| 2 | **Required CI checks** in GitHub Actions, aggregated by one stable job `panopticon/gate` | min | Mandatory gate; final authority on code |
| 3 | **GitHub rulesets + CODEOWNERS** on `main` | — | Cannot be bypassed from the repo or by an agent: PR required, required checks, CODEOWNERS review, no force push or deletion |

LLM reviewers (Sentinel, a11y reviewer, Bugbot if used) run on top of the rings. Their findings can **block auto-merge** (ADR-0008) but they never replace a deterministic check.

### MVP Wardens

| Warden | Rings | What it enforces |
|--------|-------|------------------|
| `scope-guard` | 0, 2 | Agent edits only inside the Charter's `allowed_paths`, narrowed by the issue's allowed paths (ADR-0001) |
| `protected-paths` | 0, 3 | Agent edits to The Charter, Covenant files, `.claude/**`, `.cursor/**`, `.github/**`, `deploy/**`, migrations are denied or require `ask`; CODEOWNERS review in ring 3 |
| `command-guard` | 0, 1 | Denies Charter `commands.deny` patterns (force push, `kubectl` on prod contexts, publishing packages, pipe-to-shell), applies `rewrite` rules |
| `secret-read-guard` | 0 | Denies reading `.env*` and `secrets/**` |
| `generated-files-guard` | 0, 2 | No hand edits of the generated API client or contract; points to the generator command |
| `definition-of-done` | 0, 2 | On agent `Stop`: runs the Charter's `definition_of_done` (lint, typecheck, affected tests, contract drift); red result keeps the agent working, within a loop limit |
| `bug-repro-test` | 2 | A PR labelled `type:bug` must add or change a test that **fails on `main` and passes on the PR branch**. Exception: label `test:waived` with a written justification in the PR; such a PR is never auto-merged |
| `e2e-test-modification` | 2 | Modifying an existing Playwright test requires label `needs:human` (prevents "fix the test, not the bug") |
| `test-tampering` | 2 | Flags removed or skipped tests (`.skip`, `@pytest.mark.skip`) and lowered coverage thresholds; requires human approval |
| Security tools | 1, 2 | **Semgrep** (OWASP rules for Python and TS), **gitleaks** (secrets; also in lefthook), **zizmor** (GitHub Actions workflows), **Trivy** (images and dependencies), **CodeQL**; dependency updates via Renovate or Dependabot |
| Accessibility | 1, 2 | Biome `a11y` rules; **axe-core** checks inside Playwright on key screens; **Lighthouse CI** accessibility score threshold |
| E2E | 2 | **Playwright** (only E2E tool) on the PR preview for critical paths: add offer, import, CV match, status change |
| `diff-coverage` | 2 | Minimum coverage **on changed lines** (`diff-cover`; threshold from The Charter, initial proposal 80%) |
| `risk-classifier` | 2 | Labels each PR `risk:low` / `risk:medium` / `risk:high` from Charter path rules. PRs touching auth, secrets, CI or The Charter are always `risk:high` and always need human approval (ADR-0008) |
| `pr-check` | 2 | PR references an issue, branch name convention, PR size limit (ADR-0001) |
| `agent-trailer` | 1 | Agent commits carry an `Agent:` trailer (ADR-0008) |

On top: the **Sentinel** role (blue-team security reviewer) reviews every PR diff for authorization flaws, prompt injection via job-offer content, CV data leaks and new MCP permissions; an agent reviewer checks focus order, labels and keyboard support for UI changes.

### Consequences

- Good, because a bypass of one ring is caught by the next; CI and rulesets cannot be disabled by an agent.
- Good, because agents get feedback in seconds and fix problems before opening a PR.
- Good, because every Warden verdict is recorded in The Ledger, measuring how often agents hit the guards.
- Bad, because the same rule runs several times, costing CI minutes and local latency.
- Bad, because too many gates can slow work down; Ledger data on time lost to blocks must drive pruning.
- Bad, because `bug-repro-test` needs CI to run the new test against `main`, which adds a job and complexity.

### Confirmation

- The `main` ruleset lists `panopticon/gate` as a required status check and requires CODEOWNERS review; `panopticon/gate` depends on every job listed above. CI job `ruleset-audit` compares the live ruleset with the required checks list generated from The Charter.
- `wardens doctor` (run by `wardens` CI tests) deliberately breaks a hook and asserts the action is blocked (fail-closed).
- Wardens unit tests (`pnpm --filter wardens test`) contain one positive and one negative case per Warden rule.
- The Ledger reports agent sessions without any hook events, which indicates disabled ring-0 hooks.

## Pros and Cons of the Options

### Four rings

- Good, because of defense in depth with a clear final authority.
- Bad, because of duplicated execution.

### CI only

- Good, because it is simple and cannot be bypassed.
- Bad, because there is no protection against dangerous local commands and feedback is slow.

### Agent hooks only

- Good, because of instant feedback.
- Bad, because hooks can be disabled locally and default to fail-open in Cursor.

### LLM reviewers as main gate

- Good, because they catch logic issues tools miss.
- Bad, because they are probabilistic and not a security boundary.

## More Information

- Research report, sections 2.1, 3.2, 7, 10.1, 11.4.
- Related: ADR-0001 (labels, ruleset), ADR-0003 (The Charter), ADR-0005 (engine), ADR-0008 (risk and autonomy), ADR-0010 (Ledger).
- Labels `risk:low|medium|high`, `test:waived`, `complexity:high` and `security` must be added to `.github/labels.yml` (ADR-0001).
- Amended by ADR-0013: `protected-paths` deny/ask split, `command-guard` denies `--no-verify`, `secret-read-guard` excepts `.env.example`, `risk-classifier` rules.
- Amended by ADR-0016: Sentinel reviews every PR diff except a `risk:low` PR that changes no code, policy, decisions or security specs (D6). The exception takes effect when C-20 is edited (ADR-0016 D6); until then Sentinel runs on every PR.
- Amended by ADR-0017: Claude Code is the only agent harness; the Cursor ring-0 hooks (`.cursor/hooks.json`) are frozen, not extended.
- See also ADR-0014: dependency updates use Renovate (Dependabot alerts only).
