import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PATCH_MARKER, patchWebglAddon, WEBGL_ADDON_FILE } from "./xterm-webgl-patch.mjs";

const require = createRequire(import.meta.url);
const addonPath = require.resolve("@xterm/addon-webgl");
const original = readFileSync(addonPath, "utf8");

describe("xterm webgl atlas-merge patch", () => {
  it("matches the installed addon path", () => {
    expect(WEBGL_ADDON_FILE.test(addonPath)).toBe(true);
    expect(WEBGL_ADDON_FILE.test("C:\\x\\node_modules\\@xterm\\addon-webgl\\lib\\addon-webgl.js")).toBe(true);
  });

  it("applies every replacement to the installed addon and stays valid JS", () => {
    const patched = patchWebglAddon(original);
    expect(patched.startsWith(PATCH_MARKER)).toBe(true);
    // No per-page counters left: every version bump goes through the global counter.
    expect(patched).not.toMatch(/\.version\+\+/);
    expect(patched).not.toContain("this.version=0");
    expect(patched).toContain("invalidateAtlasTextures(){");
    expect(patched).toContain("__nxMergeGen");
    // #6043: evict instead of growing past the texture units, and never index past them.
    expect(patched).toContain("__nxEvictAll(){");
    expect(patched).toContain("Math.min(this._atlas.pages.length,this._atlasTextures.length)");
    // #6295: no rectangle for attribute flags alone; rectangles keep their color's alpha.
    expect(patched).not.toContain("(0!==a||l&&0!==h)");
    expect(patched.match(/\(0!==\(50331648&a\)\|\|l&&0!==h\)/g)).toHaveLength(2);
    expect(patched).not.toContain("v=1,this._addRectangle(");
    expect(patched).toContain("v=(255&l)/255,this._addRectangle(");
    expect(patched).toContain("l=(16777215&s)<<8|255;");
    expect(() => new Function("exports", "module", "require", "define", "self", patched)).not.toThrow();
  });

  it("is idempotent", () => {
    const once = patchWebglAddon(original);
    expect(patchWebglAddon(once)).toBe(once);
  });

  it("fails loudly when an anchor is missing", () => {
    expect(() => patchWebglAddon(original.replace("n.version++", "n.version+=1"))).toThrow(/merged page version/);
  });
});
