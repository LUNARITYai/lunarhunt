import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { loadCharterAt, loadCharterYaml } from "../src/charter.ts";
import { runHook } from "../src/engine.ts";
import { caseInsensitiveAt } from "../src/paths.ts";
import { normativeCharter, repoRoot, tempRepo } from "./support.ts";

type External = { read?: string[]; write?: string[] };

function charterWith(external: External | undefined): string {
  const doc = parse(normativeCharter());
  if (external) {
    doc.paths.external = external;
  }
  return stringify(doc);
}

function real(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

type Fixture = {
  root: string;
  home: string;
  outside: string;
};

function fixture(external: External | undefined): Fixture {
  const root = tempRepo();
  writeFileSync(join(root, "panopticon.charter.yaml"), charterWith(external));
  const home = real("wardens-home-");
  const outside = real("wardens-out-");
  return { root, home, outside };
}

function hook(
  f: Fixture,
  tool: "claude" | "cursor",
  event: string,
  payload: Record<string, unknown>,
) {
  const result = runHook(
    tool,
    event,
    JSON.stringify({ cwd: f.root, ...payload }),
    { cwd: () => f.root, env: {}, home: f.home },
  );
  return result.stdout;
}

function claude(f: Fixture, name: string, filePath: string): string {
  return hook(f, "claude", "PreToolUse", {
    tool_name: name,
    tool_input: { file_path: filePath },
  });
}

function decision(stdout: string): string {
  if (stdout === "") {
    return "allow";
  }
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

function lastLog(root: string): Record<string, unknown> {
  const lines = readFileSync(
    join(root, ".panopticon/wardens.log.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}");
}

describe("paths.external charter validation", () => {
  it("accepts a charter without the key and the repository charter", () => {
    expect(loadCharterYaml(charterWith(undefined)).ok).toBe(true);
    expect(loadCharterAt(repoRoot).ok).toBe(true);
  });

  it("accepts absolute and ~/ globs", () => {
    const result = loadCharterYaml(
      charterWith({
        read: ["~/.claude/projects/*x*/memory/**"],
        write: ["/tmp/claude-*/**"],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    "relative/path/**",
    "**/x",
    "/",
    "~",
    "~/",
    "/**",
    "/*",
    "~/**",
    "~/*",
    "/*/foo",
    "/**/foo",
    "~/*/foo",
    "/{a,b}/x",
    "/tmp/../etc/**",
  ])("rejects %s", (glob) => {
    expect(loadCharterYaml(charterWith({ read: [glob] })).ok).toBe(false);
    expect(loadCharterYaml(charterWith({ write: [glob] })).ok).toBe(false);
  });

  it("rejects unknown keys", () => {
    const doc = parse(normativeCharter());
    doc.paths.external = { exec: ["/tmp/x/**"] };
    expect(loadCharterYaml(stringify(doc)).ok).toBe(false);
  });
});

describe("paths.external engine", () => {
  it("keeps the deny when the key is missing", () => {
    const f = fixture(undefined);
    const out = claude(f, "Read", join(f.outside, "a.txt"));
    expect(decision(out)).toBe("deny");
    expect(out).toContain("path escapes the worktree");
  });

  it("keeps the deny when no glob matches", () => {
    const f = fixture({ read: [`${real("wardens-other-")}/**`] });
    const out = claude(f, "Read", join(f.outside, "a.txt"));
    expect(out).toContain("path escapes the worktree");
  });

  it("expands ~/ with the injected home dir", () => {
    const f = fixture({ read: ["~/.claude/memory/**"] });
    const target = join(f.home, ".claude/memory/note.md");
    expect(decision(claude(f, "Read", target))).toBe("allow");
    expect(decision(claude(f, "Read", join(f.home, "other.md")))).toBe("deny");
  });

  it("allows a read through a read glob and through a write glob", () => {
    const f2 = fixture({ read: [] });
    writeFileSync(
      join(f2.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f2.outside}/**`] }),
    );
    expect(decision(claude(f2, "Read", join(f2.outside, "x.txt")))).toBe(
      "allow",
    );
    const f3 = fixture({ write: [] });
    writeFileSync(
      join(f3.root, "panopticon.charter.yaml"),
      charterWith({ write: [`${f3.outside}/**`] }),
    );
    expect(decision(claude(f3, "Read", join(f3.outside, "x.txt")))).toBe(
      "allow",
    );
  });

  it("allows writes only through a write glob", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({
        read: [`${f.outside}/ro/**`],
        write: [`${f.outside}/rw/**`],
      }),
    );
    for (const name of ["Edit", "Write"]) {
      expect(decision(claude(f, name, join(f.outside, "rw/a.txt")))).toBe(
        "allow",
      );
      expect(decision(claude(f, name, join(f.outside, "ro/a.txt")))).toBe(
        "deny",
      );
    }
  });

  it("does not apply repo-relative rules to an external write", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ write: [`${f.outside}/**`] }),
    );
    // Not in allowed_paths and named like a protected file: still allowed.
    const out = claude(f, "Write", join(f.outside, "panopticon.charter.yaml"));
    expect(decision(out)).toBe("allow");
  });

  it("denies a secret basename inside an allowed directory", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f.outside}/**`] }),
    );
    const out = claude(f, "Read", join(f.outside, ".env"));
    expect(decision(out)).toBe("deny");
    expect(out).toContain("secret-read-guard");
    expect(decision(claude(f, "Read", join(f.outside, ".env.example")))).toBe(
      "allow",
    );
  });

  it("denies a secret basename in any case inside an allowed directory (#77)", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f.outside}/**`], write: [`${f.outside}/**`] }),
    );
    for (const name of [".ENV", ".Env.Local", ".eNV.production"]) {
      const target = join(f.outside, name);
      expect(claude(f, "Read", target), name).toContain("secret-read-guard");
    }
    expect(decision(claude(f, "Read", join(f.outside, ".ENV.EXAMPLE")))).toBe(
      "allow",
    );
  });

  it("matches another case of an allowed directory only where the volume does (#77)", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f.outside}/**`] }),
    );
    const parent = join(f.outside, "..");
    const swapped = join(
      parent,
      [...basename(f.outside)]
        .map((ch) =>
          ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
        )
        .join(""),
    );
    // The independent truth: does the swapped spelling reach the same directory?
    const same = existsSync(swapped);
    expect(caseInsensitiveAt(f.outside)).toBe(same);
    expect(decision(claude(f, "Read", join(swapped, "a.txt")))).toBe(
      same ? "allow" : "deny",
    );
  });

  it("still allows a directory whose name changes length when folded (#77)", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f.outside}/**`] }),
    );
    mkdirSync(join(f.outside, "Straße"));
    expect(decision(claude(f, "Read", join(f.outside, "Straße/a.txt")))).toBe(
      "allow",
    );
  });

  it("does not match a .. escape or a symlink escape", () => {
    const f = fixture({});
    const secret = real("wardens-secret-");
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ read: [`${f.outside}/allowed/**`] }),
    );
    mkdirSync(join(f.outside, "allowed"));
    symlinkSync(secret, join(f.outside, "allowed/link"));
    const dotdot = join(f.outside, "allowed/../sibling.txt");
    expect(claude(f, "Read", dotdot)).toContain("path escapes the worktree");
    const viaLink = join(f.outside, "allowed/link/x.txt");
    expect(claude(f, "Read", viaLink)).toContain("path escapes the worktree");
  });

  it("matches through a symlinked prefix like /tmp on macOS", () => {
    const f = fixture({});
    const base = real("wardens-link-");
    const alias = join(base, "alias");
    mkdirSync(join(base, "target"));
    symlinkSync(join(base, "target"), alias);
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ write: [`${alias}/claude-*/**`] }),
    );
    mkdirSync(join(base, "target/claude-1"));
    // Glob written via the alias, tool path via the alias and via the real path.
    expect(decision(claude(f, "Write", join(alias, "claude-1/a.txt")))).toBe(
      "allow",
    );
    expect(
      decision(claude(f, "Write", join(base, "target/claude-1/a.txt"))),
    ).toBe("allow");
  });

  it("logs the absolute normalized path", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ write: [`${f.outside}/**`] }),
    );
    claude(f, "Write", join(f.outside, "sub/../a.txt"));
    const line = lastLog(f.root);
    expect(line.path).toBe(join(f.outside, "a.txt"));
    expect(line.decision).toBe("allow");
    expect(line.rule).toBe("none");
  });

  it("does not report an allowed external write in the post-edit audit", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({ write: [`${f.outside}/**`] }),
    );
    const target = join(f.outside, "a.txt");
    const post = hook(f, "claude", "PostToolUse", {
      tool_name: "Write",
      tool_input: { file_path: target },
    });
    expect(post).toBe("");
    const cursor = hook(f, "cursor", "afterFileEdit", { file_path: target });
    expect(cursor).not.toContain("deny");
    expect(lastLog(f.root).decision).toBe("allow");
  });

  it("handles the Cursor read, Read and Delete events", () => {
    const f = fixture({});
    writeFileSync(
      join(f.root, "panopticon.charter.yaml"),
      charterWith({
        read: [`${f.outside}/ro/**`],
        write: [`${f.outside}/rw/**`],
      }),
    );
    const before = (p: string) =>
      JSON.parse(hook(f, "cursor", "beforeReadFile", { file_path: p }))
        .permission;
    expect(before(join(f.outside, "ro/a.txt"))).toBe("allow");
    expect(before(join(f.outside, "nope/a.txt"))).toBe("deny");
    expect(before(join(f.outside, "ro/.env"))).toBe("deny");

    const pre = (tool: string, p: string) =>
      JSON.parse(
        hook(f, "cursor", "preToolUse", {
          tool_name: tool,
          tool_input: { path: p },
        }),
      ).permission;
    expect(pre("Read", join(f.outside, "ro/a.txt"))).toBe("allow");
    expect(pre("Delete", join(f.outside, "rw/a.txt"))).toBe("allow");
    expect(pre("Delete", join(f.outside, "ro/a.txt"))).toBe("deny");
    expect(pre("Write", join(f.outside, "rw/a.txt"))).toBe("allow");
  });
});
