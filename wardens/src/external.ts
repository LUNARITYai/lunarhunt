import { join, resolve } from "node:path";
import picomatch from "picomatch";
import type { Charter } from "./charter.ts";
import type { Action } from "./event.ts";
import { foldCase } from "./globs.ts";
import { UNRESOLVED_HOME } from "./home.ts";
import { caseInsensitiveAt, resolveAbsolutePath } from "./paths.ts";

const MAGIC = /[*?[\]{}()!+@]/;

function escapeLiteral(text: string): string {
  return text.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}

/** Expand `~/`, then realpath the literal prefix so `/tmp/x-*` matches `/private/tmp/x-1`. */
function expandGlob(glob: string, home: string): string | null {
  // An unresolved home gives a `~` glob nothing to match.
  if (glob.startsWith("~/") && home === UNRESOLVED_HOME) {
    return null;
  }
  const expanded = glob.startsWith("~/") ? join(home, glob.slice(2)) : glob;
  const segments = expanded.split("/").filter((part) => part.length > 0);
  const firstMagic = segments.findIndex((part) => MAGIC.test(part));
  const literal = firstMagic === -1 ? segments : segments.slice(0, firstMagic);
  const rest = firstMagic === -1 ? [] : segments.slice(firstMagic);
  const prefix = resolveAbsolutePath(`/${literal.join("/")}`, "/");
  if (prefix === null) {
    return null;
  }
  const base = prefix === "/" ? "" : escapeLiteral(prefix);
  return [base, ...rest].join("/") || "/";
}

/**
 * Normalized absolute path when `candidate` (outside the worktree) is allowed by
 * `paths.external` for this action, else null. Reads match `read` and `write`;
 * edits, writes and deletes match `write`.
 */
export function externalAllows(
  external: NonNullable<Charter["paths"]["external"]> | undefined,
  action: Action,
  candidate: string,
  cwd: string,
  home: string,
): string | null {
  if (!external) {
    return null;
  }
  const globs =
    action === "read"
      ? [...(external.read ?? []), ...(external.write ?? [])]
      : action === "edit" || action === "write" || action === "delete"
        ? (external.write ?? [])
        : [];
  if (globs.length === 0) {
    return null;
  }
  const target = resolveAbsolutePath(candidate, resolve(cwd));
  if (target === null) {
    return null;
  }
  // The allowlist widens access, so another case matches only where the volume
  // reads it as the same file (or cannot be told, which folds).
  const fold = caseInsensitiveAt(target);
  const subject = fold ? foldCase(target) : target;
  for (const glob of globs) {
    const expanded = expandGlob(glob, home);
    if (
      expanded !== null &&
      // The glob folds like the subject: a fold can change the length (`ß` is `ss`).
      picomatch.isMatch(subject, fold ? foldCase(expanded) : expanded, {
        dot: true,
        nocase: fold,
      })
    ) {
      return target;
    }
  }
  return null;
}
