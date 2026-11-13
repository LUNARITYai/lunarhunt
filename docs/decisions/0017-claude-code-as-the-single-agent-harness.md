---
status: accepted
date: 2026-11-10
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI), OVERSEER (AI)
---

# ADR-0017: Claude Code as the single agent harness

## Context and Problem Statement

PANOPTICON was designed for two agent harnesses, Claude Code and Cursor (ADR-0004, ADR-0005, ADR-0009, ADR-0012). A **harness** is the tool an agent session runs in; it is the Charter's `roles.*.engine`, the CLI's `--tool` and The Ledger's `tool`.

Cursor produced the first four agent PRs (#1, #3, #8, #9). Every agent PR since then came from Claude Code: The Charter sets `engine: claude` on every role, OVERSEER runs Claude Code in Herdr, and the Reviewer and Sentinel are Claude Code sessions.

Keeping Cursor at parity still costs work:

- `.cursor/hooks.json` generation, the recorded Cursor fixtures and a golden test;
- the Cursor effort-in-model-slug mapping (ADR-0009, `wardens/src/engines.ts`);
- spike #39 (Cursor permission file), #68 (`.cursor/worktrees.json`) and the Cursor parts of #51 and #66;
- Cursor hooks fail open by default (ADR-0004), and the proposed ADR-0015 (PR #70) configures no OS sandbox for Cursor, so a Cursor agent session has ring 0 only.

PANOPTICON has one maintainer. Two harnesses double the Wardens test matrix and the sandbox work, and the second one is the weaker security surface.

## Decision Drivers

- Spend phase 0–1 effort on The Ledger and LunarHunt, not on harness parity
- One fail-closed hook surface and one sandbox to verify
- Keep the option to add a harness later without rewriting Wardens (ADR-0005 process contract)
- Claude subscription limits are a single point of failure and must be managed explicitly

## Considered Options

1. Claude Code is the only supported agent harness; Cursor work is frozen; the `engine` seam stays
2. Keep Claude Code and Cursor at parity (status quo)
3. Claude Code only, and remove all Cursor code and the `engine` field

## Decision Outcome

Chosen option: **1, Claude Code only with the seam kept**. It stops the parity work now and keeps a later harness a contained change.

### Decisions

Enforcement status per C-01: **enforced**, **planned** (enforcer named, not built) or **not yet enforced** (prose only).

**D1. Single harness.** In autonomy phases 0–2, agent roles (`overseer`, `spec-writer`, `implementer`, `reviewer`, `sentinel`, `debugger`) run only in Claude Code.
- Krzysztof may use Cursor as his editor; that is a human session.
- Cursor's agent mode on this repository is an agent run and is given no agent-role work. It should stay under the frozen ring-0 hooks and the worktree and trailer rules, but that is not verified for the IDE's agent mode: Cursor hooks fail open by default and trailer detection depends on an environment marker. Cursor's agent mode is therefore not used on this repository while the freeze lasts (decision of 2026-11-13 below).
- Enforcement: **not yet enforced**. The Charter has `engine: claude` on every role, by inspection only; the schema also accepts `cursor`. Planned: a `charter-validate` rule and a Ledger flag (Confirmation).

**D2. Cursor-specific work is frozen.**
- #39 (Cursor permission file spike) and #68 (`.cursor/worktrees.json`) stay open, labelled `blocked`, with a link to this ADR.
- #51 already covers Claude Code only (scope change of 2026-11-06); no Cursor work is added to it.
- #66 and the proposed ADR-0015: the Cursor and Dev Container sandbox items stay deferred.
- No new Cursor fixtures, adapter features or tests.

**D3. The seam stays.** The Charter keeps `roles.*.engine`, the schema keeps the enum, and `wardens/src/engines.ts` keeps the adapter registry. The existing `.cursor/hooks.json` generation and its tests stay in the repository until phase 1 at least (Krzysztof's direction of 2026-11-10); removing them is a later decision by Krzysztof.
- Frozen means no new Cursor features. Security fixes to the shared engine and launcher still reach the Cursor adapter, because it runs the same bundle.
- Cursor coverage is best-effort and is not a control anyone relies on. `charter-drift` and the golden test prove only that the generated file equals the generator's output, not that Cursor keeps up with new Wardens.
- Krzysztof owns the freeze and its end.

**D4. Role-to-model mapping stays in The Charter.** Models are chosen per role in `roles:` (ADR-0009), never hard-coded in prompts, hooks or docs. Changing a model is a one-line Charter PR by Krzysztof.

**D5. Time-boxed OVERSEER model: a one-off deviation from C-26.** Krzysztof started the OVERSEER session on Claude Fable 5.2 on 2026-11-10, for Anthropic's promotion that ends on 2026-11-16 23:59 PT (2026-11-17 08:59 Europe/Warsaw). The Charter still says `opus` for `overseer`.
- This is a deviation from C-26 ("an agent MUST run on the model of its Charter role") and from D4. It was started by the human, not by an agent, and this ADR records it after the fact; it does not make it a rule.
- The regular route is a Charter PR that sets the model and a second one that reverts it. For the days that remain Krzysztof acknowledged the deviation instead (decision of 2026-11-13 below).
- Nothing detects the deviation or its expiry: `model-guard` (ADR-0009) is not built, and once built it would block such a session. **Not yet enforced.**
- Every commit trailer must name the model that actually ran (C-27). **Not yet enforced:** `agent-trailer` does not check the model text, which the agent reports itself; The Ledger (#98) is the planned record of the model per run.
- After 2026-11-17 08:59 Europe/Warsaw OVERSEER runs on the Charter value again. Usage credits or any other model change go through a Charter PR.
- The agent host runs Claude Code 2.1.321 or later (`wardens doctor` minimum, #102). All other roles keep their Charter values.

**D6. Quota is a planning input.** Every Herdr session (OVERSEER, implementers, reviewers) draws from the same Claude subscription. All of D6 is **not yet enforced**: remaining quota is read by hand from the Claude Code usage display and has no planned enforcer; the session status files (#99) and The Ledger (#98) are planned to record limit hits only. The references to ADR-0016 hold once it is accepted.
- The expensive model is used only where planning quality pays off (D4).
- Parallel implementers are capped by the proposed ADR-0016 and by remaining quota: OVERSEER starts an implementer only if the current 5-hour window and the weekly limit leave room for its review rounds.
- Round-2 reviews are delta-only (proposed ADR-0016 D9).
- Sessions hand over to a fresh session at about 40–50% context instead of running long (#100).
- When a limit is hit, sessions stop, the issue gets a handoff note, and work resumes after the reset. Work does not move to another harness mid-task.
- A limit hit never waives the review gate (proposed ADR-0016 D6). A PR whose Reviewer or Sentinel round was cut off stays unmerged and is labelled `needs:human` or left as a draft until the round is complete.
- A bundle, hook, Charter or config rollout (proposed ADR-0016 D7) is not started inside a window the quota may cut.

### Return condition

A second harness is reconsidered only through a new ADR, when one of these holds:

- our own benchmark on past tasks shows a clear quality or cost advantage;
- Claude limits block planned work for more than one week despite the D6 mitigations.

### Consequences

- Good, because one harness halves the hook, fixture and sandbox matrix.
- Good, because frozen Cursor issues stop competing for OVERSEER and review time.
- Good, because the `engine` seam keeps a later harness a contained change.
- Good, because agent work leaves the harness where PANOPTICON configures no OS sandbox (proposed ADR-0015) and whose hooks fail open by default.
- Bad, because all agent work depends on one vendor's availability, pricing and limits.
- Bad, because the frozen `.cursor/**` generation can rot, and a Cursor agent session stays possible with weaker protection until the follow-ups below land.
- Neutral, because ADR-0004, ADR-0005, ADR-0008, ADR-0009 and ADR-0012 still describe Cursor; this ADR amends them where they require Cursor parity.

### Confirmation

Nothing below is enforced today; D1 holds by inspection of The Charter.

- Planned: a `charter-validate` rule (or a schema change) that fails when a role's `engine` is not `claude`. It is a Charter schema change, so Krzysztof rolls it out.
- Planned: The Ledger records `tool` per run (#98) and its report flags an agent run with `tool != claude`. #98 does not list that flag yet; it is added there or in a new issue.
- #39 and #68 carry a link to this ADR and are not `agent:ready`.
- The follow-ups below are applied.

### Follow-ups (Krzysztof applies; protected or Charter paths)

- The Charter `worktree.primary_read_only_commands` still allows `agent -w *` and `agent --worktree *`; remove both.
- `AGENTS.md` (intro line and the `agent -w` worktree command), `wardens/AGENTS.md` and `.cursor/rules/github-writing.mdc` still present Cursor as an agent harness.
- ADR-0012's Confirmation items for Cursor (`.cursor/worktrees.json` exists, the Cursor worktree-count warning, Cursor payload contract tests for worktrees) are suspended while the freeze lasts.
- ADR-0008's "local agents (Claude Code, Cursor)" and the decision-log "Agent host" row (Cursor cloud agents for background work) are superseded by D1; the decision-log row is added with #101.
- Consider making the frozen Cursor hooks deny agent-role work, or a `wardens doctor` warning when a Cursor agent session is seen (new issue once this ADR is accepted).

## Pros and Cons of the Options

### Claude Code only, seam kept (chosen)

- Good, because it cuts parity work now and keeps optionality cheap.
- Bad, because agent work is locked to one vendor in phases 0–2.

### Parity (status quo)

- Good, because it keeps the most optionality.
- Bad, because the cost is paid every week, for a harness that has produced no agent PR since #9.

### Remove Cursor and the seam

- Good, because it leaves the least code.
- Bad, because adding a harness later means touching the schema, the engine and `wardens sync` again.

## Direction agreed by Krzysztof (2026-11-10); this ADR is not yet accepted

- `.cursor/hooks.json` generation and the Cursor fixtures are kept frozen, not removed, until phase 1 at least.
- #39 stays open with `blocked`; #68 stays `blocked`.
- OVERSEER runs on Fable during the promotion; afterwards the Charter default applies. Usage credits or another model need a Charter PR (D5).

## Decisions on the open points (Krzysztof, 2026-11-13)

- **D5 route:** the deviation is acknowledged as a one-off that ends on 2026-11-17 08:59 Europe/Warsaw. C-26 is unchanged and not waived; this sets no precedent for running a role on a non-Charter model. Any later model change is a Charter PR.
- **Cursor agent mode on this repository:** not used while the freeze lasts (D1). Allowing it needs a new decision after the hooks and trailer are verified for the IDE's agent mode.

## More Information

- Amends: ADR-0004 (Cursor ring-0 hooks), ADR-0005 ("invoked from Claude Code and Cursor"), ADR-0008 (local agents in Cursor), ADR-0009 (Cursor effort slugs), ADR-0012 (Cursor `agent -w` worktrees and their Confirmation items).
- Related: proposed ADR-0015 (Claude Code sandbox, PR #70), proposed ADR-0016 (parallel work, #87, PR #88), #39, #51, #66, #68, #98, #99, #100, #101.
- Background: Architect report "3 videos on agentic software delivery vs. PANOPTICON" (2026-11-10).
