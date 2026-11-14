import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

/**
 * Stands in for a home that cannot be resolved. `/dev/null` is a device, so no
 * path can exist below it: a `~` expanded against it is absolute, lies outside
 * every worktree, fails to resolve (ENOTDIR) and matches no `paths.external`
 * glob. It is never resolved against the current directory.
 */
export const UNRESOLVED_HOME = "/dev/null/unresolved-home";

function existingDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The home directory, or null unless it is an absolute path to an existing
 * directory. A `HOME` that is set must itself be that (an empty or relative
 * `HOME` is a misconfiguration, not a reason to ask the password database);
 * only an unset `HOME` falls back to `os.homedir()`, which throws for a uid
 * without a passwd entry. Never throws, never returns a relative path.
 */
export function trustedHome(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME;
  if (home !== undefined && home.length > 0) {
    return existingDirectory(home) ? home : null;
  }
  if (home === "") {
    return null;
  }
  try {
    const os = homedir();
    return existingDirectory(os) ? os : null;
  } catch {
    return null;
  }
}

/** The trusted home, or `UNRESOLVED_HOME` for code that expands `~` and must fail closed. */
export function homeOrUnresolved(env: NodeJS.ProcessEnv): string {
  return trustedHome(env) ?? UNRESOLVED_HOME;
}
