import { spawnSync } from "node:child_process";

export type Result = { exitCode: 0 | 2; stdout: string; stderr: string };

/** Everything with side effects outside git: injected so tests can stub it. */
export type Deps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
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
  step: (command, cwd) =>
    spawnSync("sh", ["-c", command], { cwd, stdio: "inherit" }).status ?? 1,
};

export function fail(stderr: string): Result {
  return { exitCode: 2, stdout: "", stderr: `${stderr}\n` };
}

export function ok(stdout = ""): Result {
  return { exitCode: 0, stdout, stderr: "" };
}
