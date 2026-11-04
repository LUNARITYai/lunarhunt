# wardens

TypeScript Wardens engine (ADR-0005). Ring 0 loads The Charter, normalizes Claude Code and Cursor hook payloads, and evaluates `scope-guard`, `protected-paths`, `command-guard` and `secret-read-guard`.

- Package name: `@lunarhunt/wardens`. CLI library: commander. Schema: Ajv draft 2020-12, then zod.
- `pnpm --filter wardens test` runs Vitest in Node. `pnpm --filter wardens check` also runs `charter-validate` against the worktree Charter.
- `pnpm --filter wardens build` writes one file, `dist/wardens.mjs`. Do not commit it.
- This issue does not install hooks. `wardens sync` is a later issue.
- Tests pass an explicit git root or a temporary repository. They must not read a developer `.panopticon/task.json`.
