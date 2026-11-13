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
- `protected-paths` asks only for a path that is in scope. An edit outside `paths.allowed_paths` is denied by `scope-guard`, and deny outranks ask.
- `.claude/**`, `.cursor/**`, `.github/**`, `.devcontainer/**`, `deploy/**`, `lefthook.yml`, the root `.env.example`, the root `AGENTS.md` and the root `CLAUDE.md` are all outside `allowed_paths`.

So these paths are human-only today, whatever the `ask` list says. The CI job for #20 had to be written by a human for this reason. Product work on `apps/**` will need CI workflow, Dev Container, deploy and `.env.example` changes; until #34 is settled, Krzysztof has to make each of them himself.

Krzysztof decided on 2026-11-13 (#34) which of these paths become reachable `ask` paths and which stay human-only. C-24 must change with it, and C-32 requires an ADR for that.

## Decision Drivers

- The Charter, C-24 and `AGENTS.md` must state the same policy (C-04).
- Agents need CI workflow, Dev Container, deploy and `.env.example` edits for product work, each with Krzysztof's approval.
- Agents must not edit their own guards or instructions: hook configs, permissions, skills, rules and the root Covenant entry files.
- Fail-closed when in doubt (C-03): a path is human-only unless it is listed.

## Considered Options

1. **Human-only.** Keep all of these paths human-only and reword C-24 and `AGENTS.md` to say so (option A on #34).
2. **Wide `ask`.** Make everything ADR-0013 D1 named reachable: add `.claude/**`, `.cursor/**`, `.github/**` and `deploy/**` to `allowed_paths` and `protected.ask`.
3. **Narrow `ask`.** Make only the paths product work needs reachable, as `ask`; everything else stays human-only (option B on #34, with the globs Krzysztof named).

## Decision Outcome

Chosen option: **narrow `ask` (3)**, decided by Krzysztof on 2026-11-13. It unblocks product work and keeps agent configs and the root Covenant files out of agent reach. Option 1 would leave every CI and deploy change to Krzysztof. Option 2 would let an approved prompt change the hooks and permissions that guard the same session.

A path is a **reachable `ask` path** only when it matches both `paths.allowed_paths` and `paths.protected.ask`. A path outside `paths.allowed_paths` is **human-only**, even if `protected.ask` lists it.

Two limits apply to every decision below:

- A task scope only narrows. An agent reaches an `ask` path only when the issue's allowed paths also list it.
- "Enforced" by ring 0 means Edit and Write actions and the shell writes that Wardens recognise. Ring 0 is a guard rail, not a sandbox: a write through an arbitrary interpreter is closed only by the sandbox (#69).

A Charter glob with no `/` matches the file name in any directory. `AGENTS.md`, `CLAUDE.md` and `.env.example` are such globs.

### D1. New reachable `ask` paths

`.github/workflows/**`, `.devcontainer/**` and `deploy/**` are added to both `paths.allowed_paths` and `paths.protected.ask`.

A session prompts only when it is marked interactive: the hook payload says so, or a human exported `PANOPTICON_INTERACTIVE=1` before starting it (`wardens sync` does not set it). Every other session is denied. That variable must not be set for background or headless sessions.

These three paths run with more rights than the agent that edits them; see "Residual risk" below.

- Enforcement: **enforced** by `scope-guard` and `protected-paths` (ring 0) once the Charter PR merges; `non_interactive_ask: deny` is unchanged, so headless sessions are denied. Review of the edit before it runs: **not yet enforced** in code; Krzysztof's merge is the control.

### D2. `.env.example` becomes reachable

`.env.example` is added to `paths.allowed_paths`. It is already in `protected.ask`.

The glob matches by file name, so every `.env.example` becomes a reachable `ask` path, not only the root one. Copies under `apps/**` and `packages/**` are reachable `ask` paths already.

`wardens worktree` setup builds a new worktree's `.env` from this file. An approved edit can therefore put a wrong value, for example a redirected endpoint or database URL, into later worktrees. The control for that is the PR review. `.env.example` is already `risk:high` through `.env*`.

- Enforcement: **enforced** by `scope-guard` and `protected-paths`. Secret scanning: gitleaks (ADR-0013 D5) is planned and **not built** (#108); GitHub secret scanning with push protection is the interim control, and it knows provider patterns only.

### D3. Human-only paths

These stay outside `paths.allowed_paths`, so `scope-guard` denies agent edits to them in every session:

- the root `AGENTS.md` and the root `CLAUDE.md`;
- agent configs: `.claude/**` and `.cursor/**`;
- the rest of `.github/**` (issue templates, labels, the PR template, `CODEOWNERS`, `renovate.json5`);
- `lefthook.yml`.

An agent that needs a change there proposes the text in an issue or PR comment and labels the issue `needs:human`.

The `AGENTS.md` and `CLAUDE.md` entries stay in `protected.ask`. For the root files they change nothing: `scope-guard` alone keeps them human-only. If `allowed_paths` were widened, they would become `ask`, not blocked. For a file of the same name in an allowed directory the entries do apply: `apps/web/CLAUDE.md` is a reachable `ask` path (D4).

The globs are anchored at the repository root. A `.claude/` or `.cursor/` directory nested under an allowed directory (for example `apps/web/.claude/`) is in scope and is not an `ask` path. No such directory exists; closing the gap needs a Charter entry and is a follow-up (#61).

Ring 0 is the only control on the human-only set. A second ring (C-02) is **not yet enforced**: the options are to move the set to `protected.deny`, or a CI check that fails an agent PR touching it (#108).

- Enforcement: **enforced** by `scope-guard` (ring 0). CODEOWNERS (ring 3) lists these paths, but code-owner review is **not yet enforced**: the interim `main` ruleset requires 0 approvals and no code-owner review (decision log 2026-11-07), so the control is that Krzysztof is the one who merges.

### D4. Unchanged `ask` paths

These already match both lists and stay reachable `ask` paths:

- `docs/constitution.md`;
- `AGENTS.md` and `CLAUDE.md` files below `apps/`, `packages/`, `wardens/` and `docs/`;
- `apps/api/migrations/**`.

C-32 still lets an agent draft a constitution change in a PR after Krzysztof approves the edit. This differs from the C-24 draft posted on #34, which put the constitution in the human-only sentence: the constitution matches `docs/**`, so making it human-only would need a Charter change that Krzysztof did not decide. Krzysztof confirms or changes this point when he accepts this ADR.

- Enforcement: **enforced** by `protected-paths`.

### D5. Generated configs

`.claude/settings.json`, `.cursor/hooks.json` and `lefthook.yml` change only through a Charter change and a human `wardens sync` (ADR-0013 D1, unchanged). They are also human-only under D3. Files that `wardens sync` generates later follow the same rule.

- Enforcement: **enforced** by `scope-guard` and, for these three files, the CI check `charter-drift`.

### D6. `.devcontainer/**` is `risk:high`

C-24 says every PR on a protected path is `risk:high`. `risk.high.paths` does not list `.devcontainer/**`, so it is added. `.github/**` and `deploy/**` are already listed.

This point is not in Krzysztof's decision text of 2026-11-13. OVERSEER added it so that C-24 stays true; Krzysztof confirms or removes it when he accepts this ADR.

- Enforcement: **not yet enforced** in code (`risk-classifier` is planned). Until then OVERSEER sets the label and Krzysztof merges every PR.

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

> Agent edits to this file, `AGENTS.md` and `CLAUDE.md` files below `apps/`, `packages/`, `wardens/` and `docs/`, CI workflows (`.github/workflows/**`), `.devcontainer/**`, `deploy/**`, migrations and `.env.example` are `ask`: allowed only after Krzysztof approves the action, and denied in non-interactive sessions. The root `AGENTS.md`, the root `CLAUDE.md`, agent configs (`.claude/**`, `.cursor/**`), the rest of `.github/**` and `lefthook.yml` are human-only: agents MUST NOT edit them. Generated configs change only through `wardens sync`.

The third sentence of C-24 ("All such PRs, and PRs touching auth code, are `risk:high`.") becomes:

> All PRs that touch a `deny`, `ask` or human-only path named in this principle, and PRs touching auth code, are `risk:high`.

The enforcer line of C-24 becomes:

> *Enforced by:* `scope-guard` and `protected-paths` (ring 0), `risk-classifier` (planned); CODEOWNERS review (ring 3) is **not yet enforced** while the interim `main` ruleset requires no approval. Deny/ask split: [ADR-0013](decisions/0013-charter-policy-refinements.md), amended by [ADR-0019](decisions/0019-ask-paths-that-agents-can-reach.md).

**Root `AGENTS.md`, "Rules Wardens will enforce", first bullet.** Replace the sentence that starts "The Charter and secrets are **deny**" with:

> The Charter and secrets are **deny**; `docs/constitution.md`, `AGENTS.md` and `CLAUDE.md` files below `apps/`, `packages/`, `wardens/` and `docs/`, `.github/workflows/**`, `.devcontainer/**`, `deploy/**`, migrations and `.env.example` are **ask** (Krzysztof approves; denied in headless runs); the root `AGENTS.md`, the root `CLAUDE.md`, `.claude/**`, `.cursor/**`, the rest of `.github/**` and `lefthook.yml` are human-only, and generated configs change only through `wardens sync` (`scope-guard`, `protected-paths`, [ADR-0013](docs/decisions/0013-charter-policy-refinements.md), [ADR-0019](docs/decisions/0019-ask-paths-that-agents-can-reach.md)).

### Amended points per ADR

| ADR | Amended point |
|-----|---------------|
| ADR-0003 | Schema outline: `.claude/**`, `.cursor/**` and `.github/**` outside `workflows/` are human-only through `allowed_paths`, not protected `ask` paths. |
| ADR-0004 | `protected-paths` row: agent configs are human-only (denied by `scope-guard`), not `ask`. |
| ADR-0006 | "Covenant files are `ask`" holds for the constitution and for `AGENTS.md` and `CLAUDE.md` files below the allowed directories; the root `AGENTS.md` and the root `CLAUDE.md` are human-only. |
| ADR-0008 | High-risk path list gains `.devcontainer/**` (D6). |
| ADR-0013 | D1 `ask` list: `.claude/**`, `.cursor/**` and `.github/**` outside `workflows/` are human-only, not `ask`; `.devcontainer/**` is a new `ask` path; the root `AGENTS.md` and the root `CLAUDE.md` are human-only. The schema example in ADR-0013 is superseded on these lines. |
| ADR-0014 | "`.github/renovate.json5` … so `ask` for agents" reads "human-only". |

The "Amended by ADR-0019" notes in these ADRs are added in the Charter PR for #34, once this ADR is accepted.

Texts that state the old policy and are updated by follow-ups, not here:

- ADR-0016 (proposed, PR #88), D3 and D7: "configs are `ask`" reads "human-only";
- `docs/specs/2026-11-04-wardens-core.md`, where it lists `.claude/**` and `.github/**` as `ask` paths;
- `.github/pull_request_template.md`, risk list: gains `.devcontainer/**` (human-only file, Krzysztof edits it).

### Consequences

- Good, because the Charter, C-24 and `AGENTS.md` state one policy, and the `ask` list names only paths where a prompt can really appear.
- Good, because agents can change CI workflows, the Dev Container, deploy manifests and `.env.example` for product work, each edit approved by Krzysztof.
- Good, because ring 0 denies agent edits to hook configs, permissions, skills, rules, `CODEOWNERS` and the root Covenant entry files, even with an approved prompt.
- Bad, because an approved workflow edit can change what CI checks, and an approved Dev Container edit changes the image that CI builds and runs. The control is that Krzysztof reviews and merges every such PR; code-owner review is not yet enforced by the ruleset. These edits need a careful review.
- Bad, because every change to skills, rules, issue templates or labels still needs Krzysztof's hands.
- Bad, because a worktree without `.panopticon/task.json` (every OVERSEER subagent worktree today) is scoped by the Charter alone, so the issue's allowed paths do not narrow the new paths there.
- Neutral: headless sessions gain nothing; `ask` still resolves to deny there.

### Residual risk

The approval prompt and Krzysztof's merge are the only controls on the content of these edits. A prompt for a shell write shows the command, not the content. None of the points below has a deterministic control today (C-01); each is **not yet enforced** and tracked in #108.

- **A PR can edit what gates it.** The required checks `check`, `contract`, `charter-drift` and `wardens-test` run from the PR's own workflow files and build the PR's own `.devcontainer/Dockerfile`.
- **Workflow token rights.** The existing workflows pin `permissions: contents: read`. An approved edit can widen that, and a workflow with write rights could act on its own PR while the ruleset requires no approval.
- **A new workflow runs on push**, before any review.
- **Privileged triggers.** `pull_request_target` and `workflow_run` run with the base repository's rights and secrets. No secrets exist yet; deploy will add some.
- **Dev Container.** Parts of `devcontainer.json` and the compose file run on the host and its Docker daemon, with the repository mounted read-write. Opened on the primary checkout, that reaches the Wardens bundle and the git hooks. A Dev Container per task worktree (the planned Cell) would run agent-edited config before review.
- **Deploy.** `deploy/**` is the GitOps source: a merge applies it with the deploy controller's rights.
- **CI trust base.** Agents already edit, with no prompt, files that decide what the checks run (`wardens/**`, `turbo.json`, package scripts). The `ask` on workflows narrows the gap; it does not close it.

Human rule until the controls exist: never open a Dev Container or a compose stack from an unreviewed agent branch.

### Preconditions for the Charter change (proposed; Krzysztof decides)

OVERSEER proposes that Krzysztof does these before he applies the Charter change. They are repository settings, not agent work:

1. Actions default workflow token: read-only; Actions may not create or approve pull requests.
2. The required checks in the `main` ruleset are pinned to the GitHub Actions app.

Tracked, not preconditions: a zizmor and actionlint required check, gitleaks, a manifest policy check for `deploy/**`, and the return to one approval with code-owner review (#82). All are in #108. Krzysztof may instead narrow D1 until they exist, for example to `.github/workflows/**` and `.devcontainer/observability/**`.

### Confirmation

- `charter-validate`: the changed Charter passes the schema; no schema change is needed.
- Wardens unit tests (`wardens-test`) read the repository Charter. Two existing tests assert the old policy and turn red with the Charter change: `wardens/test/rules.test.ts` (out-of-scope table with `.github/workflows/check.yml`, `deploy/app.yaml` and the root `.env.example`) and `wardens/test/shell-writes.test.ts` (the same paths as shell write targets). They change **in the same PR as the Charter change**, to:
  - edit of `.github/workflows/check.yml`, `.devcontainer/devcontainer.json`, `deploy/app.yaml` and `.env.example` → ask in an interactive payload, deny in a headless payload;
  - edit of `.github/CODEOWNERS`, `.github/labels.yml`, `.claude/skills/x/SKILL.md`, `.cursor/rules/x.mdc`, `lefthook.yml`, the root `AGENTS.md` and the root `CLAUDE.md` → deny by `scope-guard`.
- `charter-drift`: the generated `.claude/settings.json` matches `wardens sync` output after the Charter change.
- `wardens doctor` prints only `ok` lines in the primary checkout after the rollout.

## Pros and Cons of the Options

### 1. Human-only

- Good, because it is the smallest attack surface and needs no Charter change.
- Bad, because every CI, Dev Container and deploy change for product work waits for Krzysztof to write it.

### 2. Wide `ask`

- Good, because it matches the ADR-0013 text as written.
- Bad, because one approved prompt could weaken the hooks, permissions or instructions that guard the same session.

### 3. Narrow `ask`

- Good, because agents reach only what product work needs.
- Bad, because the list must be extended by a Charter PR when a new kind of path is needed.

## More Information

- Decision by Krzysztof on 2026-11-13, recorded on #34 (option B; three globs; `.env.example` reachable; root `AGENTS.md` and `CLAUDE.md` human-only; C-24 reworded in the Charter PR).
- Rollout, with no implementer session running (the rule proposed as ADR-0016 D7, PR #88):
  1. Krzysztof edits the Charter, `docs/constitution.md` and the root `AGENTS.md` on a branch, runs `wardens sync` and commits its output in the same PR (`charter-drift` requires it).
  2. An implementer adds the two Wardens test edits named under Confirmation to that branch; `wardens-test` stays red until they land.
  3. After the merge: `git pull` in the primary checkout, then `wardens doctor`.
  4. Existing worktrees keep a stale `.claude/settings.json` until they merge `main`; the hook reads the Charter from the primary checkout, so the verdicts are already the new ones.
  5. Before agent sessions restart, probe one path per class in an interactive session: a new `ask` path asks, a human-only path is denied.
- Related: ADR-0003 (The Charter), ADR-0004 (rings), ADR-0006 (Covenant), ADR-0008 (risk), ADR-0013 (amended), ADR-0014 (amended), ADR-0016 (proposed, PR #88; its C-20 edit rides in the same Charter PR).
- The ADR number 0018 is reserved for the data model baseline (#105).
