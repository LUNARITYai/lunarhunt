# wardens

TypeScript Wardens engine (ADR-0005). Ring 0 loads The Charter, normalizes Claude Code and Cursor hook payloads, and evaluates `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard`.

- Package name: `@lunarhunt/wardens`. CLI library: commander. Schema: Ajv draft 2020-12, then zod.
- `pnpm --filter wardens test` runs Vitest in Node. `pnpm --filter wardens check` also runs `charter-validate` against the worktree Charter.
- `pnpm --filter wardens build` writes one file, `dist/wardens.mjs`. Do not commit it.
- This issue does not install hooks. `wardens sync` is a later issue.
- Tests pass an explicit git root or a temporary repository. They must not read a developer `.panopticon/task.json`.
- Lifecycle events: Claude `PostToolUse` and Cursor `afterFileEdit` run the post-edit audit, `Stop`/`stop` call the `evaluateStop` seam in `src/lifecycle.ts` (allow until `definition-of-done` lands), Cursor `sessionStart` sets `PANOPTICON_AGENT=cursor`.
- Cursor fixtures are recordings from `cursor-agent` (`provisional: false`); the Claude fixtures are still built from the docs (`provisional: true`).
- `wardens check agent-trailer <message-file>` judges an agent commit when `PANOPTICON_AGENT`, `CLAUDECODE=1` or a non-empty `CURSOR_AGENT` is set (in that order); tests pass `env` explicitly.
