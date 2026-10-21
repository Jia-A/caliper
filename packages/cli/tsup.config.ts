import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"], // login/audit are code-split chunks, loaded on demand
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  // Functions passed to page.evaluate are sent to the browser as source text, so they must
  // come out of the build unminified and without helper calls injected by esbuild.
  minify: false,
  keepNames: false,
});
