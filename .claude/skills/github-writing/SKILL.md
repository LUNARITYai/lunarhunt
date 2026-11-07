---
name: github-writing
description: Terse shapes for text posted to GitHub. Use when writing a PR body, a review comment, a handover or status comment, or an issue body.
---

# GitHub writing

Every text posted to GitHub is read by Krzysztof, often on a phone, and by the next agent. Write it **terse**: each line carries a fact, a decision or an action. Link to the diff, the spec, the ADR or the earlier comment and let the link carry the detail. Use numbers (tests, lines, probe counts, commits) where you would reach for an adjective.

Pick the shape below and fill it. Leave a section out when it would be empty; never add sections.

## PR body (at most 15 lines)

```markdown
Closes #N
Spec: <link> · ADRs: <links>

**What:** one or two sentences on the behaviour change.
**Why:** one sentence, or a link to the issue.
**Verified:** `pnpm check` green · <N> tests · <probes or manual tests>.
**Risk:** the residual risk or follow-up issue, one line each.
**Size:** +A/−B (tests +T); one line why if over 600.
```

Use `Closes #N` only for an issue this PR really closes; write `Refs #N` for the rest.

## Review comment (Reviewer, Sentinel)

```markdown
**<Role> round <n>: <k> blocking, <m> non-blocking** at <short sha>

| ID | Severity | Where | Finding | Fix |
|----|----------|-------|---------|-----|
| B1 | blocking | `path:line` | what fails, with the concrete input | the change |
| N1 | non-blocking | ... | ... | ... |
```

One row per finding; a reproduction command goes in the Finding cell. A round with no findings is the heading line plus `No findings.`

## Handover or status comment (at most 10 lines)

```markdown
**Ready for Krzysztof** at <short sha>: CI green, review rounds <n> (no blocking).
- Waits on you: <decision or action>, one per line.
- Follow-ups: #X, #Y.
- After merge: <rollout step, e.g. `git pull` in primary, `wardens doctor`>.
```

## Issue body

The Issue Form sections only: Problem (2 to 5 lines with a concrete example), EARS acceptance criteria, allowed paths, links. Keep background and history in a linked comment or spec.

## Public repository

The repository is public. Describe an unfixed vulnerability by class only, with no working reproduction, until its fix is merged.
