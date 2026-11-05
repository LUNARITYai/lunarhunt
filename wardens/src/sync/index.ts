import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCharterAt } from "../charter.ts";
import { gitToplevel } from "../git.ts";
import { engineMessage, wardenMessage } from "../messages.ts";
import { detectAgent } from "../trailer.ts";
import { render } from "./render.ts";

export { render } from "./render.ts";

export type SyncResult = { exitCode: 0 | 2; stdout: string; stderr: string };

const AGENT_REFUSAL = wardenMessage(
  "charter-drift",
  "wardens sync writes protected configs and is for humans",
  "Ask Krzysztof to run wardens sync",
);

function driftMessage(file: string): string {
  return wardenMessage(
    "charter-drift",
    `${file} differs from wardens sync output`,
    "Ask a human to run wardens sync and commit the result",
  );
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `wardens sync [--check]`. Writes only the three generated files, only without `--check`. */
export function runSync(
  check: boolean,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SyncResult {
  if (!check && detectAgent(env) !== null) {
    return { exitCode: 2, stdout: "", stderr: `${AGENT_REFUSAL}\n` };
  }
  const toplevel = gitToplevel(cwd);
  if (!toplevel) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${engineMessage("git toplevel could not be resolved")}\n`,
    };
  }
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    const detail = loaded.errors.join("\n");
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${engineMessage("Charter validation failed")}\n${detail}\n`,
    };
  }
  const files = render(loaded.charter);
  if (check) {
    const drift = [...files]
      .filter(([path, text]) => readOrNull(join(toplevel, path)) !== text)
      .map(([path]) => driftMessage(path));
    return {
      exitCode: drift.length > 0 ? 2 : 0,
      stdout: "",
      stderr: drift.map((line) => `${line}\n`).join(""),
    };
  }
  try {
    for (const [path, text] of files) {
      const target = join(toplevel, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${engineMessage("the generated files could not be written")}\n`,
    };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}
