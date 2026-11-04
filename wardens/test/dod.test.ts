import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DodDeps,
  failedTasks,
  fingerprint,
  outputTail,
} from "../src/dod.ts";
import { runHook } from "../src/engine.ts";
import { MESSAGE_PATTERN } from "../src/messages.ts";
import { dodState, fakeCheck, git, trackedRepo } from "./dod-support.ts";
import { writeRepoFile } from "./support.ts";

const RED = {
  status: "red" as const,
  output: "lots of text\n Tasks: 1 failed\n Failed:    api#test\n",
};
const GREEN = { status: "green" as const, output: "" };
const LIMIT =
  "Blocked by Warden definition-of-done: pnpm check is still red after 3 attempts. Label the issue needs:human.";

function dirtyRepo(): string {
  const root = trackedRepo();
  writeRepoFile(root, "work.txt", "one\n");
  return root;
}

function stop(root: string, dod: DodDeps, session = "s1") {
  return runHook(
    "claude",
    "Stop",
    JSON.stringify({ session_id: session, cwd: root }),
    { cwd: () => root, env: {}, dod },
  );
}

function cursorStop(root: string, dod: DodDeps, status = "completed") {
  return runHook(
    "cursor",
    "stop",
    JSON.stringify({ conversation_id: "c1", cwd: root, status }),
    { cwd: () => root, env: {}, dod },
  );
}

function log(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, ".panopticon/wardens.log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("definition-of-done decisions", () => {
  it("lets Cursor stops with status aborted or error through without running pnpm check", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(RED);
    for (const status of ["aborted", "error"]) {
      expect(cursorStop(root, fake.deps, status).stdout).toBe("{}\n");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("skips pnpm check when HEAD is the merge-base with origin/main and the tree is clean", () => {
    const root = trackedRepo();
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const fake = fakeCheck(RED);
    expect(stop(root, fake.deps).stdout).toBe("");
    expect(fake.calls).toHaveLength(0);
  });

  it("runs pnpm check when the tree is dirty, or HEAD is ahead of origin/main", () => {
    const root = trackedRepo();
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeRepoFile(root, "work.txt", "x\n");
    const fake = fakeCheck(GREEN);
    stop(root, fake.deps);
    expect(fake.calls).toHaveLength(1);

    const ahead = trackedRepo();
    git(ahead, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeRepoFile(ahead, "a.txt", "x\n");
    git(ahead, "add", "-A");
    git(ahead, "commit", "-m", "more");
    const again = fakeCheck(GREEN);
    stop(ahead, again.deps);
    expect(again.calls).toHaveLength(1);
  });

  it("skips step 2 when origin/main does not resolve", () => {
    const root = trackedRepo();
    const fake = fakeCheck(GREEN);
    stop(root, fake.deps);
    expect(fake.calls).toHaveLength(1);
  });

  it("stores the fingerprint on green, resets the streak and skips the next unchanged stop", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(RED, GREEN, RED);
    expect(JSON.parse(stop(root, fake.deps).stdout).decision).toBe("block");
    expect(dodState(root).sessions.s1).toEqual({ red_streak: 1 });
    writeRepoFile(root, "work.txt", "two\n");
    expect(stop(root, fake.deps).stdout).toBe("");
    const state = dodState(root);
    expect(state.sessions.s1).toEqual({ red_streak: 0 });
    expect(state.last_green).toBe(fingerprint(root));
    expect(stop(root, fake.deps).stdout).toBe("");
    expect(fake.calls).toHaveLength(2);
  });

  it("changes the fingerprint when an untracked file changes, and ignores .panopticon", () => {
    const root = dirtyRepo();
    const before = fingerprint(root);
    writeRepoFile(root, ".panopticon/other.json", "{}");
    expect(fingerprint(root)).toBe(before);
    writeRepoFile(root, "work.txt", "changed\n");
    const after = fingerprint(root);
    expect(after).not.toBe(before);
    writeRepoFile(root, "nested/new.txt", "y");
    expect(fingerprint(root)).not.toBe(after);
  });

  it("runs pnpm check again after an untracked-file change following a green run", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(GREEN);
    stop(root, fake.deps);
    writeRepoFile(root, "work.txt", "different\n");
    stop(root, fake.deps);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("definition-of-done rendering", () => {
  it("blocks a Claude Stop with the C-30 line, failed tasks and the output tail", () => {
    const root = dirtyRepo();
    const body = JSON.parse(stop(root, fakeCheck(RED).deps).stdout);
    const [first, ...rest] = (body.reason as string).split("\n\n");
    expect(body.decision).toBe("block");
    expect(first).toBe(
      "Blocked by Warden definition-of-done: pnpm check is red: api#test failed. Fix the failures and stop again.",
    );
    expect(first).toMatch(MESSAGE_PATTERN);
    expect(rest.join("\n\n")).toContain("Failed:    api#test");
  });

  it("blocks a Cursor stop with followup_message", () => {
    const root = dirtyRepo();
    const body = JSON.parse(cursorStop(root, fakeCheck(RED).deps).stdout);
    expect(body.followup_message).toContain("definition-of-done");
    expect(body.followup_message).toContain("lots of text");
  });

  it("lets the 3rd consecutive red Claude stop through with additionalContext", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(RED);
    stop(root, fake.deps);
    stop(root, fake.deps);
    const third = stop(root, fake.deps);
    expect(third.exitCode).toBe(0);
    expect(JSON.parse(third.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: LIMIT },
    });
    expect(dodState(root).sessions.s1?.red_streak).toBe(3);
  });

  it("prints {} for a Cursor stop at the limit", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(RED);
    cursorStop(root, fake.deps);
    cursorStop(root, fake.deps);
    expect(cursorStop(root, fake.deps).stdout).toBe("{}\n");
  });

  it("keeps red streaks separate per session", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(RED);
    stop(root, fake.deps, "a");
    stop(root, fake.deps, "a");
    expect(JSON.parse(stop(root, fake.deps, "b").stdout).decision).toBe(
      "block",
    );
    expect(dodState(root).sessions).toEqual({
      a: { red_streak: 2 },
      b: { red_streak: 1 },
    });
  });

  it("treats a timeout as red", () => {
    const root = dirtyRepo();
    const out = JSON.parse(
      stop(root, fakeCheck({ status: "timeout", output: "partial" }).deps)
        .stdout,
    );
    expect(out.reason).toContain("did not finish within 840 seconds");
    expect(out.reason).toContain("partial");
  });

  it("falls back to 'pnpm check is red' without Failed lines", () => {
    const root = dirtyRepo();
    const out = JSON.parse(
      stop(root, fakeCheck({ status: "red", output: "boom" }).deps).stdout,
    );
    expect(out.reason.split("\n\n")[0]).toBe(
      "Blocked by Warden definition-of-done: pnpm check is red. Fix the failures and stop again.",
    );
  });

  it("renders an engine failure on stop as a block that counts toward the streak", () => {
    const root = dirtyRepo();
    const fake = fakeCheck(GREEN);
    writeRepoFile(root, "panopticon.charter.yaml", "version: [\n");
    const first = JSON.parse(stop(root, fake.deps).stdout);
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("Warden engine");
    stop(root, fake.deps);
    const third = JSON.parse(stop(root, fake.deps).stdout);
    expect(third.hookSpecificOutput.additionalContext).toContain(
      "after 3 attempts",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("never writes pnpm check output to the JSONL log", () => {
    const root = dirtyRepo();
    const fake = fakeCheck({ status: "red", output: "SECRET-OUTPUT-LINE\n" });
    stop(root, fake.deps);
    stop(root, fake.deps);
    stop(root, fake.deps);
    const lines = log(root);
    expect(
      readFileSync(join(root, ".panopticon/wardens.log.jsonl"), "utf8"),
    ).not.toContain("SECRET-OUTPUT-LINE");
    expect(lines.map((l) => l.decision)).toEqual(["deny", "deny", "allow"]);
    expect(lines[0]).toMatchObject({
      rule: "definition-of-done",
      action: "stop",
    });
    expect(lines[2]?.message).toBe(LIMIT);
  });
});

describe("definition-of-done helpers", () => {
  it("keeps the last 60 lines and at most 4000 characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const tail = outputTail(many).split("\n");
    expect(tail).toHaveLength(60);
    expect(tail[0]).toBe("line 40");
    expect(tail.at(-1)).toBe("line 99");
    const long = outputTail(`${"x".repeat(10_000)}END`);
    expect(long).toHaveLength(4000);
    expect(long.endsWith("END")).toBe(true);
  });

  it("strips ANSI and parses Failed lines", () => {
    const text =
      " \u001b[1mFailed:\u001b[0m    web#lint, api#test\n Failed:    api#test\n";
    expect(failedTasks(text)).toEqual(["web#lint", "api#test"]);
    expect(failedTasks("nothing")).toEqual([]);
  });
});
