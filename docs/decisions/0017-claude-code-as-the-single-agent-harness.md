---
status: proposed
date: 2026-11-10
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI), OVERSEER (AI)
---

# ADR-0017: Claude Code as the single agent harness

## Context and Problem Statement

PANOPTICON was designed for two agent harnesses, Claude Code and Cursor (ADR-0004, ADR-0005, ADR-0009, ADR-0012). In practice Claude Code produced every agent PR so far: The Charter sets `engine: claude` on every role, OVERSEER runs Claude Code in Herdr, and the Reviewer and Sentinel are Claude Code sessions.

Keeping Cursor at parity costs work and produces no output:

- `.cursor/hooks.json` generation, the recorded Cursor fixtures and a golden test;
- the Cursor effort-in-model-slug mapping (ADR-0009, `wardens/src/engines.ts`);
- spike #39 (Cursor permission file), #68 (`.cursor/worktrees.json`) and the Cursor parts of #51 and #66, which stalled on "Workspace Trust Required";
- Cursor hooks fail open by default (ADR-0004), and the proposed ADR-0015 (PR #70) already defers the Cursor sandbox.

PANOPTICON has one maintainer. Two harnesses double the Wardens test matrix and the sandbox work while only one of them is used.

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

**D1. Single harness.** Claude Code is the only harness that agent roles (`overseer`, `spec-writer`, `implementer`, `reviewer`, `sentinel`, `debugger`) run in, in autonomy phases 0–2. Krzysztof may still use Cursor as his own IDE; such sessions are human sessions, not agent runs.

**D2. Cursor-specific work is frozen.**
- #39 (Cursor permission file spike) and #68 (`.cursor/worktrees.json`) stay open, labelled `blocked`, with a link to this ADR.
- #51 already covers Claude Code only (scope change of 2026-11-06); no Cursor work is added to it.
- #66 and the proposed ADR-0015: the Cursor and Dev Container sandbox items stay deferred.
- No new Cursor fixtures, adapter features or tests.

**D3. The seam stays.** The Charter keeps `roles.*.engine`, the schema keeps the enum, and `wardens/src/engines.ts` keeps the adapter registry. The Ledger records `tool` on every run. The existing `.cursor/hooks.json` generation and its tests stay as they are, frozen and not extended, until phase 1 at least; removing them is a later decision by Krzysztof.

**D4. Role-to-model mapping stays in The Charter.** Models are chosen per role in `roles:` (ADR-0009), never hard-coded in prompts, hooks or docs. Changing a model is a one-line Charter PR by Krzysztof.

**D5. Time-boxed OVERSEER model.** From 2026-11-10 until the end of Anthropic's promotion on 2026-11-16 23:59 PT (2026-11-17 08:59 Europe/Warsaw), the `overseer` role runs on Claude Fable 5.2 (`claude-fable-5-2`). Krzysztof starts the session on that model; no agent switches models itself (C-26).
- The agent host runs Claude Code 2.1.321 or later (`wardens doctor` minimum, #102).
- All other roles keep their Charter values.
- After the promotion OVERSEER runs on the Charter default again, unless Krzysztof enables usage credits. Any change to the Charter value is a Charter PR, not a session decision.

**D6. Quota is a planning input.** Every Herdr session (OVERSEER, implementers, reviewers) draws from the same Claude subscription.
- The expensive model is used only where planning quality pays off (D4, D5).
- Parallel implementers are capped by the proposed ADR-0016 and by remaining quota: OVERSEER starts an implementer only if the current 5-hour window and the weekly limit leave room for its review rounds.
- Round-2 reviews are delta-only (proposed ADR-0016 D9).
- Sessions hand over to a fresh session at about 40–50% context instead of running long (#100).
- When a limit is hit, sessions stop cleanly, the issue gets a handoff note, and work resumes after the reset. Work does not move to another harness mid-task.
- The Ledger records usage-limit hits per day (proposed ADR-0016 D5).

### Return condition

A second harness is reconsidered only through a new ADR, when one of these holds:

- our own benchmark on past tasks shows a clear quality or cost advantage;
- Claude limits block planned work for more than one week despite the D6 mitigations.

### Consequences

- Good, because one harness halves the hook, fixture and sandbox matrix.
- Good, because frozen Cursor issues stop competing for OVERSEER and review time.
- Good, because the `engine` seam keeps a later harness a contained change.
- Bad, because all agent work depends on one vendor's availability, pricing and limits.
- Bad, because the frozen `.cursor/**` generation can rot; until it is removed, `charter-drift` and the golden test keep it honest.
- Neutral, because ADR-0004, ADR-0005, ADR-0009 and ADR-0012 still describe Cursor; this ADR amends them where they require Cursor parity.

### Confirmation

- The Charter: every role has `engine: claude` (already true; `charter-validate`).
- #39 and #68 carry a link to this ADR and are not `agent:ready`.
- `AGENTS.md` names Claude Code as the agent harness and drops `agent -w` from the worktree commands (Krzysztof applies it; `ask` path).
- The Ledger reports `tool` per run and flags any agent run with `tool != claude` (planned, #98). Until then D1 is **not yet enforced** beyond the Charter value.

## Pros and Cons of the Options

### Claude Code only, seam kept (chosen)

- Good, because it cuts parity work now and keeps optionality cheap.
- Bad, because agent work is locked to one vendor in phases 0–2.

### Parity (status quo)

- Good, because it keeps the most optionality.
- Bad, because the cost is paid every week, for a harness no agent role uses.

### Remove Cursor and the seam

- Good, because it leaves the least code.
- Bad, because adding a harness later means touching the schema, the engine and `wardens sync` again.

## Decisions taken with this ADR (Krzysztof, 2026-11-10)

- `.cursor/hooks.json` generation and the Cursor fixtures are kept frozen, not removed, until phase 1 at least.
- #39 stays open with `blocked`; #68 stays `blocked`.
- D5: Fable for OVERSEER during the promotion; afterwards the Charter default applies unless Krzysztof enables usage credits.

## More Information

- Amends: ADR-0004 (Cursor ring-0 hooks), ADR-0005 ("invoked from Claude Code and Cursor"), ADR-0009 (Cursor effort slugs), ADR-0012 (Cursor `agent -w` worktrees).
- Related: proposed ADR-0015 (Claude Code sandbox, PR #70), proposed ADR-0016 (parallel work, #87, PR #88), #39, #51, #66, #68.
- Background: Architect report "3 videos on agentic software delivery vs. PANOPTICON" (2026-11-10).
