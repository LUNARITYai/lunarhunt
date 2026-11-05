import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Banner line tsup writes into the bundle; `wardens doctor` reads it back. */
export const HASH_BANNER_PREFIX = "// wardens-source-hash: ";

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(dir, path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** SHA-256 over every file under `srcDir`: sorted posix paths and bytes, deterministic. */
export function hashSources(srcDir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFiles(srcDir).sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(srcDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The hash embedded in a bundle's text, or null. */
export function embeddedHash(bundleText: string): string | null {
  const match = new RegExp(`^${HASH_BANNER_PREFIX}([0-9a-f]{64})$`, "m").exec(
    bundleText,
  );
  return match?.[1] ?? null;
}
