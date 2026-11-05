import { join, resolve } from "node:path";
import picomatch from "picomatch";
import type { Charter } from "./charter.ts";
import type { Action } from "./event.ts";
import { resolveAbsolutePath } from "./paths.ts";

const MAGIC = /[*?[\]{}()!+@]/;

function escapeLiteral(text: string): string {
  return text.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}

/** Expand `~/`, then realpath the literal prefix so `/tmp/x-*` matches `/private/tmp/x-1`. */
function expandGlob(glob: string, home: string): string | null {
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
  for (const glob of globs) {
    const expanded = expandGlob(glob, home);
    if (
      expanded !== null &&
      picomatch.isMatch(target, expanded, { dot: true })
    ) {
      return target;
    }
  }
  return null;
}
