# Research 0001: Best practices for the PANOPTICON foundation

| Field | Value |
| --- | --- |
| Project | PANOPTICON (LUNARITY brand) |
| Document type | Research: input material for ADRs (not a decision) |
| Date | 2026-11-03 |
| Author | Architect (AI) for Krzysztof Oszczapiński |
| Status | Reviewed; resulting decisions are recorded in ADR-0001–0011 (`docs/decisions/`) and `docs/decision-log.md` |

> **Translation note.** Original research written 2026-11 in Polish; translated and aligned with ADR-0001–0011. Outdated names were updated in place (Codex / `panopticon.policy.yaml` → The Charter / `panopticon.charter.yaml`; JobPilot → LunarHunt). Where a recommendation was later decided differently, the original reasoning is kept and marked with a `> Superseded by ADR-NNNN: …` note. The ADRs are authoritative.

> **How to read this document.** Each section has three parts: **what today's best practice is** (with links to sources), **a recommendation for PANOPTICON**, and **a mapping** to our concepts: OVERSEER, Wardens, Cells, The Ledger and The Charter. Anything I did not confirm in a primary source (official documentation or repository) is marked **(unconfirmed)**. Tool version numbers change quickly and must be re-checked before implementation.

---

## Table of contents

1. Introduction
2. Claude Code: hooks, permissions, CLAUDE.md, subagents and skills
3. Cursor: rules, hooks, AGENTS.md, cloud agents and Bugbot
4. AGENTS.md and shared instructions across tools
5. Spec-driven development and ADRs
6. TS + Python monorepo and the API contract
7. Deterministic guards (Wardens)
8. Agent isolation (Cells)
9. Observability and run evaluation (The Ledger)
10. CI/CD and GitOps
11. Security of working with agents
12. Proposed repository structure
13. Proposed ADR list
14. Risks and open questions
15. Sources

---

## 1. Introduction

### Goal

PANOPTICON is a platform in which AI agents (Claude Code and Cursor) develop software under **deterministic control**. The most important principle is: **rules that must hold are enforced by code, not by prompts**. A prompt is a request; a hook, linter, test or branch rule is a hard barrier.

### Glossary

| Name | Role | Where it lives technically |
| --- | --- | --- |
| **PANOPTICON** | The whole platform: repo template, policies, hooks, CI and telemetry | Template repository and tooling package |
| **OVERSEER** | Architect and orchestrator agent: splits work, assigns tasks, guards the spec | Claude Code subagent or skill, integration with Linear |
| **Wardens** | Deterministic guards: agent hooks, git hooks, linters, tests, CI gates | `.claude/settings.json`, `.cursor/hooks.json`, `lefthook.yml`, `.github/workflows/` |
| **Cells** | Isolated agent work environments: branch, worktree, container or sandbox | git worktrees, devcontainer, Claude Code and Cursor sandboxes |
| **The Ledger** | Run log and evaluation metrics | OpenTelemetry, then Postgres or Langfuse |
| **The Charter** (originally "Codex") | Policy configuration, the single source of truth for Wardens | `panopticon.charter.yaml` (originally `panopticon.policy.yaml`) |

> Superseded by ADR-0001: tasks are tracked in GitHub Issues + Projects, not Linear; OVERSEER integrates with GitHub Issues.
>
> Added later (ADR-0006 glossary): the **Covenant** (`docs/constitution.md` + `AGENTS.md`), **Sentinel** (blue-team security reviewer role), **Infiltrator** (phase-2 red-team role), **LunarHunt** (pilot product, repo `LUNARITYai/lunarhunt`) and **Nightwatch** (LunarHunt's nightly ATS-scanning agent).

> Note on the name "Codex": OpenAI has a tool called Codex, and the `AGENTS.md` file originates partly from the OpenAI Codex ecosystem ([agents.md](https://agents.md/)). This can cause confusion in conversations and documentation; worth considering in the naming ADR.
>
> Superseded by ADR-0003: the policy file was renamed to **The Charter** (`panopticon.charter.yaml`) to avoid this collision.

### Key research finding

**Hooks have matured.** Claude Code now has dozens of hook events with blocking (exit code 2 or a JSON decision) and an `onFailure: "block"` option. Cursor has its own hook system with `failClosed`, and in addition **can load hooks written in Claude Code format** from `.claude/settings.json` ([Cursor Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks.md)). This lets Wardens have one engine for both tools. It changes the foundation's architecture in our favour.

### Foundation design principles (proposal)

1. **Deterministic before probabilistic.** Every rule in The Charter has an enforcer in code. A prompt at most explains it.
2. **Defense in depth.** The same rule is checked in several places: agent hook (fastest feedback), git hook (before commit), CI (mandatory gate) and GitHub ruleset (cannot be bypassed).
3. **Fail-closed where security is at stake.** Protective hooks use `onFailure: "block"` or `failClosed: true`.
4. **Single source of truth.** The Charter (`panopticon.charter.yaml`) generates or feeds tool configs, not the other way round.
5. **CI is the final judge.** Local hooks can be disabled (e.g. `disableAllHooks`); required checks on GitHub cannot.
6. **Everything measurable.** Every agent run leaves a trace in The Ledger.

---

## 2. Claude Code

### 2.1 Hooks: current capabilities

Source: [Hooks reference](https://code.claude.com/docs/en/hooks).

**Locations:** `~/.claude/settings.json` (user), `.claude/settings.json` (project, committed), `.claude/settings.local.json` (local, gitignored), managed policy (organization), plugins (`hooks/hooks.json`), and skill and subagent frontmatter. Hooks from different levels **merge**; they do not override each other.

**Handler types:** `command` (script, JSON on stdin), `http` (POST), `mcp_tool`, `prompt` (model-based evaluation) and `agent` (experimental verifying subagent).

**Most important events for PANOPTICON:**

| Event | Can it block | Use in Wardens |
| --- | --- | --- |
| `SessionStart` | No (context only) | Inject the Linear task, branch and paths allowed by The Charter. Start a Ledger record |
| `UserPromptSubmit` | Yes | Require a task identifier and add context |
| `PreToolUse` | Yes (`permissionDecision: allow/deny/ask/defer`, `updatedInput`) | **Main Warden**: forbidden commands, out-of-scope edits, changes to migrations and secrets |
| `PermissionRequest` | Yes (via `decision`) | Automatic decisions according to The Charter |
| `PostToolUse` | Does not block (the tool already ran), but exit 2 shows stderr to the agent | Formatting, quick lint or type check of the edited file, feedback |
| `PostToolBatch` | Yes | Stop the loop after a batch of tool calls |
| `Stop` / `SubagentStop` | Yes (forces the agent to keep working) | **Definition of Done**: the agent cannot finish while tests and lint are red |
| `TaskCreated` / `TaskCompleted` | Yes | Ensure tasks have acceptance criteria |
| `ConfigChange` | Yes (except `policy_settings`) | Block config changes during a session |
| `InstructionsLoaded` | No | Audit which instruction files were loaded (Ledger) |
| `WorktreeCreate` / `WorktreeRemove` | Yes | Custom Cell creation logic |
| `PreCompact` / `PostCompact` | `PreCompact` yes | Re-inject key context after compaction |
| `SessionEnd` | No | Close the Ledger record |

> Superseded by ADR-0001: the task comes from a GitHub issue (with its allowed paths), not from Linear.

**Key details:**

- **Exit code 2 blocks.** Exit code 1 is only a non-blocking error, so a policy-enforcing hook must exit with code 2 or return a JSON decision. The documentation warns about this explicitly.
- **`onFailure: "block"`** (since v2.1.295): when a hook crashes, times out or has a wrong path, the action is blocked. Without it, a typo in the path means the guard **never runs**. **Mandatory for protective Wardens.**
- **The `if` field** filters using permission-rule syntax, e.g. `"Bash(git push *)"` or `"Edit(*.ts)"`. The documentation notes that the `if` filter for Bash is "best-effort": **hard allow or deny must be implemented through the permission system, not a hook**.
- Hooks from settings **also run in subagents** (input contains `agent_id` and `agent_type`).
- `additionalContext` injects information into context (10,000-character limit). The documentation advises writing it as facts, not system instructions, otherwise the model may treat it as prompt injection.
- `disableAllHooks` in user or project settings **does not disable** managed hooks. A one-person project has no managed settings, so **CI must repeat the key checks**.

**Example Warden for Claude Code (`.claude/settings.json`):**

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "deny": [
      "Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)",
      "Bash(git push --force *)", "Bash(git push -f *)",
      "Bash(kubectl * --context prod*)",
      "Edit(./infra/prod/**)"
    ],
    "ask": ["Bash(git push *)", "Edit(./apps/api/migrations/**)"],
    "allow": ["Bash(pnpm turbo run *)", "Bash(uv run pytest *)", "Bash(uv run ruff *)"]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|mcp__.*",
        "hooks": [{ "type": "command", "command": "uv",
                    "args": ["run", "--project", "${CLAUDE_PROJECT_DIR}/tools/wardens", "wardens", "pre-tool"],
                    "onFailure": "block", "timeout": 20 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "uv",
                    "args": ["run", "--project", "${CLAUDE_PROJECT_DIR}/tools/wardens", "wardens", "post-edit"] }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "uv",
                    "args": ["run", "--project", "${CLAUDE_PROJECT_DIR}/tools/wardens", "wardens", "definition-of-done"] }] }
    ]
  }
}
```

*(The example is a sketch for our repo. Field syntax comes from the documentation, but the file itself has not been tested yet.)*

> Superseded by ADR-0005: the Wardens engine is TypeScript on Node, bundled with tsup into `wardens/dist/wardens.mjs` (package `wardens/` at the repo root, ADR-0007). Hooks call `node "${CLAUDE_PROJECT_DIR}/wardens/dist/wardens.mjs" hook --tool claude --event <event>` instead of `uv run … wardens pre-tool`; the file is generated by `wardens sync` from The Charter.

### 2.2 Permissions (`permissions`)

Sources: [Configure permissions](https://code.claude.com/docs/en/permissions), [Settings](https://code.claude.com/docs/en/settings).

- Rules are evaluated in the order **deny, then ask, then allow**. The first match wins; a more specific rule does not change this order. An allow rule **cannot carve an exception** out of deny.
- Deny on a bare tool name (e.g. `Bash`) removes the tool from context; deny with a pattern blocks only matching calls.
- Limitation: a Bash rule **does not catch the same program invoked through a path or inside `sh -c`**. The documentation recommends combining deny rules for `curl`/`wget` with a **network sandbox**.
- A `.claudeignore` file **does not work**; use `Read(...)` deny rules instead.
- `defaultMode` set to `auto` or `bypassPermissions` **does not work from project settings**, only from user or managed settings. This is a good safeguard: a repo cannot grant itself full permissions.

### 2.3 CLAUDE.md and memory

Source: [Memory](https://code.claude.com/docs/en/memory).

- Claude Code **reads `AGENTS.md`** (since v2.1.277), but **only when there is no `CLAUDE.md`** in the working directory or above. If `CLAUDE.md` exists, it must import `@AGENTS.md`.
- There are also `.claude/rules/*.md` files with `paths:` frontmatter (conditional, lazily loaded rules) and nested files in subdirectories.
- `/doctor prompt-audit` checks instructions for outdated patterns ([Skills](https://code.claude.com/docs/en/skills)).

**Recommendation:** `AGENTS.md` is the canonical source. `CLAUDE.md` contains only `@AGENTS.md` and a few Claude-specific notes; per-path rules go into `.claude/rules/`.

### 2.4 Subagents

Source: [Subagents](https://code.claude.com/docs/en/sub-agents).

- Files `.claude/agents/<name>.md` with frontmatter: `tools` (allowlist), `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `memory`, `effort` and **`isolation: worktree`**.
- `isolation: worktree` runs the subagent in a temporary worktree, i.e. a ready-made **Cell**.
- `tools: Agent(worker, researcher)` restricts **which subagents** a given agent may launch. Ideal for OVERSEER.
- Hooks in frontmatter apply only for the subagent's lifetime, and `Stop` is turned into `SubagentStop`.
- Plugin subagents **ignore** `hooks`, `mcpServers` and `permissionMode` for security reasons.

**Proposed roles:**

| Subagent | Tools | Isolation | Role |
| --- | --- | --- | --- |
| `overseer` | Read, Grep, Glob, `Agent(implementer, reviewer, spec-writer)`, Linear MCP (read and comment only) | none | Plans, splits work, does not write code |
| `spec-writer` | Read, Write only in `docs/specs/**` (enforced by a hook) | none | Specs and ADR drafts |
| `implementer` | Read, Edit, Write, Bash | `worktree` | Implementation in a Cell |
| `reviewer` | Read, Grep, Glob, Bash (tests only) | `worktree` | Review against the spec, no edit rights |

> Superseded by ADR-0009 and ADR-0001: each role has a default model **and effort level** in The Charter `roles:` (overseer and spec-writer on Opus/`high`, implementer on Sonnet/`medium` with one escalation step, reviewer on Sonnet/`medium`), and a `sentinel` security-reviewer role was added. OVERSEER uses GitHub Issues instead of Linear MCP; spec-writer may write under `docs/specs/**` and `docs/decisions/**` (ADR-0011).

### 2.5 Skills

Source: [Skills](https://code.claude.com/docs/en/skills).

- `.claude/skills/<name>/SKILL.md` with frontmatter (`description` decides when the skill activates). Former "custom commands" have been merged into skills.
- A skill can have **its own hooks in frontmatter**, e.g. a `/release` skill with a stricter Warden.
- Built-in skills such as `/verify` or pre-commit checks are worth evaluating as a complement (unconfirmed whether they fit our stack).

**Proposed PANOPTICON skills:** `/spec`, `/adr`, `/plan-tasks` (Linear), `/implement-task`, `/review-against-spec`, `/ledger-report`.

> Superseded by ADR-0001: `/plan-tasks` creates GitHub issues, not Linear tasks.

### 2.6 Other relevant features

- **Bash sandbox** ([Sandboxing](https://code.claude.com/docs/en/sandboxing)): OS-level restrictions (Seatbelt on macOS, bubblewrap and socat on Linux), with writes only in the working directory and network through a proxy with a `network.allowedDomains` list (empty by default). The built-in Read, Edit and WebFetch tools **are not subject** to the sandbox, only to permission rules. A "strict sandbox mode" disables retrying outside the sandbox.
- **Claude Code GitHub Actions** ([docs](https://code.claude.com/docs/en/github-actions)): `anthropics/claude-code-action@v1` for reacting to `@claude` in PRs and issues.
- **OTel telemetry** (section 9).

### Mapping

- **Wardens:** `PreToolUse`, `PostToolUse` and `Stop` hooks plus `permissions.deny`.
- **Cells:** `isolation: worktree`, `--worktree` and the sandbox.
- **OVERSEER:** a subagent with `tools: Agent(...)`.
- **The Charter:** generates `permissions` and hook parameters.
- **Ledger:** `SessionStart`, `SessionEnd`, `InstructionsLoaded` and OTel.

---

## 3. Cursor

### 3.1 Rules

Source: [Cursor Rules](https://cursor.com/docs/rules.md).

- Project rules go into `.cursor/rules/*.mdc` (**the `.mdc` extension is required**; plain `.md` is ignored) with `description`, `globs` and `alwaysApply` frontmatter. Modes: Always Apply, Apply Intelligently (by description), Apply to Specific Files (globs) and Apply Manually (@-mention).
- Cursor also supports **AGENTS.md** in the root and subdirectories as a simple alternative. Team Rules are available on Team and Enterprise plans.
- Good practices per the documentation: rules under 500 lines, split into smaller ones, referencing files instead of copying them, no rewriting of style guides (that is the linter's job). Add a rule only when the agent repeats the same mistake.

### 3.2 Hooks in Cursor

Sources: [Hooks](https://cursor.com/docs/agent/hooks), [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks.md).

- Configuration in `.cursor/hooks.json` (project) or `~/.cursor/hooks.json`, and on the Enterprise plan also managed from the dashboard.
- Events: `sessionStart` and `sessionEnd`, `preToolUse`, `postToolUse` and `postToolUseFailure`, `subagentStart` and `subagentStop`, **`beforeShellExecution`** and `afterShellExecution`, **`beforeMCPExecution`** and `afterMCPExecution`, **`beforeReadFile`**, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse` and `afterAgentThought`, plus Tab hooks and `workspaceOpen`.
- **Fail-open by default.** A crash or timeout lets the action through. The **`failClosed: true`** option changes that. Permission hooks do block on invalid JSON, however.
- `stop` and `subagentStop` can return a `followup_message`, i.e. an automatic continuation. `loop_limit` defaults to 5.
- **Claude Code compatibility:** Cursor loads hooks from `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json` (the "Include Third-Party Plugins, Skills, and Other Configs" setting is on by default). It maps `PreToolUse` to `preToolUse`, `Stop` to `stop` and `UserPromptSubmit` to `beforeSubmitPrompt`; `Notification` and `PermissionRequest` are not supported. It understands both the `hookSpecificOutput` format and its native one.
- **Tool name differences:** in Cursor `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task` and `MCP:<tool>`; in Claude Code `Bash`, `Edit`, `Write` and `mcp__server__tool`. The Wardens engine must therefore **normalize input**.
- Cloud agents run project hooks from `.cursor/hooks.json` (command type only, without `sessionStart`, `sessionEnd` and MCP hooks). User hooks from `~/.cursor/` **do not run** in the cloud.

**Recommendation:** one `wardens` engine (a Python CLI) called from two thin configs: `.claude/settings.json` and `.cursor/hooks.json` with `failClosed: true`. **Beware of double execution:** if Cursor's import of Claude hooks is enabled and `.cursor/hooks.json` also exists, the same Warden may run twice. This must be settled in an ADR: either we disable the import, or we rely solely on the import. I recommend native `.cursor/hooks.json`, because it provides `failClosed` and `beforeShellExecution`, together with disabling the import.

> Superseded by ADR-0005: the engine is a TypeScript CLI on Node (strict TS, zod, Vitest, tsup bundle), not Python. The double-execution recommendation was adopted as proposed: native `.cursor/hooks.json` with `failClosed: true`, Cursor's Claude hook import disabled, and duplicates detected by `wardens doctor` and a Ledger fingerprint.

### 3.3 Sandbox and run modes

Source: [Run Modes](https://cursor.com/docs/agent/security/run-modes.md).

- Modes are **Auto-review** (LLM classifier plus sandbox) and **Allowlist** (deterministic). The documentation says explicitly: *"Auto-review is not a security boundary"*.
- `.cursor/sandbox.json` (committed) defines network policy, read/write paths and temp directories. `permissions.json` controls what runs automatically.
- **Recommendation:** for PANOPTICON, Allowlist mode plus sandbox, i.e. deterministic behaviour in line with the project philosophy.

### 3.4 Worktrees, cloud agents and Bugbot

- **Worktrees** ([docs](https://cursor.com/docs/configuration/worktrees.md)): `.cursor/worktrees.json` with keys `setup-worktree`, `setup-worktree-unix` and `setup-worktree-windows`. The documentation discourages symlinking dependencies and recommends a fast package manager (pnpm, uv).
- **Cloud agents** ([docs](https://cursor.com/docs/cloud-agent.md)) run in isolated virtual machines, are started from the IDE, the web, GitHub (`@cursor`), Slack, **Linear** or the API, and open PRs. A natural cloud executor for tasks from OVERSEER.
- **Bugbot** ([docs](https://cursor.com/docs/bugbot.md)) automatically reviews every PR update and is triggered manually with a `bugbot run` comment. It keeps rules in `.cursor/BUGBOT.md` (nested files per directory), learns rules and has an optional Autofix (separate check `Cursor Bugbot Autofix`). Files marked `linguist-generated` are skipped, and PRs that are too large are rejected with a request to split.

### Mapping

- **Wardens:** `.cursor/hooks.json` with `failClosed`, `beforeShellExecution`, `beforeMCPExecution` and `beforeReadFile`. Bugbot acts as an additional, **probabilistic** reviewer, not a gate.
- **Cells:** worktrees, sandbox and cloud agents.
- **The Charter:** generates `.cursor/sandbox.json`, `hooks.json` and `BUGBOT.md`.

---

## 4. AGENTS.md

Sources: [agents.md](https://agents.md/), [Claude Code Memory](https://code.claude.com/docs/en/memory), [Cursor Rules](https://cursor.com/docs/rules.md).

### State as of November 2026

- An open format: plain Markdown with no required fields. According to the site, it is used by over 60,000 open-source projects and maintained by the **Agentic AI Foundation under the Linux Foundation**.
- Nesting: **the nearest file in the directory tree takes precedence**, and a user instruction in chat overrides everything.
- Supported by Cursor, Codex, Jules, Gemini CLI, Aider, Windsurf, Zed and Warp, among others. Claude Code reads it **natively since v2.1.277**, but only without `CLAUDE.md`, or through an `@AGENTS.md` import.

### Recommendation: layered instruction model

```
AGENTS.md                      ← canonical, shared (short: commands, structure, rules, links)
├── CLAUDE.md                  ← "@AGENTS.md" + Claude-only notes
├── .claude/rules/*.md         ← per-path rules (paths:)
├── .cursor/rules/*.mdc        ← per-path rules (globs:), generated from the same source
├── apps/web/AGENTS.md         ← nested: frontend conventions
└── apps/api/AGENTS.md         ← nested: backend conventions
```

**Content rules:**

- AGENTS.md is **short** (roughly under 150 lines; my proposal, not a standard): commands, repo map, rules and links to `docs/`.
- **Do not repeat what the linter enforces.** Instead write, e.g., "Wardens will block X, run `pnpm check`".
- Per-path rule content lives in one place, e.g. `docs/agent-rules/*.md`, and a `panopticon sync` script generates `.mdc` and `.claude/rules` from it. **(Own idea, not a standard.)**
- AGENTS.md and rule files are **security-sensitive configuration** (prompt injection, section 11), so CODEOWNERS and required review apply.

> Superseded by ADR-0006: the Covenant (`docs/constitution.md` + root and per-package `AGENTS.md`, including `wardens/` and `docs/specs/`) is the canonical instruction set, and the root `AGENTS.md` holds the glossary. Tool-specific path rules (`.claude/rules/`, `.cursor/rules/*.mdc`) are kept minimal and point back to the relevant `AGENTS.md`; there is no `docs/agent-rules/` source or `panopticon sync` generator for them. Config generation from The Charter is done by `wardens sync` (ADR-0003, ADR-0005).

---

## 5. Spec-driven development and ADRs

### 5.1 GitHub Spec Kit

Sources: [Spec Kit docs](https://github.github.io/spec-kit/), [repo](https://github.com/github/spec-kit), [agentic-sdd reference](https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md).

- Process: **Constitution, then Specify, Clarify, Plan, Checklist, Tasks, Analyze, Implement and Converge**. The `clarify`, `checklist` and `analyze` steps are optional quality gates; `converge` compares the implementation with the artifacts and adds missing tasks until the state is "Converged".
- Every phase produces a Markdown artifact (`spec.md`, `plan.md` and `tasks.md` with phases: Setup, Foundational, one phase per user story, and Polish).
- Works with many agents as commands or skills. The constitution holds the project principles the plan must follow.

### 5.2 Kiro

Sources: [Kiro Specs](https://kiro.dev/docs/specs/), [Requirements-first](https://kiro.dev/docs/specs/feature-specs/requirements-first/), [AWS Builder Center](https://builder.aws.com/content/3CSqR2TiDguv0Pg6EKn1LLswZ5i/building-production-ready-agents-with-kiro-steering-powers-hooks-specs-and-skills).

- Three files: `requirements.md` (user stories and criteria in **EARS** notation: "WHEN … THE SYSTEM SHALL …"), `design.md` and `tasks.md`.
- "Steering", i.e. `.kiro/steering/product.md`, `tech.md` and `structure.md`, provides durable context. Hooks react to file and task events.

### 5.3 ADR: MADR 4.0

Source: [MADR](https://adr.github.io/madr/).

- MADR 4.0.0 (09.2024) has full, "minimal" and "bare" templates. Sections: Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome, Consequences, **Confirmation** (how compliance is verified, e.g. by an architecture test) and Pros and Cons.
- Naming convention `NNNN-title-with-dashes.md` in `docs/decisions/`, linted with markdownlint.

### Recommendation for PANOPTICON

Create **our own lightweight process inspired by Spec Kit and Kiro**, without depending on a single tool:

```
docs/
├── constitution.md                 ← principles (Spec Kit) = the "law" of PANOPTICON, linked from AGENTS.md
├── decisions/NNNN-*.md             ← ADRs in MADR 4 format (with a Confirmation section!)
└── specs/NNNN-feature-name/
    ├── spec.md                     ← what and why; acceptance criteria in EARS
    ├── plan.md                     ← how; API contract, data model, ADRs
    └── tasks.md                    ← tasks with IDs, synchronized with Linear
```

**Deterministic enforcement, i.e. Wardens for specs:**

- A spec frontmatter validator (`id`, `status`, `linear_issue` and `adr`) run in CI.
- **Every PR must reference a spec or a Linear task.** A Danger-style check verifies this: the branch name or title contains `LUN-123`, and a PR changing `apps/**` without a link to `docs/specs/**` is rejected.
- **The ADR Confirmation section must name a concrete check**, e.g. an import-linter contract or a test. This links decisions to Wardens.
- Consider a **Spec Kit pilot** on one LunarHunt feature and compare results in the Ledger (ADR).

> Superseded by ADR-0011 and ADR-0001: the own process was adopted, but with one dated file per feature, `docs/specs/YYYY-MM-DD-<slug>.md` (sections: goal and context, EARS acceptance criteria, plan, tasks), finished specs moved to `docs/specs/implemented/`, analysis in `docs/specs/analysis/`, rules in `docs/specs/AGENTS.md` (modelled on Open Mercato's `.ai/specs`). Front matter uses `status`, `issue: #N` and `adrs`; links go to GitHub issues (`Closes #N`), not Linear `LUN-123` IDs. No Spec Kit pilot is planned; a `.specify/` directory is blocked by `toolchain-guard`.

### Mapping

- **OVERSEER:** drives Specify, then Plan and Tasks, and then creates tasks in Linear (superseded by ADR-0001: GitHub issues).
- **Wardens:** validation of artifacts and of the links between PR, spec and task.
- **The Charter:** defines which paths require a spec or ADR.

---

## 6. TS + Python monorepo and the API contract

### 6.1 Tools

| Area | Recommendation | Rationale and source |
| --- | --- | --- |
| JS packages | **pnpm workspaces** | Standard, fast, also recommended for worktrees by Cursor ([worktrees](https://cursor.com/docs/configuration/worktrees.md)) |
| Task orchestration | **Turborepo** (simpler) instead of Nx | Caching and task graph. Nx offers more (generators, `module boundaries`) but also more complexity. Choice for an ADR |
| Python | **uv workspaces** | One `uv.lock` for the whole workspace, `uv run --package` ([uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/)). A "virtual" root without `[project]` is allowed ([issue #13589](https://github.com/astral-sh/uv/issues/13589)) |
| Python–Turbo integration | Thin `package.json` in `apps/api` with `uv run …` scripts | **(Practical pattern, unconfirmed as an official Turborepo recommendation)** |
| Shared entry point | `pnpm check` (or `just check`) as one command | The agent has **one command** for "is everything green" |

> Decided in ADR-0007: pnpm workspaces + Turborepo (over Nx) + uv workspaces with a virtual root, `pnpm check` as the single entry command.

### 6.2 API contract: OpenAPI as the agreement

**Flow:**

1. FastAPI generates OpenAPI. We export it deterministically to `packages/contracts/openapi.json` with a `uv run export-openapi` script.
2. From the contract we generate a TS client into `packages/api-client`.
3. **Contract Warden in CI:**
   - **drift check:** regenerate plus `git diff --exit-code`. If the agent changed the API without regenerating, CI is red.
   - **breaking-change check:** [oasdiff](https://github.com/oasdiff/oasdiff-action) with `fail-on: ERR` or `WARN` against the base branch. Note: by default the action **sends an encrypted comparison to oasdiff.com**, so we set `review: false` to keep everything in CI ([oasdiff docs](https://www.oasdiff.com/docs/github-action)).

**TS client generator:**

| Tool | What it provides | When |
| --- | --- | --- |
| `openapi-typescript` + `openapi-fetch` | Types only plus a small runtime | Lightest. Note: Kubb states that `openapi-fetch` and `openapi-react-query` are in maintenance mode ([Kubb comparison](https://kubb.dev/docs/5.x/explanation/comparison.md), competitor source, **unconfirmed**) |
| **`@hey-api/openapi-ts`** | SDK functions per `operationId`, interceptors, TanStack Query and Zod plugins | **Recommended start**: light yet extensible ([heyapi.dev](https://heyapi.dev/docs/openapi/typescript/plugins/tanstack-query.md), [dev.to comparison](https://dev.to/nyaomaru/which-openapi-codegen-should-you-choose-openapi-typescript-vs-hey-api-vs-orval-vs-kubb-100p)) |
| Orval | React Query hooks, Zod and **MSW and Faker mocks** | When we want generated mocks for frontend tests |

**Recommendation:** hey-api, with the decision recorded in an ADR. FastAPI must be forced to produce stable `operationId`s (e.g. a custom `generate_unique_id_function`), otherwise function names in the client will "float", which is generated drift.

> Decided in ADR-0007: hey-api, drift check and oasdiff with `review: false`, stable `operationId`s.

### Mapping

- **Wardens:** drift check, oasdiff and the rule "do not edit `packages/api-client/**` by hand" (a `PreToolUse` hook blocks edits of generated files and suggests the generator command).
- **The Charter:** `generated_paths` and `contract_files` lists.

---

## 7. Deterministic guards (Wardens)

This is the heart of PANOPTICON. I propose **four rings** enforcing the same rules:

```
Ring 0: Agent hooks (Claude/Cursor)    → ms–s,  feedback while the agent works
Ring 1: Git hooks (lefthook)           → s,     before commit/push (for humans too)
Ring 2: CI (GitHub Actions)            → min,   mandatory required checks
Ring 3: GitHub rulesets + CODEOWNERS   → cannot be bypassed from the repo/agent
```

> Adopted in ADR-0004 (four rings, CI and rulesets as the final authority, MVP Wardens list).

### 7.1 Tools by category

| Category | TypeScript / Next.js | Python / FastAPI | Notes |
| --- | --- | --- | --- |
| Format and lint | **Biome v2** (lint, format, import sorting; type-aware rules opt-in) ([Biome v2](https://biomejs.dev/blog/biome-v2/)) or ESLint + typescript-eslint | **Ruff** (lint and format) | Biome covers fewer typed rules than typescript-eslint ([Biome comparison](https://biomejs.dev/introduction/comparison-with-other-tools/)). Option: Biome plus a narrow ESLint only for Next/React rules, for an ADR |
| Types | `tsc --noEmit` with `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | **Pyright** (strict) or mypy (strict). Astral's **ty** is still in beta (0.0.x) ([ty releases](https://github.com/astral-sh/ty/releases); beta status per search, **unconfirmed as of today**) | ty can be added as a fast non-blocking check |
| Architecture boundaries | **dependency-cruiser** ([repo](https://github.com/sverweij/dependency-cruiser)) | **import-linter**: `layers`, `forbidden` and `independence` contracts ([docs](https://import-linter.readthedocs.io/en/stable/contract_types/)) | Directly implements the ADR Confirmation section |
| SAST | **Semgrep** ([repo](https://github.com/semgrep/semgrep)), also as a Cursor hooks partner | Semgrep and Ruff `S` (bandit) | Custom Semgrep rules = Charter policies |
| Secrets | **gitleaks** ([repo](https://github.com/gitleaks/gitleaks)) in agent hook, pre-commit and CI | same | Plus GitHub secret scanning and push protection |
| Commits | **Conventional Commits** + **commitlint** ([commitlint](https://commitlint.js.org/)) | same | Required Linear ID, e.g. `feat(api): … [LUN-42]` |
| Git hooks | **lefthook** ([repo](https://github.com/evilmartians/lefthook)): fast, parallel, one tool for JS and Python | or the `pre-commit` framework | I recommend lefthook, because JS hooks don't need Python and vice versa |
| Tests | Vitest, Playwright (e2e) | pytest, pytest-cov, Schemathesis (property tests from OpenAPI, **to be evaluated**) | |
| Coverage | Coverage gate **on changed lines** (diff coverage), not only global | `diff-cover` ([repo](https://github.com/Bachmann1234/diff_cover)) | The agent cannot add untested code |
| Mutation testing (optional) | StrykerJS ([stryker-mutator.io](https://stryker-mutator.io/)) | mutmut ([repo](https://github.com/boxed/mutmut)) | Nightly job; result goes to the Ledger as a quality metric for agent-written tests |
| Dependencies | Renovate ([docs](https://docs.renovatebot.com/)) with pinning and grouping | same | Plus Dependency Review Action on PRs |
| Workflows | **zizmor** (static analysis of GitHub Actions) ([repo](https://github.com/zizmorcore/zizmor)) | | Detects template injection, excessive permissions and unpinned actions |
| PR checks | Danger JS ([danger.systems](https://danger.systems/js/)) or a custom `wardens pr-check` script | | PR size, link to spec and task, ADR on dependency changes, no changes in `generated/` |

> Superseded by ADR-0007: **Biome is the only linter and formatter for TypeScript** (no ESLint, no Prettier, no narrow ESLint); gaps are covered by `tsc --noEmit` in strict mode, and any additional lint tool needs a new ADR (enforced by `toolchain-guard`). Python uses **Ruff** and **Pyright** (strict); `ty` may be added later as a non-blocking check.
>
> Superseded by ADR-0001: commit convention is `feat(api): add offer CRUD (#42)` referencing a GitHub issue, not a Linear ID.
>
> Extended by ADR-0004 and the decision log: security checks are Semgrep, gitleaks, zizmor, Trivy and CodeQL (plus Renovate or Dependabot, still to be chosen); accessibility uses Biome `a11y` rules, axe-core in Playwright and Lighthouse CI; Playwright is the only E2E tool. `pr-check` is a subcommand of the TypeScript `wardens` CLI (ADR-0005).

### 7.2 Agent-specific Wardens

Classic CI cannot do these; agent hooks can:

1. **Scope guard** (`PreToolUse` on Edit and Write): the Linear task declares `allowed_paths` in `tasks.md` or in its description, and edits outside them are blocked with a message for the agent.
2. **Protected paths:** `migrations/**`, `infra/prod/**`, `.github/**`, `AGENTS.md`, `.claude/**`, `.cursor/**` and `panopticon.charter.yaml` require `ask` or `deny`. The agent **cannot weaken its own guards**. Claude Code's `ConfigChange` also supports this.
3. **Command guard** (`PreToolUse` Bash / `beforeShellExecution`): a list of forbidden commands from The Charter (force push, destructive deletion, pipe-to-shell, `kubectl` on prod, package publishing) and command rewriting through `updatedInput` (e.g. `npm install` to `pnpm add`).
4. **Generated-files guard:** blocks hand edits of the API client and lockfiles and suggests the correct command.
5. **Definition of Done** (`Stop` / `stop`): runs `pnpm check:affected`. When the result is red, it returns `decision: block` with the list of errors and the agent keeps working. A loop limit prevents endless work.
6. **Test-tampering guard:** a heuristic that detects the agent deleting or "skipping" tests (`.skip`, `@pytest.mark.skip`, lowering the coverage threshold). This is flagged in the PR and requires human approval. **(Own idea, to be designed.)**
7. **Secret read guard:** `Read` deny for `.env*` and `beforeReadFile` in Cursor.

> Superseded by ADR-0001 and ADR-0003: allowed paths come from the GitHub issue's *allowed paths* field and can only narrow the Charter's `paths.allowed_paths`. ADR-0004 added further Wardens: `bug-repro-test`, `e2e-test-modification`, `risk-classifier`, `diff-coverage`, `pr-check` and `agent-trailer`.

### 7.3 The Charter: sketch of `panopticon.charter.yaml`

*(Originally called "Codex", file `panopticon.policy.yaml`.)*

```yaml
version: 1
project: lunarhunt
tools: { claude_code: true, cursor: true }

paths:
  protected:          # require human approval
    - "apps/api/migrations/**"
    - "infra/**"
    - ".github/**"
    - "AGENTS.md"
    - ".claude/**"
    - ".cursor/**"
    - "panopticon.charter.yaml"
  generated:          # only via the generator
    - "packages/api-client/src/**"
    - "packages/contracts/openapi.json"
  secrets_deny_read: [".env", ".env.*", "secrets/**"]

commands:
  deny:               # patterns matched by the wardens engine
    - "git push --force*"
    - "git push -f*"
    - "kubectl * --context prod*"
    - "npm publish*"
  rewrite:
    "npm install": "pnpm install"

architecture:
  python_contracts: "apps/api/.importlinter"
  ts_rules: ".dependency-cruiser.cjs"

quality_gates:
  definition_of_done: ["lint", "typecheck", "test:affected", "contract:drift"]
  diff_coverage_min: 80
  max_pr_changed_lines: 600

workflow:
  require_linear_issue: true      # LUN-123 in branch/PR
  require_spec_for: ["apps/**"]
  require_adr_for: ["new_dependency", "new_service", "schema_change"]

ledger:
  sink: otlp
  capture_content: false          # no prompt content by default
```

Mechanics: `panopticon sync` generates `.claude/settings.json` (permissions and hooks), `.cursor/hooks.json`, `.cursor/sandbox.json`, `lefthook.yml` and workflow fragments from The Charter, and CI checks that the generated files are up to date (drift). **The Charter validates itself** through JSON Schema.

> Superseded by ADR-0003: the authoritative schema outline is in ADR-0003 (adds `autonomy`, `roles` with model and effort per ADR-0009, `risk`, `budgets`, `log_access`; protected paths include all Covenant files and `deploy/**`); the JSON Schema lives at `wardens/schema/charter.schema.json`. Configs are generated by **`wardens sync`** (ADR-0005), not `panopticon sync`. `require_linear_issue` is replaced by a GitHub issue reference (ADR-0001).

### 7.4 GitHub: the last ring

Sources: [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [Merge queue](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

- **Ruleset on `main`:** PR required, required checks (list from The Charter), no force push or deletion, linear history, **required CODEOWNERS review** and signed commits (optional).
- **Merge queue** (optional, later): workflows must then react to `merge_group`.
- **CODEOWNERS:** `@krzysztof` for `AGENTS.md`, `.claude/`, `.cursor/`, `.github/`, `infra/`, `panopticon.charter.yaml` and `docs/decisions/`.
- With a single developer, GitHub does not allow approving your own PR. Agents open PRs from a bot or app account, so Krzysztof approves them. A good, natural "human approves" model **(to be confirmed in an ADR when choosing agent identities)**.

> Superseded by ADR-0008: in autonomy phases 0–1, local agents commit under Krzysztof's account with an `Agent:` trailer; a dedicated GitHub App (which opens PRs Krzysztof can approve) is introduced only from phase 2.

---

## 8. Agent isolation (Cells)

### Best practices

| Level | Mechanism | Source |
| --- | --- | --- |
| Code | **git worktree + branch per task** | Claude: `claude --worktree <name>` creates `.claude/worktrees/<name>` on branch `worktree-<name>`; `.worktreeinclude` copies gitignored files ([Worktrees](https://code.claude.com/docs/en/worktrees)). Cursor: `.cursor/worktrees.json` ([docs](https://cursor.com/docs/configuration/worktrees.md)) |
| Processes | **OS sandbox** for commands | Claude: bubblewrap or Seatbelt, network through a proxy with an allowlist ([Sandboxing](https://code.claude.com/docs/en/sandboxing)). Cursor: `sandbox.json` ([Run Modes](https://cursor.com/docs/agent/security/run-modes.md)) |
| Environment | **Devcontainer** with an egress firewall | Anthropic reference container with `init-firewall.sh`. Warning: with `--dangerously-skip-permissions` the container **does not protect** against leaking what is inside it, including credentials from `~/.claude` ([Devcontainer](https://code.claude.com/docs/en/devcontainer)) |
| Cloud | Cursor Cloud Agents (VM), Linear Coding Sessions (Claude Code or Codex in a sandbox, result as a draft PR) | [Cloud Agents](https://cursor.com/docs/cloud-agent.md), [Linear Coding sessions](https://linear.app/docs/coding-sessions) |
| Data | Separate database per Cell: Postgres in a container or a schema per worktree, seeds from fixtures | Practical pattern |

### Recommendation: three classes of Cells

| Class | When | Isolation | Secrets | Network |
| --- | --- | --- | --- | --- |
| **Cell-L (local)** | Interactive work with Claude or Cursor | worktree + OS sandbox | Only `.env.dev` with test data | Allowlist: npm and PyPI registries, GitHub, LLM APIs |
| **Cell-C (container)** | Longer autonomous tasks, no-prompt mode | devcontainer + firewall + worktree, non-root user | No production secrets, short-lived tokens | Allowlist |
| **Cell-R (remote)** | Tasks delegated from Linear or GitHub | Cursor Cloud Agent or Linear Coding Session | Development environment secrets | Per provider |

Rules: **one task means one Cell, one branch and one PR**. A Cell never has production access. Ports and databases are assigned deterministically from the task ID so parallel Cells do not collide (e.g. a `WorktreeCreate` hook or `setup-worktree`).

Note from the Linear documentation: environment variables in Coding Sessions are **visible to the agent**, and environment secrets are visible to anyone who can start a session. Treat them like a local `.env`, not like hidden secrets.

> Superseded by ADR-0007 and the decision log: the **Dev Container** (`.devcontainer/devcontainer.json` with docker compose) is the base Cell, used by humans, local agents and CI; nightly agent Cells later run the same image per task with their own git worktree and Charter-defined egress limits. With tasks in GitHub Issues (ADR-0001), Linear Coding Sessions are no longer an obvious remote executor; the remote executor choice is still open (see section 14, question 5).

---

## 9. Observability and evaluation (The Ledger)

### 9.1 Standards

- **OpenTelemetry GenAI semantic conventions:** spans `invoke_agent {gen_ai.agent.name}`, `execute_tool {gen_ai.tool.name}` and model-call spans with `gen_ai.usage.input_tokens` and `output_tokens`. The conventions have a separate repository, [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md). Their status is **"Development"**, i.e. still unstable (**unconfirmed whether anything stabilized in 2026**), so attribute names may change.
- **Claude Code** exports metrics (including cost and tokens) and events through OTel; traces are **in beta**. Important: `OTEL_*` variables **cannot be set from `.claude/settings.json` in the repo**, only in the environment, in `~/.claude/settings.json` or in managed settings ([Monitoring](https://code.claude.com/docs/en/monitoring-usage)). Tool content is off by default (`OTEL_LOG_TOOL_CONTENT`).
- **Cursor** passes `conversation_id`, `generation_id`, `model`, `duration`, `modified_files`, `tool_call_count` and other fields to hooks ([Hooks](https://cursor.com/docs/agent/hooks)), so hooks feed the Ledger.
- Claude hooks receive `session_id` and `prompt_id`; the latter **matches the OTel `prompt.id` attribute**, which allows correlating hooks with telemetry ([Hooks reference](https://code.claude.com/docs/en/hooks)).

### 9.2 Ledger backend

| Option | Pros | Cons |
| --- | --- | --- |
| **Langfuse self-hosted** | Native OTLP endpoint (`/api/public/otel`, HTTP only, no gRPC), trace UI, evaluations and datasets ([Langfuse OTel](https://langfuse.com/integrations/native/opentelemetry)) | The Helm chart requires **Postgres, ClickHouse (with an operator and cert-manager), Redis and blob storage** ([Langfuse Helm](https://langfuse.com/self-hosting/deployment/kubernetes-helm)). A lot of RAM on a single VPS (**hardware requirements unconfirmed**) |
| Langfuse Cloud (free tier) | Zero maintenance | Data outside our infrastructure (**free-plan limits unconfirmed**) |
| **Own Postgres table** + OTel Collector | Lightweight, full control, good portfolio material | A UI or dashboard must be built |

**Recommendation:** **Ledger v0 is our own events in Postgres** (written by hooks, schema below) plus an OTel Collector. Langfuse (cloud or self-hosted) is attached as a sink for the LunarHunt product's LLM telemetry and for evaluations. Decision for an ADR.

> Adopted in ADR-0010: Ledger v0 is Postgres tables with JSONB events, instrumented via OpenTelemetry so a later move to Langfuse needs no agent changes. Server observability: structured JSON logs with `trace_id`, Grafana + Loki + Tempo + Prometheus; agents get read-only, redacted, audited log access.

### 9.3 What to record in the Ledger (minimal schema)

```
run            : run_id, task_id (LUN-123), spec_id, cell_id, branch, tool (claude|cursor|linear),
                 agent_type (overseer|implementer|reviewer), model, effort, started_at, ended_at, status
step/event     : run_id, ts, event (PreToolUse/stop/...), tool_name, decision (allow/deny/ask),
                 warden_rule_id, duration_ms
warden_verdict : run_id, rule_id, outcome (pass/block), message          ← "how often Wardens stopped the agent"
gate_result    : run_id/pr, check (lint/types/tests/contract/coverage), result, duration
usage          : run_id, input_tokens, output_tokens, cache_tokens, cost_usd
outcome        : pr_number, merged (bool), human_fix_commits, review_comments, reverted (bool),
                 time_to_merge, ci_reruns
```

> Superseded by ADR-0010, ADR-0001 and ADR-0009: `run` references a GitHub issue instead of a Linear task ID, records the role (including `spec-writer` and `sentinel`) and the effort level actually used, and a `log_query` table audits agent log access.

**Platform metrics (portfolio KPIs):** share of tasks delivered without manual fixes, Warden blocks per task (a drift measure), cost and time per task, first-attempt green PR rate, reverts after merge, and at night the mutation score of agent-written tests. Broken down by model, agent and task class (CRUD, logic, integrations).

**Privacy:** by default **no prompt or code content**, metadata only. Content is optional, with secret redaction (gitleaks on the payload).

---

## 10. CI/CD and GitOps

### 10.1 GitHub Actions: hygiene

Sources: [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), [SHA pinning policy (changelog 2025-08-15)](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/), [Actions 2026 security roadmap](https://github.blog/news-insights/product-news/whats-coming-to-our-github-actions-2026-security-roadmap/), [Lock workflow dependencies](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies).

- **Pin actions to a full SHA** (with a `# vX.Y.Z` comment). GitHub can **enforce this with a policy** at the repository level. Lesson from the **tj-actions/changed-files (CVE-2025-30066)** incident: tags are mutable ([Unit 42](https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/)).
- A **workflow dependency lockfile** is on GitHub's 2026 roadmap and may replace manual pinning. A "Locking action dependencies" documentation page exists, but it is **unconfirmed whether the feature is generally available for our plan**; check before the ADR.
- `permissions:` at the minimum (`contents: read` by default, the rest granted per job), **OIDC** instead of long-lived cloud secrets, `persist-credentials: false` on checkout.
- **zizmor** in CI as a workflow linter.
- **Reusable workflows** (`workflow_call`) in the PANOPTICON template repo, called by projects by SHA. This is how the foundation is shared across projects.
- Required checks have **stable names** (the ruleset references names), so one aggregating job `panopticon/gate` depends on the rest. A popular pattern that simplifies the rules (**unconfirmed as an official GitHub recommendation**).
- Run only what the change affects: `turbo run --affected` or path filters and uv.

### 10.2 Artifact supply chain

Sources: [Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [actions/attest-build-provenance](https://github.com/actions/attest-build-provenance), [Kyverno ImageValidatingPolicy](https://kyverno.io/docs/policy-types/image-validating-policy/).

- Build the image, push to **GHCR** by **digest**, then SBOM (Syft or `anchore/sbom-action`, CycloneDX), SLSA provenance attestation (`actions/attest`; according to one source `attest-build-provenance` is already a legacy wrapper, **unconfirmed**) and **cosign keyless** signing (GitHub OIDC plus Sigstore).
- In the cluster, **Kyverno `ImageValidatingPolicy`** admits only images signed by our workflow (`subject: https://github.com/<org>/<repo>/.github/workflows/*`, `issuer: https://token.actions.githubusercontent.com`).
- Image vulnerability scanning (Trivy or Grype) as a CI check.

### 10.3 Deploy: k3s + Argo CD

- **k3s** ([docs](https://docs.k3s.io/)) on a VPS: lightweight, certified Kubernetes with built-in Traefik and local-path storage.
- **Argo CD** ([docs](https://argo-cd.readthedocs.io/)) using the "app of apps" pattern or ApplicationSet. The manifests repo can be separate (`lunarity-gitops`) or a `deploy/` directory (decision for an ADR).
- **Preview environments:** an ApplicationSet with the **Pull Request generator** creates a separate application and namespace for each PR (optionally only with the `preview` label) and removes them when the PR closes ([Argo PR generator](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Pull-Request/)). On a single VPS the number of previews must be limited (ResourceQuota). An alternative for the frontend is Vercel previews, but then Next.js runs outside the cluster.
- **Promotion:** merge to `main` deploys staging automatically; production goes through a PR to the GitOps repo (tag or digest change) approved by a human. Argo CD Image Updater is an option for an ADR.
- **Secrets in the cluster:** SOPS with age or Sealed Secrets, never in plain text in Git (for an ADR).
- **An agent never has a production kubeconfig.** The command guard blocks `kubectl` on prod contexts.

> Partly decided in ADR-0007: a `deploy/` folder in the monorepo first; a separate GitOps repo is reconsidered when the k3s deployment is set up (still open in the decision log). ADR-0008: production promotion is always a human-approved step.

### Mapping

- **Wardens (rings 2 and 3):** required checks, zizmor, attestations and Kyverno as the guard at the cluster entrance.
- **Ledger:** check results, PR-to-deploy time and reverts.

---

## 11. Security of working with agents

### 11.1 Threat model

Sources: [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), [Simon Willison: The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [OWASP Secure Coding with AI Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html).

- The OWASP Agentic Top 10 (2026) lists, among others: agent goal hijack, tool misuse, identity and privilege abuse, supply chain (including MCP), unexpected code execution, memory and context poisoning, cascading failures and "rogue agents".
- The **lethal trifecta** is when an agent simultaneously has access to private data, exposure to untrusted content and the ability to communicate externally. Prompt injection can then exfiltrate data. **PANOPTICON rule: every Cell breaks at least one element of the trifecta**, usually through a network allowlist and the absence of real secrets.
- **Prompt injection through repo content:** `AGENTS.md` files, rules, dependency READMEs, comments in issues and PRs, and MCP results are all inputs. Real attacks through agent instruction files have been described ([Backslash: Codex AGENTS.md injection](https://www.backslash.security/blog/openai-codex-injection-in-agents-md-exfiltrating-credentials); paper [GitInject, arXiv 2606.09935](https://arxiv.org/html/2606.09935), **unconfirmed, full text not read**).

> Extended by the decision log and ADR-0004: for LunarHunt, job-offer content (pasted text, ATS APIs, Notion imports, Nightwatch scans) is a primary untrusted input. The **Sentinel** role reviews every PR diff for authorization flaws, prompt injection via job-offer content, data leaks and new MCP permissions; the **Infiltrator** red-team role (phase 2, preview/staging only) actively attacks these paths.

### 11.2 MCP

Sources: [MCP Security Best Practices (2026-07-28)](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), [Authorization security considerations](https://modelcontextprotocol.io/specification/draft/basic/authorization/security-considerations).

- An MCP server **must not pass the client's token through** (no token passthrough). It must validate the token audience (RFC 8707 `resource`) and protect itself against the "confused deputy".
- In practice: only trusted MCP servers pinned to a version, minimal scopes (e.g. read-only Linear for `reviewer`; with ADR-0001 this becomes read-only GitHub Issues access), `PreToolUse` hooks with an `mcp__.*` matcher and `beforeMCPExecution` with `failClosed` for write operations. In Cursor we match on `mcp_server_name`, and an unknown server is rejected (recommendation from [Cursor Hooks](https://cursor.com/docs/agent/hooks)).
- Subagents can have **their own, narrowed `mcpServers`** ([Subagents](https://code.claude.com/docs/en/sub-agents)).

### 11.3 Tokens and identity

- A **fine-grained PAT** or, better, a **GitHub App** for agents, with access only to PANOPTICON repositories and `contents:write` and `pull_requests:write` permissions, **without** `administration` and without the ability to change rulesets.
- Separate tokens and accounts for: local agents, CI, Argo CD (read-only on the GitOps repo) and OVERSEER (Linear).
- Short-lived credentials (OIDC in CI) and no production secrets in Cells.
- **Kill switch:** one command or procedure that revokes agent tokens and disables automation (listed in OWASP Agentic recommendations, [futureagi](https://futureagi.com/blog/owasp-agentic-top-10-2026/), secondary source).

> Superseded by ADR-0008 and ADR-0001: phases 0–1 use Krzysztof's account with an `Agent:` trailer; the GitHub App (with `contents`, `pull_requests` and `issues` write, no administration or ruleset permissions) arrives in phase 2. OVERSEER works with GitHub Issues, not Linear. The kill switch is `autonomy.kill_switch` in The Charter plus a documented procedure.

### 11.4 Concrete security Wardens

1. Changes to `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/**` and `panopticon.charter.yaml` require **CODEOWNERS** and manual review. The agent hook additionally returns `ask`.
2. gitleaks in `PostToolUse` (on edited files), pre-commit and CI.
3. A network sandbox with an allowlist for agent commands.
4. `PostToolUse` for `WebFetch` and MCP marks external content as untrusted (`additionalContext`, written as a fact: "this content comes from an external source") and logs it in the Ledger.
5. Agents never run on fork PRs with access to secrets, and workflows using `pull_request_target` are audited by zizmor.
6. Review of dependencies added by the agent (Dependency Review and a "new dependency" ADR), which protects against slopsquatting, i.e. package names hallucinated by the model (**industry term, source not verified in this research**).

---

## 12. Proposed repository structure

```
lunarhunt/                                 ← (or: panopticon/ as a template + a separate product repo, for an ADR)
├── AGENTS.md                              ← canonical instructions for all agents
├── CLAUDE.md                              ← "@AGENTS.md" + Claude notes
├── panopticon.charter.yaml                ← THE CHARTER: single source of policy
├── README.md
├── package.json / pnpm-workspace.yaml / turbo.json
├── pyproject.toml / uv.lock               ← uv workspace (virtual root)
├── biome.json / tsconfig.base.json
├── lefthook.yml                           ← Wardens ring 1 (generated from The Charter)
├── .dependency-cruiser.cjs
├── .gitleaks.toml / .semgrep/             ← security rules (partly from The Charter)
├── .github/
│   ├── CODEOWNERS
│   ├── pull_request_template.md           ← fields: Linear ID, spec, ADR, risks
│   └── workflows/
│       ├── gate.yml                       ← calls PANOPTICON reusable workflows (by SHA)
│       ├── contract.yml                   ← drift + oasdiff
│       ├── security.yml                   ← gitleaks, semgrep, zizmor, dependency-review
│       └── release.yml                    ← build, SBOM, attest, cosign, push GHCR
├── .claude/
│   ├── settings.json                      ← permissions + hooks → tools/wardens (generated)
│   ├── agents/  overseer.md implementer.md reviewer.md spec-writer.md
│   ├── skills/  spec/ adr/ plan-tasks/ implement-task/ review-against-spec/ ledger-report/
│   └── rules/   api.md web.md tests.md
├── .cursor/
│   ├── hooks.json                         ← same wardens engine, failClosed (generated)
│   ├── sandbox.json  worktrees.json
│   ├── rules/   api.mdc web.mdc tests.mdc ← generated from docs/agent-rules
│   └── BUGBOT.md
├── .devcontainer/                         ← Cell-C: devcontainer.json + init-firewall.sh
├── apps/
│   ├── web/        (Next.js)   AGENTS.md
│   ├── api/        (FastAPI)   AGENTS.md  .importlinter  migrations/
│   └── worker/     (Python)    AGENTS.md
├── packages/
│   ├── contracts/  openapi.json           ← contract (generated from FastAPI)
│   ├── api-client/                        ← generated TS client (hey-api)
│   └── ui/                                ← shared components
├── tools/
│   ├── wardens/    (Python, uv)           ← guard engine: pre-tool, post-edit, dod, pr-check
│   ├── ledger/                            ← event writing, schema, reports
│   └── panopticon-cli/                    ← `panopticon sync | doctor | new-spec | new-adr`
├── docs/
│   ├── constitution.md
│   ├── decisions/  0000-template.md 0001-...md       ← MADR 4
│   ├── specs/      0001-name/{spec,plan,tasks}.md
│   ├── agent-rules/                       ← source of per-path rules (→ .mdc, .claude/rules)
│   └── research/   0001-fundament-best-practices.md  ← this document
└── deploy/
    ├── base/  overlays/{staging,prod}/    ← Kustomize/Helm
    ├── argocd/  applicationsets/ (preview-pr.yaml)
    └── policies/  kyverno/ (verify-images.yaml)
```

> Superseded by ADR-0007 (authoritative layout): a single monorepo `LUNARITYai/lunarhunt`, with the PANOPTICON template extracted later. The Wardens engine is the TypeScript package **`wardens/`** at the repo root (ADR-0005), not `tools/wardens (Python, uv)`; its single CLI also covers `sync` and `doctor`, replacing the separate `panopticon-cli`. `apps/worker/` also hosts Nightwatch. Specs are dated files `docs/specs/YYYY-MM-DD-<slug>.md` with `implemented/` and `analysis/` (ADR-0011). There is no `docs/agent-rules/` (ADR-0006). The PR template references a GitHub issue (`Closes #N`), not a Linear ID (ADR-0001). `.devcontainer/` is the base Cell for humans, agents and CI (ADR-0007).

---

## 13. Proposed ADR list

| No. | Title | In one sentence |
| --- | --- | --- |
| 0001 | Recording decisions in MADR 4 | ADRs in `docs/decisions/` with a mandatory Confirmation section naming the enforcing check |
| 0002 | The Charter (then "Codex") as the single source of policy | `panopticon.charter.yaml` with JSON Schema generates the Claude, Cursor, lefthook and CI configs, and CI guards against drift |
| 0003 | Four rings of Wardens | The same rule in agent hooks, git hooks, CI and GitHub rulesets, fail-closed for security |
| 0004 | One hook engine for Claude Code and Cursor | A Python `wardens` CLI with input normalization, native configs for both tools, and a decision on Cursor's import of Claude hooks |
| 0005 | AGENTS.md as canonical instructions | AGENTS.md as the source, CLAUDE.md with an import, per-path rules generated into `.mdc` and `.claude/rules` |
| 0006 | Spec-driven process | Own lightweight process (constitution, spec with EARS, plan, tasks) instead of full Spec Kit, with a Spec Kit pilot for comparison |
| 0007 | Monorepo: pnpm + Turborepo + uv | One repo for TS and Python, `pnpm check` as the single agent entry point, Turbo vs Nx |
| 0008 | API contract and generated client | OpenAPI from FastAPI, hey-api client, drift check and oasdiff (`review: false`) |
| 0009 | Lint, format and types | Biome vs ESLint, Ruff, Pyright vs mypy (ty as a non-blocking check), TS strict |
| 0010 | Architecture boundaries | dependency-cruiser and import-linter with layer contracts |
| 0011 | Test strategy and quality gates | Test pyramid, diff coverage, Playwright, optional nightly mutation testing |
| 0012 | Cells model | Three classes (local, container, remote), worktree per task, port and database allocation, no prod access |
| 0013 | Agent roles and OVERSEER | Subagents (overseer, spec-writer, implementer, reviewer), their tools, permissions and MCP |
| 0014 | Linear integration | Task flow, ID convention in branches and commits, choice of remote executor (Cursor Cloud Agents vs Linear Coding Sessions) |
| 0015 | The Ledger | Event schema, OTel GenAI, Postgres vs Langfuse, content privacy policy, platform KPIs |
| 0016 | GitHub Actions hygiene | SHA pinning or lockfile, minimal `permissions`, OIDC, zizmor, reusable workflows |
| 0017 | Artifact supply chain | GHCR by digest, SBOM, SLSA attestations, keyless cosign, Kyverno in the cluster |
| 0018 | Hosting and GitOps | k3s on a VPS, Argo CD, GitOps repo separate or in the monorepo, staging→prod promotion via PR |
| 0019 | Preview environments | ApplicationSet PR generator with resource limits, alternatively Vercel for the frontend |
| 0020 | Secrets | SOPS or Sealed Secrets, no prod secrets in Cells, agent identities and tokens (GitHub App) |
| 0021 | Agent and MCP security | Threat model (OWASP Agentic, lethal trifecta), MCP allowlist, instruction-file protection, kill switch |
| 0022 | Naming and branding | PANOPTICON, OVERSEER, Wardens, Cells, Ledger and The Charter, including the risk of confusing "Codex" with OpenAI Codex |
| 0023 | Reusable PANOPTICON template | How the foundation reaches further projects: template repo, reusable workflows, `wardens` package and versioning |

> Superseded by the actual ADR set (`docs/decisions/README.md`), which uses different numbers. Mapping from the proposal above:
>
> - Proposed 0001 → **ADR-0002** (MADR 4.0 + decision log).
> - Proposed 0002 → **ADR-0003** (The Charter).
> - Proposed 0003 → **ADR-0004** (four rings; also covers parts of 0011 and 0021: bug-repro test, E2E, a11y, security tools, Sentinel).
> - Proposed 0004 → **ADR-0005** (engine in **TypeScript**, not Python; Cursor's Claude hook import disabled).
> - Proposed 0005 → **ADR-0006** (the Covenant; path rules are not generated).
> - Proposed 0006 → **ADR-0011** (own process; no Spec Kit pilot).
> - Proposed 0007, 0008, 0009 → **ADR-0007** (monorepo, contract, Biome only, Ruff + Pyright, Dev Container, `deploy/` first).
> - Proposed 0013 → **ADR-0009** (model and effort routing per role) and **ADR-0008** (autonomy, identity).
> - Proposed 0014 → replaced by **ADR-0001** (GitHub Issues + Projects instead of Linear).
> - Proposed 0015 → **ADR-0010** (The Ledger and observability).
> - Proposed 0012 → local part in **ADR-0012** (task isolation with git worktrees); base Cell in **ADR-0007**. Cell classes, egress limits and the remote executor are not yet written.
> - Proposed 0022 → resolved by **ADR-0003** (rename to The Charter) and the **ADR-0006** glossary.
> - Not yet written: 0010, 0016, 0017, 0018 (partly ADR-0007), 0019, 0020 (identity part in ADR-0008), 0021 (partly ADR-0004), 0023, plus a future security red-team ADR (Infiltrator).

---

## 14. Risks and open questions

### Risks

1. **Fast tool changes.** The Claude Code and Cursor hook APIs change every few weeks (the documentation shows version requirements such as v2.1.295+). **Mitigation:** a `wardens` engine with contract tests on sample payloads, minimum tool versions pinned in `AGENTS.md`, and `panopticon doctor` (now `wardens doctor`, ADR-0005).
2. **Local hooks can be disabled** (`disableAllHooks`), and without managed settings nothing prevents it. **Mitigation:** CI and rulesets as the final gate, and the Ledger detects sessions without hook events.
3. **Fail-open by default.** In both tools a hook failure lets the action through by default. **Mitigation:** `onFailure: "block"` and `failClosed: true`, plus a `panopticon doctor` (now `wardens doctor`) test that deliberately breaks a hook.
4. **Too much ceremony** will slow work down and discourage. **Mitigation:** The Charter with levels (`strict` and `relaxed`), a light path for small changes, and measuring time lost to blocks in the Ledger.
5. **A single VPS:** k3s, Argo CD, Postgres, previews and possibly Langfuse may not fit in memory. **Mitigation:** Ledger v0 in Postgres, a preview limit, Langfuse Cloud to start.
6. **False sense of security from classifiers** (Auto-review, prompt hooks). According to Cursor's documentation they are not a security boundary. **Mitigation:** hard deny rules, sandbox and allowlists.
7. **Prompt injection through dependencies and MCP.** **Mitigation:** section 11.
8. **Model costs** in `Stop` loops. **Mitigation:** `loop_limit`, `maxTurns`, a per-task budget in The Charter and alerts from the Ledger.
9. **Double hook execution** in Cursor (native plus imported from `.claude/`). **Mitigation:** a decision in ADR-0005 (proposed list: 0004) and an idempotent engine.

> Superseded by ADR-0009 (risk 8): budgets live in The Charter `budgets:`; escalation is deterministic (3 failed `Stop` hooks or 5 Warden blocks, at most one escalation per task, then `needs:human`), and effort is capped by `maxEffortLevel`.

### Open questions to settle together

1. **One repo or two?** The PANOPTICON template as a separate repo (reusable workflows plus the `wardens` package) with LunarHunt as a consumer, or everything in one monorepo at the start with extraction later?
2. **Wardens engine language:** Python (consistent with the backend, quick start via `uv run`) or TypeScript (Bun or Node, closer to examples in Cursor's documentation)? I lean towards Python.
3. **Cursor's import of Claude hooks:** do we rely on it (one config) or disable it (two native configs with `failClosed`)?
4. **Biome or ESLint** for Next.js? Biome is fast and simple; ESLint has full Next and React rules and typed linting.
5. **Remote executor:** Cursor Cloud Agents, Linear Coding Sessions, or local only for now?
6. **Where to keep the Ledger** at the start: Postgres or Langfuse Cloud?
7. **Agent identity on GitHub:** GitHub App or machine account? Affects the "human approves" model.
8. **GitOps repo:** separate or a `deploy/` directory?
9. **The name "Codex":** keep it, or change to something without a collision, e.g. "Edicts" or "The Rulebook"?
10. **Spec Kit:** use it as a tool or only as inspiration?

> Resolution status (as of ADR-0001–0011):
>
> 1. Resolved, **ADR-0007**: single monorepo `LUNARITYai/lunarhunt`; PANOPTICON template extracted later.
> 2. Resolved, **ADR-0005**: **TypeScript on Node** (strict TS, zod, Vitest, tsup bundle); the Python recommendation above was not adopted.
> 3. Resolved, **ADR-0005**: import disabled, two native configs with fail-closed settings; detected by `wardens doctor` (the decision log still tracks it as an editor setting that cannot be guaranteed from the repo).
> 4. Resolved, **ADR-0007**: Biome only (no ESLint, no Prettier), gaps covered by `tsc --strict`.
> 5. Open. Local only in phases 0–1; cloud/autonomous agents with a GitHub App from phase 2 (**ADR-0008**); the executor is not chosen yet.
> 6. Resolved, **ADR-0010**: Postgres (JSONB events via OpenTelemetry), Langfuse later as a sink.
> 7. Resolved, **ADR-0008**: Krzysztof's account with an `Agent:` trailer in phases 0–1, GitHub App from phase 2.
> 8. Partly resolved, **ADR-0007**: `deploy/` first, revisit with k3s.
> 9. Resolved, **ADR-0003**: renamed to **The Charter** (`panopticon.charter.yaml`).
> 10. Resolved, **ADR-0011**: inspiration only; own process.

---

## 15. Sources

### Claude Code (Anthropic)
- Hooks reference: https://code.claude.com/docs/en/hooks
- Settings: https://code.claude.com/docs/en/settings
- Configure permissions: https://code.claude.com/docs/en/permissions
- Memory / CLAUDE.md / AGENTS.md: https://code.claude.com/docs/en/memory
- Subagents: https://code.claude.com/docs/en/sub-agents
- Skills: https://code.claude.com/docs/en/skills
- Sandboxing: https://code.claude.com/docs/en/sandboxing
- Worktrees: https://code.claude.com/docs/en/worktrees
- Development containers: https://code.claude.com/docs/en/devcontainer
- Monitoring (OpenTelemetry): https://code.claude.com/docs/en/monitoring-usage
- GitHub Actions: https://code.claude.com/docs/en/github-actions
- Reference devcontainer: https://github.com/anthropics/claude-code/tree/main/.devcontainer

### Cursor
- Hooks: https://cursor.com/docs/agent/hooks
- Third Party Hooks (Claude Code compatibility): https://cursor.com/docs/reference/third-party-hooks.md
- Rules: https://cursor.com/docs/rules.md
- Run Modes / Sandbox: https://cursor.com/docs/agent/security/run-modes.md
- Worktrees: https://cursor.com/docs/configuration/worktrees.md
- Cloud Agents: https://cursor.com/docs/cloud-agent.md
- Bugbot: https://cursor.com/docs/bugbot.md

### Standards and process
- AGENTS.md: https://agents.md/
- GitHub Spec Kit: https://github.github.io/spec-kit/ , https://github.com/github/spec-kit , https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md
- Kiro Specs: https://kiro.dev/docs/specs/ , https://kiro.dev/docs/specs/feature-specs/requirements-first/
- Kiro (AWS Builder Center): https://builder.aws.com/content/3CSqR2TiDguv0Pg6EKn1LLswZ5i/building-production-ready-agents-with-kiro-steering-powers-hooks-specs-and-skills
- MADR: https://adr.github.io/madr/
- Linear Coding sessions: https://linear.app/docs/coding-sessions

### Monorepo and contract
- uv workspaces: https://docs.astral.sh/uv/concepts/projects/workspaces/ , https://github.com/astral-sh/uv/issues/13589
- oasdiff action: https://github.com/oasdiff/oasdiff-action , https://www.oasdiff.com/docs/github-action
- Hey API (TanStack Query plugin): https://heyapi.dev/docs/openapi/typescript/plugins/tanstack-query.md
- Generator comparison (dev.to): https://dev.to/nyaomaru/which-openapi-codegen-should-you-choose-openapi-typescript-vs-hey-api-vs-orval-vs-kubb-100p
- Kubb comparison: https://kubb.dev/docs/5.x/explanation/comparison.md
- Fern guide: https://buildwithfern.com/post/generate-idiomatic-typescript-clients-from-openapi

### Guards and quality
- Biome v2: https://biomejs.dev/blog/biome-v2/ , https://biomejs.dev/introduction/comparison-with-other-tools/
- import-linter: https://import-linter.readthedocs.io/en/stable/contract_types/
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- ty (Astral): https://github.com/astral-sh/ty/releases
- Semgrep: https://github.com/semgrep/semgrep
- gitleaks: https://github.com/gitleaks/gitleaks
- lefthook: https://github.com/evilmartians/lefthook
- commitlint: https://commitlint.js.org/
- Danger JS: https://danger.systems/js/
- diff-cover: https://github.com/Bachmann1234/diff_cover
- StrykerJS: https://stryker-mutator.io/ ; mutmut: https://github.com/boxed/mutmut
- Renovate: https://docs.renovatebot.com/
- zizmor: https://github.com/zizmorcore/zizmor
- GitHub rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- Merge queue: https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue

### Observability
- OTel GenAI agent spans: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- Langfuse OTel: https://langfuse.com/integrations/native/opentelemetry
- Langfuse Helm: https://langfuse.com/self-hosting/deployment/kubernetes-helm

### CI/CD, GitOps, supply chain
- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use
- SHA pinning policy: https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/
- Actions 2026 security roadmap: https://github.blog/news-insights/product-news/whats-coming-to-our-github-actions-2026-security-roadmap/
- Lock workflow dependencies: https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies
- tj-actions incident (Unit 42): https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/
- Artifact attestations: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- attest-build-provenance: https://github.com/actions/attest-build-provenance
- Kyverno ImageValidatingPolicy: https://kyverno.io/docs/policy-types/image-validating-policy/
- Argo CD PR generator: https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Pull-Request/
- k3s: https://docs.k3s.io/ ; Argo CD: https://argo-cd.readthedocs.io/

### Security
- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- OWASP Secure Coding with AI Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html
- Lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Backslash, AGENTS.md injection: https://www.backslash.security/blog/openai-codex-injection-in-agents-md-exfiltrating-credentials
- GitInject (arXiv, unconfirmed): https://arxiv.org/html/2606.09935
- MCP Security Best Practices: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- MCP Authorization security considerations: https://modelcontextprotocol.io/specification/draft/basic/authorization/security-considerations
- OWASP Agentic, controls per risk (secondary source): https://futureagi.com/blog/owasp-agentic-top-10-2026/
