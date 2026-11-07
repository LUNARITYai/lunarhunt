import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

const root = tempRepo();
mkdirSync(join(root, "secrets"), { recursive: true });
writeRepoFile(root, "secrets/key.txt", "x");
writeRepoFile(root, "apps/api/migrations/0001.sql", "x");
writeRepoFile(root, "docs/notes.md", "x");
writeRepoFile(root, "stash/panopticon.charter.yaml", "x");

type Outcome = { decision: "allow" | "ask" | "deny"; rule: string };

function hook(tool: string, input: Record<string, unknown>): Outcome {
  const result = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd: root, tool_name: tool, tool_input: input }),
    { cwd: () => root, env: {}, home: root },
  );
  if (result.stdout === "") {
    return { decision: "allow", rule: "none" };
  }
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  const rule = /Warden ([a-z-]+):/.exec(out.permissionDecisionReason)?.[1];
  return { decision: out.permissionDecision, rule: rule ?? "?" };
}

const bash = (command: string): Outcome => hook("Bash", { command });

const CHARTER = "panopticon.charter.yaml";

/** Every way the shell writes a protected file; `@` is replaced by the file. */
const WRITERS: Array<[string, string]> = [
  ["redirect", "echo x > @"],
  ["tee", "tee @"],
  ["cp", "cp x @"],
  ["cp dir destination", "cp x/panopticon.charter.yaml ."],
  ["cp -t", "cp -t . x/panopticon.charter.yaml"],
  [
    "cp --target-directory",
    "cp --target-directory=. x/panopticon.charter.yaml",
  ],
  ["install -t", "install -t . x/panopticon.charter.yaml"],
  ["rsync dir", "rsync x/panopticon.charter.yaml ."],
  ["mv", "mv x @"],
  ["mv source", "mv @ x"],
  ["mv dir destination", "mv x/panopticon.charter.yaml ."],
  ["rm", "rm @"],
  ["rm -rf protected dir", "rm -rf secrets"],
  ["rm -rf ancestor", "rm -rf apps/api"],
  ["touch", "touch @"],
  ["sed -i", "sed -i s/a/b/ @"],
  ["sed w flag", "sed s/a/b/w@ x"],
  ["sed w command", "sed -n w@ x"],
  ["sed w after ;", "sed -n '1p;w @' x"],
  ["sort -o", "sort -o @ x"],
  ["sort --output", "sort --output @ x"],
  ["split", "split x panopticon.charter.y"],
  ["awk print >", "awk '{print > \"panopticon.charter.yaml\"}' x"],
  ["awk printf >>", 'awk \'{printf "%s", $1 >> "panopticon.charter.yaml"}\' x'],
  ["awk -i inplace", "awk -i inplace '{print}' @"],
  ["tar -x", "tar -xf a.tar"],
  ["tar -C", "tar -C . -xf a.tar"],
  ["unzip -d", "unzip -d . a.zip"],
  ["unzip", "unzip a.zip"],
  ["git checkout", "git checkout HEAD -- @"],
  ["git restore", "git restore --source=HEAD~1 @"],
  ["git restore -s", "git restore -s HEAD~1 @"],
  ["git mv", "git mv @ x"],
  ["git mv destination", "git mv x @"],
  ["git rm", "git rm @"],
  ["patch", "patch -p1"],
  ["ex", "ex @"],
  ["ed", "ed @"],
  ["glob redirect", "echo x > panopticon.charter.y*"],
  ["glob cp", "cp x panopticon.charter.[y]aml"],
  ["glob tee", "tee panopticon.charter.?aml"],
  ["find -delete", "find . -name @ -delete"],
  ["find -fprint", "find . -fprint @"],
  ["ln -s then write", "ln -s @ l && echo x > l"],
  ["ln -s", "ln -s @ l"],
  ["dd", "dd if=x of=@"],
];

/** Wrappers that run the rest as a command; `%` is the writer. */
const WRAPPERS = [
  "env A=1 %",
  "env -i %",
  "command %",
  "exec %",
  "nohup %",
  "nice %",
  "nice -n 5 %",
  "sudo %",
  "sudo -u root %",
  "timeout 5 %",
  "timeout -s KILL 5 %",
  "xargs %",
  "xargs -n1 %",
  "find . -exec % \\;",
  "find . -execdir % \\;",
  "env nice sudo %",
];

const fill = (template: string): string => template.replaceAll("@", CHARTER);
const wrap = (wrapper: string, command: string): string =>
  wrapper.replace("%", () => command);

describe("shell writers are judged by what they write (#83)", () => {
  it.each(WRITERS)("denies %s", (_name, template) => {
    const command = fill(template);
    expect(bash(command).decision, command).toBe("deny");
  });

  const wrapped = WRITERS.flatMap(([name, template]) =>
    WRAPPERS.map((wrapper) => [name, wrapper, template] as const),
  );
  it.each(wrapped)(
    "%s: the verdict is the same behind %s",
    (_name, wrapper, template) => {
      const command = wrap(wrapper, fill(template));
      expect(bash(command).decision, command).toBe("deny");
    },
  );

  it.each([
    "./cp x panopticon.charter.yaml",
    "bin/tee panopticon.charter.yaml",
    "./CP x panopticon.charter.yaml",
    "sub/dir/mv x panopticon.charter.yaml",
    "./rm panopticon.charter.yaml",
  ])("looks up a command word with a directory part: %s", (command) => {
    expect(bash(command).decision, command).toBe("deny");
  });

  it("denies a writer whose destination the command line does not name", () => {
    for (const command of [
      "echo panopticon.charter.yaml | xargs rm",
      "echo d | xargs cp x",
      "find . -name '*.yaml' -exec rm {} \\;",
      "find . -exec mv {} d \\;",
      "tar -xf a.tar",
      "unzip a.zip",
      "patch -p1",
      "ex",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
  });

  it("reads the names a glob or a directory source copies", () => {
    for (const command of [
      "cp stash/* docs/",
      "cp stash/panopticon.* docs",
      "cp -r stash/. docs",
      "rsync -a stash/ docs/",
      "rsync -a stash/ docs",
      "cp -t docs stash/*",
      "cp -t docs $SRC",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
  });

  it("allows the same commands on an allowed path", () => {
    for (const command of [
      "cp docs/notes.md docs/copy.md",
      "cp docs/* apps/",
      "rsync -a docs/ apps/",
      "cp docs/notes.md docs/sub/",
      "cp -t docs docs/notes.md",
      "mv docs/notes.md docs/old.md",
      "rm -rf docs/tmp",
      "rm -rf apps/web/.next",
      "mkdir -p apps/web/tmp",
      "mkdir -m 755 apps/web/tmp",
      "touch docs/x.md",
      "echo x > docs/x.md",
      "echo x > docs/x*.md",
      "tee docs/x.md",
      "sed -i s/a/b/ docs/notes.md",
      "sed 's/hello world/x/' docs/notes.md",
      "sed -n '1p;$p' docs/notes.md",
      "sort -o docs/x.md docs/notes.md",
      "sort docs/notes.md",
      "split docs/notes.md docs/part-",
      "awk '$1 > 5' docs/notes.md",
      "awk '{print $1}' docs/notes.md",
      "awk '{print (1 > 2)}' docs/notes.md",
      "awk '{print > \"docs/out.txt\"}' docs/notes.md",
      "tar -tf a.tar",
      "tar -cf docs/a.tar docs/notes.md",
      "unzip -l a.zip",
      "git checkout -b feat/x",
      "git checkout main",
      "git restore --staged docs/notes.md",
      "git restore docs/notes.md",
      "git checkout HEAD -- docs/notes.md",
      "git mv docs/notes.md docs/old.md",
      "git rm docs/notes.md",
      "git status",
      "git log --format=%H -n 3",
      "find docs -name '*.md'",
      "find docs -name '*.md' -exec grep -l x {} \\;",
      "xargs grep foo",
      "env A=1 pnpm check",
      "nice -n 5 pnpm check",
      "timeout 5 cp docs/notes.md docs/copy.md",
      "ln -s notes.md docs/link",
      "patch --dry-run -p1",
      "diff docs/notes.md docs/x.md",
    ]) {
      expect(bash(command).decision, command).toBe("allow");
    }
  });
});

describe("scope-guard judges shell writes like the edit tools (#83)", () => {
  const PATHS = [
    "AGENTS.md",
    "CLAUDE.md",
    ".env.example",
    ".claude/settings.json",
    ".claude/hooks/x.sh",
    "infra/main.tf",
    "deploy/app.yaml",
    "src/new.ts",
  ];

  it.each(PATHS)("%s: the verdict of the Write tool", (path) => {
    const edit = hook("Write", { file_path: path, content: "x" });
    expect(edit.decision, path).toBe("deny");
    for (const command of [
      `echo x > ${path}`,
      `cp x ${path}`,
      `tee ${path}`,
      `touch ${path}`,
      `mkdir -p ${path}`,
      `sed -i s/a/b/ ${path}`,
      `env cp x ${path}`,
    ]) {
      expect(bash(command).decision, command).toBe(edit.decision);
    }
  });

  it("names scope-guard for a path outside allowed_paths", () => {
    expect(bash("echo x > infra/main.tf").rule).toBe("scope-guard");
    expect(bash("rm -rf infra").rule).toBe("scope-guard");
    expect(bash("echo x > infra/*.tf").rule).toBe("scope-guard");
  });

  it("does not judge reads or writes outside the worktree", () => {
    for (const command of [
      "cat AGENTS.md",
      "ls infra",
      "grep x CLAUDE.md",
      "echo x > /dev/null",
      "git diff --stat 2>&1",
    ]) {
      expect(bash(command).decision, command).toBe("allow");
    }
  });
});

describe("command names fold only what the file system aliases (#83)", () => {
  it("does not classify dotless i or capital dotted I as the ASCII tool", () => {
    // `diff` and `file` are read-only: their path arguments are no writes.
    expect(bash("diff --foo=panopticon.charter.yaml docs/x.md").decision).toBe(
      "allow",
    );
    for (const command of [
      "dıff --foo=panopticon.charter.yaml docs/x.md",
      "fıle --foo=panopticon.charter.yaml",
      "FİLE --foo=panopticon.charter.yaml",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
  });

  it("keeps the spellings a case-insensitive volume does alias", () => {
    for (const command of [
      "DIFF docs/notes.md docs/x.md",
      "Diff docs/a docs/b",
    ]) {
      expect(bash(command).decision, command).toBe("allow");
    }
    expect(bash("CP x panopticon.charter.yaml").decision).toBe("deny");
    expect(bash("ſort -o panopticon.charter.yaml x").decision).toBe("deny");
  });
});
