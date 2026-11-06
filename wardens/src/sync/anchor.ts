import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ANCHOR_REL } from "./render.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * `$HOME` the way the launcher reads it; the OS home when `HOME` is unset or
 * relative. Never throws: `os.homedir()` does for a uid without a passwd entry
 * (a CI container), and that case yields "", which is not an absolute path.
 * Callers that read files under it must reject a non-absolute home.
 */
export function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home !== undefined && home.length > 0 && isAbsolute(home)) {
    return home;
  }
  try {
    return homedir();
  } catch {
    return "";
  }
}

/** The trusted-primaries file the hook launcher reads. No environment override. */
export function anchorPath(home: string): string {
  return join(home, ANCHOR_REL);
}

/**
 * Absolute path lines of the anchor text; blank and relative lines are ignored,
 * as in the launcher. A carriage return stays part of the line, as in the
 * launcher, where it makes the path not exist; `doctor` flags it.
 */
export function parseAnchor(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("/"));
}

export function readAnchorText(home: string): string | null {
  try {
    return readFileSync(anchorPath(home), "utf8");
  } catch {
    return null;
  }
}

export function readAnchor(home: string): string[] | null {
  const text = readAnchorText(home);
  return text === null ? null : parseAnchor(text);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Both the given and the physical spelling of a primary, for comparing with anchor lines. */
export function anchorListsPrimary(
  entries: readonly string[],
  primary: string,
): boolean {
  const physical = real(primary);
  return entries.some((entry) => real(entry.replace(/\/+$/, "")) === physical);
}

/**
 * Adds `primary` (physical path) to the anchor, keeping other entries. Idempotent:
 * an up-to-date file is not rewritten. The directory is 0700 and the file 0600.
 */
export function writeAnchor(home: string, primary: string): void {
  const file = anchorPath(home);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if ((statSync(dir).mode & 0o777) !== DIR_MODE) {
    chmodSync(dir, DIR_MODE);
  }
  const physical = real(primary);
  const existing = readAnchor(home) ?? [];
  const lines = anchorListsPrimary(existing, primary)
    ? existing
    : [...existing, physical];
  const text = `${lines.join("\n")}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current !== text) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, file);
  }
  if ((statSync(file).mode & 0o777) !== FILE_MODE) {
    chmodSync(file, FILE_MODE);
  }
}
