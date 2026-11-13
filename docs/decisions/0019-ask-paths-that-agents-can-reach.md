---
status: proposed
date: 2026-11-13
decision-makers: Krzysztof Oszczapiński
consulted: OVERSEER (AI)
---

# ADR-0019: Ask paths that agents can reach, and paths that stay human-only

## Context and Problem Statement

ADR-0013 D1 split protected paths into `deny` and `ask`. It listed `.claude/**`, `.cursor/**`, `.github/**` and `deploy/**` as `ask`. C-24 and the root `AGENTS.md` repeat that list.

The Charter on `main` does not match it (#34):

- `paths.protected.ask` holds only the Covenant files, `apps/api/migrations/**` and `.env.example`.
- An edit is judged by `scope-guard` first. A path outside `paths.allowed_paths` is blocked before `protected-paths` can ask.
- `.claude/**`, `.cursor/**`, `.github/**`, `.devcontainer/**`, `deploy/**`, `lefthook.yml`, `.env.example`, the root `AGENTS.md` and `CLAUDE.md` are all outside `allowed_paths`.

So these paths are human-only today, whatever the `ask` list says. The CI job for #20 had to be written by a human for this reason. Product work on `apps/**` will need CI workflow, Dev Container, deploy and `.env.example` changes, and ADR-0016 D8 blocks that work until this is settled.

Krzysztof decided on 2026-11-13 (#34) which of these paths become reachable `ask` paths and which stay human-only. C-24 must change with it, and C-32 requires an ADR for that.

## Decision Drivers

- The Charter, C-24 and `AGENTS.md` must state the same policy (C-04).
- Agents need CI workflow, Dev Container, deploy and `.env.example` edits for product work, each with Krzysztof's approval.
- Agents must not edit their own guards or instructions: hook configs, permissions, skills, rules and the root Covenant entry files.
- Fail-closed when in doubt (C-03): a path is human-only unless it is listed.

## Considered Options

1. **A.** Keep all of these paths human-only and reword C-24 and `AGENTS.md` to say so.
2. **B, wide.** Make everything ADR-0013 D1 named reachable: add `.claude/**`, `.cursor/**`, `.github/**` and `deploy/**` to `allowed_paths` and `protected.ask`.
3. **B, narrow.** Make only the paths product work needs reachable, as `ask`; everything else stays human-only.

## Decision Outcome

Chosen option: **B, narrow (3)**, decided by Krzysztof on 2026-11-13. It unblocks product work and keeps agent configs and the root Covenant files out of agent reach. Option A would leave every CI and deploy change to Krzysztof. Option 2 would let an approved prompt change the hooks and permissions that guard the same session.

A path is a **reachable `ask` path** only when it matches both `paths.allowed_paths` and `paths.protected.ask`. A path outside `paths.allowed_paths` is **human-only**, even if `protected.ask` lists it.

### D1. New reachable `ask` paths

`.github/workflows/**`, `.devcontainer/**` and `deploy/**` are added to both `paths.allowed_paths` and `paths.protected.ask`.

- Enforcement: **enforced** by `scope-guard` and `protected-paths` (ring 0) once the Charter PR merges; `non_interactive_ask: deny` is unchanged, so headless sessions are denied.

### D2. `.env.example` becomes reachable

`.env.example` is added to `paths.allowed_paths`. It is already in `protected.ask`.

- Enforcement: **enforced** by `scope-guard` and `protected-paths`; gitleaks scans the file as before (ADR-0013 D5).

### D3. Human-only paths

These stay outside `paths.allowed_paths`, so agents cannot edit them in any session:

- the root `AGENTS.md` and `CLAUDE.md`;
- agent configs: `.claude/**` and `.cursor/**`;
- the rest of `.github/**` (issue templates, labels, the PR template, `CODEOWNERS`, `renovate.json5`);
- `lefthook.yml`.

An agent that needs a change there proposes the text in an issue or PR comment and labels the issue `needs:human`.

The root `AGENTS.md` and `CLAUDE.md` stay listed in `protected.ask`. The entries have no effect today; they keep the files guarded if `allowed_paths` is ever widened by mistake.

- Enforcement: **enforced** by `scope-guard` (ring 0) and CODEOWNERS (ring 3).

### D4. Unchanged `ask` paths

`docs/constitution.md`, `**/AGENTS.md` inside packages and `docs/specs/`, and `apps/api/migrations/**` already match both lists and stay reachable `ask` paths. C-32 still lets an agent draft a constitution change in a PR after Krzysztof approves the edit.

- Enforcement: **enforced** by `protected-paths`.

### D5. Generated configs

`.claude/settings.json`, `.claude/agents/*.md`, `.cursor/hooks.json`, `.cursor/worktrees.json` and `lefthook.yml` change only through a Charter change and a human `wardens sync` (ADR-0013 D1, unchanged). They are also human-only under D3.

- Enforcement: **enforced** by `scope-guard` and the CI check `charter-drift`.

### D6. `.devcontainer/**` is `risk:high`

C-24 says every PR on a protected path is `risk:high`. `risk.high.paths` does not list `.devcontainer/**`, so it is added. `.github/**` and `deploy/**` are already listed.

This point is not in Krzysztof's decision text of 2026-11-13. OVERSEER added it so that C-24 stays true; Krzysztof confirms or removes it when he accepts this ADR.

- Enforcement: **not yet enforced** in code (`risk-classifier` is planned); CODEOWNERS already covers every path through the `*` rule.

### Charter changes (applied by Krzysztof, C-24)

```yaml
paths:
  allowed_paths:
    # existing entries stay
    - ".github/workflows/**"      # D1
    - ".devcontainer/**"          # D1
    - "deploy/**"                 # D1
    - ".env.example"              # D2
  protected:
    ask:
      # existing entries stay
      - ".github/workflows/**"    # D1
      - ".devcontainer/**"        # D1
      - "deploy/**"               # D1

risk:
  high:
    paths:
      # existing entries stay
      - ".devcontainer/**"        # D6
```

### Proposed normative changes (applied by Krzysztof in the Charter PR for #34)

**`docs/constitution.md`, C-24, second sentence.** Replace:

> Agent edits to Covenant files (`AGENTS.md`, `**/AGENTS.md`, `CLAUDE.md`, this file), agent configs (`.claude/**`, `.cursor/**`), CI (`.github/**`), `deploy/**`, migrations and `.env.example` are `ask`: allowed only after Krzysztof approves the action, and denied in non-interactive sessions.

with:

> Agent edits to this file, `AGENTS.md` files inside packages and `docs/specs/`, CI workflows (`.github/workflows/**`), `.devcontainer/**`, `deploy/**`, migrations and `.env.example` are `ask`: allowed only after Krzysztof approves the action, and denied in non-interactive sessions. The root `AGENTS.md`, `CLAUDE.md`, agent configs (`.claude/**`, `.cursor/**`), the rest of `.github/**` and `lefthook.yml` are human-only: agents MUST NOT edit them. Generated configs change only through `wardens sync`.

The enforcer line of C-24 becomes:

> *Enforced by:* `scope-guard` and `protected-paths` (ring 0), CODEOWNERS (ring 3), `risk-classifier`. Deny/ask split: [ADR-0013](decisions/0013-charter-policy-refinements.md), amended by [ADR-0019](decisions/0019-ask-paths-that-agents-can-reach.md).

**Root `AGENTS.md`, "Rules Wardens will enforce", first bullet.** Replace the sentence that starts "The Charter and secrets are **deny**" with:

> The Charter and secrets are **deny**; `docs/constitution.md`, package `AGENTS.md` files, `.github/workflows/**`, `.devcontainer/**`, `deploy/**`, migrations and `.env.example` are **ask** (Krzysztof approves; denied in headless runs); the root `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.cursor/**`, the rest of `.github/**` and `lefthook.yml` are human-only, and generated configs change only through `wardens sync` (`protected-paths`, [ADR-0013](docs/decisions/0013-charter-policy-refinements.md), [ADR-0019](docs/decisions/0019-ask-paths-that-agents-can-reach.md)).

### Amended points per ADR

| ADR | Amended point |
|-----|---------------|
| ADR-0013 | D1 `ask` list: `.claude/**`, `.cursor/**` and `.github/**` outside `workflows/` are human-only, not `ask`; `.devcontainer/**` is a new `ask` path; the root `AGENTS.md` and `CLAUDE.md` are human-only. The schema example in ADR-0013 is superseded on these lines. |
| ADR-0008 | High-risk path list gains `.devcontainer/**` (D6). |
| ADR-0014 | "`.github/renovate.json5` … so `ask` for agents" reads "human-only". |

### Consequences

- Good, because the Charter, C-24 and `AGENTS.md` state one policy, and the `ask` list names only paths where a prompt can really appear.
- Good, because agents can change CI workflows, the Dev Container, deploy manifests and `.env.example` for product work, each edit approved by Krzysztof.
- Good, because agents cannot edit hook configs, permissions, skills, rules, `CODEOWNERS` or the root Covenant entry files, even with an approved prompt.
- Bad, because an approved workflow edit can change what CI checks. The PR is `risk:high` and CODEOWNERS review is the control; workflow edits need a careful review.
- Bad, because every change to skills, rules, issue templates or labels still needs Krzysztof's hands.
- Neutral: headless sessions gain nothing; `ask` still resolves to deny there.

### Confirmation

- `charter-validate`: the changed Charter passes the schema; no schema change is needed.
- Wardens unit tests (`wardens-test`), added with the first Wardens PR after the Charter change, against the repository Charter:
  - edit of `.github/workflows/check.yml`, `.devcontainer/devcontainer.json`, `deploy/x.yaml` and `.env.example` → ask in an interactive payload, deny in a headless payload;
  - edit of `.github/CODEOWNERS`, `.github/labels.yml`, `.claude/skills/x/SKILL.md`, `.cursor/rules/x.mdc`, `lefthook.yml`, the root `AGENTS.md` and `CLAUDE.md` → deny by `scope-guard`.
- `charter-drift`: the generated `.claude/settings.json` matches `wardens sync` output after the Charter change.
- `wardens doctor` prints only `ok` lines in the primary checkout after the rollout.

## Pros and Cons of the Options

### A. Keep all human-only

- Good, because it is the smallest attack surface and needs no Charter change.
- Bad, because every CI, Dev Container and deploy change for product work waits for Krzysztof to write it.

### B, wide

- Good, because it matches the ADR-0013 text as written.
- Bad, because one approved prompt could weaken the hooks, permissions or instructions that guard the same session.

### B, narrow

- Good, because agents reach only what product work needs.
- Bad, because the list must be extended by a Charter PR when a new kind of path is needed.

## More Information

- Decision by Krzysztof on 2026-11-13, recorded on #34 (option B; three globs; `.env.example` reachable; root `AGENTS.md` and `CLAUDE.md` human-only; C-24 reworded in the Charter PR).
- Rollout follows ADR-0016 D7: Krzysztof applies the Charter change and runs `wardens sync` when no implementer session is running.
- Related: ADR-0003 (The Charter), ADR-0004 (rings), ADR-0006 (Covenant), ADR-0008 (risk), ADR-0013 (amended), ADR-0014 (amended), ADR-0016 (proposed, PR #88; its C-20 edit rides in the same Charter PR).
- The ADR number 0018 is reserved for the data model baseline (#105).
