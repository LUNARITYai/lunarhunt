import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorListsPrimary, readAnchor } from "./sync/anchor.ts";
import { primaryProblem } from "./sync/primary.ts";

/**
 * The trusted primary checkout of a running bundle (#73). The hook launcher
 * execs `<primary>/wardens/dist/wardens.mjs` for a primary it found in the
 * anchor, so the location of the running bundle names that primary without
 * any argument, environment variable or git data an agent could set. Returns
 * the physical path only when the bundle sits at that exact place, the
 * directory is a structural primary checkout and the anchor lists it. Null
 * otherwise (a bundle built in a worktree, a run from TypeScript source, a
 * missing or foreign anchor entry).
 */
export function bundlePrimary(moduleUrl: string, home: string): string | null {
  try {
    return resolveBundlePrimary(moduleUrl, home);
  } catch {
    return null;
  }
}

function resolveBundlePrimary(moduleUrl: string, home: string): string | null {
  if (typeof home !== "string" || !isAbsolute(home)) {
    return null;
  }
  const bundle = realpathSync(fileURLToPath(moduleUrl));
  const dist = dirname(bundle);
  if (
    basename(bundle) !== "wardens.mjs" ||
    basename(dist) !== "dist" ||
    basename(dirname(dist)) !== "wardens"
  ) {
    return null;
  }
  const primary = dirname(dirname(dist));
  if (primaryProblem(primary) !== null) {
    return null;
  }
  const listed = readAnchor(home);
  return listed !== null && anchorListsPrimary(listed, primary)
    ? primary
    : null;
}
