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
  | { ok: false; reason: "escape" | "unresolvable" };

type Located =
  | { ok: true; path: string }
  | { ok: false; reason: "unresolvable" };

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === "string" ? code : undefined;
}

function nearestExistingReal(absolute: string): Located {
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      lstatSync(current);
    } catch (err) {
      // Walk up only on ENOENT: this segment does not exist yet, so the
      // parent can still be realpath'd and the missing name re-appended.
      // ENOTDIR is not that case. An ancestor exists but is not a directory,
      // and joining the basename back on would report an in-repo path a write
      // cannot create there. ELOOP, EACCES and every other code fail closed.
      if (errorCode(err) !== "ENOENT") {
        return { ok: false, reason: "unresolvable" };
      }
      const parent = dirname(current);
      if (parent === current) {
        return { ok: true, path: absolute };
      }
      pending.push(basename(current));
      current = parent;
      continue;
    }
    try {
      const real = realpathSync(current);
      return {
        ok: true,
        path: pending.reduceRight((acc, part) => join(acc, part), real),
      };
    } catch {
      // lstat saw the node (often a symlink) but its target cannot be
      // resolved. Re-appending the basename would hide an outside write.
      return { ok: false, reason: "unresolvable" };
    }
  }
}

/**
 * Repo-relative POSIX path. Relative inputs resolve from `cwd`.
 * A missing file keeps its final segment and realpaths the nearest existing parent.
 * An unresolvable symlink, or any error other than ENOENT, fails closed.
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
  const located = nearestExistingReal(absolute);
  if (!located.ok) {
    return located;
  }
  let root = toplevel;
  try {
    root = realpathSync(toplevel);
  } catch {
    root = resolve(toplevel);
  }
  const rel = relative(root, located.path);
  if (rel === "") {
    return { ok: true, path: "." };
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: "escape" };
  }
  return { ok: true, path: rel.split(sep).join("/") };
}
