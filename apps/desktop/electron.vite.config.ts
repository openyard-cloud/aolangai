import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The core package is bundled from source; its runtime deps stay external (listed in this package.json).
const core = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: { "@aolangai/core": core } },
  },
  preload: {
    // CommonJS preload keeps the renderer sandbox on.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    resolve: { alias: { "@aolangai/core": core } },
    plugins: [react()],
  },
});
