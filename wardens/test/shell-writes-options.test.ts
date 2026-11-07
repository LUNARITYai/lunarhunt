import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/engine.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

const root = tempRepo();
for (const [path, text] of [
  ["AGENTS.md", "x"],
  ["README.md", "x"],
  ["package.json", "{}"],
  ["tsconfig.base.json", "{}"],
  ["apps/a.txt", "x"],
  ["apps/web/AGENTS.md", "x"],
  ["apps/web/src/a.ts", "x"],
  ["apps/sub/b.txt", "x"],
  ["apps/api/migrations/0001.sql", "x"],
  ["docs/notes.md", "x"],
  ["packages/contracts/openapi.json", "{}"],
  ["secrets/key.txt", "x"],
] as const) {
  writeRepoFile(root, path, text);
}
mkdirSync(join(root, "apps/y"), { recursive: true });

function bash(command: string): "allow" | "ask" | "deny" {
  const result = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command } }),
    { cwd: () => root, env: {}, home: root },
  );
  if (result.stdout === "") {
    return "allow";
  }
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

/** No option removes a word from judgement (#83 round 2). */
const DENIED: Record<string, string[]> = {
  "-f is a flag, not a pattern option": [
    "rm -f panopticon.charter.yaml",
    "rm -r -f panopticon.charter.yaml",
    "rm -f apps/web/AGENTS.md",
    "mv -f panopticon.charter.yaml apps/y",
    "git rm -f package.json",
    "git checkout -f AGENTS.md",
    "git restore -f AGENTS.md",
    "find apps -exec rm -f {} +",
    "gzip -f panopticon.charter.yaml",
    "shred -f panopticon.charter.yaml",
  ],
  "a sed script is found by position, not by its look": [
    "sed -i 2d panopticon.charter.yaml",
    "sed -i 1h panopticon.charter.yaml",
    "sed -i 10k panopticon.charter.yaml",
    "sed -i -e 2d panopticon.charter.yaml",
    "sed -i -- 2d panopticon.charter.yaml",
  ],
  "rsync -t is times, not a target directory": [
    "rsync -t a.tar AGENTS.md",
    "rsync -rt apps/a.txt panopticon.charter.yaml",
    "rsync -avt apps/a.txt packages/contracts/openapi.json",
  ],
  "every operand of a link is judged": [
    "ln -s apps/a.txt package.json apps/y",
    "ln -s apps/a.txt panopticon.charter.yaml",
  ],
  "an output option of any command is a write": [
    "curl --output package.json http://x",
    "curl --out package.json http://x",
    "curl -o package.json http://x",
    "curl -sSo package.json http://x",
    "git diff --output package.json",
    "git archive --output package.json HEAD",
    "curl -O http://x/panopticon.charter.yaml",
    "curl --remote-name http://x/panopticon.charter.yaml",
    "wget http://x/panopticon.charter.yaml",
    "sort --outp=package.json apps/a.txt",
    "sort -opackage.json apps/a.txt",
  ],
  "find removes whatever its filters say": [
    "find apps/api ! -name zz -delete",
    "find apps -delete -name zz",
    "find apps/api -iname 0001.SQL -delete",
    "find apps/api -not -name zz -delete",
    "find apps/api -name zz -o -name yy -delete",
    "find apps/api -name '[z]z' -delete",
    "find apps/api -type f -exec rm {} \\;",
  ],
  "GNU long options match unambiguous prefixes": [
    "cd apps/sub && cp --par api/migrations/x.sql ..",
    "tar -cf apps/o.tar --remove-fi .claude",
    "tar -cf apps/o.tar --use-comp='tee package.json' apps/a.txt",
    "tar -cf apps/o.tar --checkpoint-act=exec='cp apps/a.txt package.json' apps/a.txt",
    "tar -cf apps/o.tar --index-fi=package.json apps/a.txt",
    "tar -cf apps/o.tar --listed-inc=package.json apps/a.txt",
    "gawk --inc=inplace '{print}' package.json",
    "gawk --fil=prog.awk apps/a.txt",
    "gawk --sou='BEGIN{system(\"x\")}' apps/a.txt",
    "rsync --files-f=list apps/a.txt apps/y",
    "rsync --write-b=package.json apps/a.txt apps/y",
    "git checkout --pathspec-from-f=list",
    "git checkout --the package.json",
    "zip --mov apps/o.zip AGENTS.md",
  ],
  "every letter of a cluster is scanned": [
    "tar -c -f apps/o.tar -vgpackage.json apps/a.txt",
    "tar -cvIf apps/o.tar apps/a.txt",
    "rsync -aessh apps/a.txt apps/y",
    "rsync -avze 'ssh -o x' apps/a.txt apps/y",
    "zip -rm apps/o.zip AGENTS.md",
    "sed -nf script.sed apps/a.txt",
    "awk -vx=1 -fprog.awk apps/a.txt",
    "awk -ninplace '{print}' package.json",
  ],
  "a glob list is capped for the whole command": [
    `cp ${Array.from({ length: 12 }, () => `${"a".repeat(400)}*`).join(" ")} docs/`,
  ],
};

const ALLOWED = [
  // A copy source is read: only protected and generated files are judged.
  "cp package.json apps/web/package.json",
  "cp tsconfig.base.json apps/web/tsconfig.json",
  "cp README.md docs/",
  "cp -r README.md docs/",
  "cp -a package.json apps/web/package.json",
  "rsync -a README.md docs/",
  "rsync -a --exclude node_modules docs/ apps/y/",
  "ln -s notes.md docs/link",
  // Scripts and in-place editing.
  "sed -i.bak s/a/b/ apps/a.txt",
  "sed -i -E 's/x/y/' apps/a.txt",
  "sed -i -e 's/x/y/' apps/a.txt",
  "sed -n 's/a/b/p' -- docs/notes.md",
  "sed -n '1,5p' docs/notes.md",
  // The everyday set.
  "pnpm check",
  "pnpm --filter wardens test",
  "git status",
  "git add docs/notes.md",
  "git commit -m 'feat: x'",
  "git switch -c feat/z",
  "git checkout main",
  "git checkout -b feat/q origin/main",
  "git restore --staged docs/notes.md",
  "mkdir -p apps/web/tmp",
  "cp docs/notes.md docs/copy.md",
  "mv docs/notes.md docs/old.md",
  "rm -rf apps/web/.next",
  "rm -f docs/old.md",
  "tee docs/out.md",
  "find . -name x",
  "find docs -name '*.md'",
  "tar -tf a.tar",
  "tar --checkpoint=100 -tf a.tar",
  "tar -cf docs/a.tar docs/notes.md",
  "grep -o foo docs/notes.md",
  "ls -o docs",
  "curl -o - https://example.com/x",
  "curl -s https://example.com/x",
  "wget -qO- https://example.com/x",
  "git diff --stat",
  "chmod +x apps/a.txt",
  "chmod -R a+r docs",
];

describe("no option removes a word from judgement (#83 round 2)", () => {
  for (const [name, commands] of Object.entries(DENIED)) {
    it.each(commands)(`${name}: denies %s`, (command) => {
      expect(bash(command), command).toBe("deny");
    });
  }

  it.each(ALLOWED)("allows %s", (command) => {
    expect(bash(command), command).toBe("allow");
  });
});
