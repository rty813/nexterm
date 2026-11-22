import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { patchWebglAddon, WEBGL_ADDON_FILE } from "./scripts/xterm-webgl-patch.mjs";
import { patchXtermCore, XTERM_CORE_FILE } from "./scripts/xterm-core-patch.mjs";

const host = process.env.TAURI_DEV_HOST;

// Fixes applied to the published xterm.js bundles: the WebGL atlas-merge corruption
// (scripts/xterm-webgl-patch.mjs) and the decoration leak (scripts/xterm-core-patch.mjs).
// `transform` covers `vite build`; the esbuild plugin covers the dev-server dependency
// pre-bundle (its name is part of Vite's optimizer hash, so a stale cache is rebuilt
// automatically: bump it when a patch changes).
const XTERM_PATCHES: { file: RegExp; patch: (source: string) => string }[] = [
  { file: WEBGL_ADDON_FILE, patch: patchWebglAddon },
  { file: XTERM_CORE_FILE, patch: patchXtermCore },
];

function xtermPatches(): Plugin {
  return {
    name: "nexterm-xterm-patches",
    enforce: "pre",
    transform(code, id) {
      // Query-suffixed ids (e.g. Rollup's `?commonjs-es-import` proxy) are wrappers, not the bundle.
      if (id.includes("?")) return null;
      const p = XTERM_PATCHES.find((p) => p.file.test(id));
      return p ? { code: p.patch(code), map: null } : null;
    },
  };
}

const xtermEsbuildPatches = {
  name: "nexterm-xterm-patches-v4",
  setup(build: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: "js" }>) => void }) {
    for (const { file, patch } of XTERM_PATCHES) {
      build.onLoad({ filter: file }, async ({ path }) => ({
        contents: patch(await readFile(path, "utf8")),
        loader: "js",
      }));
    }
  },
};

export default defineConfig(async () => ({
  plugins: [react(), xtermPatches()],
  optimizeDeps: { esbuildOptions: { plugins: [xtermEsbuildPatches] } },
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
