---
status: draft
issue: 82
adrs: ["0001", "0008", "0010", "0012"]
---

# Agent GitHub App identity: pushes and PRs as `lunarhunt-agent[bot]`

## Goal and context

Issue: [#82](https://github.com/LUNARITYai/lunarhunt/issues/82).

Problem, as of 2026-11-07:
- All agent pushes, PRs, comments and labels go out under `koszczapinski`.
- GitHub: "Pull request authors cannot approve their own pull requests" ([S5]). So the `main` ruleset can require an approval only if Krzysztof merges through the admin bypass.
- The bypass (`RepositoryRole` admin, mode `pull_request`) is not usable from GitHub Mobile. Merging therefore needs a computer.
- Interim `main` ruleset (#37): `required_approving_review_count: 0`, `require_code_owner_review: false`, required checks `check`, `contract`, `charter-drift`, `wardens-test`.

Goal:
- A dedicated GitHub App pushes agent branches and opens agent PRs.
- Krzysztof becomes a real reviewer and code owner on every agent PR.
- The ruleset goes back to one code-owner approval.

Relation to other work:
- Sandbox spec on PR #70 (`2026-11-06-wardens-sandbox.md`), Decision 8: option C is decided (no GitHub credential inside the sandbox). This spec is option D, the follow-up that decision names. It keeps C intact: the token never enters the sandbox.
- [#64](https://github.com/LUNARITYai/lunarhunt/issues/64) `wardens overseer`: its fixed, shell-free operations are where the App-backed writes live.
- [ADR-0008](../decisions/0008-autonomy-phases-and-risk-based-merge-policy.md) puts the App in phase 2 and Krzysztof's account in phases 0–1. This spec moves the App forward to phase 0 for pushes and PRs, so ADR-0008's "Agent identity" section needs an amending ADR (Task 2). C-27 still holds: the `Agent:` trailer stays.

**Out of scope:**
- the App itself, its key and repository settings (human-only, Rollout);
- cloud and night-shift agents (phase 2), and one App per role;
- phase-3 auto-merge and how it meets the review rule (ADR-0008 follow-up ADR);
- signed or verified commits.

### Sources (checked 2026-11-07)

- [S1] Installation token lifetime 1 hour; optional `repositories` / `permissions` narrowing at mint: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- [S2] App JWT `exp` at most 10 minutes ahead; `iat` 60 s in the past: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- [S3] Ruleset bypass actors include GitHub Apps; modes "Always allow" and "For pull requests only": https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- [S4] Add/remove issue labels, create a label, create an issue comment: "Issues" or "Pull requests" write. Create a PR: "Pull requests" write: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- [S5] "Pull request authors cannot approve their own pull requests": https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews
- [S6] Code owners are requested automatically when a PR opens, not for drafts; notified when a draft is marked ready. Code owners need write access: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- [S7] Events triggered by `GITHUB_TOKEN` create no workflow runs; use an App installation token instead: https://docs.github.com/en/actions/concepts/security/github_token
- [S8] `DELETE /installation/token` revokes the token in use; `PUT /app/installations/{id}/suspended` (JWT) blocks the App's API access: https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token, https://docs.github.com/en/rest/apps/apps#suspend-an-app-installation
- [S9] Private key: "the single most valuable secret"; never hard-coded; up to 25 keys; a new key must exist before the old one is deleted: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
- [S10] Editing `.github/workflows` needs the "Workflows" permission; Apps have no permissions by default: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- [S11] Rulesets: code-owner review rule; "Restrict creations" / "Restrict deletions" apply to actors without bypass: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

**Not verified in primary docs:**
- that GitHub Mobile can approve and merge a PR under a ruleset (the Mobile docs list only "read, review, and collaborate"); Rollout step 6 tests it;
- that deleting a private key invalidates installation tokens already minted. The kill procedure therefore suspends the installation as well;
- the exact bot commit email; it is read from `GET /users/lunarhunt-agent%5Bbot%5D` at setup;
- the author of a squash-merge commit for an App-authored PR; recorded in Rollout step 5.

## Acceptance criteria (EARS)

### The App (human setup, checked by `doctor`)

- THE App SHALL be private, named `lunarhunt-agent` (Decision 1), and installed on `LUNARITYai/lunarhunt` only ("Only select repositories").
- THE App SHALL hold exactly these repository permissions: Contents read/write, Pull requests read/write, Issues read/write (Decision 2), Metadata read.
- THE App SHALL NOT hold Administration, Workflows, Secrets, Variables, Environments, Actions, Deployments, Pages, Webhooks, Checks or Statuses permissions, or any organization or account permission.
- THE App SHALL NOT be a bypass actor on any ruleset, a CODEOWNERS entry, or a collaborator.
- THE App SHALL subscribe to no webhook events, and SHALL have no webhook URL.
- WHEN `wardens doctor` runs with `identity.app` set in The Charter, THE `app-identity` check SHALL fail if any of the above differs. It uses `GET /repos/{owner}/{repo}/installation` for permissions and the ruleset API for `bypass_actors`.

### Private key

- THE private key SHALL live only in the store chosen in Decision 3. It SHALL NOT exist as a file in the repository, any worktree, `~/.config/panopticon/`, `.env`, The Charter or The Ledger.
- THE key store SHALL NOT be readable from a sandboxed Bash command, the Read tool, or MCP tools.
- WHEN R1 shows that a sandboxed Bash can read the key item (for example `security find-generic-password` over Mach IPC rather than the denied `~/Library/Keychains` files), THE key item SHALL require an interactive confirmation for every access (Decision 3, K1).

### Token broker

- THE only code that reads the key or mints tokens SHALL be the broker: the `publish`, `pr comment`, `issue label` and `issue comment` operations of `wardens overseer` (#64), running outside the agent sandbox (Decision 4).
- WHEN the broker runs an operation, THE SYSTEM SHALL:
  - sign a JWT with `iat` = now − 60 s and `exp` ≤ now + 9 min [S2];
  - mint one installation token with `repositories: ["lunarhunt"]` and only the permissions the operation needs [S1]: `publish` → `contents: write, pull_requests: write`; `pr comment` → `pull_requests: write`; `issue label`, `issue comment` → `issues: write`;
  - run the operation;
  - revoke the token with `DELETE /installation/token` in a `finally` block [S8].
- THE broker SHALL keep the token and JWT in process memory only. They SHALL NOT appear in argv, the environment of any child process, stdout, stderr, files, the JSONL log or The Ledger.
- THE broker SHALL make all GitHub API calls in-process (`fetch`), not through `gh` or `curl`.
- WHEN `publish` pushes, THE SYSTEM SHALL run `git push` (Decision 5, P1) with:
  - the remote URL fixed to `https://github.com/LUNARITYai/lunarhunt.git`;
  - `-c credential.helper=` (clears every configured helper), then one helper, `wardens credential-pipe`, that reads the token once from an inherited pipe and closes it;
  - `GIT_TERMINAL_PROMPT=0`, no `GH_TOKEN` / `GITHUB_TOKEN` / `GIT_ASKPASS` / `SSH_AUTH_SOCK` in its environment;
  - exactly one refspec, `<branch>:refs/heads/<branch>`, where `<branch>` is the worktree's task branch and matches `<type>/<issue>-<slug>`.
- THE push SHALL run the `pre-push` hooks as usual (C-21), inside the sandbox profile through `srt`, so agent-written code in `pnpm check` runs sandboxed.
- IF a test `pre-push` hook reads the inherited pipe, THEN it SHALL get end-of-file (test asserts it).
- THE broker SHALL refuse:
  - refspecs for `main`, tags, deletions or force pushes;
  - a worktree whose branch does not match the Charter `worktree.naming.branch`;
  - PR bodies or comments not read from stdin or a `paths.external` file (#64 rule);
  - labels not in `.github/labels.yml` (C-09).
- WHEN `publish` opens a PR, THE PR SHALL be non-draft (code owners are requested only for non-draft PRs [S6]), have base `main`, and carry the body given.
- THE token lifetime SHALL be the duration of one operation. GitHub's ceiling is 1 hour [S1].

### Failure behaviour

- IF the key is unavailable, the confirmation is declined, minting fails, or the network fails, THEN THE broker SHALL exit non-zero with `Blocked by Warden app-identity: <reason>; no App token was available. Stop and report needs:human; do not retry with another credential.`
- THE broker SHALL NOT fall back to `gh auth`, `~/.config/gh`, the macOS git credential helper, SSH keys, `GH_TOKEN`, `GITHUB_TOKEN` or any human credential.
- WHEN the failure prevents the agent from labelling the issue itself, THE agent SHALL stop and state `needs:human` in its final message. The broker records a failure event, and Krzysztof sets the label.
- IF `identity.app` is unset in The Charter, THEN THE broker SHALL refuse every write operation with an `engine` message.

### Commit authorship

- WHEN `wardens worktree new` or `setup` creates a task worktree, THE SYSTEM SHALL set worktree-scoped `user.name = lunarhunt-agent[bot]` and `user.email = <bot id>+lunarhunt-agent[bot]@users.noreply.github.com` (`extensions.worktreeConfig`, `git config --worktree`). The values come from The Charter `identity.app.commit_email` (Decision 9).
- THE primary checkout's identity SHALL stay Krzysztof's. His commits SHALL carry no `Agent:` trailer.
- THE `agent-trailer` Warden SHALL keep requiring `Agent: <tool> (<model>)` on every agent commit.
- WHEN CI runs `agent-trailer`, it SHALL fail a commit that has the bot author and no `Agent:` trailer, and warn on a commit that has a human author and an `Agent:` trailer.

### Ruleset end state (human, checked by `ruleset-audit`)

- THE `main` ruleset SHALL have, in its `pull_request` rule: `required_approving_review_count: 1`, `require_code_owner_review: true`, `dismiss_stale_reviews_on_push: true`, `required_review_thread_resolution: true`, `allowed_merge_methods: ["squash"]`, `require_last_push_approval: false` (Decision 8).
- THE `main` ruleset SHALL require the status checks `check`, `contract`, `charter-drift`, `wardens-test`, and keep `deletion`, `non_fast_forward` and `required_linear_history`.
- THE `bypass_actors` SHALL be exactly what Decision 6 settles, and SHALL NOT contain an `Integration` actor [S3].
- WHEN an App-authored PR is opened, GitHub SHALL request a review from `@koszczapinski` (CODEOWNERS `*`) [S6].
- WHEN Krzysztof approves an App-authored PR and all four checks are green, he SHALL be able to squash-merge it from GitHub Mobile without the bypass (Rollout step 6).

### Sandbox, `command-guard` and The Ledger

- WHILE `sandbox.enabled` is true, THE sandbox `deny_read` minimum and the "no credential in `env`" rule of the sandbox spec SHALL stay unchanged.
- THE Charter `commands.deny` SHALL gain (Krzysztof, Task 4): `security *`, `gh auth token*`, `gh auth login*`, `gh auth refresh*`, `gh api * -X *`, `gh api * --method*`, `gh api * -f *`, `gh api * -F *`, `gh api * --field*`, `gh api * --raw-field*`, `gh api * --input*`, `gh pr merge*`, `curl * -H *uthorization*`, `curl * --header *uthorization*`. This overlaps #61 and sandbox Decision 5. These are a deny-side belt; the floor is that no token exists inside the sandbox.
- WHEN the broker mints, uses, revokes or fails, THE SYSTEM SHALL record one event each: `identity_token_minted`, `identity_operation`, `identity_token_revoked`, `identity_failure`. The fields are: operation, issue, branch, PR number, pushed SHA, granted permissions, `expires_at`, installation id and result. Never the token, the JWT or the key. Until ADR-0010 lands, the events go to `.panopticon/wardens.log.jsonl` (core spec).
- THE Ledger SHALL flag an App-authored PR merged through a bypass, and a push to a task branch by any actor other than the App (`ruleset-audit`, later).

### Revocation and kill switch

- WHEN `autonomy.kill_switch` is true, THE broker SHALL refuse every operation.
- THE kill procedure (documented in the ADR, Task 2) SHALL be: suspend the installation [S8], set `kill_switch`, then rotate the key: create the new key first, then delete the old one [S9].
- WHEN a token may have leaked, THE procedure SHALL suspend the installation; waiting out the 1-hour expiry is not enough.

## Plan

### Settled points

- **Why an App rather than a machine user or PAT:** short-lived, narrowable tokens [S1]; no seat; no password or 2FA to hold; suspension in one call [S8]. ADR-0008 option C, brought forward.
- **Permissions:**
  - Contents write is needed for the push; Pull requests write for creating and commenting on PRs [S4].
  - Issues write is needed for issue labels and comments; for PRs, Pull requests write already covers labels [S4].
  - No Workflows: a push that edits `.github/workflows/**` fails [S10], which backs up C-24 in ring 3.
  - No Administration: the App cannot change rulesets or settings.
- **Residual powers of a leaked token** (≤ 1 h, until suspension): push or delete non-`main` branches, create tags and releases, create labels, edit issue and PR bodies, merge an already-approved PR. Mitigations: per-operation narrowing and revocation; Decision 7 (tag ruleset); the Ledger flags.
- **Workflows run on App PRs:** pushes and PRs made with an installation token trigger workflows, unlike `GITHUB_TOKEN` [S7]. The PR comes from a branch in the same repository, not a fork, so no fork approval applies.
- **Krzysztof's own PRs:** with one required approval, a PR he authors cannot be approved by him [S5]. It merges through the admin bypass on the web (Decision 6).
- **Renovate PRs** (ADR-0014) are authored by the Renovate App; Krzysztof approves them like agent PRs.
- **`gh` reads:** `gh pr view`, `gh pr checks` and `git fetch` keep working unauthenticated inside the sandbox (public repository, sandbox spec).

### Charter (Krzysztof)

```yaml
identity:
  app:
    slug: lunarhunt-agent
    app_id: <number>
    installation_id: <number>
    commit_email: "<bot id>+lunarhunt-agent[bot]@users.noreply.github.com"
    key_store: keychain        # Decision 3
    keychain_service: panopticon.lunarhunt-agent
```

- No secret in it. The engine schema accepts an optional `identity:` section; when it is absent, the broker refuses and `doctor` skips `app-identity`.

### Engine and CLI changes (`wardens/**`)

- `wardens/src/identity/`: JWT signing (`node:crypto`, RS256, no new dependency), mint, narrow, revoke, Keychain read through `security` with argv (`execFileSync`). The `security` call is made only by the broker; agents are denied it (`commands.deny`).
- `wardens credential-pipe`: a git credential helper that answers `get` from fd 3 once and ignores `store` / `erase`.
- `wardens overseer publish|pr comment|issue label|issue comment`: shares #64's argument validation and adds the token path.
- `doctor app-identity`; `agent-trailer` CI author check; worktree identity config in `wardens worktree new|setup`.
- Tests: no token in argv, env, stdout, stderr or log (spawn spies); revoke on every exit path; refusal table; the `pre-push` pipe read gets end-of-file; no fallback when the key is missing (with `~/.config/gh` present in a throwaway `HOME`).

### Rollout (Krzysztof; nothing unmergeable in between)

1. This spec `ready`; ADR (Task 2) accepted.
2. Create the App on `LUNARITYai` with the permissions above and no webhook. Install it on `lunarhunt` only. Generate two keys [S9]: store one per Decision 3, and keep the other offline as a rotation spare. Ruleset unchanged (0 approvals).
3. Merge Tasks 3–5 under the interim ruleset; Krzysztof still pushes those PRs himself.
4. Add `identity:` and the `commands.deny` entries to The Charter; `wardens sync`; `wardens doctor` green.
5. Trial: one docs PR through `wardens overseer publish`. Check: author `lunarhunt-agent[bot]`; review requested from `@koszczapinski`; four checks run; Ledger events present. Record the squash-commit author after merge.
6. Mobile trial on that PR, still at 0 approvals: approve and squash-merge from GitHub Mobile. If Mobile cannot merge, stop here and choose between waiting and using the web.
7. Merge or close every open PR authored by `koszczapinski`, or accept that each one needs the web bypass after step 8.
8. Switch the `main` ruleset to the end state, and apply Decision 7's tag ruleset.
9. Covenant (human): `AGENTS.md` workflow step 7 says agents publish through `wardens overseer publish`; ADR-0008's identity section is marked amended.

### Known limitations

- Phase 0–1 with Decision 4 = I1: a human still triggers each publish. The gain is identity and review, not autonomy.
- A Keychain item is readable by any unsandboxed process of the same macOS user once access is confirmed. The sandbox, `commands.deny` and per-access confirmation narrow this; they do not remove it.
- The squash commit on `main` may show Krzysztof as committer; authorship evidence is the PR author, the `Agent:` trailer and The Ledger.

## Tasks

Each task becomes its own issue linked to #82.

1. **This spec.** Sentinel review; Krzysztof sets `status: ready`. **Allowed paths:** `docs/specs/**`.
2. **ADR: agent GitHub App identity** (amends ADR-0008 "Agent identity" and ADR-0001; kill procedure). `proposed`. `risk:high`. **Allowed paths:** `docs/decisions/**`, `docs/decision-log.md`.
3. **Charter `identity:` schema** (optional section, no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
4. **Broker:** `wardens/src/identity/`, `credential-pipe`, `overseer publish|pr comment|issue label|issue comment`, Ledger events, tests. Depends on 3 and on #64's operation framework. `risk:high`. **Allowed paths:** `wardens/**`. Charter `commands.deny` values: Krzysztof.
5. **Authorship and checks:** worktree identity config, `agent-trailer` CI author check, `doctor app-identity`. Depends on 3. `risk:high`. **Allowed paths:** `wardens/**`.
6. **Covenant update** (`AGENTS.md` step 7). Human-approved. `risk:high`. **Allowed paths:** `AGENTS.md`.

Tasks 4 and 5 can run in parallel.

## Probes

- **R1:** inside the Claude Code sandbox profile of the sandbox spec, does `security find-generic-password -s panopticon.lunarhunt-agent` succeed? It decides whether K1's confirmation is mandatory or a second layer.
- **R2:** under `srt`, does `git push` with `credential-pipe` on fd 3 authenticate, and does a `pre-push` hook that reads fd 3 get end-of-file?
- **R3:** GitHub Mobile approve and squash-merge under a ruleset (Rollout step 6).

## Decisions (Krzysztof)

1. **App owner and name.**
   - A: a private App owned by the `LUNARITYai` organization, named `lunarhunt-agent`.
   - B: owned by Krzysztof's personal account.
   - **Recommendation: A.** The repository is org-owned, and the App outlives a personal account.
2. **Issues permission.** The sandbox spec's D sketch said "no issues, labels". #82 says issues read/write.
   - A: Issues write, narrowed per operation.
   - B: none. Agents cannot label `agent:in-progress` / `needs:human` or comment on issues; Krzysztof does it.
   - **Recommendation: A.** Escalation is an agent duty (C-31). Body edits stay blocked by the fixed operations and `commands.deny`. A leaked token's issue powers last ≤ 1 h.
3. **Private key store.**
   - K1: login Keychain item with no trusted apps, so every access asks for confirmation.
   - K2: Keychain item trusted for a code-signed broker binary only. Needs a compiled helper; `node` itself cannot be the trusted app.
   - K3: off-machine token vending (phase 2, cloud).
   - **Recommendation: K1 for phases 0–1.** One click per publish, and never "Always Allow". K3 with phase 2.
4. **How the broker runs outside the sandbox.**
   - I1: Krzysztof runs `wardens overseer publish <worktree>` in his own terminal.
   - I2: a per-user launchd broker on a Unix socket; the sandboxed `wardens overseer` client sends a fixed request (needs `allowUnixSockets` and sandbox R6).
   - I3: sandbox `excludedCommands` for `wardens overseer *`. This reopens prefix matching on a shell string, the problem #64 removes.
   - **Recommendation: I1 now, I2 as a follow-up after #64 and R6.** Reject I3.
5. **Push transport.**
   - P1: `git push` with `credential-pipe`, hooks sandboxed through `srt`.
   - P2: push through the REST git data API: no hooks run, SHAs are rewritten, and commits are GitHub-verified.
   - P3: an unsandboxed `git push` with the token in the environment.
   - **Recommendation: P1.** Hooks still run (C-21), and the token is never in env or argv. Reject P3.
6. **Admin bypass in the end state.**
   - A: keep `RepositoryRole` admin, mode `pull_request`, for Krzysztof's own PRs and emergencies (web only); the Ledger flags bypass merges of App PRs.
   - B: remove every bypass. Krzysztof's own PRs then cannot merge (one approver).
   - **Recommendation: A.**
7. **Blast-radius rulesets for a leaked token.**
   - A: add a tag ruleset (`refs/tags/**`: restrict creation, update and deletion; admin bypass) [S11].
   - B: A, plus restricted deletion of `refs/heads/**` except the App's own task branches.
   - C: none.
   - **Recommendation: A now.** B only if branch deletion shows up in The Ledger.
8. **`require_last_push_approval`.**
   - false: `dismiss_stale_reviews_on_push` already voids an approval on every new push.
   - true: also blocks Krzysztof from approving after he pushes a fix-up to an agent PR.
   - **Recommendation: false.**
9. **Commit author in task worktrees.**
   - A: the bot identity (worktree-scoped config).
   - B: keep Krzysztof as author; only the PR author is the bot.
   - **Recommendation: A.** History separates agent work from human work (#82 problem statement). The `Agent:` trailer stays as the model record.
