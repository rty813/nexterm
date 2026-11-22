// Fixes a decoration leak in the published @xterm/xterm 5.5.0 bundle (lib/xterm.js).
// Applied at build time by vite.config.ts, like scripts/xterm-webgl-patch.mjs. Every anchor
// must match exactly once: if xterm.js is upgraded and the minified code changes, the build
// fails loudly instead of shipping without the fix. Still present on xterm.js master (2026-11).
//
// Bug: DecorationService keeps its decorations in a SortedList keyed by `marker.line`.
// Marker.dispose() sets `line = -1` *before* it fires onDispose, and the decoration's dispose
// handler then asks the list to delete it by key -1, which it is not stored under. The
// delete fails unless the decoration happens to be the lowest in the list (so trimming the
// scrollback, which goes from the top, mostly works), and every decoration whose marker
// xterm disposes elsewhere (`clear` / ESC[2J / ESC[3J, reset) stays in the list forever,
// keyed -1. Those stale entries also break the list's order, so later deletes can miss as
// well, and every render walks all of them. A cleared screen of highlighted output left
// 160+ behind.
//
// Fix: when the lookup by key does not find the value, fall back to an identity search.
// That only happens for these disposals (O(n) over the decorations, n is small).

export const PATCH_MARKER = "/*nexterm:xterm-decoration-leak-fix*/";

/** @type {Array<{ name: string, from: string, to: string }>} */
const REPLACEMENTS = [
  {
    name: "SortedList.delete identity fallback",
    from:
      "delete(e){if(0===this._array.length)return!1;const t=this._getKey(e);if(void 0===t)return!1;" +
      "if(i=this._search(t),-1===i)return!1;if(this._getKey(this._array[i])!==t)return!1;" +
      "do{if(this._array[i]===e)return this._array.splice(i,1),!0}while(++i<this._array.length&&this._getKey(this._array[i])===t);return!1}",
    to:
      "delete(e){if(0===this._array.length)return!1;const t=this._getKey(e);" +
      "if(void 0!==t&&(i=this._search(t),-1!==i))for(;i<this._array.length&&this._getKey(this._array[i])===t;i++)" +
      "if(this._array[i]===e)return this._array.splice(i,1),!0;" +
      "const __nxI=this._array.indexOf(e);return-1!==__nxI&&(this._array.splice(__nxI,1),!0)}",
  },
];

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Apply the fix to the source of @xterm/xterm/lib/xterm.js.
 * Idempotent; throws if any anchor is missing or ambiguous.
 * @param {string} source
 * @returns {string}
 */
export function patchXtermCore(source) {
  if (source.includes(PATCH_MARKER)) return source;
  let out = source;
  for (const { name, from, to } of REPLACEMENTS) {
    const n = count(out, from);
    if (n !== 1) {
      throw new Error(
        `[xterm-core-patch] "${name}": expected 1 match in @xterm/xterm, found ${n}. ` +
          "xterm.js was probably upgraded; check whether deleting a decoration whose marker was " +
          "disposed still fails, and update or remove scripts/xterm-core-patch.mjs.",
      );
    }
    out = out.replace(from, () => to);
  }
  return PATCH_MARKER + out;
}

/** Matches the core bundle's resolved path on any OS. */
export const XTERM_CORE_FILE = /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.js$/;
