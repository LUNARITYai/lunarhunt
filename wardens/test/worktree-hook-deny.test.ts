import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { tempRepo } from "./support.ts";

const root = tempRepo();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function bash(command: string): string {
  return runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command } }),
    { cwd: () => root, env: {} },
  ).stdout;
}

// An absolute path inside the repository; one outside it is denied by the path rules already.
const BUNDLE = `${root}/wardens/dist/wardens.mjs`;

/** Every way an agent could reach the WorktreeCreate/WorktreeRemove entrypoints with a forged payload. */
const DENIED = [
  "wardens worktree create --tool claude",
  "wardens worktree remove --tool claude",
  "wardens worktree remove --tool=claude",
  "wardens worktree --tool claude create",
  "wardens worktree create --tool cursor",
  "node wardens/dist/wardens.mjs worktree create --tool claude",
  `node ${BUNDLE} worktree create --tool claude`,
  `${BUNDLE} worktree remove --tool claude`,
  "node --experimental-strip-types wardens/src/cli.ts worktree create --tool claude",
  "pnpm exec wardens worktree create --tool claude",
  "pnpm --filter wardens exec wardens worktree create --tool claude",
  "npx wardens worktree remove --tool claude",
  "FOO=1 node wardens.mjs worktree remove --tool claude",
  "env CLAUDECODE= wardens worktree create --tool claude",
  `echo '{"name":"42-x","cwd":"/"}' | node ${BUNDLE} worktree create --tool claude`,
  `bash -c 'node ${BUNDLE} worktree create --tool claude'`,
  `sh -c "wardens worktree remove --tool claude"`,
  "git -c alias.x='!wardens worktree create --tool claude' x",
  // Aliases and functions, defined and used apart.
  "alias w='node wardens/dist/wardens.mjs worktree create'",
  "w --tool claude",
  'w() { node wardens/dist/wardens.mjs worktree create "$@"; }',
  // Quoting and escaping inside the words.
  'wardens worktree create --to"ol" claude',
  "wardens worktree cr''eate --tool claude",
  "wardens worktree cr\\eate --tool claude",
  "wardens 'worktree' \"create\" '--tool' claude",
  // Values and verbs built from variables.
  "v=create; wardens worktree $v --tool claude",
  'wardens worktree create --tool "$t"',
  'wardens worktree "$verb" "$flag" claude',
  "wardens\tworktree\tcreate\t--tool\tclaude",
  // The other hook entrypoint of the same flag.
  "node wardens/dist/wardens.mjs hook --tool claude --event Stop",
  // Not a hook, but the agent marker refuses it anyway: denied up front.
  "wardens worktree remove 42-x",
];

const ALLOWED = [
  "wardens worktree list",
  "wardens doctor",
  "git worktree list",
  "git worktree add x -b feat/1-x",
  "git worktree remove x",
  "claude --worktree 42-offer-crud",
  "pnpm --filter wardens test",
  "pnpm check",
  "ls wardens/src/worktree",
  "rg worktree wardens/src",
  'git commit -m "feat(wardens): wardens worktree create hooks"',
  'gh issue comment 51 --body "wardens worktree remove stays human only"',
  "git log --oneline -5",
];

describe("agents cannot invoke the worktree hook entrypoints from a shell", () => {
  it.each(DENIED)("denies: %s", (command) => {
    const out = bash(command);
    expect(out).toContain('"deny"');
    expect(out).toContain("Blocked by Warden command-guard");
    expect(out).toContain("worktree hook entrypoints");
  });

  it.each(ALLOWED)("allows: %s", (command) => {
    expect(bash(command)).toBe("");
  });
});
