# Context handoff

Long sessions degrade and burn quota. A session hands over to a fresh one at about 40–50% of its context window, with a short note that lets the new session continue without re-reading the repo.

## Rule

WHEN a session's context use reaches the threshold below, THE session finishes its current step, writes a handoff note, and stops. A fresh session continues.

| Role | Threshold |
|------|-----------|
| Implementer (and other task roles) | about 40% of the context window |
| OVERSEER | about 50% of the context window; with a 1M-context model also at most about 400k tokens |

- Finish the step in progress. Do not start the next one.
- Never write secrets, `.env` content, CV content or other personal data in a note.
- A usage-limit stop needs a note too. See [Usage limits](#usage-limits).

## Measuring context

- Run `/context` in Claude Code.
- Or read the status line, if it shows context use.
- The measurement is manual until a hook exposes it.
- Check at each natural step boundary: after a commit, after a review round, after a long tool output.

## Handoff note

Post it as an issue comment:

- Implementer: on its own issue.
- OVERSEER: on the pinned tracking issue, or on the decision thread.

Format:

```markdown
<!-- panopticon-handoff role=<role> session=<id> issue=#<n> branch=<branch> head=<sha> -->
## Handoff (<role>, <YYYY-MM-DD HH:MM Europe/Warsaw>)
- **State:** what is done (commits, PRs, review round).
- **Next step:** the single next action.
- **Open decisions / blockers:** with owner.
- **Do not redo:** things verified already (tests run, approaches rejected and why).
- **Read first:** at most 5 files or links.
```

Rules for the fields:

- The HTML comment is machine-readable. `session` is the `hc` terminal name or the Claude Code session id. `head` is the short commit sha of the branch tip.
- **State:** commit shas, PR numbers, review round, check results.
- **Next step:** exactly one action, written so a fresh session can do it without asking.
- **Open decisions / blockers:** one per line, each with an owner (Krzysztof, OVERSEER, the Architect).
- **Do not redo:** includes `pnpm check` runs with their result, and rejected approaches with the reason.
- **Read first:** five items or fewer. Prefer the issue, the brief comment, one spec, one diff.
- Terse text per the `github-writing` skill: one fact per line.

## Usage limits

- A 5-hour or weekly usage-limit stop also needs a handoff note.
- Write it before the limit if the session sees a warning.
- When a limit is hit, the session stops. Work resumes after the reset, in a fresh session ([ADR-0017](../decisions/0017-claude-code-as-the-single-agent-harness.md) D6, proposed).
- A limit never waives the review gate ([ADR-0016](../decisions/0016-parallel-work-and-a-single-overseer.md) D6).

## Resume procedure

A fresh session, in this order:

1. Read the latest `panopticon-handoff` comment on the issue (or on the tracking issue for OVERSEER). Take the newest by time, matching the role.
2. Run `git log` of the branch and compare its tip with `head` in the comment. If they differ, read the commits after `head`.
3. Read the issue labels (`agent:in-progress`, `needs:human`, `risk:*`). A `needs:human` label means stop and report.
4. Read the files in **Read first**. Nothing else is needed yet.
5. Do the **Next step**. Do not redo anything under **Do not redo**.
6. Post a one-line comment that the new session took over, with its session id.

Work in the existing worktree and on the existing branch of the issue. Do not create a second worktree for the same issue (see [Herdr operating model](herdr.md)).
