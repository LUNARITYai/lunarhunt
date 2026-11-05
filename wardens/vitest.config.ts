import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most wardens tests spawn the CLI with `node --experimental-strip-types` and run slowly in a loaded CI container.
    testTimeout: 20_000,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
