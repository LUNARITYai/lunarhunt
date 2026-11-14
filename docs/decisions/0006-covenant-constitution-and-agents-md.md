---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0006: The Covenant: `constitution.md` and `AGENTS.md` as agent principles

## Context and Problem Statement

Agents need durable principles and project knowledge at the start of every session: what PANOPTICON names mean, which commands to run, which rules Wardens enforce and why. Claude Code and Cursor read different files (`CLAUDE.md`, `.claude/rules/`, `.cursor/rules/*.mdc`, `AGENTS.md`). Claude Code reads `AGENTS.md` natively only when no `CLAUDE.md` exists; otherwise `CLAUDE.md` must import `@AGENTS.md`. Instruction files are also an attack surface for prompt injection. We also introduced custom names (Warden, Charter, Cell, Ledger…) that agents do not know in our meaning.

## Decision Drivers

- One canonical set of instructions for all agent tools
- Short, focused instructions; nothing that a linter or Warden already enforces is repeated as prose
- Local rules close to the code they apply to
- Unambiguous vocabulary: one name per concept
- Instruction files treated as security-sensitive configuration
- Public portfolio repository readable by any engineer

## Considered Options

1. **Covenant** = `docs/constitution.md` + root `AGENTS.md` + per-package `AGENTS.md`; `CLAUDE.md` only imports `@AGENTS.md`
2. `CLAUDE.md` as canonical, with Cursor rules copied from it
3. Tool-specific rule files only (`.claude/rules/`, `.cursor/rules/*.mdc`) with no shared file

## Decision Outcome

Chosen option: **the Covenant (option 1)**, because `AGENTS.md` is an open format read by both Cursor and Claude Code, nesting gives local rules for free (the nearest file wins), and a separate constitution keeps the stable principles apart from day-to-day instructions.

### Structure

- **`docs/constitution.md`**: the non-negotiable principles of PANOPTICON (deterministic before probabilistic, defense in depth, fail-closed for security, single source of truth, CI is the final judge, everything measurable, human approves high risk). Changed rarely and only by ADR.
- **Root `AGENTS.md`**: global rules, the one entry command (`pnpm check`), repository map, links to `docs/`, and the **glossary**:
  - PANOPTICON (platform), OVERSEER (orchestrator/architect agent), Warden (deterministic guard: hook or CI check that blocks a forbidden action; a *hook* is only the mechanism that invokes it), The Charter (`panopticon.charter.yaml`, policy config), Covenant (this set of files), Cell (isolated agent environment, Dev Container based), The Ledger (run log and metrics), Sentinel (blue-team security reviewer role), Infiltrator (phase-2 red-team role), Nightwatch (nightly ATS-scanning agent in LunarHunt), LunarHunt (pilot product).
- **Per-package `AGENTS.md`** in every package (`apps/web`, `apps/api`, `apps/worker`, `wardens`, `packages/*`) and in `docs/specs/` (how to write a spec, ADR-0011), holding only local rules.
- **`CLAUDE.md`** contains only `@AGENTS.md` and, if needed, a few Claude-specific notes. Path-scoped rules for tools that need them (`.claude/rules/`, `.cursor/rules/*.mdc`) are kept minimal and point back to the relevant `AGENTS.md`.
- **Naming rules:** one name per concept, never used as synonyms; code uses self-explanatory technical names inside (e.g. `wardens/src/rules/scope-guard.ts`); Warden messages follow the format in ADR-0005. The word "factory" is not used for PANOPTICON.
- **English only:** all repository content (code, comments, docs, ADRs, specs, issues, PRs, commit messages) is written in English.
- **Security:** all Covenant files are protected paths in The Charter and covered by CODEOWNERS; agents may propose changes only through a PR.

### Consequences

- Good, because both tools read the same instructions, and local rules load only where relevant.
- Good, because the glossary makes custom names an advantage: they are unique and searchable.
- Good, because keeping instructions short and not duplicating linter rules reduces stale guidance.
- Bad, because nested `AGENTS.md` files need maintenance as packages evolve.
- Bad, because English-only content means design sessions in Polish must be translated before they enter the repository.

### Confirmation

- Warden `covenant-check` (CI job `docs-check`): root `AGENTS.md` contains a `Glossary` section defining every term listed above; every package directory with a `package.json` or `pyproject.toml` has an `AGENTS.md`; `CLAUDE.md` contains `@AGENTS.md`; root `AGENTS.md` stays under a line budget (initial proposal: 150 lines).
- Warden `protected-paths` denies agent edits to `AGENTS.md`, `**/AGENTS.md`, `CLAUDE.md`, `docs/constitution.md`; CODEOWNERS requires Krzysztof's review.
- CI job `language-check`: a lightweight language detector on changed Markdown files and PR titles flags non-English content (warning first, required check once tuned).

## Pros and Cons of the Options

### Covenant (constitution + AGENTS.md)

- Good, because it is tool-neutral, nested and open.
- Bad, because there are more files to maintain.

### CLAUDE.md canonical

- Good, because it fits Claude Code perfectly.
- Bad, because Cursor and other tools need copies, which drift.

### Tool-specific rules only

- Good, because each tool gets its native features.
- Bad, because there is no single source and rules are duplicated.

## More Information

- AGENTS.md: <https://agents.md/>; Claude Code memory: <https://code.claude.com/docs/en/memory>; Cursor rules: <https://cursor.com/docs/rules.md>
- Per-package `AGENTS.md` inspired by open-mercato/open-mercato.
- Research report, sections 2.3, 4, 11.1.
- Related: ADR-0003 (The Charter), ADR-0005 (message format), ADR-0011 (spec process).
- Amended by ADR-0013: Covenant files are `ask` (not deny) for agents; generated packages (`packages/contracts`, `packages/api-client`) are exempt from per-package `AGENTS.md`.
- Amended by ADR-0019: "Covenant files are `ask`" holds for the constitution and for `AGENTS.md` and `CLAUDE.md` files below the allowed directories; the root `AGENTS.md` and the root `CLAUDE.md` are human-only.
