---
status: draft
issue: "#38"
adrs: ["0003", "0004", "0005", "0010", "0012", "0013"]
---

# Wardens worktree: `worktree-guard` and `wardens worktree`

## Goal and context

Issue [#38](https://github.com/LUNARITYai/lunarhunt/issues/38) implements the [ADR-0012](../decisions/0012-task-isolation-with-git-worktrees.md) follow-up. It is the last phase-0 piece before several agents can work on LunarHunt in parallel.

Today (2026-11-05), the ring-0 Wardens are live ([spec](2026-11-04-wardens-sync.md)), but:

- Nothing stops an agent from editing the primary checkout or committing on `main`. ADR-0012's `worktree-guard` does not exist.
- Task worktrees are created by hand (`git worktree add`) or by Claude Code subagent isolation (`agent-<id>` on `worktree-agent-<id>`). Nobody writes `.panopticon/task.json`, so `scope-guard` falls back to the Charter `allowed_paths` for every task. In #20 Krzysztof wrote `task.json` by hand.
- A fresh worktree has no `.env`, task database or port allocation, so parallel app work on `apps/**` would collide.

This spec takes the phase-0 subset of ADR-0012, splits it into tasks and closes the points ADR-0012 left open.

**Out of scope:**
- nightly Cells and per-Cell compose stacks (phase 2);
- Ledger events (`worktree_created` and others are logged to the JSONL only until ADR-0010 lands);
- `pr-check`;
- the Charter `worktree.cleanup` scheduler (a human runs `prune`);
- sub-worktrees (`<issue>-<slug>--<suffix>`).

## Acceptance criteria (EARS)

### Charter `worktree:` section

- THE Charter schema SHALL accept an optional top-level `worktree:` section with the keys from ADR-0012 used here:
  - `required_for_agents`, `protected_branches`, `base_ref`, `naming` (`worktree`, `branch`, `slug_max_length`), `location.default`;
  - `setup.steps`, `setup.env_template`, `setup.copy_from_primary` (max 0 items);
  - `resources` (`database`, `ports`);
  - `primary_read_only_commands`, `cleanup.stale_after_days`.
- WHEN the section is absent, THE SYSTEM SHALL behave exactly as today: `worktree-guard` off, and `wardens worktree` refuses with an `engine` message naming the missing section.
- IF `setup.copy_from_primary` is not empty, THEN Charter validation SHALL fail.

### `worktree-guard` (ring 0)

The hook's `cwd` is classified as:

- **primary checkout:** `git rev-parse --path-format=absolute --git-dir` equals `--git-common-dir`;
- **linked worktree:** the two differ;
- **detached:** `git branch --show-current` is empty.

Criteria:

- WHEN `worktree.required_for_agents` is true and an agent `edit`, `write` or `delete` targets a path inside the repository while the cwd is the primary checkout, a protected branch (`worktree.protected_branches`) or a detached `HEAD`, THE SYSTEM SHALL deny it with a `worktree-guard` message in C-30 format that names `wardens worktree new <issue>`.
- WHEN the same conditions hold for an agent `shell` command, THE SYSTEM SHALL deny it unless the command matches `worktree.primary_read_only_commands`, which uses the same glob semantics as `commands.allow`.
- WHEN an agent edit from inside a linked worktree targets a path in the primary checkout or in another worktree, THE SYSTEM SHALL deny it with `worktree-guard`. Path rules stay relative to the cwd's worktree root, as today.
- WHEN the target is an allowed `paths.external` path (#28), THE SYSTEM SHALL NOT apply `worktree-guard` to it. Memory and scratchpad writes stay possible from a read-only cwd.
- WHEN the cwd is a linked worktree on a non-protected branch, THE SYSTEM SHALL NOT apply `worktree-guard`. A branch name that does not match the worktree name is allowed in phase 0, because Claude Code subagent worktrees start on `worktree-agent-<id>` and the agent switches branches itself.
- `worktree-guard` SHALL run before `scope-guard` and SHALL win when both object.
- Humans are not affected, because ring 0 runs only in agent hooks.

### `wardens worktree` CLI (humans)

- WHEN a human runs `wardens worktree new <issue> [--slug <slug>]`, THE SYSTEM SHALL:
  1. read the issue with `gh issue view <issue> --json title,labels,body`;
  2. derive `<type>` from the `type:*` label (`feature`→`feat`, `bug`→`fix`, `chore`→`chore`, `docs`→`docs`, `spike`→`spike`) and the slug from `--slug`, or else from the title (lowercase kebab-case, at most `slug_max_length`);
  3. run `git fetch origin main` and `git worktree add -b <type>/<issue>-<slug> <location>/<issue>-<slug> <base_ref>`;
  4. run setup (below);
  5. print the worktree path.
- IF the issue has no `type:*` label, or its body has no non-empty `### Allowed paths` section, THEN `new` SHALL create nothing and exit 2 with a message naming the missing field.
- WHEN setup runs (`wardens worktree setup`, also used by `new`), THE SYSTEM SHALL, in the worktree:
  1. write `.panopticon/task.json` with `issue`, `branch`, `slug` and `allowed_paths`, one entry per non-empty line of the issue's `### Allowed paths` section;
  2. run `worktree.setup.steps` in order;
  3. write `.env` from `setup.env_template`, setting only `TASK_ISSUE`, `WEB_PORT = ports.web + issue % 1000`, `API_PORT = ports.api + issue % 1000` and, when `resources.database` is set, `DATABASE_URL` for `lunarhunt_t<issue>`;
  4. write `.panopticon/setup.ok` last.
- A failing step SHALL stop setup without writing `setup.ok`, print the failing step and exit 2.
- Setup SHALL never read or copy any file from the primary checkout except `setup.env_template`. A test seeds a secret in a primary `.env` and asserts that the value never appears in the worktree.
- IF another open task worktree has the same `issue % 1000`, THEN setup SHALL fail with a message naming both worktrees.
- WHEN an agent runs `wardens worktree new`, `setup`, `remove` or `prune` (an agent marker is set; see the sync spec, `agent-trailer`), THE SYSTEM SHALL refuse with `Blocked by Warden worktree-guard: wardens worktree grants task scope and is for humans. Ask Krzysztof to run it.` and exit 2. `wardens worktree list` is allowed for agents.
- WHEN `wardens worktree list` runs, THE SYSTEM SHALL print one line per linked worktree: name, branch, issue, whether `setup.ok` exists, and the PR state from `gh`, if any.
- WHEN `wardens worktree remove <name>` runs, THE SYSTEM SHALL:
  - refuse when the worktree has uncommitted changes or unpushed commits (unless `--force`), or when the caller's cwd is inside that worktree (#32);
  - otherwise run `git worktree remove`, delete the local branch if it is merged into `origin/main`, and, when `resources.database` is set, drop `lunarhunt_t<issue>`.
- WHEN `wardens worktree prune` runs, THE SYSTEM SHALL remove every linked worktree whose PR is merged or closed, with the same refusal rules as `remove`, and list the rest.

### Task database (phase 0, optional)

- WHEN `worktree.resources.database` is set, setup SHALL create `lunarhunt_t<issue>` on the shared Postgres (connection from `setup.env_template`'s `DATABASE_URL`, database replaced) if it does not exist, and run the task branch's migrations.
- IF Postgres is unreachable, THEN setup SHALL fail with `Start the Dev Container services (Postgres) and run wardens worktree setup again.`
- WHEN `resources.database` is not set, setup SHALL skip every database step.

### Tool integration (generated by `wardens sync`)

- THE generated `.claude/settings.json` SHALL add `WorktreeCreate` and `WorktreeRemove` hooks that call the primary bundle's `worktree create --tool claude` and `worktree remove --tool claude` (the same command shape as the other hooks, #27), plus `worktree.baseRef: "fresh"`. The hooks carry an explicit `timeout` (`WorktreeCreate` 900 s, because it runs `setup.steps`; `WorktreeRemove` 120 s) and no `onFailure`, because a non-zero exit of `WorktreeCreate` already fails the spawn.
- WHEN `WorktreeCreate` receives a `name` that matches `<issue>-<slug>`, THE SYSTEM SHALL create the worktree as `new` does. Here the hook, not the agent, grants scope. The scope comes from the human-written issue.
- For any other name (a subagent), it SHALL create `<location>/<name>` from the parent task branch's `HEAD`. It SHALL copy the parent worktree's `.panopticon/task.json`, so a subagent never has wider scope than its parent. If the hook's `cwd` is the primary checkout or `main`, it SHALL fail with a `worktree-guard` message.
- THE generated `.cursor/worktrees.json` SHALL run `wardens worktree setup --tool cursor` as `setup-worktree-unix` and `setup-worktree`. Cursor setup SHALL switch the worktree to the convention branch. **Moved to [#68](https://github.com/LUNARITYai/lunarhunt/issues/68)**: the Cursor setup environment is not recorded yet (the recording run stopped at "Workspace Trust Required"), so #51 covers Claude Code only and `worktree create|remove --tool cursor` refuses.
- The exact `WorktreeCreate` payloads were recorded on 2026-11-06 (Claude Code 2.1.319, macOS). The `WorktreeRemove` payload did not fire in either flow and is **provisional** (see below).

#### Payloads (normative)

THE SYSTEM SHALL parse only the fields it uses, strictly (a wrong type or a missing field is an error), and ignore unknown fields:

| Event | Fields used | Recorded shape |
| --- | --- | --- |
| `WorktreeCreate` | `hook_event_name` (must be `WorktreeCreate`), `cwd` (absolute path of the parent session), `name` | `{"session_id":"…","transcript_path":"…","cwd":"<primary>","hook_event_name":"WorktreeCreate","name":"66-rec-test"}` for `claude --worktree 66-rec-test`; for subagent isolation `cwd` is the parent session's directory (often a linked worktree), `name` is `agent-<hex>` and `prompt_id` is present |
| `WorktreeRemove` | `hook_event_name` (must be `WorktreeRemove`), `cwd`, `worktree_path` | **Provisional**, from the documented schema: the common fields plus `worktree_path`. Fixture `wardens/test/fixtures/worktree-hook/worktree-remove-provisional.json` is not a real recording |

The payload has no base ref, agent type or tool name. The base always comes from the Charter (`worktree.base_ref`) or from the parent worktree. Before merge, Krzysztof records one real `WorktreeRemove` (an interactive `claude --worktree x`, exited with no changes, choosing "remove") and the fixture is replaced.

#### `WorktreeCreate` (normative)

- **Trust anchor.** The payload `cwd` is untrusted: a parent worktree's Charter can be changed by shell writes. THE SYSTEM SHALL derive the primary checkout from the location of the running bundle (`<primary>/wardens/dist/wardens.mjs`; from source, the repository that contains `src/`), never from the payload, the toplevel or `CLAUDE_PROJECT_DIR`. It SHALL refuse (exit 2, C-30 message) a `cwd` whose `git-common-dir` differs from the bundle's, which covers a foreign repository and a nested repository inside a worktree. It SHALL load the Charter from the primary checkout only, so `setup.steps`, `location` and `base_ref` never come from a parent worktree. IF the `location` directory resolves outside the primary checkout (a symlink), THEN it SHALL refuse.
- THE SYSTEM SHALL create every worktree at `<primary>/<location>/<name>` (the Charter `location`). A subagent whose parent runs in a linked worktree therefore never gets a nested worktree.
- **Stdout contract.** On success THE SYSTEM SHALL print exactly one line on stdout: the absolute worktree path. All git, `gh` and setup output goes to stderr. On any failure it SHALL exit non-zero with a C-30 message on stderr and empty stdout.
- **Name rule.** `name` SHALL match `^[a-z0-9][a-z0-9-]{0,63}$`: lowercase letters, digits and `-`, at most 64 characters, no leading `-`, so no `/`, `..` or whitespace. IF the name, the path `<location>/<name>` or the branch already exists, THEN it SHALL refuse. Git and `gh` run as argument vectors, never through a shell.
- **Task names.** WHEN `name` matches `<issue>-<slug>` (`^[1-9][0-9]{0,8}-[a-z0-9][a-z0-9-]*$`), THE SYSTEM SHALL create the worktree as `new` does (issue lookup, `type:*` label, `task.json` from the human-written Allowed paths, `setup`), with the extra rule that the canonical name derived from the issue SHALL equal `name`. The scope comes from the issue, not from the agent. IF the session's own worktree (`cwd`) has a `.panopticon/task.json`, valid or not, THEN the name SHALL be refused unless its issue equals the parent's issue, so a scoped session can never widen its scope through a task name. **Residual risk:** from a primary-checkout, detached or no-`task.json` parent, any open issue can be chosen. The result stays inside the Charter `allowed_paths` envelope and is the same choice a human makes with `claude --worktree 42-x`. A name that starts with `<digits>-` but is not a valid task name (`0-x`, `66-`) SHALL be refused with "names starting with <digits>- are reserved for task worktrees".
- **Subagent names** (any other valid name). The branch is `worktree-<name>` (Claude Code's default naming, allowed by `worktree-guard`). The parent is the `cwd` and the base depends on its kind:
  - **linked worktree on a task branch** (not detached, not protected): the base is the parent's `HEAD`;
  - **primary checkout, or a protected branch such as `main`**: THE SYSTEM SHALL fail with a `worktree-guard` message naming `wardens worktree new <issue>`;
  - **detached `HEAD`** (OVERSEER spawns implementers from a detached worktree): the base is `worktree.base_ref` after `git fetch`. This case SHALL succeed.
  - In both successful cases the parent's narrowing follows: a valid `.panopticon/task.json` is copied, so a subagent never has wider scope than its parent; an invalid one fails closed; none means the Charter `allowed_paths` (the OVERSEER case).
  - The branch is created with `--no-track`.
- Subagent worktrees run no `setup.steps`, write no `.env` and take no ports: they would share the parent's issue number, and the port-collision rule would refuse them.
- **Clean failure.** IF anything fails after `git worktree add` succeeded for this target and branch (setup step, `task.json` copy), THEN THE SYSTEM SHALL remove the worktree, its directory and the branch before it exits, so no half-made worktree or branch is left. Before the add, nothing is removed, so a path or branch that another creator made is never touched.
- **Timeouts.** Each git call (180 s), `gh` call (60 s) and setup step (240 s) is cut off below the 900 s hook timeout; a timeout fails the step and runs the clean failure.

#### `WorktreeRemove` (normative, provisional payload)

- THE SYSTEM SHALL use the same trust anchor as `WorktreeCreate`, and act only on a `worktree_path` that is a linked worktree of the repository and lies under the Charter `location`, and only on a **subagent worktree** (branch `worktree-<name>`, or a name that is not a task name). A task worktree (`<issue>-<slug>`) is kept and left to a human: `wardens worktree remove` or `prune`. Any other path is kept.
- IF the worktree has uncommitted changes, or commits that no remote and no other local branch holds, or git cannot verify either, THEN THE SYSTEM SHALL keep it, write the reason to stderr and to `.panopticon/wardens.log.jsonl`, and exit 0. The message names `git worktree remove <path>` for a kept subagent worktree, because `remove` and `prune` refuse non-task worktrees. A commit that another local branch holds does not count as unpushed, so an unmodified subagent worktree based on an unpushed parent commit is removed. A locked worktree is kept. It never deletes work and never fails loudly (a non-zero exit only matters to Claude Code when the directory is still there).
- Otherwise it removes the worktree (the same `git worktree remove` as `remove`, without `--force`) and deletes the `worktree-<name>` branch when no other ref needs its commits.
- A malformed payload exits 2 and removes nothing. `prune` and `doctor`'s `worktrees` check stay the real cleanup, because the hook did not fire in the recorded runs.

#### Agents cannot invoke the entrypoints (normative)

- The hook runs with `CLAUDECODE` set, so the entrypoints call the library functions directly, not the human-only `new` and `remove` paths that refuse agent markers.
- **Best effort, not the protection.** Text parsing cannot close this class: `node -e`, `python -c`, `xargs`, ANSI-C quoting, `$(cat file)` and script files all get through. Safety comes from the entrypoints granting an agent nothing: the trust anchor, the scope rules (a task.json only narrows; a scoped session cannot ask for another issue) and the `remove` semantics (only clean, pushed subagent worktrees).
- On top of that, the engine SHALL deny in `command-guard`, independent of Charter values, one generic pattern: a shell segment whose executable resolves to the Wardens entrypoint (`wardens`, or a path ending in `wardens.mjs` or `cli.ts`, after the wrappers `env`, `exec`, `node`, `tsx`, `pnpm exec`, `pnpm --filter … exec`, `npx`, `sh -c`, `eval`) and whose arguments hold a dynamic construct (`$`, a backtick, a glob character, a brace expansion), any `--tool` flag, or `worktree create` / `worktree remove`. A segment whose executable word is itself dynamic is denied when it names the entrypoint. `git -c alias.*=!…`, `git config alias.*`, `gh alias set` and `alias` definitions that name the entrypoint are denied too. `wardens worktree list`, `wardens doctor` and the other plain forms pass, and words inside text commands (commit messages, PR bodies, `rg` patterns, `sed` and `awk` scripts) never match.

### `doctor`

- THE `doctor` SHALL add these checks:
  - `worktrees`: warn on worktrees without `setup.ok`, worktrees whose PR is merged or closed, and worktrees with no commit for `stale_after_days`;
  - `task-databases`: when `resources.database` is set, warn on orphan `lunarhunt_t*` databases;
  - `worktree-exclusions`: fail when `.claude/worktrees/` is missing from `.gitignore`, `biome.json`, `tsconfig.base.json` or `pyproject.toml`.
- `--ci` skips `worktrees` and `task-databases`.

## Plan

### Settled points

| Topic | Settlement |
| --- | --- |
| Who grants task scope | `scope-guard` intersects the Charter `allowed_paths` with `task.json`, so task.json can only narrow. Only humans (`wardens worktree new`/`setup`) and the `WorktreeCreate` hook write it, and its content comes from the issue's human-written **Allowed paths**. An agent could still edit an issue body with `gh issue edit --body`, so the Charter gets `commands.deny` entries for `gh issue edit * --body*` and `gh issue edit * -b *` (Decisions, item 2). |
| Detached `HEAD` | Treated like the primary checkout: read-only plus `primary_read_only_commands`. OVERSEER plans from a detached worktree. It needs `gh` and `git fetch` but no repo edits. PR and issue bodies go through quoted heredocs (#40) or `paths.external` files. |
| OVERSEER shell allowlist | `primary_read_only_commands` extends ADR-0012's list with the `gh` commands OVERSEER uses: `gh issue view*`, `gh issue list*`, `gh issue create*`, `gh issue comment*`, `gh issue edit * --add-label*`, `gh issue edit * --remove-label*`, `gh pr view*`, `gh pr list*`, `gh pr checks*`, `gh pr diff*`, `gh pr create*`, `gh pr comment*`, `gh pr edit*`, `gh pr ready*`, `gh label list*`. **Not** `gh pr merge*` (humans merge in phases 0–2) and **not** `gh api*` (it can write anything). |
| Subagent worktrees today | Until the `WorktreeCreate` hook lands (Task 5), subagent worktrees keep Claude Code's naming. `worktree-guard` allows them because they are linked worktrees on non-protected branches. `scope-guard` uses the Charter `allowed_paths`, because there is no `task.json`. |
| Branch / name mismatch | Phase 0 does not block it (see criteria). ADR-0012's third message (`expected feat/42-…`) waits until every creation path goes through `wardens worktree`. |
| Database per task | Optional through `resources.database`. Krzysztof works on macOS, often without the Dev Container's Postgres running. Making the database mandatory would block every docs or Wardens task. |
| Ports | ADR-0012 offsets. The collision check covers only open task worktrees on this machine. |
| Agents running `wardens worktree` | Refused by agent marker, the same mechanism as `wardens sync`. `list` stays open. |

### Engine and CLI changes

- `charter.ts` and `schema/charter.schema.json` get the optional `worktree:` section, strict, with defaults only where ADR-0012 gives them.
- A new rule `worktree-guard` in `rules.ts`, ordered first, with a cwd classifier in `git.ts` (`classifyCwd(cwd) → primary | linked`, branch or detached).
- A new `wardens/src/worktree/` with `new`, `setup`, `list`, `remove`, `prune` and `create` (the hook). `gh` and `git` calls are injected for tests. Tests use temporary repos with linked worktrees and a stub `gh`.
- `sync/render.ts` gains `WorktreeCreate`/`WorktreeRemove`, `worktree.baseRef` and `.cursor/worktrees.json` (Task 5; normative blocks are added to this spec in that task's PR).

### Rollout (Krzysztof)

1. After Task 2 merges: add the `worktree:` section to The Charter (proposed values in Decisions, item 1). Rebuild the primary bundle; the post-pull hook does it (#43).
2. After Task 3 merges: `worktree-guard` is live. Sessions in the primary checkout can read and use the allowlist. Agents work in task worktrees.
3. From Task 4 on, create task worktrees with `wardens worktree new <issue>`; agents get the right `task.json`.
4. After Task 5: run `wardens sync`. Claude Code `--worktree` and subagent isolation go through our hook.

### Known limitations

- `worktree-guard` is ring 0 only. Backstops are the `main` ruleset and the branch convention (later `pr-check`).
- Shell commands that write without a path argument (`git commit` in the primary checkout, for example) are caught only because the whole command is not on the read-only list. The list must stay conservative.
- Port collisions across machines or with non-worktree processes are not detected.

## Tasks

Each task becomes its own issue, linked to #38.

1. **This spec.** Krzysztof sets `status: ready`. **Allowed paths:** `docs/specs/**`.
2. **Charter `worktree:` schema** (engine accepts the optional section; no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`. Then Krzysztof adds the values.
3. **`worktree-guard`** (rule, classifier, tests for every criterion above). `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2 and on the Charter values.
4. **`wardens worktree new|setup|list|remove|prune`** with `task.json`, `.env`, ports, agent refusal, and the optional task database. `risk:high`. **Allowed paths:** `wardens/**`. Depends on 2. Can run in parallel with 3.
5. **Tool integration:** `WorktreeCreate`/`WorktreeRemove` hook, `.cursor/worktrees.json` and `worktree.baseRef`, after recording the real payloads. Generated files via a human `wardens sync`. `risk:high`. **Allowed paths:** `wardens/**`, `docs/specs/**`. Depends on 4.
6. **`doctor` checks** `worktrees`, `task-databases`, `worktree-exclusions`. **Allowed paths:** `wardens/**`. Depends on 4.

Tasks 3 and 4 can run in parallel: different files, both depend only on 2.

## Decisions (Krzysztof)

1. **Charter values.** Proposed:

   ```yaml
   worktree:
     required_for_agents: true
     protected_branches: ["main"]
     base_ref: "origin/main"
     naming: { worktree: "{issue}-{slug}", branch: "{type}/{issue}-{slug}", slug_max_length: 40 }
     location: { default: ".claude/worktrees/{name}" }
     setup:
       steps: ["pnpm install --frozen-lockfile", "uv sync --frozen", "pnpm exec lefthook install"]
       env_template: ".env.example"
       copy_from_primary: []
     resources:
       ports: { web: 30000, api: 31000 }
       # database: "lunarhunt_t{issue}"   # enable once the Dev Container Postgres is the norm
     primary_read_only_commands: [ADR-0012 list, plus the gh commands under Settled points]
     cleanup: { stale_after_days: 7 }
   ```

   `pnpm --filter wardens build` is not a setup step any more: hooks run the primary bundle (#27), and `pnpm check` does not need a worktree bundle.
2. **`commands.deny` additions** against scope widening through issue bodies: `gh issue edit * --body*`, `gh issue edit * -b *`, `gh issue edit * --body-file*`. OVERSEER then cannot fix issue bodies; it comments instead.
3. **Task database.** Off in phase 0 (above), or on now?
4. **Detached `HEAD` as read-only.** Confirm. The alternative is giving OVERSEER its own `overseer/<date>` branch.
