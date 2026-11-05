import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../src/dod.ts";
import { tempRepo, writeRepoFile } from "./support.ts";

export function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

/** Temp repo with one commit holding the Charter and `files`. */
export function trackedRepo(files: Record<string, string> = {}): string {
  const root = tempRepo();
  for (const [rel, text] of Object.entries(files)) {
    writeRepoFile(root, rel, text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  return root;
}

export function dodState(root: string): {
  last_green: string | null;
  sessions: Record<string, { red_streak: number }>;
} {
  return JSON.parse(
    readFileSync(join(root, ".panopticon/dod-state.json"), "utf8"),
  );
}

/** Scripted check runner; counts calls. */
export function fakeCheck(...results: CheckResult[]) {
  const calls: string[] = [];
  const runCheck = (root: string): CheckResult => {
    calls.push(root);
    return (
      results[Math.min(calls.length - 1, results.length - 1)] ?? {
        status: "green",
        output: "",
      }
    );
  };
  return { calls, deps: { runCheck } };
}
