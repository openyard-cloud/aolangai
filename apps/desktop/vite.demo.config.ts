// The browser demo (demo/): the real renderer on an in-memory bridge, built as static files into site/demo/.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The renderer imports nothing but types from core, and the demo only DEFAULT_LIMITS, all of it in types.ts. Pointing
 * `@aolangai/core` there (not at the index) keeps node:sqlite, node:fs and the agent SDK out of the browser bundle:
 * any other value imported from core fails the build instead of being bundled.
 */
const coreTypes = here("../../packages/core/src/types.ts");

/**
 * Chrome does not load module scripts from file:// pages (their origin is opaque, so the request is cross-origin).
 * The bundle is one IIFE, loaded by a classic deferred script; `crossorigin` goes too, for the same reason.
 */
function classicScript(): Plugin {
  return {
    name: "aolangai-demo-classic-script",
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin src=/g, "<script defer src=")
          .replace(/<script type="module" src=/g, "<script defer src=")
          .replace(/ crossorigin(?=[\s>])/g, ""),
    },
  };
}

export default defineConfig({
  root: here("demo"),
  base: "./",
  publicDir: false,
  plugins: [react(), classicScript()],
  resolve: { alias: { "@aolangai/core": coreTypes } },
  build: {
    outDir: here("../../site/demo"),
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: { output: { format: "iife", codeSplitting: false } },
  },
});
