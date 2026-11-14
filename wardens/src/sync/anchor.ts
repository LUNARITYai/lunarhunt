import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ANCHOR_REL } from "./render.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const REPOS_NAME = "repos";

/** The trusted-primaries file the hook launcher reads. No environment override. Only for an absolute home (see `trustedHome`). */
export function anchorPath(home: string): string {
  if (!isAbsolute(home)) {
    throw new Error("the home directory is not an absolute path");
  }
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
  const physical = real(primary);
  const existing = readAnchor(home) ?? [];
  const lines = anchorListsPrimary(existing, primary)
    ? existing
    : [...existing, physical];
  writeProtected(anchorPath(home), `${lines.join("\n")}\n`);
}

/** Writes `text` to `file` in the anchor directory: directory 0700, file 0600, replaced atomically, untouched when equal. */
function writeProtected(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if ((statSync(dir).mode & 0o777) !== DIR_MODE) {
    chmodSync(dir, DIR_MODE);
  }
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

const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/** `owner/repo` of a github.com remote URL, or null. */
export function githubRepo(url: string): string | null {
  return GITHUB_REMOTE.exec(url.trim())?.[1] ?? null;
}

/** The issue-repository sidecar next to the anchor: `<primary>\t<owner/repo>` per line. Written only by `wardens sync`. */
export function reposPath(home: string): string {
  return join(dirname(anchorPath(home)), REPOS_NAME);
}

function repoEntries(home: string): [string, string][] {
  let text: string;
  try {
    text = readFileSync(reposPath(home), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line): [string, string][] => {
    const [path, repo, ...rest] = line.split("\t");
    return path?.startsWith("/") && repo && rest.length === 0
      ? [[path, repo]]
      : [];
  });
}

/** The recorded `owner/repo` of `primary`, or null. */
export function readRepo(home: string, primary: string): string | null {
  const physical = real(primary);
  return (
    repoEntries(home).find(([path]) => real(path) === physical)?.[1] ?? null
  );
}

/** Sets the entry of `primary` (physical path), keeping the others; same atomic, 0600 write as the anchor. */
export function writeRepo(home: string, primary: string, repo: string): void {
  const physical = real(primary);
  const lines = [
    ...repoEntries(home).filter(([path]) => real(path) !== physical),
    [physical, repo],
  ].map(([path, name]) => `${path}\t${name}`);
  writeProtected(reposPath(home), `${lines.join("\n")}\n`);
}
