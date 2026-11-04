## Summary

<!-- What changed and why, in a few sentences. -->

Closes #N

## Spec and ADRs

<!-- Link `docs/specs/YYYY-MM-DD-<slug>.md` when the issue type or paths require a spec (ADR-0011, C-10). Link related ADRs. Write "none" for a chore, docs-only change or small bug that does not need a spec. -->

## Risk class

<!-- ADR-0008, extended by ADR-0013. Choose one.
`risk:high` if this touches auth, secrets (`.env*`, `secrets/**`), `.github/**`, `panopticon.charter.yaml`, Covenant files (`docs/constitution.md`, `AGENTS.md`, `**/AGENTS.md`, `CLAUDE.md`), `.claude/**`, `.cursor/**`, `lefthook.yml`, `deploy/**`, `apps/api/migrations/**`, `wardens/**`, `docs/decisions/**`, `docs/decision-log.md`, or the PR carries `test:waived` or `needs:human`.
`risk:medium` is the default for product code.
`risk:low` is documentation, tests only, or a small change on non-protected paths. `risk-classifier` sets the label; this box is the author's claim. -->

- [ ] risk:low
- [ ] risk:medium
- [ ] risk:high

## Tests

<!-- What you ran and what it covers.
A `type:bug` PR must add or change a test that fails on `main` and passes on this branch (C-15). The only exception is `test:waived` with a written justification here; that PR is `risk:high`, needs a human and is never auto-merged.
Changing an existing Playwright test needs `needs:human` (C-17). -->

## Agent trailer

<!-- Agent commits must include the trailer `Agent: <tool> (<model>)` (ADR-0008). Example: `Agent: cursor (grok-4.7)`. Phases 0–1 commit under Krzysztof's git identity; the trailer keeps authorship traceable. Renovate app PRs on `renovate/*` are exempt (ADR-0014). -->
