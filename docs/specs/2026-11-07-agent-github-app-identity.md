---
status: draft
issue: 82
adrs: ["0001", "0008", "0010", "0012"]
---

# Agent GitHub App identity: pushes and PRs as `lunarhunt-agent[bot]`

## Goal and context

Issue: [#82](https://github.com/LUNARITYai/lunarhunt/issues/82).

### Problem (2026-11-07)

- All agent pushes, PRs, comments and labels go out under `koszczapinski`.
- GitHub: "Pull request authors cannot approve their own pull requests" [S5]. A required approval can therefore be met only through the admin bypass, and that bypass is not usable from GitHub Mobile.
- Interim `main` ruleset (#37): 0 approvals, no code-owner review, required checks `check`, `contract`, `charter-drift`, `wardens-test`. Today any process that can use Krzysztof's `gh` token can merge a green PR with no approval at all.

### Goal

- A dedicated GitHub App authors agent branches and PRs.
- Krzysztof becomes a real reviewer and code owner.
- The ruleset goes back to one code-owner approval.

### Two stages (Decision 10)

- **Stage 1: attribution and mobile merge.** The App authors agent PRs, and one approval plus code-owner review is restored.
  - Not a security boundary: agents still run as Krzysztof's OS user, so his `gh` keyring token and the osxkeychain git helper stay reachable.
  - Known self-approval path: an agent runs `gh pr review --approve` as `koszczapinski` on the bot's PR and meets the code-owner rule.
  - Stage 1 is still stricter than today. A forged approval needs an explicit review action, where today an agent can merge with no approval.
- **Stage 2: security boundary.** Gated on all of:
  - the sandbox (#69 / PR #70) enforced with `gate: block`;
  - an in-sandbox probe showing Krzysztof's credentials are unreachable (`doctor human-credentials`);
  - the Charter `commands.deny` and allow-list changes below.
  - The ruleset is only as strong as the agent's lack of Krzysztof's credentials.

### Stage 1 threat model

- In Stage 1 the agent runs as Krzysztof's UID without a sandbox. Anything his session can reach, the agent can reach or spoof: Keychain prompts, the broker process, `.git` config, his `gh` token.
- Stage 1 is attribution and mobile merge, **not a security control**. The only gates are Krzysztof refusing an unannounced prompt and reviewing diffs.
- The TTY check, the typed confirmation and "human-only" are conveniences, not enforced against an agent: a pty (`script`, Python `pty`) or another spelling of the CLI defeats them.
- Known residuals, accepted for Stage 1:
  - config or proxy redirect of the push between Phase A and Phase B (`http.proxy` with `sslVerify=false`, `extraHeader`, `insteadOf`, `commondir`, `alternates`);
  - a lookalike Keychain prompt fired by a process left over from Phase A at the announced moment;
  - `wardens identity` reached through other spellings or a pty;
  - self-approval through Krzysztof's `gh` token.
- The Stage 1 key is treated as burnt. The Stage 2 gate generates a fresh key and deletes the Stage 1 key.

### Relation to other work

- **Sandbox spec, PR #70, Decision 8:** option C is decided (no GitHub credential inside the sandbox). This spec is its option D.
  - The token never reaches a process an agent launched.
  - Stage 2 also depends on sandbox Decision 7 / Task 4c, a sandbox runner for unsandboxed DoD code.
- **#64 `wardens overseer`:** not a prerequisite. This spec defines its own human-only CLI, `wardens identity` (Plan), which owns its argument validation and makes in-process `fetch` calls.
  - #64 stays the agent-facing read CLI and keeps `gh` for reads.
  - Agent-triggered writes (I2) need a #64 spec first.
- **ADR-0008** puts the App in phase 2. Stage 1 brings it forward to phase 0, so the "Agent identity" section needs an amending ADR (Task 2). C-27 holds: the `Agent:` trailer stays.
- **Format:** Sources, Probes and Decisions follow Tasks, as in the worktree and sandbox specs.

### Out of scope

- creating the App, its key and repository settings (human-only, Rollout);
- cloud and night-shift agents, one App per role (phase 2);
- phase-3 auto-merge;
- signed commits.

### Sources (checked 2026-11-07)

- [S1] Installation token expires after 1 hour; optional `repositories` / `permissions` narrowing: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- [S2] JWT `exp` ≤ 10 min ahead; `iat` 60 s in the past: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- [S3] Ruleset bypass actors include GitHub Apps; modes "Always allow" / "For pull requests only": https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- [S4] Issue labels and comments: "Issues" or "Pull requests" write; create a PR: "Pull requests" write: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- [S5] "Pull request authors cannot approve their own pull requests": https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews
- [S6] Code owners are requested automatically on a non-draft PR and notified when a draft is marked ready; they need write access: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- [S7] `GITHUB_TOKEN` events create no workflow runs; App installation tokens do: https://docs.github.com/en/actions/concepts/security/github_token
- [S8] `DELETE /installation/token` revokes the token in use; `PUT /app/installations/{id}/suspended` needs a JWT and "blocks the app from accessing the account's resources": https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token, https://docs.github.com/en/rest/apps/apps#suspend-an-app-installation
- [S9] The private key is "the single most valuable secret"; up to 25 keys; a new key must exist before the old one can be deleted: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
- [S10] Editing `.github/workflows` needs the "Workflows" permission; Apps have no permissions by default: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- [S11] Code-owner review rule; "Restrict creations / deletions" apply to actors without bypass: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

### Not verified (each has a probe or trial step)

- U1: approve and squash-merge from GitHub Mobile under a ruleset. The Mobile docs list only "read, review, and collaborate" (R3).
- U2: whether suspension or key deletion invalidates installation tokens already minted. The leak procedure assumes it does not (R4).
- U3: whether an App's approving review counts toward `required_approving_review_count`. `require_code_owner_review` is the control that keeps the bot out.
- U4: what `require_extra_approval_for_unattributed_changes` treats as "unattributed", and whether bot or noreply commits trigger it (Rollout step 6).
- U5: the bot's commit email, read from `GET /users/lunarhunt-agent%5Bbot%5D` at setup.
- U6: the author of the squash commit for an App-authored PR (Rollout step 6).

## Acceptance criteria (EARS)

### The App (human setup, human-checked)

- THE App SHALL be private, owned by `LUNARITYai` (Decision 1), installed on `LUNARITYai/lunarhunt` only, and have no webhook.
- In Stage 1, THE App SHALL hold exactly: Contents read/write, Pull requests read/write, Metadata read (Decision 2).
- THE App SHALL NOT hold Administration, Workflows, Secrets, Variables, Environments, Actions, Deployments, Pages, Webhooks, Checks, Statuses, or any organization or account permission.
- THE App SHALL NOT be a bypass actor on any ruleset, a CODEOWNERS entry or a collaborator.
- The repository Actions setting "Allow GitHub Actions to create and approve pull requests" SHALL be off (`can_approve_pull_request_reviews: false`).
- THE checks above SHALL be run by Krzysztof with `wardens identity check`. Its credentials:
  - the App JWT (one announced key prompt) for the installation;
  - his own `gh` for the ruleset and the Actions setting.
  - It prints only field names and pass or fail, never response bodies or tokens.
  - It is human-run; the no-fallback rule applies to `publish` only.
  - `wardens doctor` stays agent-runnable and never touches the key.

### Private key

- THE key SHALL be stored as a login-Keychain generic-password item, service `panopticon.lunarhunt-agent`, created with `security add-generic-password -s panopticon.lunarhunt-agent -a lunarhunt-agent -T "" -w`.
  - `-T ""`: no trusted app, so every access asks for confirmation.
  - `-w` without a value: the value is typed or pasted at the prompt, never on argv.
  - The value is the base64 of the PEM. The exact import form is the one probe R5 shows to round-trip about 2.2 KB without truncation.
- Krzysztof SHALL never click "Always Allow". He SHALL deny any Keychain prompt that the broker did not announce on its own TTY just before ("Keychain prompt for panopticon.lunarhunt-agent expected now").
- THE key SHALL NOT exist as a file anywhere after import:
  - download the `.pem` into a directory excluded from Time Machine, iCloud and Spotlight;
  - import it;
  - delete it and empty the Trash. APFS gives no overwrite guarantee, so the window is kept short.
- No standing spare key SHALL exist (Revocation).
- R1 SHALL pass before Rollout step 3.
- Phases 1+ target: the key and JWT signing in a different UID (launchd daemon under a dedicated user, I2) or on a sign-only device (K3), as GitHub suggests [S9].

### Broker: `wardens identity` (human-only)

- THE only code that reads the key or mints tokens SHALL be `wardens identity publish` and `wardens identity check`.
- IF stdin or stdout is not a TTY, THEN THE broker SHALL refuse. This is a convenience, not a control (Stage 1 threat model).
- THE Charter `commands.deny` SHALL contain, as a belt only: `security *`, `wardens identity*`, `node *wardens* identity*`, `*wardens.mjs identity*`, `pnpm exec wardens identity*`, `script *`.
- WHEN `publish <worktree>` starts, THE broker SHALL:
  - read The Charter from the trusted primary (`bundlePrimary`, #74), never from the worktree;
  - check that the worktree's `.git` file points into the primary's `.git/worktrees/` list;
  - run the config check below as its first git call;
  - then require a clean tree and a branch that matches `worktree.naming.branch`;
  - record `SHA = HEAD`;
  - read the PR body file once into memory.
- THE broker SHALL run every git command with a clean environment:
  - only `PATH=/usr/bin:/bin:<directory of the git binary>`, `HOME=<empty 0700 temp dir>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `LANG=C`;
  - no `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK` or `GIT_*` besides those.
- **Config check:** IF `git config --show-origin --list` (local and worktree scope) has a dangerous key, THEN THE broker SHALL refuse.
  - The deny list (case-insensitive): `url.*` (including `insteadOf` and `pushInsteadOf`), `http.*`, `credential.*`, `include.*`, `includeIf.*`, `remote.*.pushurl`, `remote.*.proxy`, `remote.*.receivepack`, `remote.*.uploadpack`, `remote.*.vcs`, `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.gitProxy`, `core.askPass`, `core.pager`, `core.editor`, `core.worktree`, `filter.*`, `diff.*.textconv`, `diff.*.command`, `merge.*.driver`, `protocol.*`, `uploadpack.*`, `receive.*`, `gpg.*`, `alias.*`, `sequence.editor`.
  - `remote.origin.url` must equal `https://github.com/LUNARITYai/lunarhunt.git`. Every other key (`branch.*.*`, `gc.*`, `pull.*`, benign `core.*` scalars) passes.
  - A test SHALL run the check against this repository's real config and pass.
- **Phase A (hooks, no token):** THE broker SHALL run exactly the `pre-push` command from the trusted primary's `lefthook.yml` (today `pnpm check`) at `SHA`. These are the hooks `--no-verify` skips in Phase B; the worktree's own `lefthook.yml` is never read.
  - No token exists yet and no extra fd is open.
  - Stage 1: unsandboxed in Krzysztof's terminal. Same exposure as his manual push today; residual.
  - Stage 2: under the sandbox runner of sandbox Decision 7 / Task 4c.
  - IF it fails, THEN THE broker SHALL stop before showing any prompt.
- **Confirmation:** THE broker SHALL print branch, `SHA`, `git diff --stat origin/main...SHA`, the PR title (from the first line of the body file) and the SHA-256 of the body. It SHALL strip C0, C1 and ESC characters from everything it prints. It SHALL require Krzysztof to type the branch name, then announce the Keychain prompt.
- **Phase B (token):** THE broker SHALL:
  - sign a JWT (`iat` = now − 60 s, `exp` ≤ now + 9 min) [S2];
  - mint one token with `repositories: ["lunarhunt"]`, `permissions: {contents: write, pull_requests: write}` [S1];
  - push `git push --no-verify https://github.com/LUNARITYai/lunarhunt.git <SHA>:refs/heads/<branch>`;
  - IF an open PR exists for the branch, THEN push only (update); otherwise create the PR with in-process `fetch` (non-draft [S6], base `main`, the in-memory body). A test covers both cases;
  - revoke the token with `DELETE /installation/token` in a `finally` block [S8].
- `--no-verify` in Phase B is a broker-only exception to C-21/C-22. Phase A already ran the same `pre-push` command on the same `SHA`, and pushing the explicit `SHA` closes the race. The ADR (Task 2) records it. Agents stay denied `--no-verify`.
- THE credential helper (`wardens credential-pipe`, fd 3) SHALL answer only `get` with `protocol=https`, `host=github.com`, `path=LUNARITYai/lunarhunt.git`.
  - The broker sets `-c credential.useHttpPath=true -c credential.helper= -c credential.helper=<helper>`.
  - It returns `username=x-access-token` and the token, reads fd 3 once, and answers any other request with nothing.
  - With hooks off and the config checked, only git, `git-remote-https` and the helper inherit fd 3.
- THE token and JWT SHALL appear in no argv, child environment, stdout, stderr, file or log.
- THE broker SHALL refuse: refspecs for `main`, tags, deletions, force pushes; a `SHA` that is not `HEAD` of the task branch; `kill_switch: true`; an unset `identity:` section.
- **Stage 2 broker requirements** (against an agent that can write the worktree and the shared `.git`):
  - repeat the config check right before the JWT is signed;
  - push from a broker-created bare repository in a 0700 temp dir: broker-owned config, `objects/info/alternates` pointing at the primary's `.git/objects`, `update-ref refs/heads/<branch> <SHA>`. No agent-writable config is read in Phase B;
  - pin `-c http.proxy= -c http.sslVerify=true -c http.sslCAInfo=<system bundle> -c http.extraHeader= -c core.fsmonitor=false`;
  - use absolute `/usr/bin/git`, an explicit `GIT_EXEC_PATH`, and the helper as an absolute `node` path plus the primary's bundle;
  - run Phase A in its own process group, and refuse to prompt while any descendant of it is alive;
  - a Phase A fixture that rewrites the config SHALL cause a refusal.

### Labels and escalation (Decision 2)

- In Stage 1 (I1), THE App SHALL have no Issues permission, and the broker no label or comment operation.
- WHERE I2 is enabled, THE App MAY gain Issues write, used only by an add-only allowlist from the trusted Charter (`identity.labels.add: ["agent:in-progress", "needs:human"]`): issues only, no PR labels, no removals.
- **Deviation from #82's criterion "the agent shall stop and label `needs:human`":** under I1, the agent SHALL stop and state `needs:human` in its final message, and Krzysztof sets the label. Recorded here for Krzysztof's approval.

### Failure behaviour

- IF the key is unavailable, the prompt is declined, minting fails or the network fails, THEN THE broker SHALL exit non-zero with `Blocked by Warden app-identity: <reason>; no App token was available. Stop and report needs:human; do not retry with another credential.`
- `publish` SHALL NOT fall back to `gh auth`, `~/.config/gh`, osxkeychain, SSH, `GH_TOKEN`, `GITHUB_TOKEN` or any human credential. The clean git environment enforces this for git.
- Stage 2: agents SHALL be unable to use any human credential (probe `doctor human-credentials`).

### Commit authorship

- WHEN `wardens worktree new|setup` creates a task worktree, THE SYSTEM SHALL set worktree-scoped `user.name = lunarhunt-agent[bot]` and `user.email` from Charter `identity.app.commit_email` (Decision 9).
- THE primary checkout keeps Krzysztof's identity; his commits carry no `Agent:` trailer.
- THE lefthook `agent-trailer` check SHALL keep requiring `Agent: <tool> (<model>)` on agent commits.
- WHEN the CI `agent-trailer` job (Task 6, human-applied) runs on a PR authored by `lunarhunt-agent[bot]`, it SHALL fail if any commit lacks an `Agent:` trailer.
  - Exemption: a commit whose author and committer are both Krzysztof's GitHub account (the commit's GitHub-resolved `author.login` and `committer.login` = `koszczapinski`, from the API), so his fix-ups never need the bypass.
  - The match uses the GitHub-resolved login, not the free-text name. A spoofed `user.email` still resolves to his account; that is the Stage 1 same-UID residual.
  - The commit author can be overridden (`--author`, `-c user.name`), the PR author cannot.

### Ruleset end state (human; compared in Rollout)

- THE `main` ruleset's `pull_request` rule SHALL be: `required_approving_review_count: 1`, `require_code_owner_review: true`, `dismiss_stale_reviews_on_push: true`, `required_review_thread_resolution: true`, `require_last_push_approval: false` (Decision 8), `require_extra_approval_for_unattributed_changes: true` (unchanged, U4), `required_reviewers: []`, `dismissal_restriction.enabled: false`, `allowed_merge_methods: ["squash"]`.
- THE `main` ruleset SHALL keep `deletion`, `non_fast_forward`, `required_linear_history`, and the required checks `check`, `contract`, `charter-drift`, `wardens-test` (`strict: false`).
- THE `bypass_actors` SHALL be exactly Decision 6, with no `Integration` actor [S3].
- A tag ruleset (`refs/tags/**`: restrict creation, update and deletion; admin bypass mode "always") SHALL exist before any token is minted (Rollout step 2).
- WHEN an App-authored PR is opened, GitHub SHALL request review from `@koszczapinski` [S6].
- WHEN Krzysztof approves it and the four checks are green, he SHALL be able to squash-merge it from GitHub Mobile without the bypass (Rollout step 9).

### Sandbox and `command-guard`

- THE sandbox's minimum `deny_read` and its "no credential in `env`" rule SHALL stay unchanged.
- Stage 2 Charter changes (Krzysztof; a deny-side belt, not the floor):
  - remove `gh pr create*`, `gh pr comment*`, `gh pr edit*`, `gh pr ready*`, `gh issue create*`, `gh issue comment*` and the label edits from `primary_read_only_commands`;
  - add to `commands.deny`: `gh pr review*`, `gh pr merge*`, `gh pr close*`, `gh issue close*`, `gh release*`, `gh workflow*`, `gh repo*`, `gh secret*`, `gh auth token*`, `gh auth login*`, `gh auth refresh*`, `git credential*`, `security *`, `wardens identity*`;
  - `gh api` mutating forms in flag-first and attached spellings: `gh api -X*`, `gh api * -X*`, `gh api --method*`, `gh api * --method*`, `gh api -f*`, `gh api * -f*`, `gh api -F*`, `gh api * -F*`, `gh api --field*`, `gh api * --field*`, `gh api --raw-field*`, `gh api * --raw-field*`, `gh api --input*`, `gh api * --input*`;
  - A `command-guard` table test SHALL cover each spelling, including `gh api -X POST`, `gh api -fbody=x`, `gh api --method=PATCH` and `gh api x -XPOST`. This overlaps #61 and sandbox Decision 5.
  - **No `curl` entries.** Single-token globs cannot match `-H` and its value as separate tokens, nor `-u`, `--oauth2-bearer` or `-K`. This is a known gap; the floor is that no token exists inside the sandbox.
- Stage 2 also needs a replacement for the agent comment and label path that the removals take away (I2 with a #64 spec, or a human-run `wardens identity comment`). It is a Stage 2 gate.
- `gh pr review*`, `git credential*`, `security *` and `wardens identity*` MAY land in Stage 1, since OVERSEER needs none of them.

### The Ledger

- WHEN the broker mints, pushes, creates a PR, revokes or fails, THE SYSTEM SHALL append one event each (`identity_token_minted`, `identity_operation`, `identity_token_revoked`, `identity_failure`). Fields: operation, issue, branch, `SHA`, PR number, permissions, `expires_at`, installation id, result. Never the token, JWT or key.
- THE events SHALL go to `~/.local/state/panopticon/identity.log.jsonl` (0700 dir, outside the sandbox write set, sandbox spec), opened `O_APPEND`, until ADR-0010 lands.
- WHEN Krzysztof runs `wardens identity audit`, THE SYSTEM SHALL compare:
  - GitHub's repository events for actor `lunarhunt-agent[bot]` (public events API, unauthenticated);
  - with the `identity_operation` events.
  - Match key: event type, ref or PR number, head SHA, and a time window of ±10 min around the local event.
  - Every unmatched GitHub event SHALL be reported as a leak alarm. GitHub is the source of truth; in Stage 1 the local log is same-UID writable.
  - It SHALL also list approvals and merges by `koszczapinski` on bot PRs, for Krzysztof to confirm as his own. This is the only signal for the Stage 1 self-approval residual.
  - Cadence: after each publish and at each OVERSEER session start.
  - Gaps, stated: event latency of 30 s to 6 h, 30-day and 300-event limits, no events for reads, PR or issue body edits, review-thread resolution or auto-merge enablement. A recent leak can look clean.

### Revocation and kill switch

- WHEN `autonomy.kill_switch` is true, THE broker SHALL refuse every operation.
- **Kill (no key needed):** suspend the installation in the GitHub web UI (org Settings → GitHub Apps → Configure → Suspend) as org owner; then set `kill_switch`.
- **Key leak:**
  1. Generate a new key in the UI [S9] and discard its download.
  2. Delete the compromised key.
  3. Uninstall the App in the UI. Unsuspend needs only a JWT, so suspension alone is reversible by the key holder.
  4. Later, generate a fresh key, import it, and reinstall.
- **Token leak:** uninstall or suspend in the UI. The 1-hour expiry [S1] is not relied on, and suspension's effect on live tokens is U2.

## Plan

### Settled points

- **App, not machine user or PAT:** short-lived, narrowable tokens [S1], suspension in one step, no seat or 2FA to hold (ADR-0008 option C, brought forward).
- **Permissions:**
  - Contents write is needed for the push; Pull requests write for PR creation [S4].
  - No Workflows: a push touching `.github/workflows/**` fails [S10], which backs up C-24.
  - No Administration.
- **Residual powers of a leaked Stage-1 token** (until uninstall):
  - push to or delete non-`main` branches, including other PRs' branches;
  - create releases;
  - edit PR titles and bodies;
  - resolve review threads (defeats `required_review_thread_resolution`);
  - submit or dismiss reviews: an App approval does not meet the code-owner rule, while dismissal can drop Krzysztof's "request changes";
  - enable auto-merge, close PRs, merge an already-approved PR.
  - Controls: code-owner review, `dismiss_stale_reviews_on_push`, the tag ruleset, a token only in Phase B, revocation, `identity audit`.
- **Workflows run on App PRs** [S7]. The PR comes from a same-repo branch, not a fork.
- **Krzysztof's own PRs** cannot be approved by him [S5]. They merge through the admin bypass on the web (Decision 6).
- **Renovate PRs** (ADR-0014): Krzysztof approves them like agent PRs.
- **Token lifetime:** from Phase B start to `finally`. GitHub's ceiling is 1 h [S1].

### Charter (Krzysztof)

```yaml
identity:
  app:
    slug: lunarhunt-agent
    app_id: <number>
    installation_id: <number>
    commit_email: "<bot id>+lunarhunt-agent[bot]@users.noreply.github.com"
    keychain_service: panopticon.lunarhunt-agent
  labels:
    add: []            # ["agent:in-progress", "needs:human"] only with I2
```

- No secret in it. When the section is absent, the broker refuses.

### Engine (`wardens/**`)

- `wardens/src/identity/`: RS256 JWT (`node:crypto`, no new dependency), mint, revoke, Keychain read via `execFileSync("/usr/bin/security", …)`, clean git env, config allowlist, Phase A/B, Ledger append, `audit`, `check`.
- `wardens credential-pipe`.
- Tests:
  - spawn spies assert no token in argv, env, stdout, stderr or logs;
  - revoke runs on every exit path;
  - a refusal table, with a hostile config case for each refused key;
  - no fallback when `~/.config/gh` exists in a throwaway `HOME`;
  - a fixture hook in Phase A that reads every fd and finds no token;
  - the helper refuses another host or path.

### Rollout (Krzysztof)

1. Spec `ready`. ADR (Task 2) accepted.
2. Create the tag ruleset. Set the Actions setting off.
3. R1 and R5 pass; then create the App (Stage 1 permissions, no webhook) and install it on `lunarhunt` only. Generate one key, import it per "Private key", delete the `.pem`.
4. Merge Tasks 3–5 under the interim ruleset (Krzysztof pushes them himself).
5. Add `identity:` to The Charter; `wardens sync`; `wardens identity check` green. Save the rollback copy as a `PUT`-shaped body: only `name`, `target`, `enforcement`, `conditions`, `rules` and `bypass_actors` from `gh api repos/LUNARITYai/lunarhunt/rulesets/26499211`.
6. Web trial: one docs PR via `wardens identity publish`. Check:
   - bot author and the review request;
   - the four checks;
   - Ledger events and `identity audit` clean;
   - R4;
   - U4 (does an extra approval get requested?);
   - after merge, the squash-commit author (U6).
7. Covenant PR (Task 7, `AGENTS.md` step 7: Krzysztof publishes agent work with `wardens identity publish`; the agent states `needs:human`). Merge it before step 8, while 0 approvals still applies.
8. Merge or close open PRs authored by `koszczapinski`, then switch the `main` ruleset to the end state. Compare the result field by field with the end-state list.
9. Mobile trial (R3) on a trivial bot PR: approve and squash-merge from GitHub Mobile. IF that fails, THEN restore the step-5 copy (0 approvals) with `gh api -X PUT`, and record the result on #82.
10. Krzysztof applies the CI `agent-trailer` job (Task 6) as a non-required check. After one green week, he adds it to the required checks (Decision 11) and to the end-state list.
11. Stage 2 (only after the gates in "Two stages"):
    - generate a fresh key, import it, and delete the Stage 1 key;
    - the Charter changes in "Sandbox and `command-guard`";
    - the `doctor human-credentials` probe green inside the sandbox;
    - the Stage 2 broker requirements;
    - Phase A under the sandbox runner;
    - the comment and label replacement path.

### Known limitations

- Stage 1 gives no security boundary (Two stages). Phase A runs agent code unsandboxed, as Krzysztof's push does today.
- With I1, a human triggers each publish. The gain is identity and review, not autonomy.
- K1 relies on Krzysztof denying prompts the broker did not announce. A same-UID process can raise a lookalike prompt at the announced moment (Stage 1 threat model).
- **Deferred to Stage 2 or later:**
  - killing Phase A leftovers before the prompt (Stage 2 process-group rule);
  - a code-signed Keychain helper (K2);
  - refusing when an ancestor process is an agent launcher;
  - the repository activity API for push audit.
- The local Ledger file is same-UID writable in Stage 1. `identity audit` against GitHub is the check.

## Tasks

Each task becomes its own issue linked to #82.

1. **This spec.** Sentinel review; Krzysztof sets `status: ready`. **Allowed paths:** `docs/specs/**`.
2. **ADR: agent GitHub App identity.** Amends ADR-0008 "Agent identity" and ADR-0001; covers the broker-only `--no-verify` exception and the kill and leak procedures. `proposed`, `risk:high`. **Allowed paths:** `docs/decisions/**`, `docs/decision-log.md`.
3. **Charter `identity:` schema** (optional section, no behaviour change). `risk:high`. **Allowed paths:** `wardens/**`.
4. **Broker:** `wardens identity publish|check|audit`, `credential-pipe`, Ledger file, tests. Depends on 3. `risk:high`. **Allowed paths:** `wardens/**`.
5. **Worktree identity config and lefthook check:** `wardens worktree new|setup` writes the bot identity. Depends on 3. `risk:high`. **Allowed paths:** `wardens/**`.
6. **CI `agent-trailer` job** keyed on PR author (Decision 11 on required or not). Krzysztof applies the workflow; an agent may draft the Warden side in `wardens/**`. `risk:high`. **Allowed paths:** `wardens/**`; `.github/workflows/**` human-only.
7. **Covenant update** (`AGENTS.md` step 7), before Rollout step 8. `risk:high`. **Allowed paths:** `AGENTS.md`.
8. **Stage 2:** the `doctor human-credentials` probe and the `command-guard` table tests in `wardens/**`; Charter values by Krzysztof. Depends on #69 enforced with `gate: block` and on sandbox Task 4c. `risk:high`. **Allowed paths:** `wardens/**`.

Tasks 4 and 5 can run in parallel.

## Probes

- **R1** (precondition of Rollout step 3): with a **dummy item** of service `panopticon.lunarhunt-agent`, in a plain agent Bash (Stage 1) and, once #70 lands, inside the sandbox profile, try to obtain the value or a token:
  - `security find-generic-password -s panopticon.lunarhunt-agent -w` (expect a prompt or a failure, never a value);
  - while `publish` runs: `ps eww`, `lldb -p`, `sample` and `vmmap` against the broker pid (expect a refusal under SIP or no secret);
  - an agent-driven `publish` through a pty, and a background process left over from Phase A that fires its own prompt.
  - IF any of these yields a value without a prompt, THEN Stage 1 does not start, and the design moves to the different-UID broker (I2). Prompt-gated results are the accepted Stage 1 residual.
- **R5** (precondition of Rollout step 3): round-trip a 2.2 KB dummy value through the exact import command and `find-generic-password -w`, then compare bytes. Record the working form; if `-w` at the prompt truncates, use another encoding or input form and note any short argv exposure.
- **R2:** a Phase A fixture hook reads fds 0–255 and the environment and finds no token. In Phase B, the helper refuses `host=evil.example`.
- **R3:** approve and squash-merge from GitHub Mobile under the end-state ruleset (Rollout step 9).
- **R4:** mint a token, suspend the installation in the UI, then call `GET /installation/repositories` with the old token. Record whether it still works (U2).

## Decisions (Krzysztof)

1. **App owner.**
   - A: private App owned by `LUNARITYai`.
   - B: owned by Krzysztof's personal account.
   - **Recommendation: A.**
2. **Issues permission (depends on 4).**
   - A: none in Stage 1. Issues write with an add-only label allowlist only once I2 exists.
   - B: Issues write now.
   - **Recommendation: A.** Under I1 the agent cannot use it, so B adds only risk. This accepts the recorded deviation from #82's `needs:human` criterion.
3. **Key store.**
   - K1: Keychain item, `-T ""`, a prompt per access.
   - K2: Keychain item trusted for a code-signed helper.
   - K3: a sign-only device or off-machine signing.
   - **Recommendation: K1 for Stage 1. For phases 1+, a different-UID daemon (I2) or K3.**
4. **Broker invocation.**
   - I1: Krzysztof runs `wardens identity publish` in his terminal.
   - I2: a launchd daemon under a dedicated macOS user, on a Unix socket; needs a #64 spec and sandbox R6.
   - I3: sandbox `excludedCommands`.
   - **Recommendation: I1 now, I2 later. Reject I3.**
5. **Push mechanism.**
   - P1: Phase A hooks with no token, then a Phase B `--no-verify` push of the same `SHA`, with the clean git env and the fd-3 helper.
   - P2: push through the REST git data API (no hooks, rewritten SHAs).
   - P3: token in the env, hooks on.
   - **Recommendation: P1. Reject P3.**
6. **Admin bypass.**
   - A: keep `RepositoryRole` admin, mode `pull_request`, web only, for Krzysztof's own PRs.
   - B: remove it.
   - **Recommendation: A.** `identity audit` lists bypass merges of bot PRs.
7. **Branch ruleset on `refs/heads/**`** (deletion and `non_fast_forward` except `main` patterns):
   - A: now;
   - B: defer to Stage 2, after checking that it blocks neither auto-delete of merged head branches nor a force-push after a rebase of a task branch.
   - **Recommendation: B.** The tag ruleset is now mandatory, not a decision.
8. **`require_last_push_approval`.**
   - **Recommendation: false.** Stale approvals are already dismissed on push, and true would block Krzysztof from approving after he pushes a fix-up.
9. **Commit author in task worktrees.**
   - A: the bot (worktree-scoped).
   - B: Krzysztof.
   - **Recommendation: A**, with the CI check keyed on PR author (Task 6).
10. **Ship Stage 1 alone.**
    - A: yes. Attribution, mobile merge and a real approval step now, with the same-UID self-approval residual stated.
    - B: wait for Stage 2.
    - **Recommendation: A.** It is strictly tighter than today's 0-approval ruleset.
11. **CI `agent-trailer` as a required check.**
    - A: required after one green week as non-required.
    - B: never required.
    - **Recommendation: A.**
