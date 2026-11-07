import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { secretCandidates, tokenize } from "../src/command.ts";
import { runHook } from "../src/engine.ts";
import { charterWithoutWorktree, tempRepo } from "./support.ts";

function real(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

type Fixture = {
  root: string;
  home: string;
  readDir: string;
  writeDir: string;
};

function fixture(): Fixture {
  const root = tempRepo();
  const readDir = real("wardens-shell-read-");
  const writeDir = real("wardens-shell-write-");
  const doc = parse(charterWithoutWorktree());
  doc.paths.external = { read: [`${readDir}/**`], write: [`${writeDir}/**`] };
  writeFileSync(join(root, "panopticon.charter.yaml"), stringify(doc));
  return { root, home: real("wardens-shell-home-"), readDir, writeDir };
}

function bash(f: Fixture, command: string): string {
  const result = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({
      cwd: f.root,
      tool_name: "Bash",
      tool_input: { command },
    }),
    { cwd: () => f.root, env: {}, home: f.home },
  );
  return result.stdout;
}

function allowed(out: string): boolean {
  return out === "";
}

const HEREDOC = (head: string, delimiter: string, body: string) =>
  `${head} <<${delimiter}\n${body}\nEOF`;

describe("quoted heredocs", () => {
  it("allows git commit -F - with a quoted delimiter", () => {
    const f = fixture();
    const body = "subject\n\nsee /etc/passwd and $(rm -rf x) and `id`";
    expect(allowed(bash(f, HEREDOC("git commit -F -", "'EOF'", body)))).toBe(
      true,
    );
    expect(allowed(bash(f, HEREDOC("git commit -F -", '"EOF"', body)))).toBe(
      true,
    );
    expect(allowed(bash(f, HEREDOC("git commit -F -", "-'EOF'", body)))).toBe(
      true,
    );
  });

  it("denies an unquoted heredoc", () => {
    const f = fixture();
    const out = bash(f, HEREDOC("git commit -F -", "EOF", "x $(date)"));
    expect(out).toContain("command-guard");
    expect(out).toContain("could not be parsed safely");
  });

  it("denies oddly quoted, unterminated and partly quoted delimiters", () => {
    const f = fixture();
    for (const command of [
      "cat <<E'O'F\nx\nEOF",
      "cat <<'EOF'\nx\n",
      "cat <<'EOF'",
      "cat <<'EOF'x\nx\nEOF",
    ]) {
      expect(bash(f, command), command).toContain("command-guard");
    }
  });

  it("still evaluates the command before the heredoc with every rule", () => {
    const f = fixture();
    expect(
      bash(f, HEREDOC("git commit --no-verify -F -", "'EOF'", "x")),
    ).toContain("--no-verify");
    expect(bash(f, HEREDOC("cat .env", "'EOF'", "x"))).toContain(
      "secret-read-guard",
    );
    expect(bash(f, HEREDOC("cat /etc/passwd", "'EOF'", "x"))).toContain(
      "path escapes the worktree",
    );
  });

  it("evaluates commands after the heredoc terminator", () => {
    const f = fixture();
    const out = bash(f, "cat <<'EOF'\nhello\nEOF\ngit push --force");
    expect(out).toContain("git push --force is denied");
  });

  it("does not turn the body into commands or paths", () => {
    const pipeline = tokenize("cat <<'EOF'\ngit push --force /etc/passwd\nEOF");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.segments.map((s) => s.argv)).toEqual([["cat"], []]);
    }
  });

  it("denies a heredoc fed to an interpreter or exec wrapper", () => {
    const f = fixture();
    const body = "\ngit push --force\nEOF";
    for (const command of [
      `bash <<'EOF'${body}`,
      `sh <<'EOF'${body}`,
      `/bin/sh <<'EOF'${body}`,
      `cat <<'EOF' | sh${body}`,
      `cat <<'EOF' | bash -s${body}`,
      `cat <<'EOF' | /usr/bin/env sh${body}`,
      `python3 - <<'EOF'${body}`,
      `python3.12 - <<'EOF'${body}`,
      `node <<'EOF'${body}`,
      `xargs -I{} sh -c {} <<'EOF'${body}`,
      `env bash <<'EOF'${body}`,
      `sudo sh <<'EOF'${body}`,
      `exec bash <<'EOF'${body}`,
      `source /dev/stdin <<'EOF'${body}`,
      `. /dev/stdin <<'EOF'${body}`,
      `eval "$(cat <<'EOF'${body}\n)"`,
      `timeout 5 bash <<'EOF'${body}`,
      `nohup sh <<'EOF'${body}`,
      `perl <<'EOF'${body}`,
      `awk -f /dev/stdin <<'EOF'${body}`,
      `ruby <<'EOF'${body}`,
      `ls <<'EOF'${body}`,
      `cat <<'EOF'\nx\nEOF\n| sh`,
      `cat <<'EOF' && bash -c 'git push --force'\nx\nEOF`,
    ]) {
      const out = bash(f, command);
      expect(out, command).toContain("command-guard");
      expect(out, command).toContain("could not be parsed safely");
    }
  });

  it("still allows heredocs for git, gh, cat and tee", () => {
    const f = fixture();
    for (const command of [
      "git commit -F - <<'EOF'\nmsg\nEOF",
      "gh pr create --body-file - <<'EOF'\nbody\nEOF",
      "cat <<'EOF' > x.md\nbody\nEOF",
      "tee x.md <<'EOF'\nbody\nEOF",
      "cat <<'EOF' | tee x.md\nbody\nEOF",
    ]) {
      expect(allowed(bash(f, command)), command).toBe(true);
    }
  });

  it("strips leading tabs for <<- only", () => {
    const f = fixture();
    expect(allowed(bash(f, "cat <<-'EOF'\n\tx\n\tEOF"))).toBe(true);
    expect(bash(f, "cat <<'EOF'\nx\n\tEOF")).toContain("command-guard");
  });
});

describe("message-like option values", () => {
  it("does not take quoted body text for a path", () => {
    const f = fixture();
    const body = "'... /etc/passwd and ../../x ...'";
    expect(
      allowed(bash(f, `gh pr create --body ${body} --title 'a /etc/b'`)),
    ).toBe(true);
    expect(allowed(bash(f, `git commit -m ${body}`))).toBe(true);
    expect(allowed(bash(f, `git commit -am ${body}`))).toBe(true);
    expect(allowed(bash(f, `gh release create v1 --notes=${body}`))).toBe(true);
    expect(allowed(bash(f, `gh pr create -b ${body} -t ${body}`))).toBe(true);
  });

  it("keeps plausible paths as candidates", () => {
    const f = fixture();
    expect(bash(f, "cat /etc/passwd")).toContain("path escapes the worktree");
    expect(bash(f, "echo '/etc/passwd'")).toContain(
      "path escapes the worktree",
    );
    expect(bash(f, "gh pr create --body-file /etc/passwd")).toContain(
      "path escapes the worktree",
    );
    expect(bash(f, "git commit -F /etc/passwd")).toContain(
      "path escapes the worktree",
    );
    expect(bash(f, "git commit -F .env")).toContain("secret-read-guard");
    expect(bash(f, "gh pr create --body-file .env")).toContain(
      "secret-read-guard",
    );
  });

  it("does not skip the word after a short flag of another command", () => {
    const f = fixture();
    expect(bash(f, "ls -m .env")).toContain("secret-read-guard");
    expect(bash(f, "cat -t .env")).toContain("secret-read-guard");
  });

  it("lists candidates with read and write classes", () => {
    const pipeline = tokenize("cp a b");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      const [segment] = pipeline.segments;
      expect(secretCandidates(segment as never)).toEqual([
        { path: "cp", write: true },
        { path: "a", write: false },
        { path: "b", write: true },
      ]);
    }
  });
});

describe("key=value candidates (#75)", () => {
  function candidates(command: string) {
    const pipeline = tokenize(command);
    expect(pipeline.ok).toBe(true);
    return pipeline.ok
      ? secretCandidates(pipeline.segments[0] as never).map((c) => c.path)
      : [];
  }

  it("lists the value of a key=value word and of an --opt=value word", () => {
    expect(candidates("dd if=a of=/abs/b")).toContain("/abs/b");
    expect(candidates("dd if=a of=/abs/b")).toContain("a");
    expect(candidates("tool --out=../x")).toContain("../x");
  });

  it("does not list the assignments in front of the command", () => {
    expect(candidates("A=/tmp/x pnpm check")).not.toContain("/tmp/x");
    expect(candidates("env A=/tmp/x B=../y pnpm check")).not.toContain(
      "/tmp/x",
    );
    expect(candidates("env A=/tmp/x pnpm check B=/abs")).toContain("/abs");
  });

  it("keeps a glued short option value secret-read only", () => {
    const pipeline = tokenize("cut -d/ -f1 f");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      const glued = secretCandidates(pipeline.segments[0] as never).find(
        (c) => c.path === "/",
      );
      expect(glued).toEqual({ path: "/", write: false, secretOnly: true });
    }
  });
});

describe("paths.external in shell", () => {
  it("allows a read below paths.external.read and a write below write", () => {
    const f = fixture();
    expect(allowed(bash(f, `cat ${join(f.readDir, "a.txt")}`))).toBe(true);
    expect(allowed(bash(f, `cat < ${join(f.readDir, "a.txt")}`))).toBe(true);
    expect(allowed(bash(f, `cat ${join(f.writeDir, "a.txt")}`))).toBe(true);
    expect(allowed(bash(f, `echo x > ${join(f.writeDir, "a.txt")}`))).toBe(
      true,
    );
    expect(allowed(bash(f, `echo x >> ${join(f.writeDir, "a.txt")}`))).toBe(
      true,
    );
    expect(allowed(bash(f, `echo x >${join(f.writeDir, "a.txt")}`))).toBe(true);
    expect(allowed(bash(f, `cp a.txt ${join(f.writeDir, "a.txt")}`))).toBe(
      true,
    );
    expect(allowed(bash(f, `cp ${join(f.readDir, "a.txt")} .`))).toBe(true);
    expect(allowed(bash(f, `mkdir -p ${join(f.writeDir, "d")}`))).toBe(true);
  });

  it("normalizes .. in an external path", () => {
    const f = fixture();
    const sneaky = join(f.readDir, "x", "..", "..", "elsewhere");
    expect(bash(f, `cat ${sneaky}`)).toContain("path escapes the worktree");
  });

  it("denies a write to a path that is only readable", () => {
    const f = fixture();
    const target = join(f.readDir, "a.txt");
    for (const command of [
      `echo x > ${target}`,
      `echo x >> ${target}`,
      `echo x >${target}`,
      `rm ${target}`,
      `touch ${target}`,
      `cp a ${target}`,
      `mv a ${target}`,
      `cp -t ${f.readDir} a`,
      `sed -i s/a/b/ ${target}`,
    ]) {
      expect(bash(f, command), command).toContain("path escapes the worktree");
    }
  });

  it("denies a path outside every external glob", () => {
    const f = fixture();
    expect(
      bash(f, `echo x > ${join(tmpdir(), "wardens-nowhere.txt")}`),
    ).toContain("path escapes the worktree");
    expect(bash(f, "echo x > /etc/passwd")).toContain(
      "path escapes the worktree",
    );
    expect(bash(f, "echo x >/etc/passwd")).toContain(
      "path escapes the worktree",
    );
  });

  it("checks the basename of an external path for secrets", () => {
    const f = fixture();
    expect(bash(f, `cat ${join(f.readDir, ".env")}`)).toContain(
      "secret-read-guard",
    );
    expect(bash(f, `cat ${join(f.writeDir, ".env.production")}`)).toContain(
      "secret-read-guard",
    );
    expect(allowed(bash(f, `cat ${join(f.readDir, ".env.example")}`))).toBe(
      true,
    );
  });

  it("expands ~ with the injected home", () => {
    const f = fixture();
    expect(bash(f, "cat ~/notes.txt")).toContain("path escapes the worktree");
  });

  it("denies external shell paths without a paths.external key", () => {
    const f = fixture();
    const doc = parse(charterWithoutWorktree());
    writeFileSync(join(f.root, "panopticon.charter.yaml"), stringify(doc));
    expect(bash(f, `cat ${join(f.readDir, "a.txt")}`)).toContain(
      "path escapes the worktree",
    );
  });
});

describe("shell comments in the tokenizer", () => {
  it("drops a comment up to the newline and flags it", () => {
    const pipeline = tokenize("echo a # b; rm x");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.segments.map((segment) => segment.argv)).toEqual([
        ["echo", "a"],
      ]);
      expect(pipeline.comment).toBe(true);
      expect(pipeline.newline).toBe(false);
    }
  });

  it("keeps the command after the comment line and flags the newline", () => {
    const pipeline = tokenize("ls # x \\\nrm -rf y");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.segments.map((segment) => segment.argv)).toEqual([
        ["ls"],
        ["rm", "-rf", "y"],
      ]);
      expect(pipeline.newline).toBe(true);
    }
  });

  it("does not treat a mid-word or quoted # as a comment", () => {
    for (const command of ["echo a#b", "echo '#x'", 'echo "#x"']) {
      const pipeline = tokenize(command);
      expect(pipeline.ok && pipeline.comment, command).toBe(false);
    }
  });
});

describe("a # the shell reads differently from the tokenizer", () => {
  const f = fixture();

  it("still hits commands.deny", () => {
    for (const command of [
      "echo $\u007bx:- #}; git push --force origin main",
      "echo $\u007bx:-a #}&& npm publish",
      "echo $[1 #]; git push +main",
      "echo a # x; git push --force",
      "git commit -m a #note --no-verify",
      "echo a # x \\\ngit push --force",
    ]) {
      expect(bash(f, command), command).toContain("command-guard");
    }
  });

  it("fails closed when a real comment meets shell syntax that can change #", () => {
    const parse = "the command could not be parsed safely";
    for (const command of [
      "echo a # it's\necho $\u007bx:- #}; git push --force origin main; echo 'x' # it's",
      "echo a # it's\necho $\u007bx:- #}; npm publish; echo 'x' # it's",
      "echo a # c\necho $\u007bx#pat}",
      "echo a # c\necho $[1 #]",
      "echo a # c\necho $(( 1 #))",
      "echo a # c\ncase x in x) git push --force;; esac",
    ]) {
      expect(bash(f, command), command).toContain(parse);
    }
  });

  it("fails closed for a # right after a parenthesis or brace", () => {
    for (const command of [
      "(echo a)# x \\\ngit push --force origin main",
      "(# y \\\ngit push --force origin main)",
      "(echo a)#x \\\nnpm publish",
      "echo a;(# x \\\ngit push --force)",
      "{ echo a; }# x \\\ngit push --force",
      "a)#x \\\ngit push --force",
    ]) {
      expect(bash(f, command), command).toContain("command-guard");
    }
  });

  it("fails closed for operator-adjacent # and # with a continuation", () => {
    for (const command of [
      "echo a &!# x \\\ngit push --force origin main",
      "echo a &|# x \\\nnpm publish",
      "echo a &! # x \\\ngit push --force",
      "ls # c \\\ngit push --force",
    ]) {
      expect(bash(f, command), command).toContain("command-guard");
    }
  });

  it("splits zsh &! and &| like &", () => {
    for (const command of [
      "echo a &! git push --force",
      "echo a &| npm publish",
    ]) {
      expect(bash(f, command), command).toContain("command-guard");
    }
  });

  it("keeps a continuation without # working", () => {
    expect(allowed(bash(f, "pnpm --filter wardens \\\ntest"))).toBe(true);
  });

  it("keeps plain comments and quoted # working", () => {
    for (const command of [
      "pnpm check # run the checks",
      "git log --grep='#12'",
      "gh issue comment 5 --body 'fix #12'",
    ]) {
      expect(allowed(bash(f, command)), command).toBe(true);
    }
  });

  it("still hits secret-read-guard", () => {
    for (const command of ["cat .env # c", "echo x #; cat .env"]) {
      expect(bash(f, command), command).toContain("secret-read-guard");
    }
  });
});

// #79: an unquoted redirect operator ends the word before it, as in the shell.
describe("glued redirects in the tokenizer", () => {
  function words(command: string): string[] {
    const pipeline = tokenize(command);
    expect(pipeline.ok, command).toBe(true);
    return pipeline.ok ? (pipeline.segments[0]?.argv ?? []) : [];
  }

  it.each([
    ["echo x>f", ["echo", "x", ">f"]],
    ["echo x>>f", ["echo", "x", ">>f"]],
    ["echo x>|f", ["echo", "x", ">|f"]],
    ["echo x<f", ["echo", "x", "<f"]],
    ["echo x<>f", ["echo", "x", "<>f"]],
    ["echo x&>f", ["echo", "x", "&>f"]],
    ["echo x&>>f", ["echo", "x", "&>>f"]],
    ["echo x>&2", ["echo", "x", ">&2"]],
    ["echo x<&-", ["echo", "x", "<&-"]],
    ["echo x>&f", ["echo", "x", ">&f"]],
    ["echo x 2>f", ["echo", "x", "2>f"]],
    ["echo x 2>>f", ["echo", "x", "2>>f"]],
    ["echo x 0<f", ["echo", "x", "0<f"]],
    ["echo x 2>&1", ["echo", "x", "2>&1"]],
    ["echo x 1<&0", ["echo", "x", "1<&0"]],
    ["echo x {fd}>f", ["echo", "x", "{fd}>f"]],
    ["echo x>f>g", ["echo", "x", ">f", ">g"]],
    ["echo x>f 2>&1", ["echo", "x", ">f", "2>&1"]],
    ["echo x 2>&1>f", ["echo", "x", "2>&1", ">f"]],
    ["echo x<a>b", ["echo", "x", "<a", ">b"]],
    // `a=b` is the assignment, `>c` the redirect
    ["a=b>c", [">c"]],
    ["x>f", ["x", ">f"]],
    ["echo>f", ["echo", ">f"]],
    ["cat<<<x", ["cat", "<<<x"]],
    ["cat x<<<y", ["cat", "x", "<<<y"]],
    ["cat 0<<<y", ["cat", "0<<<y"]],
    ["echo 'a'>f", ["echo", "a", ">f"]],
    ['echo "a">f', ["echo", "a", ">f"]],
    // digits are a descriptor only as the whole word before the operator
    ["echo x2>f", ["echo", "x2", ">f"]],
    ["echo 2x>f", ["echo", "2x", ">f"]],
    ['echo "2">f', ["echo", "2", ">f"]],
    ["echo \\2>f", ["echo", "2", ">f"]],
    ["echo a=2>f", ["echo", "a=2", ">f"]],
    ["echo 22>f", ["echo", "22>f"]],
    ["echo 2 >f", ["echo", "2", ">f"]],
  ])("splits %s", (command, expected) => {
    expect(words(command)).toEqual(expected);
  });

  it.each([
    ["rg 'a>b'", ["rg", "a>b"]],
    ['echo "x<y"', ["echo", "x<y"]],
    ["git log --format='%h > %s'", ["git", "log", "--format=%h > %s"]],
    ['git commit -m "a>b"', ["git", "commit", "-m", "a>b"]],
    ["echo x\\>y", ["echo", "x>y"]],
    ["echo x\\<y", ["echo", "x<y"]],
    ["echo 'x'\">\"'y'", ["echo", "x>y"]],
  ])("keeps %s literal", (command, expected) => {
    const pipeline = tokenize(command);
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.segments[0]?.argv).toEqual(expected);
      expect(pipeline.segments[0]?.meta).toEqual([]);
    }
  });

  it("reads a redirect after an assignment-like word as an assignment and a redirect", () => {
    const pipeline = tokenize("a=b>c");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.segments[0]?.env).toEqual({ a: "b" });
      expect(pipeline.segments[0]?.meta).toEqual([0]);
    }
  });

  it("flags only the redirect words as meta", () => {
    const pipeline = tokenize("echo x>f y 2>&1 z<g");
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      const [segment] = pipeline.segments;
      expect(segment?.argv).toEqual([
        "echo",
        "x",
        ">f",
        "y",
        "2>&1",
        "z",
        "<g",
      ]);
      expect(segment?.meta).toEqual([2, 4, 6]);
    }
  });

  it("lists the target of a glued redirect as a candidate exactly like a spaced one", () => {
    const pairs: Array<[string, string]> = [
      ["echo x > f", "echo x>f"],
      ["echo x >> f", "echo x>>f"],
      ["echo x 2> f", "echo x 2>f"],
      ["echo x >| f", "echo x>|f"],
      ["echo x &> f", "echo x&>f"],
      ["echo x >& f", "echo x>&f"],
      ["echo x <> f", "echo x<>f"],
      ["cat x < f", "cat x<f"],
      ["cat x 0< f", "cat x 0<f"],
      ["cat x 2>&1", "cat x 2>&1"],
      ["cat x <&-", "cat x<&-"],
    ];
    const list = (command: string) => {
      const pipeline = tokenize(command);
      expect(pipeline.ok, command).toBe(true);
      return pipeline.ok
        ? secretCandidates(pipeline.segments[0] as never).map(
            (c) => `${c.path}:${c.write}`,
          )
        : [];
    };
    for (const [spaced, glued] of pairs) {
      expect(list(glued), glued).toEqual(list(spaced));
    }
    expect(list("echo x>f")).toContain("f:true");
    expect(list("cat x<f")).toContain("f:false");
  });

  it("keeps heredocs and here-strings working glued to the word before", () => {
    const f = fixture();
    const body = "subject\n\nsee /etc/passwd and $(rm -rf x) and `id`";
    for (const head of ["git commit -F -", "git commit -F-", "cat", "cat -"]) {
      for (const glued of ["<<'EOF'", '<<"EOF"']) {
        const command = `${head}${glued}\n${body}\nEOF`;
        expect(allowed(bash(f, command)), command).toBe(true);
      }
    }
    expect(allowed(bash(f, "cat<<<'x'"))).toBe(true);
    expect(allowed(bash(f, "cat -<<<'/etc/passwd'"))).toBe(false);
    expect(allowed(bash(f, "cat <<<'/etc/passwd'"))).toBe(false);
  });

  it("applies paths.external to a glued redirect like a spaced one", () => {
    const f = fixture();
    const read = join(f.readDir, "a.txt");
    const write = join(f.writeDir, "a.txt");
    for (const command of [
      `echo x>${write}`,
      `echo x>>${write}`,
      `echo x 2>${write}`,
      `echo x&>${write}`,
      `cat<${read}`,
      `cat x<${read}`,
    ]) {
      expect(allowed(bash(f, command)), command).toBe(true);
    }
    for (const command of [
      `echo x>${read}`,
      `echo x>>${read}`,
      `echo x&>${read}`,
      `echo x>${f.readDir}/../a.txt`,
      "echo x>/etc/hosts",
      "cat</etc/hosts",
    ]) {
      expect(allowed(bash(f, command)), command).toBe(false);
    }
  });
});

describe("device paths in shell", () => {
  const devices = [
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/stdin",
    "/dev/fd/0",
    "/dev/fd/12",
  ];
  const forms = [
    (d: string) => `echo x >${d}`,
    (d: string) => `echo x > ${d}`,
    (d: string) => `echo x >>${d}`,
    (d: string) => `echo x >> ${d}`,
    (d: string) => `echo x >|${d}`,
    (d: string) => `echo x 2>${d}`,
    (d: string) => `echo x 2> ${d}`,
    (d: string) => `echo x &>${d}`,
    (d: string) => `echo x &> ${d}`,
    (d: string) => `cat <${d}`,
    (d: string) => `cat < ${d}`,
    (d: string) => `echo x | tee ${d}`,
    // glued to the previous word (#79)
    (d: string) => `echo x>${d}`,
    (d: string) => `echo x>>${d}`,
    (d: string) => `echo x>|${d}`,
    (d: string) => `echo x 2>${d}`,
    (d: string) => `echo x&>${d}`,
    (d: string) => `echo x&>>${d}`,
    (d: string) => `echo x>&${d}`,
    (d: string) => `cat<${d}`,
    (d: string) => `cat x<${d}`,
  ];

  it("are not path candidates in any redirect form", () => {
    const f = fixture();
    for (const device of devices) {
      for (const form of forms) {
        const command = form(device);
        expect(allowed(bash(f, command)), command).toBe(true);
      }
    }
  });

  it("keeps other /dev paths and traversal as escaping candidates", () => {
    const f = fixture();
    for (const path of [
      "/dev/sda",
      "/dev/null2",
      "/dev/fd/x",
      "/dev/fd/",
      "/dev/../etc/passwd",
    ]) {
      for (const command of [
        `echo x >${path}`,
        `echo x 2> ${path}`,
        `tee ${path}`,
      ]) {
        expect(bash(f, command), command).toContain(
          "path escapes the worktree",
        );
      }
    }
  });
});

describe("a home that cannot be resolved (#73)", () => {
  function viaEnv(f: Fixture, command: string, env: NodeJS.ProcessEnv): string {
    return runHook(
      "claude",
      "PreToolUse",
      JSON.stringify({
        cwd: f.root,
        tool_name: "Bash",
        tool_input: { command },
      }),
      { cwd: () => f.root, env },
    ).stdout;
  }

  function withHomeGlob(f: Fixture): void {
    const doc = parse(charterWithoutWorktree());
    doc.paths.external = { read: ["~/.wardens-cache/**"], write: [] };
    writeFileSync(join(f.root, "panopticon.charter.yaml"), stringify(doc));
  }

  it("grants a ~ external read only when HOME resolves", () => {
    const f = fixture();
    withHomeGlob(f);
    const command = "cat ~/.wardens-cache/x";
    expect(allowed(viaEnv(f, command, { HOME: f.home }))).toBe(true);
    for (const HOME of ["", "relative/home"]) {
      expect(allowed(viaEnv(f, command, { HOME }))).toBe(false);
    }
  });

  it("denies writes to and reads of home-relative paths as unprovable", () => {
    const f = fixture();
    for (const HOME of ["", "relative/home"]) {
      for (const command of [
        "echo hi > ~/x",
        "tee ~/x",
        "cat ~/.ssh/id_rsa",
        "cd ~ && touch y",
      ]) {
        expect(allowed(viaEnv(f, command, { HOME })), command).toBe(false);
      }
      const write = runHook(
        "claude",
        "PreToolUse",
        JSON.stringify({
          cwd: f.root,
          tool_name: "Write",
          tool_input: { file_path: "~/x", content: "x" },
        }),
        { cwd: () => f.root, env: { HOME } },
      ).stdout;
      expect(allowed(write)).toBe(false);
    }
  });
});
