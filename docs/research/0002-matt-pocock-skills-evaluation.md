# Research 0002: Matt Pocock's agent skills and the "grill with docs" flow

| Field | Value |
| --- | --- |
| Project | PANOPTICON / LunarHunt |
| Document type | Research: input for a possible ADR (not a decision) |
| Date | 2026-11-18 |
| Author | Researcher (AI subagent) for Krzysztof Oszczapiński |
| Status | Draft; not reviewed. No decision is recorded here. |

> **How to read this document.** Each claim about a skill cites its source in brackets, e.g. [S3]. The source list is at the end. Skill behaviour is taken from the skill's `SKILL.md` on the `main` branch of `mattpocock/skills` where it was readable, and from the aihero.dev skill pages otherwise. The copy installed for this user could not be read (see "Limits"), so the installed version may differ from `main`. Anything not confirmed in a source is marked **(unverified)**. Claims about our process cite the file that owns them.

---

## Summary

The skills are a coherent, well-documented flow: **grill → spec → tickets → implement (TDD) → code review → retro** [S1, S13]. Most of their *ideas* already exist in PANOPTICON in a stricter, enforced form: EARS specs with human approval (C-10, ADR-0011), issues with allowed paths, one PR per task, an independent Reviewer and Sentinel (ADR-0016 D6), and Wardens (ADR-0004). Where the skills write files, open branches, set labels or merge, they assume a repo without our Charter and clash with it. Where they are *thinking disciplines* (interviewing, TDD, debugging, design vocabulary, writing for agents), they fit and add value.

**Ranked recommendation** (highest value and lowest conflict first):

1. **Adopt `grilling`** as the way OVERSEER and spec-writers resolve open questions. It is our existing decision-queue practice (numbered questions with a recommended answer, ADR-0018's "Q all ok") with a written method behind it.
2. **Adopt `tdd`** for implementers, and name the test seams in each spec's Plan. It complements C-15 and C-16.
3. **Adopt `diagnosing-bugs`**, split between the read-only `debugger` role (phases 1–3) and the implementer (phases 4–6).
4. **Adopt `codebase-design`** and **`writing-for-agents`** as reference vocabulary; neither writes files on its own.
5. **Adopt `research`** for delegated reading (this document follows it), with `docs/research/NNNN-*.md` as the location.
6. **Adapt `to-tickets` ideas** into the spec's Tasks section: vertical (tracer-bullet) slices, native GitHub "blocked by" links, and "name the observation that would show each criterion false".
7. **Adapt `wizard`** for steps only Krzysztof can perform (rulesets, GitHub App, secrets), written outside protected paths and never run by an agent.
8. **Adapt `prototype`** only under a `type:spike` issue.
9. **Adapt `implement`** only as an implementer's inner loop; its self-review never replaces the independent Reviewer.
10. **Reject `grill-with-docs` as packaged**: its doc-writing half targets a root `GLOSSARY.md` and `docs/adr/`, which collide with our glossary in `AGENTS.md` and MADR ADRs in `docs/decisions/`.
11. **Reject `to-spec`** (spec as an issue with a `ready-for-agent` label, no EARS, no human `ready` step) and **`pr`** (competes with `github-writing` and the PR template).
12. **Reject `implement-spec`** (the orchestrator flow): integration branch, merger subagent, end-only review and unbounded parallelism conflict with C-11, ADR-0016 D4/D6 and the 2-subagent cap.

**Orchestrator in a new tab vs our OVERSEER:** keep the native-subagent OVERSEER. The implementers are native subagents in both models; the differences are the integration branch, end-only review and frontier-wide parallelism, which our rules forbid for good reasons. Two cheap borrowings are worth taking: a fresh OVERSEER session per spec (`docs/operations/context-handoff.md` already restarts OVERSEER at about half context), and "rebase on the target tip before reporting done".

**Action needed before any adoption:** several of these skills are **already active** in this repo's sessions as user-level, model-invoked skills (`pr`, `code-review`, `domain-modeling`, `tdd`, and others appear in this session's skill list, both unprefixed and as `mattpocock-skills:*`). `domain-modeling` triggers on "recording or editing an ADR" and `pr` on "writing a PR body" [S5, S10], so they can steer agents away from MADR 4 (ADR-0002) and `github-writing` today. See open question 1.

**Update 2026-11-18, after this research run:** Krzysztof parked six user-level skills (`pr`, `domain-modeling`, `setup-pre-commit`, `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`) outside `~/.claude/skills` and disabled the `mattpocock-skills` plugin in the primary checkout's local Claude Code settings. The two conflicting triggers (`pr`, `domain-modeling`) are gone from sessions started in the primary. The unprefixed `grilling`, `tdd`, `diagnosing-bugs`, `codebase-design`, `writing-for-agents`, `research`, `prototype`, `wizard` and `code-review` stay active. Whether the change holds in a session started inside a task worktree is not yet checked.

---

## 1. The "grill with docs" main flow

**What it does.** `/grill-with-docs` is user-invoked only (`disable-model-invocation: true`) [S2]. Its `SKILL.md` is one line that loads `grilling` and `domain-modeling` [S1, S2]. It interviews the user round by round, answers from the codebase what the codebase can answer, writes each resolved term to `GLOSSARY.md` immediately, and writes an ADR under `docs/adr/` only for decisions that are hard to reverse, surprising without context, and a real trade-off [S1, S5]. Everything else stays in the conversation, which the page calls "the most serious open complaint about the skill" [S1]. The documented chain is `grill-with-docs → to-spec → to-tickets → implement → code-review → retro` [S1]; `/ask-matt` adds that a static chain "would be wrong for most situations" and that small changes may skip the spec [S13].

**Known issues the source lists** [S1]: inside other orchestration layers the file-writing step may silently fail while the interview continues; if `grilling` or `domain-modeling` fails to load, it asks everything at once with no recommendations.

**Overlap with our process.**

| Matt's step | Our equivalent | Owner in our process |
|---|---|---|
| grill-with-docs | Decision queue on #7, spec questions (ADR-0018's 18 questions) | OVERSEER, spec-writer, Krzysztof |
| GLOSSARY.md | Glossary in root `AGENTS.md` (human-only path, C-24) | Krzysztof |
| ADR under `docs/adr/` | MADR 4 ADRs in `docs/decisions/` (ADR-0002) | spec-writer drafts, Krzysztof's merge accepts (ADR-0020) |
| to-spec | Spec file `docs/specs/YYYY-MM-DD-<slug>.md`, EARS, `status: ready` by Krzysztof (C-10, ADR-0011) | spec-writer |
| to-tickets | Spec "Tasks" section → `agent:ready` issues with allowed paths | OVERSEER |
| implement | Implementer subagent, one issue, one worktree, one PR (C-11, C-33) | implementer |
| code-review | Independent Reviewer + Sentinel (ADR-0016 D6) | reviewer, sentinel |
| retro | No equivalent yet; Ledger v0 is being built (ADR-0010, `docs/specs/2026-11-14-ledger-v0.md`), no report yet | — |

**Verdict: adapt.** Keep the interview (via `grilling`). Drop the file writes:
- A root `GLOSSARY.md` is outside the Charter's `allowed_paths` (`panopticon.charter.yaml`, `paths.allowed_paths`), so `scope-guard` would block it; the source itself warns that such a block may be silent [S1].
- `docs/adr/` is inside `docs/**` and would be allowed, which is worse: it would create a second ADR folder in a different format next to `docs/decisions/` (ADR-0002).
- The glossary we have lives in the root `AGENTS.md`, which agents cannot edit (C-24). Resolved terms go into the spec or ADR draft, or into the decision queue as a proposed glossary line for Krzysztof.

**What adoption would need.** No new skill: use `grilling` (section 2.1). Optionally one line in `docs/specs/AGENTS.md` (an `ask` path): "Resolve open questions with the `grilling` skill before drafting; record answers in the spec, not in a glossary file."

---

## 2. Per-skill evaluation

### 2.1 `grilling` — adopt

- **Does** [S4]: interviews "relentlessly until you reach a shared understanding"; walks a design tree in rounds, asking the whole frontier of unblocked questions at once; numbers questions (Q1, Q2…) with a recommended answer marked ➡️, phrased so "yes" accepts it; facts are looked up (by a sub-agent), decisions go to the user; does not act until the user confirms.
- **Overlap:** matches the decision-queue convention (each decision with options, a recommendation and a reply phrase) and the spec question style of the data model spec (`docs/specs/2026-11-13-lunarhunt-data-model.md`, Q1–Q18; decision log 2026-11-14 "Q all ok").
- **Conflicts:** none found. It writes no files.
- **Change needed:** none mandatory. Optional pointer in `docs/specs/AGENTS.md` (ask path) and in the OVERSEER brief template.

### 2.2 `domain-modeling` — adapt (behaviour), reject (file layout)

- **Does** [S5]: challenges terms against the glossary, sharpens vague terms, tests relationships with edge cases, cross-checks against code; writes `GLOSSARY.md` (or per-context glossaries via `GLOSSARY-MAP.md`) inline; offers an ADR in `docs/adr/` only when all three gates hold ("If any of the three is missing, skip the ADR"). Formats come from sub-files `GLOSSARY-FORMAT.md` and `ADR-FORMAT.md` (not read).
- **Overlap:** our root `AGENTS.md` glossary ("One name per concept") and ADR-0002.
- **Conflicts:** model-invoked on "recording or editing an ADR" [S5]; it would steer a spec-writer drafting an ADR towards `docs/adr/` and its own format instead of MADR 4. Root `GLOSSARY.md` is out of scope (see section 1).
- **Worth keeping:** the three ADR gates are a useful filter; `docs/decisions/` holds 19 ADRs written between 2026-11-03 and 2026-11-14, several of which are policy refinements.
- **Change needed:** parked on 2026-11-18 (see Summary), so the trigger is gone for now. If kept, a project skill or `docs/decisions/README.md` note that ADRs are MADR 4 in `docs/decisions/` and the glossary is in `AGENTS.md`.

### 2.3 `to-spec` — reject

- **Does** [S6]: synthesises the conversation into a spec without re-interviewing and publishes it to the tracker as a single issue (or local files under `.scratch/`) with a `ready-for-agent` label meaning "no further triage needed". Sections mentioned: seams, out of scope, implementation decisions, testing decisions; user-story template. Acceptance-criteria format: not described.
- **Conflicts:**
  - spec is a dated file in `docs/specs/` with EARS criteria and front matter (C-10, ADR-0011, `docs/specs/AGENTS.md`);
  - `ready-for-agent` is not in `.github/labels.yml` (C-09 forbids other labels);
  - only Krzysztof sets `status: ready` (`docs/specs/AGENTS.md`), whereas `ready-for-agent` invites AFK pickup [S6].
- **Worth borrowing:** a short **Seams** subsection and an **Out of scope** list in the spec Plan. "The spec records decisions you already made" [S6] is a good rule for spec-writers.
- **Change needed:** if borrowed, two lines in `docs/specs/AGENTS.md` (Plan: seams, out of scope).

### 2.4 `to-tickets` — adapt (ideas only)

- **Does** [S7]: splits a spec into tracer-bullet tickets ("a narrow but complete path through every layer"), each sized for one fresh context window; orders prefactoring first; quizzes the user on granularity before publishing; uses native blocking links (`gh issue create --blocked-by`, `--parent`); recommends that for each acceptance criterion you "name the observation that would show it false" and confirm it fails at the base commit. Known issues: over-decomposition, horizontal slicing, no auto-dispatch.
- **Overlap:** spec Tasks section and OVERSEER turning tasks into `agent:ready` issues (ADR-0011); declared dependencies via GitHub "blocked by" links (ADR-0016 D2).
- **Conflicts:** none for the ideas; the skill's own label vocabulary comes from `setup-matt-pocock-skills` and would clash with `.github/labels.yml` (C-09) if run.
- **Change needed:** `docs/specs/AGENTS.md` Tasks rules: "each task is a vertical slice with its allowed paths and its blockers"; OVERSEER uses native blocked-by links when creating issues. The falsification test fits C-15 and EARS.

### 2.5 `implement` — adapt (inner loop only)

- **Does** [S8, S9]: user-invoked; reads the ticket, runs `tdd` at agreed seams, typechecks often, runs the full suite once, runs `code-review`, then "commits to the branch you are on. It does not create one, and it does not ask." No PR mode; does not close tickets.
- **Overlap:** the implementer role. Our implementer already switches to `<type>/<issue>-<slug>` first (`docs/operations/herdr.md`).
- **Conflicts:** its `code-review` self-check is not the independent Reviewer (ADR-0016 D6: fresh read-only session, never merged with the implementer's session). Non-trivial tickets can exceed 100k tokens [S9]; Charter effort and escalation rules (C-26) still apply.
- **Change needed:** none in the Covenant. The brief may say "work test-first per the `tdd` skill"; `pnpm check` stays the completion criterion (C-12).

### 2.6 `tdd` — adopt

- **Does** [S10]: red before green, one seam, one test, one minimal implementation per cycle; "Tests live at seams, never against internals"; seams agreed with the user before the first test; anti-patterns: implementation-coupled tests, tautological tests ("Expected values must come from an independent source of truth"), horizontal slicing; refactoring belongs to review.
- **Overlap:** C-15 (failing test first for bugs), C-16 (never weaken tests), `diff_coverage_min: 80` in The Charter.
- **Conflicts:** "agree seams with the user" has no user in a subagent run. Resolve by naming seams in the spec Plan (2.3) or the brief.
- **Change needed:** optional line in `apps/*/AGENTS.md` and `wardens/AGENTS.md` (ask paths) or in the brief template; seams in the spec Plan.

### 2.7 `code-review` — adapt (Reviewer aid, not the gate)

- **Does** [S11]: diffs `git diff <fixed-point>...HEAD`, runs two parallel fresh sub-agents (Standards incl. `CODING_STANDARDS.md`/`CONTRIBUTING.md` and twelve Fowler smells; Spec against the linked issue or spec), each under 400 words; reports side by side; edits nothing.
- **Overlap:** our Reviewer. The Spec axis is close to what our Reviewer does against EARS criteria.
- **Conflicts:**
  - no security axis; it is not Sentinel (C-20, ADR-0016 D6);
  - its output shape is not the `github-writing` round comment (blocking/non-blocking table, round count, D9);
  - it sees only committed changes [S9];
  - it spawns sub-agents from a sub-agent (Reviewer), which our docs do not cover **(unverified whether nested spawning works for our Reviewer subagents)**.
- **Change needed:** if used, the Reviewer brief says "use `code-review` for the Standards/Spec pass, then report in the `github-writing` round shape". `.claude/skills/github-writing` is human-only (C-24), so any shape change there is Krzysztof's.

### 2.8 `pr` — reject

- **Does** [S12]: PR body with Summary (a visual), Evidence (before/after), Merge Danger (door, blast radius); no rules on closing keywords, length or labels.
- **Conflicts:** model-invoked on "Use when writing a PR body", the same trigger as our `github-writing` skill, which mandates `.github/pull_request_template.md`, `Closes #N` (C-09) and one risk box (PR template). Two skills on one trigger make the result non-deterministic. Parked on 2026-11-18 (see Summary).
- **Worth borrowing:** "Evidence: before and after" matches our Tests line; "one-way vs two-way door" could inform the risk line. Krzysztof edits `github-writing` and the template himself (human-only paths).

### 2.9 `diagnosing-bugs` — adopt (split across roles)

- **Does** [S14]: six phases: build a fast deterministic red-capable feedback loop ("the skill" itself; no Phase 2 without it), reproduce and minimise, 3–5 ranked falsifiable hypotheses, instrument with tagged debug logs, regression test before the fix at a correct seam, cleanup. Redacts secrets in shown output.
- **Overlap:** `debugger` role (`read_only: true` in The Charter), C-15, C-18.
- **Conflicts:** phases 4–6 write code; the `debugger` is read-only. Phase 1 may need a test file.
- **Change needed:** brief convention: debugger runs phases 1–3 and hands a hypothesis report to OVERSEER; the implementer runs 4–6 under a `type:bug` issue with the failing test first (C-15).

### 2.10 `research` — adopt

- **Does** [S15]: background run with a clean context; primary sources; one Markdown file with cited claims, where the repo keeps similar notes.
- **Overlap:** `docs/research/` (this file). Fits native subagents.
- **Conflicts:** none in scope `docs/**`. Reading outside the worktree is blocked by the Wardens engine (observed in this run).
- **Change needed:** none. Optionally a `docs/research/` naming note (`NNNN-<slug>.md`, front-matter table).

### 2.11 `prototype` — adapt

- **Does** [S16]: throwaway code to answer one question; logic branch (single HTML file) or UI branch (variants on one route behind a URL parameter); in-memory state or a scratch DB; no tests or polish; kept on "a throwaway branch, out of main" with a pointer on the implementation issue.
- **Conflicts:** C-09 (issue first, branch naming) and C-11 (one PR) are satisfied only if the prototype has its own `type:spike` issue (`.github/ISSUE_TEMPLATE/spike.yml`, label `type:spike`) and its branch is never opened as a PR to `main`. "No tests" is fine only off `main` (C-16 applies to PRs).
- **Change needed:** a short rule in `docs/specs/AGENTS.md` or the spike issue form: prototypes live on `spike/<issue>-<slug>`, are never merged, and their verdict is recorded on the issue.

### 2.12 `codebase-design` — adopt (vocabulary)

- **Does** [S17]: shared terms (module, interface, implementation, adapter, depth, seam, leverage, locality), the deletion test, "One adapter means a hypothetical seam. Two adapters means a real one", testability guidance; sub-files for deepening and "design it twice".
- **Conflicts:** none; it writes nothing. Its terms do not collide with our glossary terms.
- **Change needed:** none. Spec-writers may cite it in Plan sections.

### 2.13 `wizard` — adapt

- **Does** [S18]: generates a bash wizard from `template.sh` for steps only a human can perform; hidden secret input (`ask_secret`), `write_env` into `.env`, `set_secret`/`set_var` via `gh`, `confirm` before irreversible steps; the agent checks it with `bash -n` and `shellcheck` but "Don't run it end-to-end yourself"; ephemeral by default, saved to a scratch or `scripts/` path.
- **Overlap:** human hand-off instructions (numbered steps for Krzysztof), e.g. ruleset and GitHub App setup (#82), `wardens sync`.
- **Conflicts:** a root `scripts/` is outside `allowed_paths`; the wizard must live in a scratch location or under `docs/` or `wardens/`. Agents must not read the `.env` it writes (C-18). Production steps stay human (C-07).
- **Change needed:** none in the Covenant; a convention in the OVERSEER hand-off practice.

### 2.14 `writing-for-agents` — adopt (reference)

- **Does** [S19]: pointer wording decides when material is reached; progressive disclosure; steps end on a completion criterion; positive phrasing; one meaning in one place; prune no-ops and "sediment".
- **Overlap:** `AGENTS.md` "Per-package AGENTS.md" rules (local rules only, no repetition), ADR-0006.
- **Conflicts:** none; the target files are `ask` or human-only, so the human approves every edit.
- **Change needed:** none.

### 2.15 `implement-spec`, `wayfinder`, `retro` (orchestration and upkeep)

- **`implement-spec` — reject.** See section 3.
- **`wayfinder` — defer.** Plans very large efforts as a `wayfinder:map` issue with labelled decision tickets (HITL or AFK), resolved one ticket per session [S20]. Its labels are outside `.github/labels.yml` (C-09). Its own known issues include agents writing production code during planning and "waterfall drift" on a 27-ticket map [S20]. Our spec-plus-ADR flow covers the current scale.
- **`retro` — adapt later.** Suggests environment improvements after a session; "Mechanical violations should get deterministic checks" [S3]. This matches C-01. Useful once The Ledger's report exists (ADR-0010; Ledger v0 is being built); outputs should be proposals in issues, since Covenant files are `ask` or human-only.

---

## 3. Orchestrator in a new tab vs native-subagent OVERSEER

**Note on the term.** No primary source found says "new tab". The closest documented design is `/implement-spec`: "one orchestrating session" that you start by clearing context and typing `/implement-spec` with a pointer to the spec [S21]. This section reads "orchestrator in a new tab" as that: a fresh top-level session per spec that runs implementer subagents. How Krzysztof used it in practice could not be read (section 4).

### 3.1 Mechanics

| Aspect | `/implement-spec` orchestrator [S21, S22, S3] | Our OVERSEER (`docs/operations/herdr.md`, ADR-0016, decision log 2026-11-14) |
|---|---|---|
| Orchestrator session | Fresh session per spec, cleared context | One long-lived OVERSEER; restart via handoff note at ~40–50% context (`docs/operations/context-handoff.md`) |
| Implementers | Native subagents, background, own worktree and branch | Native subagents, worktree isolation, own branch |
| Parallelism | Whole frontier of unblocked tickets at once | At most 2 (Krzysztof, 2026-11-14) under ADR-0016 D4's 3; overlapping and `serialize_on` tasks serial (D3) |
| Start | User types the command | Krzysztof's explicit go-ahead per task ("start 98") |
| Branch model | One integration branch; implementers merge the integration tip, a **merger subagent** merges finished work | One branch and one PR per issue (C-11); Krzysztof merges to `main` |
| Review | `code-review` once, after all tickets land; one fixer subagent | Independent Reviewer per PR, Sentinel per D6, max 2 rounds (D9) |
| PR | Draft PR only if the tracker closes work via PRs | Every task ends in a PR with `Closes #N` |
| Tracker | Orchestrator resolves tickets | Human merge closes the issue |
| Exploration notes | "in a directory outside the repo" | Briefs and handoffs as issue comments |
| Model per subagent | Not specified | Charter `roles:` model and effort (C-26) |
| Permissions | Not specified | `default` mode for every role; no bypass (decision log 2026-11-10) |

### 3.2 Context and token cost

- A fresh orchestrator per spec starts small; pointers ("context pointers to the spec, tickets, research notes, and previous commits") keep subagent prompts small [S22]. Our OVERSEER uses the same pointer pattern (one-line prompt pointing to a brief comment, `herdr.md`).
- Our long-lived OVERSEER accumulates context and pays for it on every turn; the mitigation is the handoff restart.
- Cost signals in the sources: non-trivial `implement` tickets can exceed 100k tokens [S9]; one user reported a five-ticket `implement-spec` review-and-fix loop of about four hours [S21]. No per-run token figures were found **(unverified)**.
- Frontier-wide parallelism draws the shared subscription faster; ADR-0017 D6 treats quota as a planning input.

### 3.3 Enforcement under Wardens

- Ring 0 applies to both models alike, because both run in Claude Code (ADR-0017 D1) and hooks fire for subagent tool calls. Observed in this run: as a subagent, a `Read` outside the worktree was refused with `Blocked by Warden engine: path escapes the worktree`.
- Consequences for `implement-spec` as written:
  - exploration notes "outside the repo" [S22] work only in a directory on the Charter's `paths.external` allowlist (the session scratchpad under `/tmp/claude-*/*lunarhunt*/` qualifies); any other directory is blocked for subagents. This is a placement rule, not a reason to reject;
  - the issue's allowed paths are not enforced in subagent worktrees in either model (no `.panopticon/task.json`, ADR-0016 D2, `herdr.md`);
  - "silent test skips" in worktrees that lack gitignored fixtures, local databases or credentials [S21] apply to our subagent worktrees too, until the `WorktreeCreate` hook (#51) provisions `.env` from `.env.example` and the per-task database (ADR-0012).
- Ring 2 (`panopticon/gate`, C-05) and human merge (ADR-0008) would catch an integration-branch PR, but it would exceed `max_pr_changed_lines: 600` (The Charter) for any non-trivial spec.

### 3.4 Review gate

- End-only review over one large branch conflicts with ADR-0016 D6 (Reviewer on every PR, Sentinel per scope) and D9 (two bounded rounds). The source itself notes that a mid-run review misreads unbuilt tickets and that the review/fix loop "does not say when to stop" [S21].
- A merger subagent landing work is an agent merging; on `main` that would breach the human-merge rule for phases 0–2 (C-25, ADR-0008). On an integration branch it is allowed by the letter but moves all human review to one late, large PR.

### 3.5 Gains and losses

**Gains from switching:** throughput when tickets are truly independent; a clean orchestrator context per spec; less OVERSEER bookkeeping.

**Losses:**
- the per-task PR, review and human merge (C-11, D6, ADR-0008);
- the review economy (D9);
- the 2-subagent cap and `serialize_on` serialization (D3), which prevent the merge collisions the source itself reports (two implementers adding the same string under different names) [S21];
- Charter model routing (C-26), since the skill does not set subagent models.

**History:** before 2026-11-14 implementers ran as separate `hc`/Herdr sessions. They were dropped because a background terminal was invisible to Krzysztof, children inherited the wrong environment (Node version), and every launch needed a pasted command (decision log 2026-11-14). A "new tab" per **orchestrator** does not reintroduce those problems if the implementers stay native subagents. A new tab per **implementer** would.

### 3.6 Recommendation

Keep the native-subagent OVERSEER. Take three low-risk borrowings:
1. **Fresh OVERSEER session per spec**, or at each spec boundary, using the existing handoff note. This captures most of the context saving. It needs no Covenant change.
2. **"Update to the target tip before reporting done"**: the implementer rebases on `origin/main` and re-runs `pnpm check` before handing over (C-12). Brief template only.
3. **Native blocked-by links and an explicit frontier**: OVERSEER starts only frontier tasks that also satisfy D3 overlap rules. This puts ADR-0016 D2 into practice.

Reconsider `implement-spec` only for a narrow case: a set of `risk:low` tickets with disjoint allowed paths, no `serialize_on` hits, each still landing as its own PR. That is a different skill, not this one.

---

## 4. Krzysztof's `workspace-ai-assistant` run

**Not readable.** Every read outside this worktree was refused by the Wardens engine (`Blocked by Warden engine: path escapes the worktree`). Per the task rules, this was not worked around. Nothing can be said about the quality of its task breakdown, specs or implementation. A follow-up could run from a session started in that repository, or Krzysztof could copy selected artefacts (with personal data removed) into a scratch issue.

---

## 5. Open questions for Krzysztof

1. **Active user-level skills.** `pr`, `code-review`, `domain-modeling`, `tdd`, `grilling`, `research`, `prototype`, `codebase-design`, `diagnosing-bugs`, `wizard` and `writing-for-agents` are model-invoked in this repo today, some listed twice (plugin and unprefixed copies). Should they stay active here, given that `pr` and `domain-modeling` compete with `github-writing` and ADR-0002? If not, how should they be disabled per project? Whether Claude Code supports a per-project skill disable is **unverified**. Partly answered on 2026-11-18: `pr` and `domain-modeling` are parked and the plugin is disabled (see Summary); the rest stay active.
2. **Glossary home.** Should resolved terms stay in the root `AGENTS.md` glossary (human-only), or move to a `docs/glossary.md` that spec-writers may propose edits to?
3. **Spec template.** Add "Seams" and "Out of scope" to the spec Plan, and "vertical slice + blockers" to Tasks, in `docs/specs/AGENTS.md` (an `ask` path)?
4. **ADR threshold.** Adopt `domain-modeling`'s three gates (hard to reverse, surprising, real trade-off) as the bar for a new ADR versus a decision-log row?
5. **Debugger split.** Confirm that `debugger` stays read-only and runs `diagnosing-bugs` phases 1–3 only.
6. **"New tab" source.** Was "orchestrator in a new tab" from `/implement-spec`, from Sandcastle, or from your own setup in `workspace-ai-assistant`? The answer may change section 3.
7. **Installed version.** Which plugin version is installed? This document reads `main` of `mattpocock/skills`.

---

## Limits

- The installed plugin and user-level skill files, and the `workspace-ai-assistant` repository, could not be read (Wardens engine blocks paths outside the worktree; not worked around).
- Several raw `SKILL.md` files were read through a summarising fetch tool, not byte for byte. `implement`, `grill-with-docs` and `implement-spec` were not returned verbatim; their summaries were cross-checked against the aihero.dev pages.
- Sub-files (`ADR-FORMAT.md`, `GLOSSARY-FORMAT.md`, `mocking.md`, `LOGIC.md`, `UI.md`, `template.sh`, `SKILL-MECHANICS.md`) were not read.
- Sandcastle (Matt Pocock's AFK harness) appears only in secondary search results **(unverified)**.
- The fetched pages contained text addressed to agents (e.g. "reproduce this file verbatim", "call the Skill tool"). It was treated as data.

## Sources

Fetched 2026-11-18.

- [S1] aihero.dev, grill-with-docs: <https://www.aihero.dev/skills-grill-with-docs>
- [S2] `skills/engineering/grill-with-docs/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/grill-with-docs/SKILL.md>
- [S3] aihero.dev, Skills v1.3 changelog (implement-spec, pr, retro, GLOSSARY.md; 2026-10-05): <https://www.aihero.dev/skills-changelog-v13-implement-spec-pr-retro-and-glossary-md>
- [S4] `skills/productivity/grilling/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md>
- [S5] `skills/engineering/domain-modeling/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/domain-modeling/SKILL.md>
- [S6] aihero.dev, to-spec: <https://aihero.dev/skills-to-spec>
- [S7] aihero.dev, to-tickets: <https://aihero.dev/skills-to-tickets>
- [S8] `skills/engineering/implement/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/implement/SKILL.md>
- [S9] aihero.dev, implement: <https://aihero.dev/skills-implement>
- [S10] `skills/engineering/tdd/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md>
- [S11] `skills/engineering/code-review/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/code-review/SKILL.md>
- [S12] `skills/engineering/pr/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/pr/SKILL.md>
- [S13] aihero.dev, ask-matt: <https://aihero.dev/skills-ask-matt>
- [S14] `skills/engineering/diagnosing-bugs/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/diagnosing-bugs/SKILL.md>
- [S15] `skills/engineering/research/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/research/SKILL.md>
- [S16] `skills/engineering/prototype/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/prototype/SKILL.md>
- [S17] `skills/engineering/codebase-design/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/codebase-design/SKILL.md>
- [S18] `skills/engineering/wizard/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/wizard/SKILL.md>
- [S19] `skills/productivity/writing-for-agents/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/writing-for-agents/SKILL.md>
- [S20] aihero.dev, wayfinder: <https://aihero.dev/skills-wayfinder>
- [S21] aihero.dev, implement-spec: <https://aihero.dev/skills-implement-spec>
- [S22] `skills/engineering/implement-spec/SKILL.md`: <https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/implement-spec/SKILL.md>
- [S23] Repository and skill index: <https://github.com/mattpocock/skills>

Internal: `AGENTS.md`; `docs/constitution.md`; `docs/specs/AGENTS.md`; ADR-0002, 0004, 0008, 0009, 0011, 0012, 0016, 0017, 0018, 0019, 0020; `docs/decision-log.md` (2026-11-10, 2026-11-14 rows); `panopticon.charter.yaml` (read only); `.github/labels.yml`; `.claude/skills/github-writing/SKILL.md`; `docs/operations/herdr.md`; `docs/operations/context-handoff.md`.
