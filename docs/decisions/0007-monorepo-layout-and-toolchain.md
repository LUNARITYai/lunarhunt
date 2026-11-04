---
status: accepted
date: 2026-11-03
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0007: Monorepo layout and toolchain

## Context and Problem Statement

LunarHunt (repo `LUNARITYai/lunarhunt`) is the pilot product built under PANOPTICON. It combines a Next.js UI and admin panel with a FastAPI backend that owns domain logic, AI, document parsing and background workers (including Nightwatch). PANOPTICON tooling (Wardens, Ledger) lives in the same repository at first and is extracted into a reusable template later. Agents need one predictable layout, one command that answers "is everything green", reproducible environments and a contract between TypeScript and Python that cannot drift silently.

## Decision Drivers

- One repository for TS and Python, with one entry command for agents (`pnpm check`)
- Fast, cached, affected-only task runs
- As few tools as possible, each with a clear job
- Strict typing on both sides
- API contract changes visible and checked in CI
- Same environment for human, local agents and CI (base Cell)

## Considered Options

- **Repository:** single monorepo (PANOPTICON extracted later) vs. separate template repo + product repo from day one
- **Task runner:** Turborepo vs. Nx
- **TS lint/format:** Biome only vs. ESLint + Prettier vs. Biome + a narrow ESLint for Next/React rules
- **Python types:** Pyright vs. mypy (Astral `ty` as optional non-blocking check)
- **TS client generator:** `@hey-api/openapi-ts` vs. `openapi-typescript` + `openapi-fetch` vs. Orval
- **GitOps manifests:** `deploy/` folder in the monorepo vs. separate GitOps repository
- **Environment:** Dev Container vs. host-installed tools

## Decision Outcome

Chosen options:

- **Single monorepo** in the LUNARITY organization; the PANOPTICON template is extracted once it is stable.
- **pnpm workspaces + Turborepo** for TS tasks, **uv workspaces** (one `uv.lock`, virtual root) for Python; Python packages expose their tasks to Turborepo through thin `package.json` scripts calling `uv run …`. Turborepo is chosen over Nx for simplicity.
- **Biome is the only linter and formatter for TypeScript** (no ESLint, no Prettier); gaps are covered by `tsc --noEmit` with `strict: true` (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Any additional lint tool requires a new ADR.
- **Ruff** (lint and format) and **Pyright** in strict mode for Python.
- **API contract:** FastAPI generates OpenAPI with stable `operationId`s; `uv run export-openapi` writes `packages/contracts/openapi.json`; **hey-api** generates the TS client into `packages/api-client`. CI runs a **drift check** (regenerate + `git diff --exit-code`) and **oasdiff** breaking-change detection against the base branch (`review: false`, so nothing leaves CI).
- **Dev Container as the base Cell:** `.devcontainer/devcontainer.json` with docker compose (app services, Postgres, local Grafana stack), pinned Node/pnpm and Python/uv; lefthook and Wardens installed on create. The same image is used by humans, local agents and CI; nightly agent Cells later run it per task with their own git worktree and Charter-defined network egress limits.
- **`deploy/` folder** in the monorepo for GitOps manifests at first; a separate GitOps repository is reconsidered when the k3s deployment is set up.

### Layout

```text
lunarhunt/
├── AGENTS.md  CLAUDE.md  panopticon.charter.yaml
├── package.json  pnpm-workspace.yaml  turbo.json  biome.json  tsconfig.base.json
├── pyproject.toml  uv.lock                  # uv workspace (virtual root)
├── lefthook.yml                             # generated from The Charter
├── .devcontainer/                           # base Cell
├── .github/  .claude/  .cursor/
├── apps/
│   ├── web/      Next.js (UI, admin panel)          AGENTS.md
│   ├── api/      FastAPI (domain, AI, parsing)      AGENTS.md  migrations/
│   └── worker/   Python background jobs, Nightwatch AGENTS.md
├── packages/
│   ├── contracts/   openapi.json (generated)
│   ├── api-client/  TS client (generated, hey-api)
│   └── ui/          shared components
├── wardens/      TypeScript Wardens engine (ADR-0005) AGENTS.md
├── docs/         constitution.md  decisions/  specs/  research/
└── deploy/       Kubernetes manifests (GitOps)
```

### Consequences

- Good, because agents learn one layout and one command (`pnpm check`), and Turborepo runs only affected tasks.
- Good, because Biome gives one fast tool for lint, format and import sorting with a11y rules.
- Good, because the contract drift and oasdiff checks make API changes explicit.
- Good, because the Dev Container removes "works on my machine" and is the first step towards isolated Cells.
- Bad, because Biome has fewer type-aware and Next/React-specific rules than typescript-eslint; we accept the gap and rely on `tsc --strict`.
- Bad, because bridging uv into Turborepo through `package.json` scripts is a practical pattern, not an official integration.
- Bad, because extracting PANOPTICON into a template later will require a migration.

### Confirmation

- CI job `check` runs `pnpm check` (Turborepo: Biome, `tsc --noEmit`, Ruff, Pyright, tests) on affected packages; it is part of `panopticon/gate`.
- Warden `toolchain-guard`: fails if `eslint`, `prettier` or their configs appear in any `package.json` or the repository without an ADR reference.
- CI job `contract`: `uv run export-openapi` + hey-api generation + `git diff --exit-code`; `oasdiff` breaking-change check with `fail-on: ERR`.
- CI builds and runs `pnpm check` inside the Dev Container image, so the image itself is tested.
- Warden `generated-files-guard` (ADR-0004) blocks hand edits to `packages/contracts/**` and `packages/api-client/src/**`.

## Pros and Cons of the Options

### Single monorepo vs. template + product repos

- Good (monorepo), because everything moves together while PANOPTICON is still changing quickly.
- Bad (monorepo), because the template boundary is implicit until extraction.

### Turborepo vs. Nx

- Good (Turborepo), because it is simpler: caching and task graph only.
- Bad (Turborepo), because there are no generators or built-in module boundaries (covered by Wardens and architecture checks instead).

### Biome only vs. ESLint + Prettier vs. Biome + narrow ESLint

- Good (Biome only), because it is one fast tool and one config.
- Bad (Biome only), because there are fewer typed and framework-specific rules.
- ESLint + Prettier: full Next/React and typed linting, but two slower tools and more config.
- Biome + narrow ESLint: best coverage, but two linters to keep consistent.

### Pyright vs. mypy

- Good (Pyright), because it is fast with a strict mode.
- Neutral: mypy is equally valid; `ty` may be added later as a non-blocking check.

### hey-api vs. alternatives

- Good (hey-api), because it is light, generates SDK functions per `operationId` and has TanStack Query and Zod plugins.
- `openapi-typescript` + `openapi-fetch`: lighter, fewer features. Orval: also generates MSW mocks; heavier.

### `deploy/` vs. separate GitOps repo

- Good (`deploy/`), because there is nothing extra to set up for the MVP.
- Bad (`deploy/`), because production promotion and Argo CD access are cleaner with a separate repo; revisit with k3s.

## More Information

- uv workspaces: <https://docs.astral.sh/uv/concepts/projects/workspaces/>; Biome: <https://biomejs.dev/introduction/comparison-with-other-tools/>; hey-api: <https://heyapi.dev/>; oasdiff action: <https://github.com/oasdiff/oasdiff-action>
- Research report, sections 6, 8, 10.3, 12.
- Related: ADR-0004 (Wardens), ADR-0005 (engine), ADR-0006 (Covenant), ADR-0010 (observability stack).
- Amended by ADR-0013: `pnpm check` includes the contract drift check; generated packages carry a README and header note instead of `AGENTS.md`.
- See also ADR-0014: Renovate for dependency updates.
