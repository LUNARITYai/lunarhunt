import { join } from "node:path";
import { trustedHome } from "./home.ts";
import { hashSources } from "./source-hash.ts";
import { structuralPrimary } from "./sync/primary.ts";

export const STALE_MESSAGE =
  "Wardens bundle is stale. Run pnpm --filter wardens build in the primary checkout.";

/** What the running bundle embeds, and how to hash the primary checkout's sources. */
export type BundleProbe = {
  /** Source hash embedded at build time; null when running from TypeScript source. */
  running: string | null;
  /** Hash of `<primary>/wardens/src`, or null when it cannot be computed. */
  current: (root: string) => string | null;
};

/** Replaced by tsup `define` in the bundle; absent (undefined) when running from source. */
function embedded(): string | null {
  const value = process.env.WARDENS_BUNDLE_HASH;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

export const defaultBundleProbe: BundleProbe = {
  running: embedded(),
  current: (root) => {
    const home = trustedHome(process.env);
    const derived = home === null ? null : structuralPrimary(root, home);
    const primary = derived?.ok ? derived.primary : null;
    return primary ? hashSources(join(primary, "wardens", "src")) : null;
  },
};

/** The stale-bundle warning, or null when fresh, unknown or on any error. Never throws. */
export function staleWarning(
  root: string,
  probe: BundleProbe = defaultBundleProbe,
): string | null {
  try {
    if (probe.running === null) {
      return null;
    }
    const current = probe.current(root);
    return current !== null && current !== probe.running ? STALE_MESSAGE : null;
  } catch {
    return null;
  }
}
