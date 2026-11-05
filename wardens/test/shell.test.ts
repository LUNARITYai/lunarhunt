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
