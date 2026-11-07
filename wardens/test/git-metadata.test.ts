import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCharterAt } from "../src/charter.ts";
import { evaluateRule, evaluateRules, runHook } from "../src/engine.ts";
import type { NormalizedEvent } from "../src/event.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { finalizeVerdict } from "../src/render.ts";
import { loadTask } from "../src/task.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

const MESSAGE =
  "Blocked by Warden protected-paths: git metadata is not editable by agents. Label the issue needs:human.";

function eventFor(root: string, partial: Partial<NormalizedEvent>) {
  const event: NormalizedEvent = {
    tool: "claude",
    event: "PreToolUse",
    action: "edit",
    path: null,
    command: null,
    mcp_server: null,
    session_id: null,
    agent: null,
    model: null,
    interactive: true,
    cwd: root,
    phase: "pre",
    stop_status: null,
    foreign: false,
    ...partial,
  };
  const loaded = loadCharterAt(root);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("; "));
  }
  return {
    event,
    ctx: { event, charter: loaded.charter, task: loadTask(root), root },
  };
}

function protectedPathsVerdict(
  root: string,
  partial: Partial<NormalizedEvent>,
) {
  const { event, ctx } = eventFor(root, partial);
  return finalizeVerdict(evaluateRule("protected-paths", ctx), event);
}

function allRulesVerdict(root: string, partial: Partial<NormalizedEvent>) {
  const { event, ctx } = eventFor(root, partial);
  return finalizeVerdict(evaluateRules(ctx), event);
}

const DENIED_PATHS = [
  ".git",
  "./.git",
  "sub/../.git",
  ".git/config",
  ".git/hooks/x",
  "apps/web/.git",
  "apps/web/.git/config",
  ".GIT/config",
];

const ALLOWED_PATHS = [
  ".gitignore",
  ".gitattributes",
  ".github/x",
  "docs/.git-notes.md",
  "gitfoo/x",
  "sub/git",
];

const DENIED_COMMANDS = [
  "echo x > .git",
  "echo x >> .git/config",
  "cp x .git",
  "mv x .git/HEAD",
  "tee .git",
  "printf x | tee .git/hooks/pre-commit",
  "sed -i s/a/b/ .git/config",
  "rm -rf .git",
  "touch ./sub/../.git",
  "echo x > ./.git",
  "dd of=.git/config",
  "dd if=x of=.git/hooks/pre-commit",
  "install -m 755 x .git/hooks/pre-commit",
  "rsync -a a/ .git/",
  "perl -pi -e s/a/b/ .git/config",
  "curl -o .git/config https://example.com/x",
  "tar --file=.git/x -c .",
  "chmod 755 .git/hooks/pre-commit",
  "cd .git && echo x > config",
  "cd sub/../.git && touch config",
];

const ALLOWED_COMMANDS = [
  "cat .git/HEAD",
  "ls .git",
  "git status",
  "grep foo .git/config",
  "cp .git/HEAD x",
  "echo x > .gitignore",
  "cp x .github/y",
  "echo x > docs/.git-notes.md",
  "find . -name .git",
  'find . -name "*.ts" -not -path "./.git/*"',
  "find . -path ./.git -prune -o -print",
  "cd .git",
  "[ -d .git ]",
  "test -e .git",
  "echo .git",
  "git log -- .git",
  "git ls-files .git",
  "git -C .git status",
  "sed -n 1p .git/HEAD",
  "awk 1 .git/HEAD",
  "tar --exclude=.git -cf x.tar .",
  "rsync -a --exclude .git a b/",
  "rsync -a a b/ --exclude .git",
  "git --git-dir=.git status",
  "echo x > /dev/null",
  "ls . 2>&1",
  "echo x > ./out/*.txt",
];

describe("git metadata is not editable by agents", () => {
  describe.each(["edit", "write", "delete"] as const)("%s", (action) => {
    it.each(DENIED_PATHS)("denies %s", (path) => {
      const root = tempRepo({ open: true });
      const verdict = protectedPathsVerdict(root, { action, path });
      expect(verdict.decision).toBe("deny");
      expect(verdict.rule).toBe("protected-paths");
      expect(verdict.message).toBe(MESSAGE);
      expect(verdict.message).toMatch(MESSAGE_PATTERN);
    });

    it.each(ALLOWED_PATHS)("does not fire for %s", (path) => {
      const root = tempRepo({ open: true });
      const verdict = protectedPathsVerdict(root, { action, path });
      expect(verdict.message ?? "").not.toContain("git metadata");
    });
  });

  it.each(DENIED_COMMANDS)("denies the shell command %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = protectedPathsVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("protected-paths");
    expect(verdict.message).toBe(MESSAGE);
  });

  it.each(ALLOWED_COMMANDS)(
    "does not fire for the shell command %s",
    (command) => {
      const root = tempRepo({ open: true });
      const verdict = protectedPathsVerdict(root, { action: "shell", command });
      expect(verdict.message ?? "").not.toContain("git metadata");
      // No other rule objects either.
      expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
        "allow",
      );
    },
  );

  it("allows reading .git/HEAD with the read tool", () => {
    const root = tempRepo({ open: true });
    const verdict = protectedPathsVerdict(root, {
      action: "read",
      path: ".git/HEAD",
    });
    expect(verdict.decision).toBe("allow");
  });

  it("is a built-in rule: it holds with every rule evaluated together", () => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "write", path: ".git" });
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(MESSAGE);
  });

  it("denies a shell write through a symlink that resolves into .git", () => {
    const root = tempRepo({ open: true });
    symlinkSync(join(root, ".git"), join(root, "alias"));
    const verdict = protectedPathsVerdict(root, {
      action: "shell",
      command: "echo x > alias/config",
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(MESSAGE);
  });

  describe("through the hook", () => {
    // An allow renders as empty output.
    const hook = (root: string, tool: string, input: object) => {
      const out = runHook(
        "claude",
        "PreToolUse",
        JSON.stringify({ cwd: root, tool_name: tool, tool_input: input }),
        { cwd: () => root, env: {} },
      ).stdout;
      if (out.trim() === "") {
        return { permissionDecision: "allow", permissionDecisionReason: "" };
      }
      return JSON.parse(out).hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };

    it("denies a Write to the .git pointer and to a file under .git/", () => {
      const root = tempRepo({ open: true });
      writeRepoFile(root, "sub/keep", "x");
      for (const file_path of [
        join(root, ".git"),
        join(root, ".git/hooks/pre-commit"),
        join(root, "sub/../.git"),
      ]) {
        const out = hook(root, "Write", { file_path, content: "x" });
        expect(out.permissionDecision).toBe("deny");
        expect(out.permissionDecisionReason).toBe(MESSAGE);
      }
    });

    it("denies a Bash redirect onto .git", () => {
      const root = tempRepo({ open: true });
      const out = hook(root, "Bash", { command: "echo gitdir: x > .git" });
      expect(out.permissionDecision).toBe("deny");
      expect(out.permissionDecisionReason).toBe(MESSAGE);
    });

    it("does not block a read of .git/HEAD or a write to .gitignore", () => {
      const root = tempRepo({ open: true });
      expect(
        hook(root, "Read", { file_path: join(root, ".git/HEAD") })
          .permissionDecision,
      ).toBe("allow");
      expect(
        hook(root, "Write", {
          file_path: join(root, ".gitignore"),
          content: "x",
        }).permissionDecisionReason ?? "",
      ).not.toContain("git metadata");
    });
  });
});

const EXPANSION_MESSAGE =
  "Blocked by Warden command-guard: the command could not be parsed safely. Retry with literal paths.";

describe("expansion in write targets fails closed", () => {
  const DENIED_EXPANSIONS = [
    'echo x > "$HOME/.config/panopticon/primaries"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    'echo x > "${HOME}/.config/panopticon/primaries"',
    'echo x > "$VAR/primaries"',
    "echo x > $VAR",
    "cd $HOME/.config/panopticon && echo x > primaries",
    'cd "$VAR" && echo x > primaries',
    'cp x "$VAR/wardens/dist/wardens.mjs"',
    'echo x > "$PRIMARY/wardens/dist/wardens.mjs"',
    'tee "$VAR/wardens/dist/wardens.mjs"',
    "echo x > .g*t/config",
    "echo x > .git*",
    "rm -rf .[g]it",
    "echo x > {.git,y}",
    "echo x > ~root/y",
    'sed -i s/a/b/ "$VAR/config"',
  ];

  it.each(DENIED_EXPANSIONS)("denies %s", (command) => {
    const root = tempRepo({ open: true });
    for (const verdict of [
      protectedPathsVerdict(root, { action: "shell", command }),
      allRulesVerdict(root, { action: "shell", command }),
    ]) {
      expect(verdict.decision).toBe("deny");
      expect(verdict.message).toMatch(MESSAGE_PATTERN);
    }
  });

  it.each([
    'echo x > "$HOME/.config/panopticon/primaries"',
    "echo x > $VAR",
    'cd "$VAR" && echo x > primaries',
    'cp x "$VAR/wardens/dist/wardens.mjs"',
    "echo x > .g*t/config",
  ])("secret-read-guard denies %s with the same message", (command) => {
    const root = tempRepo({ open: true });
    const { event, ctx } = eventFor(root, { action: "shell", command });
    const verdict = finalizeVerdict(
      evaluateRule("secret-read-guard", ctx),
      event,
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(EXPANSION_MESSAGE);
  });

  it("names the expansion in the message", () => {
    const root = tempRepo({ open: true });
    const verdict = protectedPathsVerdict(root, {
      action: "shell",
      command: "echo x > $VAR",
    });
    expect(verdict.message).toBe(EXPANSION_MESSAGE);
  });

  it.each([
    "echo x > /dev/null",
    "ls . 2>&1",
    "ls . > /dev/null 2>&1",
    "echo '$HOME' > out.txt",
    "echo $HOME > out.txt",
    "echo x > ./out/*.txt",
    "cd sub && echo x > y",
    'git commit -m "$MSG"',
    "echo $X",
  ])("still allows %s", (command) => {
    const root = tempRepo({ open: true });
    expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
      "allow",
    );
  });

  it("denies a TMPDIR target, because TMPDIR cannot be proven to resolve into paths.external.write", () => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, {
      action: "shell",
      command: 'echo x > "$TMPDIR/x"',
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(EXPANSION_MESSAGE);
  });
});

describe("the launcher configuration is not editable by agents", () => {
  const ANCHOR_MESSAGE =
    "Blocked by Warden protected-paths: the Wardens launcher configuration is not editable by agents. Label the issue needs:human.";

  it.each([
    "cat ~/.config/panopticon/primaries",
    "ls .config/panopticon",
    "echo x > /Users/someone/.config/panopticon/primaries",
    "echo '/x' >> ~/.config//panopticon/primaries",
    "cd ~/.config/panopticon",
    'echo x > "$HOME/.config/panopticon/primaries"',
  ])("denies shell text naming it: %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
  });

  it("names it with the neutral message", () => {
    const root = tempRepo({ open: true });
    const verdict = protectedPathsVerdict(root, {
      action: "shell",
      command: "cat ~/.config/panopticon/primaries",
    });
    expect(verdict.message).toBe(ANCHOR_MESSAGE);
  });

  it.each(["edit", "write", "delete"] as const)(
    "denies %s on the directory",
    (action) => {
      const root = tempRepo({ open: true });
      for (const path of [
        ".config/panopticon/primaries",
        "sub/.config/panopticon",
      ]) {
        const verdict = protectedPathsVerdict(root, { action, path });
        expect(verdict.decision).toBe("deny");
        expect(verdict.message).toBe(ANCHOR_MESSAGE);
      }
    },
  );

  it("denies the Write tool on the anchor in the home directory", () => {
    const root = tempRepo({ open: true });
    const out = runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: root,
        tool_name: "Write",
        tool_input: {
          file_path: `${process.env.HOME}/.config/panopticon/primaries`,
          content: "/tmp/evil\n",
        },
      }),
      { cwd: () => root, env: {} },
    ).stdout;
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("git commands that rewrite metadata", () => {
  const DENIED_GIT = [
    "git init --separate-git-dir meta x",
    "git init --separate-git-dir=meta",
    "git worktree add x -b y",
    "git worktree remove x",
    "git worktree move a b",
    "git worktree repair",
    "git worktree prune",
    "git worktree lock x",
    "git worktree unlock x",
    "git worktree",
    "git -c core.fsmonitor=evil status",
    "git -c core.pager=evil log",
    "git -c user.name=x commit -m y",
    "git -c alias.x=!evil x",
    "git --config-env=core.pager=EVIL log",
    "git --git-dir=.git commit -m x",
    "git --git-dir .git commit -m x",
    "git --git-dir=meta add .",
    "git --work-tree=other checkout .",
    "git --work-tree other checkout .",
    "git --exec-path=bin status",
    "git config user.name x",
    "git config --global user.name x",
    "git config --unset user.name",
    "git config --add remote.origin.url x",
    "git config --edit",
    "git config user.name",
    "git config --file x.cfg --get a.b",
    "git config --replace-all a.b c",
    "git config core.worktree other",
    "GIT_DIR=/tmp/other git commit -m x",
    "GIT_WORK_TREE=/tmp/other git add .",
    "GIT_CONFIG_GLOBAL=/tmp/x git commit -m y",
  ];

  const ALLOWED_GIT = [
    "git commit -m x",
    "git switch -c feat/1-x",
    "git fetch -q origin",
    "git push -u origin feat/1-x",
    "git status",
    "git -C sub status",
    "git -C sub commit -m x",
    "git worktree list",
    "git worktree list --porcelain",
    "git --git-dir=.git status",
    "git --git-dir .git log --oneline",
    "git -c color.ui=never log",
    "git -c core.quotepath=false diff",
    "git config --get user.name",
    "git config --get-all remote.origin.fetch",
    "git config --get-regexp remote",
    "git config --list",
    "git config -l",
    "git config --list --show-origin",
    "git config --show-origin --get user.name",
    "git config --local --get core.bare",
    "git config --global --list --show-scope",
    "git init",
    "git init -q x",
    "GIT_EDITOR=true git rebase --continue",
    "git diff --stat",
    "git log --oneline -5",
    "git add -A",
  ];

  it.each(DENIED_GIT)("denies %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("command-guard");
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });

  it.each(ALLOWED_GIT)("allows %s", (command) => {
    const root = tempRepo({ open: true });
    expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
      "allow",
    );
  });
});

describe("directory changes the tracker cannot follow fail closed", () => {
  const DENIED_CD = [
    "cd && echo x > config",
    "cd",
    'cd ""',
    'cd "" && echo x > config',
    "cd -",
    "cd - && echo x > config",
    "pushd .git && echo x > config",
    "pushd sub",
    "pushd",
    "popd",
    "cd sub && popd && echo x > y",
    "cd /tmp && echo x > y",
    "cd .. && echo x > y",
    "cd ~ && echo x > y",
    "cd /tmp/claude-1/x-lunarhunt/y && echo x > z",
    "cd ~/.claude/projects/x-lunarhunt/memory && echo x > y",
  ];
  const ALLOWED_CD = [
    "cd apps/web && pnpm test",
    "cd wardens && pnpm exec vitest run",
    "cd . && ls",
    "cd sub/../other && ls",
    "cd .git",
    "cd -P sub && ls",
    "cd sub && cat ../.env.example",
  ];

  it.each(DENIED_CD)("denies %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });

  it.each(["cd", 'cd ""', "cd -", "pushd", "popd", "cd /tmp && ls"])(
    "reports %s as not parseable safely, from both guards",
    (command) => {
      const root = tempRepo({ open: true });
      for (const id of ["secret-read-guard", "protected-paths"] as const) {
        const { event, ctx } = eventFor(root, { action: "shell", command });
        const verdict = finalizeVerdict(evaluateRule(id, ctx), event);
        expect(verdict.message).toBe(EXPANSION_MESSAGE);
      }
    },
  );

  it.each(ALLOWED_CD)("allows %s", (command) => {
    const root = tempRepo({ open: true });
    expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
      "allow",
    );
  });

  it("resolves each word against the tracked directory, not the starting one", () => {
    const root = tempRepo({ open: true });
    // From sub/, ../.env is the repository's .env.
    const secret = allRulesVerdict(root, {
      action: "shell",
      command: "cd sub && cat ../.env",
    });
    expect(secret.decision).toBe("deny");
    expect(secret.rule).toBe("secret-read-guard");
    // And a relative write after cd lands where the shell is.
    const metadata = allRulesVerdict(root, {
      action: "shell",
      command: "cd sub/.. && echo x > .git",
    });
    expect(metadata.message).toBe(MESSAGE);
  });
});

describe("environment that redirects the shell or git fails closed", () => {
  const DENIED_ENV = [
    "CDPATH=x cd y",
    "export CDPATH=x",
    "CDPATH=x; cd y",
    "X=a; export GIT_DIR",
    "X=GIT_DIR; export $X",
    "export GIT_DIR=x",
    "declare -x GIT_DIR=x",
    "typeset GIT_WORK_TREE=x",
    "readonly HOME=x",
    "local PWD=x",
    "GIT_DIR=x; git add .",
    "GIT_DIR=.git git status",
    "env GIT_DIR=x git add .",
    "env -i GIT_DIR=x git add .",
    "env -C sub git status",
    "env -S 'GIT_DIR=x git add .'",
    "command env GIT_DIR=x git add .",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=evil git status",
    "GIT_CONFIG_GLOBAL=/dev/null git log",
    "GIT_CONFIG_PARAMETERS=x git status",
    "HOME=x cmd",
    "PWD=x cmd",
    "OLDPWD=x cmd",
    "BASH_ENV=x bash",
    "ENV=x sh",
    "GIT_EDITOR=true; git rebase --continue",
    "export GIT_EDITOR=true",
    "env GIT_EDITOR=true git rebase --continue",
    "GIT_PAGER=less git log",
    "GIT_EXEC_PATH=x git status",
    "GIT_INDEX_FILE=x git add .",
  ];
  const ALLOWED_ENV = [
    "GIT_EDITOR=true git rebase --continue",
    "GIT_SEQUENCE_EDITOR=true git rebase -i main",
    "GIT_TERMINAL_PROMPT=0 git fetch",
    "GIT_AUTHOR_NAME=x git commit -m y",
    "GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y GIT_COMMITTER_NAME=z git commit -m w",
    "GIT_PAGER=cat git log",
    "CI=1 pnpm test",
    "NODE_ENV=test pnpm test",
    "export FOO=bar",
    "FOO=bar; echo $FOO",
    "env FOO=bar pnpm test",
  ];

  it.each(DENIED_ENV)("denies %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("command-guard");
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });

  it.each(ALLOWED_ENV)("allows %s", (command) => {
    const root = tempRepo({ open: true });
    expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
      "allow",
    );
  });
});

describe("abbreviated long options", () => {
  const sh = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });

  it("git accepts an abbreviation of init's --separate-git-dir but rejects abbreviated global options", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wardens-abbrev-")));
    const meta = join(dir, "meta");
    expect(sh(dir, "init", "-q", `--se=${meta}`, join(dir, "a")).status).toBe(
      0,
    );
    expect(existsSync(meta)).toBe(true);
    // `--s` is ambiguous (`--shared`), `--git-d` is not accepted at all.
    expect(
      sh(dir, "init", "-q", `--s=${meta}-2`, join(dir, "b")).status,
    ).not.toBe(0);
    expect(
      sh(join(dir, "a"), `--git-d=${join(meta, "x")}`, "status").status,
    ).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    "git init --separate-git-dir=meta x",
    "git init --separate-git-dir meta x",
    "git init --separate-git-di=meta",
    "git init --separate=meta x",
    "git init --sepa=meta x",
    "git init --sep=meta x",
    "git init --se=meta x",
    "git clone --se=meta https://example.com/r.git",
    "git --git-d=meta add .",
    "git --git-dir meta add .",
    "git --work-t other checkout .",
    "git --work-tre=other checkout .",
    "git --exec-p=bin status",
    "git --config-e=core.pager=EVIL log",
  ])("denies %s", (command) => {
    const root = tempRepo({ open: true });
    const verdict = allRulesVerdict(root, { action: "shell", command });
    expect(verdict.decision).toBe("deny");
  });

  it.each([
    "git init --shared",
    "git init --bare x",
    "git init -b main",
    "git clone https://example.com/r.git",
    "git --no-pager log",
  ])("allows %s", (command) => {
    const root = tempRepo({ open: true });
    expect(allRulesVerdict(root, { action: "shell", command }).decision).toBe(
      "allow",
    );
  });
});
