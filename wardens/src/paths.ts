import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type ResolvedPath =
  | { ok: true; path: string }
  | { ok: false; reason: "escape" };

function nearestExistingReal(absolute: string): string {
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      lstatSync(current);
      const real = realpathSync(current);
      return pending.reduceRight((acc, part) => join(acc, part), real);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      pending.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Repo-relative POSIX path. Relative inputs resolve from `cwd`.
 * A missing file keeps its final segment and realpaths the nearest existing parent.
 */
export function resolveRepoPath(
  candidate: string,
  cwd: string,
  toplevel: string,
): ResolvedPath {
  const normalized = candidate.replaceAll("\\", "/");
  const absolute = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
  const finalAbsolute = nearestExistingReal(absolute);
  let root = toplevel;
  try {
    root = realpathSync(toplevel);
  } catch {
    root = resolve(toplevel);
  }
  const rel = relative(root, finalAbsolute);
  if (rel === "") {
    return { ok: true, path: "." };
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "escape" };
  }
  return { ok: true, path: rel.split(sep).join("/") };
}
