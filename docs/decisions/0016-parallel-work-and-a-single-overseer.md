---
status: proposed
date: 2026-11-07
decision-makers: Krzysztof Oszczapiński
consulted: OVERSEER (AI), spec-writer (AI)
---

# ADR-0016: Parallel work and a single OVERSEER

## Context and Problem Statement

Krzysztof set a direction for parallel agent work on 2026-11-07 (issue #87). The Covenant and The Charter cover only part of it:

- C-11 and C-33 give one task one branch, one worktree and one PR. Nothing says one implementer per issue, or that dependencies are declared.
- Nothing limits how many implementers run at once, or orders tasks that touch the same files.
- Ring-0 hooks of every worktree run the primary checkout's Wardens bundle (ADR-0012). A bundle, hook or Charter change pulled mid-session changes the rules under every running agent.
- The independent Reviewer is applied by hand; its enforcer is #60.
- Parallel feature work on `apps/**` without an agreed data model and API contract produces conflicting migrations and contract diffs.
- OVERSEER's implementers run in Claude Code subagent worktrees (`agent-<hash>`, branch `worktree-agent-<hash>` until renamed). They do not pass through `wardens worktree new`, and the `WorktreeCreate` hook from ADR-0012 is not wired yet (#51).

C-01 requires an enforcer in code for every rule that must hold. This ADR records each point as a decision with its enforcement status. Recording it is not approval to raise the limit or to start tasks.

## Decision Drivers

- Throughput is bounded by review, CI and Krzysztof's merges, not by implementer count
- Merge conflicts and fix rounds cost more than serial work on the same files
- The review gate is a safety control, not a throughput knob (C-07, ADR-0008)
- Rules that agents follow must not change under a running session
- Every limit is a Charter key (C-04), checked by a Warden (C-01)
- Claude usage limits and the single agent host (decision log 2026-11-04) are finite

## Considered Options

1. No limit; OVERSEER parallelises as it sees fit
2. A hard Charter limit enforced now by a blocking Warden
3. A working limit of 2–4 in The Charter, enforced in steps (detect first, block later); more only through a later trial decision

## Decision Outcome

Chosen option: **3, a working limit enforced in steps**. It caps parallel work now without waiting for an enforcer that does not exist yet, and moves to blocking once the count is reliable on every worktree creation path.

### Decisions

Enforcement status per C-01: **enforced** (a Warden or check exists today), **planned** (enforcer named, not built), **not yet enforced** (no enforcer; prose only).

**D1. One OVERSEER.** One active OVERSEER session per project. Other planning or chat sessions do not commission implementation; they hand proposals to OVERSEER through issues.
- Rationale: two planners assign overlapping work and cannot see each other's file scopes.
- Enforcement: **not yet enforced.** Candidate: The Ledger records the role of each session (ADR-0010); a Ledger query flags two concurrent `overseer` sessions. The Ledger is not built.

**D2. One implementer per issue.** Each issue has at most one implementer at a time, in its own worktree, with a declared file scope (`### Allowed paths`) and declared dependencies (GitHub "blocked by" links, or "Depends on #N" in the issue).
- Rationale: two implementers on one issue produce competing PRs; undeclared dependencies cause out-of-order merges.
- Enforcement:
  - own worktree: **enforced** for edits and write commands in the primary checkout or in another worktree (`worktree-guard`). C-33's `<issue>-<slug>` naming is **not enforced** for subagent worktrees (`agent-<hash>` passes). C-33's "*Enforced by:* `worktree-guard` (planned)" is stale; the guard is wired.
  - file scope: **enforced when the worktree has `.panopticon/task.json`** (written by `wardens worktree new`; `scope-guard` reads its `allowed_paths`). Without it, `scope-guard` checks only the Charter's `allowed_paths` (`wardens/src/guards.ts`, `pathInScope`). Subagent worktrees have no task file today.
  - one implementer per issue: **planned**, at the points named in D4.
  - declared dependencies: **not yet enforced**.

**D3. Overlapping tasks run one after another.** Tasks whose issues' allowed paths overlap run serially. Tasks that touch a path in Charter `concurrency.serialize_on` also run serially with each other, even if their allowed paths do not otherwise overlap. OVERSEER decides overlap from the issues' allowed paths before assigning work.
- Shared mechanisms in `serialize_on`: `wardens/src/command.ts`, `wardens/src/guards.ts`, `wardens/src/charter.ts`, `wardens/schema/charter.schema.json`, `packages/contracts/openapi.json`, `packages/api-client/src/**`.
- The bundle, hook configs and The Charter are not listed: the bundle is not in git, and the others are `deny` or `ask` paths no issue can list. Their hazard is rollout (D7).
- Rationale: most Wardens and contract tasks edit these files; parallel edits there are the main source of conflicts and re-review.
- Overlap and `serialize_on` are judged on **declared** allowed paths only. A worktree without a task file is scoped only by the Charter's wide `allowed_paths`, so it can touch a `serialize_on` path without declaring it.
- `serialize_on` is incomplete (e.g. `wardens/src/task.ts`, `wardens/src/worktree/**`, `wardens/src/sync/**` are not listed). OVERSEER keeps it and proposes additions through Charter PRs.
- Enforcement:
  - creation time: **planned**, the same check points as D4: intersect the new task's allowed paths with those of other active tasks and with `serialize_on`, and refuse on overlap. Advisory for undeclared paths.
  - PR diff (ring 2, C-02): **planned**, a `serialize-check` in `pr-check` that compares the PR's changed files with `serialize_on` and with the changed files of other open PRs, and fails or labels `needs:human` on a shared hit.
  - Until built: **not yet enforced**; OVERSEER applies it by hand.

**D4. Working limit of 2–4 implementers.** At most 4 implementers run at once (Charter `concurrency.max_parallel_implementers: 4`).
- The limit is operational, not architectural: no design (ports, Cells, The Ledger) depends on it. 2 is the lower bound for parallel work to be useful, not a requirement.
- The limit is a ceiling, never a target; OVERSEER starts a task only when one is ready and does not overlap (D3).
- Counted by exclusion: every linked worktree counts as an implementer unless its branch matches a review prefix (`review-*`, `sentinel-*`). The directory name is ignored.
- Attribution: the issue resolves through `issueOf` (`wardens/src/worktree/index.ts`): `.panopticon/task.json`, else the `<type>/<issue>-<slug>` branch. A counted worktree with no resolvable issue is **unattributed**; it still counts, and `doctor` warns about it.
- The count is **advisory** while agents run under Krzysztof's UID: an agent can rename its branch (`git branch -m` is not denied) or edit its own `task.json`, and so move itself in or out of the review prefixes or the attribution.
- Rationale: review, CI and merges are the bottleneck; more implementers queue more unreviewed PRs and more conflicts.
- Enforcement: **planned** in two steps:
  1. `wardens doctor` check `concurrency` counts worktrees as above, warns above the Charter limit and lists unattributed worktrees. `doctor` sees every linked worktree, whatever created it.
  2. Blocking at creation: the `WorktreeCreate` hook (#51) and `wardens worktree new` refuse a new task worktree at the limit, on an issue already counted, or on D3 overlap; the hook sets the review prefix for reviewer and Sentinel worktrees. Until #51 lands the subagent path cannot be blocked, and the limit stays a `doctor` warning.
  - Both steps stay advisory against an agent that renames its branch; a non-advisory count needs a separate agent identity (#82) or The Ledger's session records.
- Until built: **not yet enforced**.

**D5. More implementers only as a later trial.** Raising the limit above the Charter limit (towards 5–6) needs a new ADR. The trial starts only when The Ledger shows, over a defined window, healthy values for:
- review queue time and CI queue time per PR;
- merge conflicts per PR;
- fix rounds (review re-runs) per PR;
- Claude usage-limit hits per day;
- agent host load (CPU, memory, disk).

Thresholds are set in that ADR.
- Rationale: the limit is raised on data, like autonomy phases (ADR-0008).
- Enforcement: the limit is a Charter key. Agent edits to The Charter are **enforced** as denied (`protected-paths`). Human approval of the `risk:high` Charter PR rests on Krzysztof being the one who merges: the interim `main` ruleset requires 0 approvals (decision log 2026-11-07, #37, #84) until the agent GitHub App returns it to 1 (#82). The metrics are **not yet enforced**; they need The Ledger.

**D6. The review gate is never traded for speed.** Current rule: an independent Reviewer on every PR; Sentinel on every PR (ADR-0008 phase 1, `AGENTS.md`). Both are fresh read-only sessions, run in parallel with other work, and are never skipped, shortened or merged with the implementer's session to raise throughput. Reviewers and Sentinels do not count against D4.
- Practice so far (process of 2026-11-05, #60): Sentinel only on `risk:high` and security PRs. This ADR does not narrow the rule; the scope is an open decision for Krzysztof, keyed to the `risk-classifier` result.
- Rationale: parallel work raises the risk of unseen interactions; the gate is the control for that (C-07, ADR-0008).
- Enforcement: **planned**, ring-2 check `review-gate` (#60). Until built: **not yet enforced**; OVERSEER applies it by hand.

**D7. Shared-mechanism changes roll out between sessions.** OVERSEER coordinates changes to the bundle, hooks, The Charter and generated configs: one at a time (D3), and announces the rollout once it believes no implementer session is running. The rollout is a **human** step. Krzysztof first confirms himself that no agent session is running (`wardens worktree list`, `git worktree list`, `lsof +D .claude/worktrees`); OVERSEER's announcement and the D4 count do not replace that check. He then runs `git pull` in the primary checkout, rebuilds the bundle, and runs `wardens doctor` until green; then new sessions start. Agents cannot pull in the primary checkout (C-33, `worktree-guard`).
- Rationale: every worktree's hooks run the primary checkout's bundle (ADR-0012), so a mid-session pull changes the rules under running agents.
- Enforcement:
  - The Charter cannot be edited by agents: **enforced** (`protected-paths`, `deny`);
  - configs are `ask`: **enforced** (`protected-paths`);
  - stale bundle or drifted configs: **enforced as detection** (`wardens doctor` checks `bundle` and `drift`; CI `charter-drift`);
  - "only between sessions": **not yet enforced**; Krzysztof's own check is the control, and the D4 count (zero counted worktrees, none unattributed) is a supporting signal only.

**D8. Contracts before parallel feature work.** Before parallel feature work on `apps/**` starts, the LunarHunt data model and API contracts are agreed: a spec with `status: ready` (C-10) and the matching `packages/contracts/openapi.json` merged to `main`.
- Rationale: parallel features on an unagreed model produce conflicting migrations and contract diffs.
- Enforcement:
  - spec before feature work on `apps/**`: **planned** (C-10, Charter `require_spec_for`; the `spec-check` Warden is not built);
  - contract is generated, drift is checked: **enforced** (`pnpm check` contract drift, CI `contract`);
  - "agreed before parallel work": **not yet enforced**; D3's `serialize_on` keeps contract and client paths serial meanwhile.

### Consequences

- Good, because parallel work is capped by review and merge capacity, not by how many agents can start.
- Good, because shared mechanisms change one at a time and never under a running agent.
- Good, because the review gate stays independent of throughput pressure.
- Good, because raising the limit is a data-gated decision, like autonomy phases.
- Bad, because until the planned checks exist, D1–D4, D6 and D7's timing rely on OVERSEER following prose (C-01 gap, stated per decision).
- Bad, because serializing on `wardens/src/command.ts` and `guards.ts` slows Wardens work, where most current issues land.
- Bad, because blocking on the subagent path waits for #51, and the count stays advisory while agents share Krzysztof's UID.
- Neutral, because the Charter key needs a schema change first, so it lands with the D4 check, not before.

### Confirmation

- The Charter schema (`wardens/src/charter.ts` and `wardens/schema/charter.schema.json`) accepts `concurrency:`; `wardens sync` output, `wardens doctor` `drift` and CI `charter-drift` stay green.
- Wardens tests for the planned checks:
  - `concurrency` doctor check counts every linked worktree except review-prefixed branches, ignores directory names, reports issue-less worktrees as unattributed and counts them, and warns above the limit;
  - the `WorktreeCreate` hook and `wardens worktree new` refuse at the limit, on overlapping allowed paths, on `serialize_on` paths, and on an issue already counted;
  - `serialize-check` fails or labels a PR whose changed files hit `serialize_on` or another open PR's changed files;
  - every refusal uses the C-30 message format.
- `review-gate` per #60.
- The Ledger, once built, reports concurrent implementers, concurrent OVERSEER sessions and the D5 metrics.

## Pros and Cons of the Options

### No limit

- Good, because there is no new enforcer to build.
- Bad, because review and CI queues grow without bound.
- Bad, because overlap and conflicts are found only at merge.
- Bad, because it pushes the review gate to trade depth for speed.

### Hard Charter limit enforced now

- Good, because C-01 holds from day one.
- Bad, because the subagent creation path has no hook yet (#51); a blocking Warden would miss the sessions OVERSEER actually starts.
- Bad, because it blocks OVERSEER until a schema change, an engine change and a bundle rollout land, which are themselves serialized work (D3, D7).

### Working limit enforced in steps (chosen)

- Good, because it caps work now and states each enforcement gap honestly.
- Good, because the count is first observed (`doctor` warning), then made blocking.
- Bad, because the cap is prose until the `doctor` check lands.

## Proposed normative changes (Krzysztof applies after acceptance)

Agents do not edit these files: `docs/constitution.md` and `AGENTS.md` are `ask`, The Charter is `deny` (C-24).

Order:
1. Charter schema change (`wardens/src/charter.ts`, `wardens/schema/charter.schema.json`) and the `doctor` `concurrency` check, through a normal Wardens issue.
2. The Charter `concurrency:` section (Krzysztof).
3. C-34 and the `AGENTS.md` lines, which reference those keys.

### `panopticon.charter.yaml`: new section

```yaml
concurrency: # ADR-0016
  max_parallel_implementers: 4   # operational ceiling; raising it needs a new ADR (D5)
  count: { exclude_branches: ["review-*", "sentinel-*"], resolve_issue: [task_file, branch] }
  serialize_on:
    - "wardens/src/command.ts"
    - "wardens/src/guards.ts"
    - "wardens/src/charter.ts"
    - "wardens/schema/charter.schema.json"
    - "packages/contracts/openapi.json"
    - "packages/api-client/src/**"
```

- `count`: every linked worktree counts as one implementer unless its branch matches `exclude_branches`; its issue resolves from `.panopticon/task.json`, else from its `<type>/<issue>-<slug>` branch, and a worktree with no issue counts as unattributed.
- `serialize_on`: at most one active task may have declared allowed paths matching any listed path, and at most one open PR may change one; tasks are serialized on these paths even when their allowed paths do not otherwise overlap.

### `docs/constitution.md`: new principle C-34

Highest existing ID is C-33. Place C-34 in section II (Way of working), after C-33:

```markdown
**C-34 Bounded parallel work.** One OVERSEER per project assigns implementation; other sessions MUST NOT commission it. Each issue MUST have at most one implementer at a time, with declared allowed paths and dependencies. Tasks whose allowed paths overlap, or that touch a path in the Charter's `concurrency.serialize_on`, MUST run one after another. Agents MUST NOT run more implementers at once than `concurrency.max_parallel_implementers`; reviewers and Sentinels do not count, and the review gate MUST NOT be reduced to raise throughput. Changes to the Wardens bundle, hooks, The Charter or generated configs are rolled out by a human, only when no implementer session is running.
*Enforced by:* `wardens doctor` `concurrency` check (planned, warning; advisory while agents share the human's UID); `WorktreeCreate` hook and `wardens worktree new` refusal at the limit and on overlap (planned, #51; advisory for undeclared paths); `serialize-check` on the PR diff (planned, ring 2); `review-gate` (planned, #60); Krzysztof's own check of running sessions before a rollout; `wardens doctor` `bundle` and `drift`, CI `charter-drift` (detect stale rollouts); single OVERSEER and declared dependencies not yet enforced. [ADR-0016](decisions/0016-parallel-work-and-a-single-overseer.md)
```

### `AGENTS.md`: "Parallel work" subsection

Add after "Workflow: issue to PR":

```markdown
## Parallel work

- OVERSEER alone assigns tasks; at most `concurrency.max_parallel_implementers` run at once, and overlapping or `concurrency.serialize_on` tasks run one after another (C-34, [ADR-0016](docs/decisions/0016-parallel-work-and-a-single-overseer.md)).
- Krzysztof rolls out merged bundle, hook, Charter or config changes between sessions (`git pull` in the primary, `wardens doctor`); OVERSEER announces when no implementer is running.
```

## Open decisions

- **Limit value:** start at 4 (the top of 2–4) or at 3 until the `doctor` count exists.
- **Count source:** worktree list by exclusion with `issueOf` attribution (now), or Ledger sessions once The Ledger exists.
- **Sentinel scope:** every PR (ADR-0008, `AGENTS.md`) or only `risk:high` and security PRs (practice so far). OVERSEER recommends Sentinel on every PR except `risk:low` PRs (per `risk-classifier`) with no change to code, policy, decisions or security specs. A narrower scope amends ADR-0008; resolve before acceptance.
- **Lockfiles:** whether `pnpm-lock.yaml` and `uv.lock` join `serialize_on` or are left to rebase.
- **Contract baseline (D8):** which spec defines the LunarHunt data model, and whether it needs its own ADR.

## More Information

- Issue #87 (direction and gap table); #60 (review gate); #62 (effort by risk, Sentinel on security specs); #51 (`WorktreeCreate` hook); #82 (agent GitHub App); #84 (interim ruleset, 0 approvals).
- Related: ADR-0003 (The Charter), ADR-0008 (autonomy phases, human merge, Sentinel), ADR-0009 (role routing), ADR-0010 (The Ledger), ADR-0012 (worktrees, primary checkout bundle).
- Revisit when The Ledger is live, when #51 lands, or when D5's trial is proposed.
