---
status: accepted
date: 2026-11-13
decision-makers: Krzysztof Oszczapiński
consulted: OVERSEER (AI)
---

# ADR-0020: An ADR is accepted by the merge of its pull request

## Context and Problem Statement

ADR-0002 and C-32 make acceptance a two-step act: an agent drafts an ADR with status `proposed`, Krzysztof merges the pull request, and then Krzysztof changes the status to `accepted` in a second change.

On 2026-11-13 the second step was missed three times. ADR-0016, ADR-0017 and ADR-0019 were merged to `main` with status `proposed`, although Krzysztof had accepted their decisions on the pull requests. Notes in ADR-0004, ADR-0005, ADR-0008, ADR-0009 and ADR-0012 read "Amended by ADR-0016 (proposed)" and "Amended by ADR-0017 (proposed)", so a reader cannot tell whether those amendments are in force.

Krzysztof works from a phone for most reviews. A status edit after the merge is a separate change on a protected path, and nothing reminds him of it.

How should the status of an ADR be set, so that `main` never shows an accepted decision as `proposed`?

## Decision Drivers

- The status on `main` must match what Krzysztof decided (C-01: documentation and behaviour agree)
- Only Krzysztof accepts an ADR (C-32, ADR-0002)
- One step for the human, workable from a phone
- The status stays in the file, so it travels with the repository and a Warden can check it

## Considered Options

1. Keep the two steps: merge as `proposed`, then a second change sets `accepted`
2. The pull request carries the final status, and the merge is the acceptance
3. Track the status with a GitHub label instead of the front matter

## Decision Outcome

Chosen option: **2**, because the merge is already the only act that puts an ADR on `main`, and only Krzysztof can merge.

### Decisions

Enforcement status per C-01: **enforced** (a check exists today), **planned** (named enforcer, not built), **not yet enforced** (no enforcer).

**D1. The pull request carries the status the ADR will have on `main`.** An agent that drafts an ADR writes `status: accepted` in the file and in the `docs/decisions/README.md` row when the decision is ready for Krzysztof. While the pull request is open, the ADR is a proposal, whatever its status line says, because it is not on `main`.
- Enforcement: **not yet enforced** (Reviewer). `adr-check` (ADR-0002, planned) checks that the README row equals the file's status.

**D2. The merge by Krzysztof is the acceptance.** No second change follows. An agent never merges or approves a pull request.
- Enforcement: **enforced** in ring 0: The Charter denies `gh pr merge *` and `gh pr review *` and the matching `gh api` forms (`command-guard`, #95). In ring 3 the `main` ruleset requires a pull request; it does not require an approval (interim ruleset, 2026-11-07), so the human merge is a convention until agents act under their own GitHub App identity (#82).

**D3. `proposed` on `main` is the exception.** Krzysztof may ask for an ADR to be merged as `proposed` when he wants the text on `main` for further discussion. The pull request body says so. Such an ADR is not in force, and "Amended by" notes that point to it say "(proposed)".
- Enforcement: **not yet enforced** (Reviewer).

**D4. An agent never changes the status of an ADR that is already on `main`.** A status change on `main` (`proposed` to `accepted` or `rejected`, `accepted` to `deprecated` or `superseded`) is made by Krzysztof, or by a pull request whose body names his decision and which he merges.
- Enforcement: **not yet enforced** (Reviewer and Sentinel; `docs/decisions/**` is `risk:high`, so the pull request always waits for Krzysztof).

**D5. Reviewer and Sentinel read `accepted` in an open pull request as "proposed for acceptance".** Their briefs say so. It is not a finding.
- Enforcement: **not yet enforced** (OVERSEER's review briefs).

**D6. Specs are unchanged.** Only Krzysztof sets a spec to `status: ready` (ADR-0011, C-10). A spec's status gates agent work before any merge of code, so it keeps its own explicit step.

### Statuses set with this ADR

Krzysztof set these himself in the pull request for this ADR (a shell command he ran; the commit records his change):

- ADR-0016, ADR-0017 and ADR-0019: `proposed` to `accepted`. He accepted their decisions on PR #88, PR #104 and PR #107 on 2026-11-13.
- ADR-0020: `accepted`.

### Amended points

- **ADR-0002, Rules, "Statuses" and "Authorship":** the status path is unchanged. "Agents may draft ADRs with status `proposed`; only Krzysztof changes a status to `accepted`" is read as D1, D2 and D4: the agent's pull request carries the final status and Krzysztof's merge accepts it.
- **ADR-0016 D8, last sentence** ("Agents draft that ADR as `proposed`; accepting it is Krzysztof's step"): read as D1 and D2.

### Proposed normative changes (applied by Krzysztof, or by an agent on an `ask` path with his approval)

`docs/constitution.md`, C-32, second sentence. Today:

> Agents MAY draft such an ADR with status `proposed` and MUST NOT mark it `accepted`.

Proposed:

> Agents MAY draft such an ADR. Its pull request carries the status the ADR will have on `main`, and only Krzysztof's merge of that pull request accepts it. Agents MUST NOT merge it and MUST NOT change the status of an ADR that is already on `main`.

`docs/specs/AGENTS.md`, "Rules for the `spec-writer` role", first bullet. Today: "ADRs you draft stay `proposed`." Proposed: "ADRs you draft carry the status they will have on `main` (ADR-0020); Krzysztof's merge accepts them."

Until C-32 is edited, C-32 as written wins: agents keep writing `proposed`, and Krzysztof sets the status himself in the pull request before he merges.

### Consequences

- Good, because `main` shows the status Krzysztof decided, with no follow-up change to forget.
- Good, because acceptance is one act that works from a phone.
- Good, because the status stays in the file and in the index, where agents and `adr-check` read it.
- Bad, because an open pull request shows `accepted` for a decision that is not yet accepted; reviewers must know D5.
- Bad, because the text no longer stops an agent from writing `accepted`; the control is the human merge, which ring 0 enforces and ring 3 does not yet (D2).
- Neutral, because a pull request closed without merging leaves nothing on `main`, so a rejected ADR needs no `rejected` file unless Krzysztof wants the record.

### Confirmation

- `command-guard` denies agent merges and approvals (The Charter `commands.deny`, tests in `wardens/test/`).
- `adr-check` (ADR-0002, planned): the README row equals the file's status for every ADR.
- Reviewer: an ADR pull request states in its body whether the ADR is for acceptance or is a draft to merge as `proposed` (D3), and no pull request changes the status of an ADR on `main` without naming Krzysztof's decision (D4).
- Human: Krzysztof merges every `docs/decisions/**` pull request (`risk:high`, ADR-0008).

## Pros and Cons of the Options

### 1. Keep the two steps

- Good, because an agent cannot write `accepted` at all.
- Bad, because the second step is easy to miss; it was missed three times on 2026-11-13.
- Bad, because the second change is another protected-path edit for Krzysztof.

### 2. The pull request carries the final status

- Good, because one human act decides and records.
- Good, because the file stays the single source of the status.
- Bad, because the status line alone no longer shows who accepted; the merge commit does.

### 3. A GitHub label

- Good, because a label is one tap.
- Bad, because a label lives on a pull request or an issue, not on the file; agents reading the repository do not see it.
- Bad, because MADR 4.0 requires the status in the front matter (ADR-0002), and a Warden cannot check a label offline.
- Bad, because the label would still need a second step after the merge.

## More Information

- Issue #113. Decided by Krzysztof in chat on 2026-11-13.
- Related: ADR-0002 (ADR format and statuses, amended), ADR-0008 (human merge, `risk:high`), ADR-0011 (spec status, unchanged), ADR-0016 (D8, amended), #82 (agent GitHub App identity), #95 (merge and approval denied for agents).
- Revisit when agents act under their own GitHub identity (#82) and the ruleset requires Krzysztof's approval again.
