import picomatch from "picomatch";

const OPTIONS = { dot: true } as const;

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** A pattern with no `/` matches the basename. A pattern with `/` matches the repo-relative path. */
export function globMatches(pattern: string, path: string): boolean {
  const target = pattern.includes("/") ? path : basename(path);
  return picomatch.isMatch(target, pattern, OPTIONS);
}

export function anyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, path));
}

/**
 * Last match wins, starting from not denied.
 * `!*.example` is the only exception and is not passed to picomatch as a negation.
 */
export function denyListMatches(
  patterns: readonly string[],
  path: string,
): boolean {
  let denied = false;
  const base = basename(path);
  for (const pattern of patterns) {
    if (pattern === "!*.example") {
      if (picomatch.isMatch(base, "*.example", OPTIONS)) {
        denied = false;
      }
      continue;
    }
    if (globMatches(pattern, path)) {
      denied = true;
    }
  }
  return denied;
}
