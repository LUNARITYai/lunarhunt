import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { tokenizeAll } from "../src/command.ts";
import { runHook } from "../src/engine.ts";
import { invokesWorktreeHook } from "../src/hook-deny.ts";
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
  // Alias definitions that name the entrypoint.
  "alias w='node wardens/dist/wardens.mjs worktree create'",
  "git config alias.w '!wardens worktree create'",
  "gh alias set w 'api repos/x; wardens worktree create'",
  // A dynamic executable that names the entrypoint (brace expansion, variable).
  "{node,wardens/dist/wardens.mjs} worktree create --tool claude",
  '$bundle worktree create "$@"',
  // Dynamic constructs in the arguments of the entrypoint.
  "wardens worktree $'cr\\x65ate' --tool claude",
  "wardens worktree cr*te --tool claude",
  "wardens worktree {create,remove} --tool claude",
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
  // Grouping, negation, compound commands and xargs in front of the executable.
  "(wardens worktree create --tool claude)",
  "if true; then wardens worktree create --tool claude; fi",
  "! wardens worktree remove --tool claude",
  "xargs wardens worktree create --tool claude",
  "{ wardens worktree create --tool claude; }",
  "while true; do wardens worktree create --tool claude; done",
  "time wardens worktree remove --tool claude",
  // Not a hook, but the agent marker refuses it anyway: denied up front.
  "wardens worktree remove 42-x",
];

const ALLOWED = [
  "wardens worktree list",
  "wardens doctor",
  "git worktree list",
  "claude --worktree 42-offer-crud",
  "pnpm --filter wardens test",
  "pnpm check",
  "ls wardens/src/worktree",
  "rg worktree wardens/src",
  'git commit -m "feat(wardens): wardens worktree create hooks"',
  'gh issue comment 51 --body "wardens worktree remove stays human only"',
  "git log --oneline -5",
  // Words inside text commands never match.
  'git commit -m "fix(wardens): doc the hook --tool claude flag (#51)"',
  'gh pr create --title x --body "Adds wardens worktree create --tool claude hooks"',
  'rg -n "hook --tool claude" wardens/src',
  'rg -- "--tool claude" docs',
  'rg -n "--tool" wardens/src/worktree',
  'echo "docs: --tool cursor worktree"',
  "pnpm --filter wardens exec vitest run test/worktree.test.ts -t remove",
  'pnpm --filter wardens exec vitest run worktree -t "create"',
  "claude --worktree 50-wardens-worktree-new-setup-list-remove-prune",
  // Plain entrypoint forms; --tool is only an entrypoint flag on `worktree`.
  "wardens hook --tool claude --event PreToolUse",
  "node wardens/dist/wardens.mjs hook --tool claude --event Stop",
  "wardens check scope-guard --tool claude",
  "wardens worktree list",
  "node wardens/dist/wardens.mjs doctor --json",
  "node --experimental-strip-types wardens/src/cli.ts check charter-validate",
  "pnpm exec wardens sync --check",
];

// Out of reach by design (best effort): interpreters, xargs, scripts, aliases
// used apart from their definition. Safety comes from the entrypoint itself.

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

  // Command substitution is denied as unparseable before this rule runs.
  // Denied by the ring-0 git rules (main), consistent with this design.
  it.each([
    "git worktree add x -b feat/1-x",
    "git worktree remove x",
    "git worktree prune",
  ])("denies by the git worktree rule: %s", (command) => {
    expect(bash(command)).toContain('"deny"');
  });

  it.each([
    "wardens worktree create $(echo --tool) claude",
    "wardens worktree create `echo --tool` claude",
    "wardens $(cat verb) $(cat flag)",
    "node wardens/dist/wardens.mjs worktree $(cat verb)",
  ])("denies a substitution: %s", (command) => {
    expect(bash(command)).toContain('"deny"');
  });

  // sed and awk scripts are judged by the entrypoint rule alone: another
  // rule (secret-read-guard) reads their script word as a path, which is not
  // this rule's business.
  it.each([
    "sed -n '/remove/,$p' wardens/src/worktree/index.ts",
    "awk '/create/' wardens/src/worktree/index.ts",
    "sed -n '/--tool claude/p' wardens/src/worktree/hook.ts",
  ])("the entrypoint rule ignores: %s", (command) => {
    expect(invokesWorktreeHook(tokenizeAll(command))).toBe(false);
  });
});
