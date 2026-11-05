import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { HASH_BANNER_PREFIX, hashSources } from "./src/source-hash.ts";

// Embedded so `wardens doctor` can tell a stale bundle from the current sources.
const sourceHash = hashSources(
  fileURLToPath(new URL("./src", import.meta.url)),
);

export default defineConfig({
  entry: { wardens: "src/cli.ts" },
  format: ["esm"],
  target: "node26",
  outDir: "dist",
  // Never clean: scripts/build.ts builds into a temp dir and renames the bundle in.
  clean: false,
  define: { "process.env.WARDENS_BUNDLE_HASH": JSON.stringify(sourceHash) },
  splitting: false,
  sourcemap: false,
  bundle: true,
  noExternal: ["ajv", "commander", "picomatch", "yaml", "zod"],
  // Bundled CommonJS (yaml) calls require(); ESM output has none.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __wardensCreateRequire } from "node:module";',
      "const require = __wardensCreateRequire(import.meta.url);",
      `${HASH_BANNER_PREFIX}${sourceHash}`,
    ].join("\n"),
  },
  outExtension: () => ({ js: ".mjs" }),
});
