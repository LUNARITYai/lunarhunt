// Test helper, run in a child process: WorktreeCreate with the real setup-step
// runner (its output goes to fd 2) and a stub `gh`. argv[2] is the anchor.
import { readFileSync } from "node:fs";
import { runWorktreeHook } from "../src/worktree/hook.ts";
import { hookDeps } from "../src/worktree/types.ts";

const anchor = process.argv[2] ?? "";
const body = ["### Allowed paths", "wardens/**"].join("\n");
const res = runWorktreeHook(
  "create",
  "claude",
  readFileSync(0, "utf8"),
  {
    ...hookDeps,
    env: { CLAUDECODE: "1" },
    gh: (args) => ({
      status: 0,
      stdout: JSON.stringify({
        title: "Noisy",
        body,
        labels: [{ name: "type:feature" }],
        state: "OPEN",
        url: `https://github.com/o/r/issues/${args[2]}`,
      }),
    }),
  },
  anchor,
);
process.stdout.write(res.stdout);
process.stderr.write(res.stderr);
process.exitCode = res.exitCode;
