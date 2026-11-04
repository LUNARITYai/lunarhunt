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
  // Bundled CommonJS (yaml) calls require(); ESM output has none.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __wardensCreateRequire } from "node:module";',
      "const require = __wardensCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  outExtension: () => ({ js: ".mjs" }),
});
