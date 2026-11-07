import { spawnSync } from "node:child_process";
import { wardenMessage } from "../messages.ts";

export type Result = { exitCode: 0 | 2; stdout: string; stderr: string };

/** Everything with side effects outside git: injected so tests can stub it. */
export type Deps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Trusted primary (from the running bundle and the launcher anchor) whose Charter applies; absent: the checkout git names as primary. */
  charterRoot?: string;
  /** Runs `gh <args>`; `status` is the exit code (non-zero when gh is missing). */
  gh: (args: string[], cwd: string) => { status: number; stdout: string };
  /** Runs one `setup.steps` command through the shell; returns its exit code. */
  step: (command: string, cwd: string) => number;
};

export const realDeps: Deps = {
  env: process.env,
  cwd: process.cwd(),
  gh: (args, cwd) => {
    const res = spawnSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: res.status ?? 1, stdout: res.stdout ?? "" };
  },
  // Step output goes to stderr so stdout carries only the worktree path.
  step: (command, cwd) =>
    spawnSync("sh", ["-c", command], { cwd, stdio: ["ignore", 2, 2] }).status ??
    1,
};

/** C-30 engine message with a specific next action for a human. */
export function msg(what: string, next: string): string {
  return wardenMessage("engine", what.replace(/[\s.]+$/, ""), next);
}

/** First line only, so multi-line git stderr cannot break the C-30 format. */
export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

export function fail(stderr: string): Result {
  return { exitCode: 2, stdout: "", stderr: `${stderr}\n` };
}

export function ok(stdout = "", stderr = ""): Result {
  return { exitCode: 0, stdout, stderr };
}
