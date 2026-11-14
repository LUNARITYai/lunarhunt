---
status: accepted
date: 2026-11-04
decision-makers: Krzysztof Oszczapiński
consulted: Architect (AI)
---

# ADR-0014: Dependency updates with Renovate

## Context and Problem Statement

ADR-0004 lists "dependency updates via Renovate or Dependabot" without choosing. The monorepo (ADR-0007) has pnpm (`pnpm-lock.yaml`), a uv workspace (`uv.lock`), GitHub Actions, the Dev Container and Docker images. Update PRs must be few, grouped, reviewable by one person, safe against supply-chain attacks on fresh releases, and must fit the risk and autonomy rules of ADR-0008, which allow auto-merge only in phase 3 and only through `autonomy-gate`. Krzysztof chose Renovate on 2026-11-04.

## Decision Drivers

- Few, grouped PRs for a one-person team
- One tool covering pnpm, uv (including `uv.lock` and workspaces), GitHub Actions, Dev Container and Docker
- A cooldown on new releases (supply-chain risk)
- No merge path that bypasses `autonomy-gate`, CODEOWNERS review or the risk classes (ADR-0008)
- Security advisories still visible on GitHub

## Considered Options

1. Renovate (Mend Renovate GitHub App), with Dependabot alerts kept on
2. Dependabot version and security updates
3. Both Renovate and Dependabot updates

## Decision Outcome

Chosen option: **Renovate (1)**, because it groups updates flexibly, supports pnpm, uv workspaces and `uv.lock`, GitHub Actions digest pinning and Dev Container features in one config, has a dependency dashboard and `minimumReleaseAge`, and its config is a reviewable file.

### Rules

- **Config:** `.github/renovate.json5` (under `.github/**`, so `ask` for agents and `risk:high` to change, ADR-0013). Validated in CI.
- **Grouping and schedule:** weekly schedule (one batch before Monday morning, Europe/Warsaw); groups for: all non-major npm dev tooling, all non-major Python packages, GitHub Actions, Dev Container and Docker images. Major updates get their own PR each. `lockFileMaintenance` weekly. Dependency dashboard issue on.
- **Cooldown:** `minimumReleaseAge: "7 days"` for every ecosystem. Because Renovate does not pass this to pnpm or uv, the same cooldown is also set in the package managers (pnpm `minimumReleaseAge`, uv `exclude-newer`), so lockfile maintenance and transitive updates respect it.
- **Pinning:** GitHub Actions pinned to commit digests (also expected by zizmor).
- **Labels:** `dependencies` plus `type:chore`; both added to `.github/labels.yml` (ADR-0001).
- **No auto-merge by Renovate.** `automerge: false` and `platformAutomerge: false` in every phase. Renovate PRs are classified by `risk-classifier` like any other PR; lockfile and manifest changes are `risk:medium` by default (`risk:high` when they touch protected paths, e.g. `.github/**`). Whether minor and patch updates may become `risk:low` and auto-merge in phase 3 through `autonomy-gate` is decided in the phase-3 auto-merge ADR announced in ADR-0008, not here.
- **Security updates:** Renovate handles vulnerability fixes (`vulnerabilityAlerts`, and `osvVulnerabilityAlerts` for transitive lockfile-only dependencies), bypassing the schedule and cooldown for fixes only.
- **Dependabot:** **Dependabot alerts stay ON** (Dependency graph and security advisories on GitHub; they create no PRs and Renovate reads them). **Dependabot version updates and Dependabot security updates stay OFF**: no `.github/dependabot.yml`, "Dependabot security updates" disabled in repository settings, so there are never two bots opening PRs for the same change.
- **Identity and exemptions:** Renovate PRs come from the Renovate app, not from an agent, so `agent-trailer` does not apply. `pr-check` (C-09) exempts PRs whose author is the Renovate app and whose branch starts with `renovate/`: the dependency dashboard issue replaces `Closes #N`, and the branch convention does not apply. Every other check in `panopticon/gate` applies unchanged.
- **Agents:** agents do not bump dependency versions ad hoc; adding a new dependency that a task needs is allowed and is reviewed like any code change.

### Consequences

- Good, because one tool and one file cover every ecosystem in the monorepo with grouped, scheduled PRs.
- Good, because the cooldown and digest pinning reduce supply-chain risk.
- Good, because no dependency change reaches `main` outside the normal gate, review and autonomy rules.
- Bad, because Renovate is a third-party app with write access to the repository (one more identity besides Krzysztof, agents and, later, the PANOPTICON GitHub App).
- Bad, because the Renovate config language is large; misconfiguration can produce noisy PRs (mitigated by config validation and the dashboard).
- Neutral: a self-hosted Renovate run in GitHub Actions is possible later if the app's permissions become a concern.

### Confirmation

- CI job `renovate-config` (part of `docs-check` or `panopticon/gate`): `renovate-config-validator --strict .github/renovate.json5`; a small test asserts `automerge` and `platformAutomerge` are false and `minimumReleaseAge` is set.
- Warden `toolchain-guard` (ADR-0007): fails if `.github/dependabot.yml` exists.
- CI job `ruleset-audit` (ADR-0004), extended: via the GitHub API, Dependabot alerts are enabled and Dependabot security updates are disabled for `LUNARITYai/lunarhunt`.
- `pr-check` tests: a PR from the Renovate app on `renovate/*` passes without `Closes #N`; a PR on `renovate/*` from any other author fails.
- `risk-classifier` tests: a lockfile-only PR is `risk:medium`; a PR changing `.github/renovate.json5` is `risk:high`.

## Pros and Cons of the Options

### Renovate

- Good, because of flexible grouping, scheduling, cooldown, wide manager support (pnpm, uv, Actions, Dev Container) and a dashboard.
- Bad, because of a larger config surface and a third-party app.

### Dependabot

- Good, because it is built into GitHub and needs no extra app.
- Bad, because grouping and scheduling are less flexible, and monorepo ecosystems need one config block each.

### Both

- Good, because of overlapping coverage.
- Bad, because of duplicate PRs and two sets of rules to keep consistent.

## More Information

- Renovate PEP 621 manager (uv, `uv.lock`, workspaces): <https://docs.renovatebot.com/modules/manager/pep621/>; uv with Renovate: <https://docs.astral.sh/uv/guides/integration/renovate/>; minimum release age: <https://docs.renovatebot.com/key-concepts/minimum-release-age/>
- Related: ADR-0001 (labels), ADR-0004 (security tools, `pr-check`), ADR-0007 (toolchain), ADR-0008 (risk and autonomy), ADR-0013 (protected paths).
- Amended by ADR-0019: "`.github/renovate.json5` … so `ask` for agents" reads "human-only".
