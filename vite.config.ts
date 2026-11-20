import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { patchWebglAddon, WEBGL_ADDON_FILE } from "./scripts/xterm-webgl-patch.mjs";

const host = process.env.TAURI_DEV_HOST;

// Backports the WebGL atlas-merge corruption fix into @xterm/addon-webgl
// (see scripts/xterm-webgl-patch.mjs). `transform` covers `vite build`; the esbuild plugin
// covers the dev-server dependency pre-bundle (its name is part of Vite's optimizer hash,
// so a stale cache is rebuilt automatically).
function xtermWebglPatch(): Plugin {
  return {
    name: "nexterm-xterm-webgl-patch",
    enforce: "pre",
    transform(code, id) {
      // Query-suffixed ids (e.g. Rollup's `?commonjs-es-import` proxy) are wrappers, not the bundle.
      if (id.includes("?") || !WEBGL_ADDON_FILE.test(id)) return null;
      return { code: patchWebglAddon(code), map: null };
    },
  };
}

const xtermWebglEsbuildPatch = {
  name: "nexterm-xterm-webgl-patch-v2",
  setup(build: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: "js" }>) => void }) {
    build.onLoad({ filter: WEBGL_ADDON_FILE }, async ({ path }) => ({
      contents: patchWebglAddon(await readFile(path, "utf8")),
      loader: "js",
    }));
  },
};

export default defineConfig(async () => ({
  plugins: [react(), xtermWebglPatch()],
  optimizeDeps: { esbuildOptions: { plugins: [xtermWebglEsbuildPatch] } },
  clearScreen: false,
  // relay/ is a separate Node project with its own node:test suite.
  test: { exclude: ["**/node_modules/**", "relay/**"] },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/relay/**"],
    },
  },
}));
