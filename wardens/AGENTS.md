# wardens

TypeScript Wardens engine (ADR-0005). Ring 0 loads The Charter, normalizes Claude Code and Cursor hook payloads, and evaluates `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard`.

- Package name: `@lunarhunt/wardens`. CLI library: commander. Schema: Ajv draft 2020-12, then zod.
- `pnpm --filter wardens test` runs Vitest in Node. `pnpm --filter wardens check` also runs `charter-validate` against the worktree Charter.
- `pnpm --filter wardens build` writes one file, `dist/wardens.mjs`. Do not commit it.
- This issue does not install hooks. `wardens sync` is a later issue.
- Tests pass an explicit git root or a temporary repository. They must not read a developer `.panopticon/task.json`.
- Lifecycle events: Claude `PostToolUse` and Cursor `afterFileEdit` run the post-edit audit, `Stop`/`stop` call the `evaluateStop` seam in `src/lifecycle.ts` (allow until `definition-of-done` lands), Cursor `sessionStart` sets `PANOPTICON_AGENT=cursor`.
- Fixtures with `provisional: true` and `source: "documented"` (Cursor `stop`, `afterFileEdit`, `sessionStart`) were not recorded. Replace each with a recording from `cursor-agent`.
- `wardens check agent-trailer <message-file>` judges an agent commit when `PANOPTICON_AGENT` or `CLAUDECODE=1` is set; tests pass `env` explicitly.
