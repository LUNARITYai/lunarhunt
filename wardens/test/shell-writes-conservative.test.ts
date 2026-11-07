import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

const root = tempRepo();
for (const [path, text] of [
  ["package.json", "{}"],
  ["apps/a.txt", "x"],
  ["apps/sub/b.txt", "x"],
  ["apps/api/migrations/x.sql", "x"],
  ["docs/notes.md", "x"],
  ["docs/specs/AGENTS.md", "x"],
  ["packages/contracts/openapi.json", "{}"],
  ["secrets/key.txt", "x"],
] as const) {
  writeRepoFile(root, path, text);
}
mkdirSync(join(root, "apps/web/.next"), { recursive: true });
for (let at = 0; at < 6000; at += 1) {
  writeFileSync(join(root, "apps/web/.next", `chunk-${at}.js`), "x");
}

function bash(command: string): "allow" | "ask" | "deny" {
  const result = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({
      cwd: root,
      tool_name: "Bash",
      tool_input: { command },
    }),
    { cwd: () => root, env: {}, home: root },
  );
  if (result.stdout === "") {
    return "allow";
  }
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

/** Writers with an option or operand the tables do not model: the destination must still be judged. */
const DENIED = [
  // An operand is a target whatever its place or its option (rsync, chmod, chown, chgrp).
  "rsync -a apps/web/src/a.ts panopticon.charter.yaml",
  "rsync apps/a.txt packages/contracts/openapi.json --files-from apps/f",
  "chmod -w panopticon.charter.yaml",
  "chmod -R -w panopticon.charter.yaml",
  "chmod -x .git/hooks/pre-commit",
  "chmod -w packages/contracts/openapi.json",
  "chown -R me panopticon.charter.yaml",
  "chgrp -R staff panopticon.charter.yaml",
  // A value after the operands, or glued to a flag cluster, is a destination.
  "cp apps/a.txt package.json --suffix apps/y",
  "cp -rt.claude apps/a.txt",
  "install -Dt.claude apps/a.txt",
  "mv -ft.claude apps/a.txt",
  "cp -rtsecrets apps/a.txt",
  "cp -t secrets apps/a.txt",
  "unzip -dsecrets a.zip",
  "unzip -qdsecrets a.zip",
  // The first operand is not always the file: options with values come first.
  "zip -b apps CLAUDE.md apps/a.txt",
  "split --lines 5 apps/a.txt .claude/h",
  "awk --assign x=1 '{print > \"package.json\"}' apps/a.txt",
  "sed -l 5 -n 'w package.json' apps/a.txt",
  // The destination is the source path under the current directory.
  "cd apps/sub && cp --parents api/migrations/x.sql ..",
  "cd apps && cp --parents api/migrations/x.sql sub",
  "rsync -R apps/sub/./api/migrations/x.sql apps/",
  // A wrapper form the walker does not parse hides the command.
  "timeout 1E3 cp apps/a.txt package.json",
  "timeout .5 cp apps/a.txt package.json",
  "env -a foo cp apps/a.txt package.json",
  "env - cp apps/a.txt package.json",
  "echo a | xargs -J % cp % package.json",
  "echo a | xargs -S 5 cp apps/a.txt package.json",
  "echo AGENTS.md | xargs git rm -f",
  "echo package.json | xargs git checkout --",
  // Git pathspecs: any form that restores a file.
  "git restore -WS package.json",
  "git restore -SW package.json",
  "git checkout --theirs package.json",
  "git checkout package.json",
  "git checkout .",
  "git restore .",
  "git rm --pathspec-from-file=list",
  "git checkout --pathspec-from-file=list",
  // Features that run a program or write a file the text does not name.
  "tar -cf apps/o.tar --remove-files .claude",
  "tar -cf apps/o.tar --checkpoint=1 --checkpoint-action=exec='cp apps/a.txt package.json' apps/a.txt",
  "tar -cf apps/o.tar -I 'tee package.json' apps/a.txt",
  "tar -cf apps/o.tar --use-compress-program='tee package.json' apps/a.txt",
  "tar -cf apps/o.tar --index-file=package.json apps/a.txt",
  "tar -cf apps/o.tar -g package.json apps/a.txt",
  "sed -n '1e cp apps/a.txt package.json' apps/a.txt",
  "sed 's/a/b/e' apps/a.txt",
  "sed -f script.sed apps/a.txt",
  "sed -n ':a;w package.json' apps/a.txt",
  "awk 'BEGIN{\"cp apps/a.txt package.json\" | getline}'",
  "awk 'BEGIN{system(\"cp apps/a.txt package.json\")}'",
  'awk \'/"/ {print > "package.json"}\' apps/a.txt',
  "awk -f prog.awk apps/a.txt",
  "awk -i other.awk apps/a.txt",
  "zip -m apps/o.zip AGENTS.md",
  "zip -T apps/o.zip apps/a.txt",
  "rsync -e 'tee package.json' apps/a.txt apps/b",
  "rsync --write-batch=package.json apps/a.txt apps/b",
  "rsync --exclude-from=apps/f apps/a.txt apps/b",
];

const ALLOWED = [
  "pnpm check",
  "pnpm --filter wardens test",
  "git status",
  "git add docs/notes.md",
  "git commit -m 'feat: x'",
  "git switch -c feat/x",
  "git checkout main",
  "git checkout -b feat/y origin/main",
  "git restore --staged docs/notes.md",
  "git log --format=%H -n 3",
  "mkdir -p apps/web/tmp",
  "cp docs/notes.md docs/copy.md",
  "cp docs/notes.md apps/a2.txt",
  "mv docs/notes.md docs/old.md",
  "rm -rf apps/web/.next",
  "rm -rf apps/web/.next/cache",
  "tee docs/out.md",
  "sed -i s/a/b/ docs/notes.md",
  "sed -n -e 's/a/b/p' docs/notes.md",
  "find . -name '*.ts'",
  "find docs -name '*.pyc' -delete",
  "tar -tf a.tar",
  "tar -cf docs/a.tar docs/notes.md",
  "chmod +x apps/a.txt",
  "chmod 644 docs/notes.md",
  "chmod -R a+r docs",
  "chown -R me docs/notes.md",
  "curl -o - https://example.com/x",
  "zip -x '*.tmp' docs/out.zip docs/notes.md",
  "awk -F: '{print $1}' docs/notes.md",
  "awk '$1 > 5' docs/notes.md",
  "split -l 10 docs/notes.md docs/part-",
  "timeout 5 cp docs/notes.md docs/copy.md",
  "timeout 1.5s pnpm check",
  "env A=1 pnpm check",
  "xargs grep foo",
  "echo docs/notes.md | xargs grep foo",
];

describe("writers are judged conservatively (#83 round 1)", () => {
  it.each(DENIED)("denies %s", (command) => {
    expect(bash(command), command).toBe("deny");
  });

  it.each(ALLOWED)("allows %s", (command) => {
    expect(bash(command), command).toBe("allow");
  });

  it("denies a protected file used as the source of a copy: every operand is a target", () => {
    expect(bash("cp panopticon.charter.yaml docs/c.yaml")).toBe("deny");
  });

  it.each([
    "./ls --config=panopticon.charter.yaml",
    "apps/web/ls --config=panopticon.charter.yaml",
    "./diff of=panopticon.charter.yaml",
    "./git commit -m .env",
    "bin/gh issue create -b .env",
  ])(
    "does not give the command word %s the tables of its basename",
    (command) => {
      expect(bash(command), command).toBe("deny");
    },
  );

  it("lists a large tree and judges its files, not a glob of its name", () => {
    expect(bash("rm -rf apps/web/.next")).toBe("allow");
    expect(bash("mv apps/web/.next apps/web/.old")).toBe("allow");
  });
});
