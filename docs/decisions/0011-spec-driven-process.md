---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0011: Own lightweight spec-driven process

## Context and Problem Statement

Agents produce better results when work starts from a written specification with testable acceptance criteria instead of a one-line prompt. GitHub Spec Kit packages this as a CLI with agent commands (`/specify`, `/plan`, `/tasks`, `/implement`) and templates (constitution, spec, plan, tasks); Kiro uses `requirements.md` with EARS criteria, `design.md` and `tasks.md`. PANOPTICON already has its own pieces that such a tool would have to fit around: the Covenant (ADR-0006), The Charter and Wardens (ADR-0003, ADR-0004) and GitHub Issues (ADR-0001). We need to decide whether to adopt Spec Kit directly or run our own process.

## Decision Drivers

- Specs that agents can follow and Wardens can validate
- Tight link between spec, issue, branch, PR and The Ledger
- Full control over structure and evolution; no dependency on another tool's release cycle
- Low ceremony for small changes
- A visible, own process is a stronger portfolio piece

## Considered Options

1. Use GitHub Spec Kit directly (CLI, commands, templates, `.specify/` directory)
2. Own lightweight process inspired by Spec Kit and Kiro
3. No formal specs (issues only)

## Decision Outcome

Chosen option: **own lightweight process (option 2)**, because it keeps the useful flow (constitution → spec with EARS → plan → tasks) while fitting our Covenant, Charter, Wardens and GitHub Issues without a competing directory structure. On 2026-11-03 we checked that neither Open Mercato nor Callstack uses Spec Kit; Open Mercato runs its own spec process in `.ai/specs/` (dated files, `implemented/` and `analysis/` subfolders, spec-writing rules in `AGENTS.md`), which we use as a model.

### Process

- **Constitution:** `docs/constitution.md` (part of the Covenant, ADR-0006). Plans must respect it.
- **Spec files:** `docs/specs/YYYY-MM-DD-<slug>.md`, one per feature, with front matter (`status: draft|ready|in-progress|implemented`, `issue: #N`, `adrs: [...]`) and sections:
  1. **Goal and context** (what and why),
  2. **Acceptance criteria in EARS** (e.g. `WHEN the user imports an offer from Notion, THE SYSTEM SHALL create one offer per page.`),
  3. **Plan** (approach, API contract changes, data model, affected packages, ADRs needed),
  4. **Tasks** (numbered, each small enough for one PR, with allowed paths).
- **Folders:** active specs in `docs/specs/`; finished ones moved to `docs/specs/implemented/`; research and analysis in `docs/specs/analysis/`. `docs/specs/AGENTS.md` describes how to write a spec; a template lives in `docs/specs/TEMPLATE.md`.
- **Link to issues:** every spec references its GitHub issue, and every feature issue references its spec (Issue Forms, ADR-0001). Tasks become issues labelled `agent:ready` with allowed paths.
- **Roles:** the `spec-writer` role (on Opus, ADR-0009) drafts specs under `docs/specs/**` only; OVERSEER turns tasks into issues; Krzysztof approves the spec (`status: ready`) before implementation starts.
- **Light path:** `type:chore`, `type:docs` and small `type:bug` changes do not need a spec; the Charter's `require_spec_for` lists the paths and issue types that do.

### Consequences

- Good, because specs, issues and Wardens form one traceable chain from requirement to merged PR.
- Good, because EARS criteria are directly testable and map to tests and E2E scenarios.
- Good, because we own the templates and can evolve them with Ledger data.
- Bad, because we build and maintain our own templates and validator instead of getting them ready-made.
- Bad, because we do not benefit from Spec Kit's community updates and agent commands out of the box.
- Neutral: Spec Kit ideas (e.g. its optional clarify, analyze and converge steps) can be adopted selectively later.

### Confirmation

- Warden `spec-check` (CI job `docs-check`): spec file names match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$`; front matter has `status` and `issue`; every acceptance criterion line in the criteria section follows the EARS pattern (`WHEN|WHILE|IF|WHERE … THE SYSTEM SHALL …` or the ubiquitous `THE SYSTEM SHALL …`); specs with `status: implemented` live in `implemented/`.
- Warden `pr-check` (ADR-0004): a PR changing `apps/**` for a `type:feature` issue must link an issue that references a spec in `docs/specs/`.
- Warden `scope-guard`: the `spec-writer` role may write only under `docs/specs/**` and `docs/decisions/**`.
- Warden `toolchain-guard` (ADR-0007): fails if a `.specify/` directory appears, preventing accidental mixing with Spec Kit.

## Pros and Cons of the Options

### Spec Kit directly

- Good, because it is ready immediately and widely known.
- Bad, because its directory layout and flow can clash with The Charter, Wardens and GitHub Issues, and we depend on upstream changes.

### Own process inspired by Spec Kit and Kiro

- Good, because of full control and a tailored fit.
- Bad, because of initial effort to write templates and validators.

### No formal specs

- Good, because there is zero overhead.
- Bad, because agents get vague tasks and acceptance cannot be verified.

## More Information

- GitHub Spec Kit: <https://github.com/github/spec-kit>; Kiro specs: <https://kiro.dev/docs/specs/>; Open Mercato specs: <https://github.com/open-mercato/open-mercato/tree/main/.ai/specs>
- Research report, section 5.
- Related: ADR-0001 (issues, forms), ADR-0002 (ADRs), ADR-0006 (Covenant, constitution), ADR-0009 (spec-writer role).
- Amended by ADR-0013: `require_spec_for` added to the Charter schema (D7); `spec-check` excludes `docs/specs/AGENTS.md`, `docs/specs/TEMPLATE.md` and `README.md` files from the dated-filename and spec checks (A5).
