import { defineConfig } from "vite";

/**
 * Build config for the replay page only.
 *
 * Root is site/, so Vite resolves ./main.ts there while the imports of
 * ../src/core and ../harness stay real source files - the page bundles the same
 * code the tests run. base is "./" because Pages serves a project site under a
 * subpath.
 */
export default defineConfig({
  root: "site",
  base: "./",
  build: {
    outDir: "../site-dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
