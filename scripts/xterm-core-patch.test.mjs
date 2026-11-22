import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PATCH_MARKER, patchXtermCore, XTERM_CORE_FILE } from "./xterm-core-patch.mjs";

const require = createRequire(import.meta.url);
const corePath = require.resolve("@xterm/xterm");
const original = readFileSync(corePath, "utf8");

/** The bundle's Terminal, run headless (never opened: no DOM needed). */
function load(source) {
  const mod = { exports: {} };
  new Function("module", "exports", "self", source)(mod, mod.exports, globalThis);
  return mod.exports.Terminal;
}

/** Decorations xterm still holds after `scenario` ran on a terminal with 10 decorated rows. */
async function leftOver(Terminal, scenario) {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 20, allowProposedApi: true });
  const write = (s) => new Promise((resolve) => term.write(s, resolve));
  await write(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n"));
  const decorations = [];
  for (let i = 0; i < 10; i++) {
    const marker = term.registerMarker(-i);
    decorations.push(term.registerDecoration({ marker, x: 0, width: 4 }));
  }
  await scenario(write);
  const held = [...term._core._decorationService.decorations];
  term.dispose();
  return { held: held.length, disposed: decorations.filter((d) => d.isDisposed).length };
}

const clear = (write) => write("\x1b[H\x1b[2J\x1b[3J");
const scrollAway = (write) => write("\r\n".repeat(100));

describe("xterm decoration leak patch", () => {
  it("matches the installed core path", () => {
    expect(XTERM_CORE_FILE.test(corePath)).toBe(true);
    expect(XTERM_CORE_FILE.test("C:\\x\\node_modules\\@xterm\\xterm\\lib\\xterm.js")).toBe(true);
    expect(XTERM_CORE_FILE.test("/x/node_modules/@xterm/addon-webgl/lib/addon-webgl.js")).toBe(false);
  });

  it("applies to the installed bundle and is idempotent", () => {
    const patched = patchXtermCore(original);
    expect(patched.startsWith(PATCH_MARKER)).toBe(true);
    expect(patched).toContain("this._array.indexOf(e)");
    expect(patchXtermCore(patched)).toBe(patched);
  });

  it("the unpatched bundle leaks (if this fails, xterm.js fixed it: drop the patch)", async () => {
    const Terminal = load(original);
    // Trimming the scrollback happens to work (it disposes the lowest line first, where a
    // lookup for -1 lands); clearing the screen does not.
    expect((await leftOver(Terminal, clear)).held).toBeGreaterThan(0);
  });

  it("drops decorations whose markers xterm disposes", async () => {
    const Terminal = load(patchXtermCore(original));
    expect(await leftOver(Terminal, clear)).toEqual({ held: 0, disposed: 10 });
    expect(await leftOver(Terminal, scrollAway)).toEqual({ held: 0, disposed: 10 });
    // Untouched rows keep theirs.
    expect(await leftOver(Terminal, async () => {})).toEqual({ held: 10, disposed: 0 });
  });
});
