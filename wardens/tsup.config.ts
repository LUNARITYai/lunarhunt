import { defineConfig } from "tsup";

export default defineConfig({
  entry: { wardens: "src/cli.ts" },
  format: ["esm"],
  target: "node26",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  bundle: true,
  noExternal: ["ajv", "commander", "picomatch", "yaml", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  outExtension: () => ({ js: ".mjs" }),
});
