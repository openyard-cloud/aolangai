import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Tests run workspace packages from source, without building dist/ first.
    alias: { "@aolangai/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["language.test.ts", "public-tree.test.ts", "packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/demo/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
