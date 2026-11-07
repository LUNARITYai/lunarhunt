import picomatch from "picomatch";

const OPTIONS = { dot: true } as const;
const FOLDED = { dot: true, nocase: true } as const;

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * The spelling a case-insensitive file system treats as the same name (#77):
 * `nocase` covers the ASCII letters, this covers the few non-ASCII letters
 * whose simple case folding is ASCII (U+017F is `s`, U+212A is `k`). It may
 * fold more than a volume does, which only denies more.
 */
export function foldCase(text: string): string {
  // U+1E9E (capital sharp s) folds to `ss` on APFS, but to `ß` in JavaScript.
  return text.replaceAll("ẞ", "ss").toUpperCase().toLowerCase();
}

/**
 * A pattern with no `/` matches the basename. A pattern with `/` matches the repo-relative path.
 * `fold` ignores case: for deny-style lists, where an other-case spelling of a
 * listed file must not slip through (macOS and Windows volumes are case-insensitive).
 */
export function globMatches(
  pattern: string,
  path: string,
  fold = false,
): boolean {
  const target = pattern.includes("/") ? path : basename(path);
  return fold
    ? picomatch.isMatch(foldCase(target), pattern, FOLDED)
    : picomatch.isMatch(target, pattern, OPTIONS);
}

export function anyGlob(
  patterns: readonly string[],
  path: string,
  fold = false,
): boolean {
  return patterns.some((pattern) => globMatches(pattern, path, fold));
}

/**
 * Last match wins, starting from not denied. Always case-insensitive.
 * `!*.example` is the only exception and is not passed to picomatch as a negation.
 */
export function denyListMatches(
  patterns: readonly string[],
  path: string,
): boolean {
  let denied = false;
  const base = foldCase(basename(path));
  for (const pattern of patterns) {
    if (pattern === "!*.example") {
      if (picomatch.isMatch(base, "*.example", FOLDED)) {
        denied = false;
      }
      continue;
    }
    if (globMatches(pattern, path, true)) {
      denied = true;
    }
  }
  return denied;
}
