// Backport of xterm.js PR #5883 ("Fix webgl rendering corruption from atlas page merges")
// onto the published @xterm/addon-webgl 0.18.0 bundle (lib/addon-webgl.js).
//
// No stable addon release carries the fix (it first shipped in 0.20.0-beta, which needs
// @xterm/xterm 6.1), so vite.config.ts applies this at build time instead of editing
// node_modules. Every anchor must match exactly once: if the addon is upgraded and the
// minified code changes, the build fails loudly rather than shipping an unpatched renderer.
// Remove this file (and the plugin in vite.config.ts) once the addon is upgraded to a
// release that includes the fix.
//
// Bug (docs/bbs-glyph-corruption.zh-CN.md): after the texture atlas merges pages,
//  1. per-page `version` counters can coincide with the version already bound to that
//     texture unit, so GlyphRenderer skips the re-upload and samples the old canvas;
//  2. a merge that happens in the middle of _updateModel leaves already-written cells
//     pointing at stale texture page indices.
// Either way cells draw pixels from another glyph until a resize or font change rebuilds
// everything.
//
// Also backports PR #6043: once the pages reach the maximum texture size they can no longer
// be merged, and 0.18.0 kept adding pages beyond maxAtlasPages; render() then threw on every
// frame ("reading 'version'") and the pane stopped updating. The atlas is now evicted and
// rebuilt instead. (PR #6042 is covered by the per-renderer merge generation below; 0.18.0
// has no oversized-glyph page, so that part of #6043 does not apply.)
//
// Also backports PR #6295 (issue #6116, not merged yet): default-background cells with
// underline / dim / italic drew opaque black over a background image.
//
// Differences from upstream: upstream resets the atlas' `_requestClearModel` flag in
// beginFrame(), but the atlas is shared between terminals with the same font settings, so
// whichever pane rendered first would swallow the flag. Here each renderer remembers the
// atlas merge generation it last built its model against instead.

export const PATCH_MARKER = "/*nexterm:webgl-atlas-merge-fix*/";

// A global counter rather than a static on the AtlasPage class: minified identifiers are
// scoped per function, so the class name is not reachable from every call site.
const NEXT = "(globalThis.__nexterm_atlasPageVersion=(globalThis.__nexterm_atlasPageVersion||0)+1)";

/** @type {Array<{ name: string, from: string, to: string }>} */
const REPLACEMENTS = [
  {
    name: "AtlasPage initial version",
    from: "this._usedPixels=0,this._glyphs=[],this.version=0,",
    to: `this._usedPixels=0,this._glyphs=[],this.version=${NEXT},`,
  },
  {
    name: "AtlasPage.clear version",
    from: "this.fixedRows.length=0,this.version++",
    to: `this.fixedRows.length=0,this.version=${NEXT}`,
  },
  {
    name: "merged page version",
    from: "n=this._mergePages(s,o);n.version++;",
    to: `n=this._mergePages(s,o);n.version=${NEXT};`,
  },
  {
    // Count merges so each renderer sharing this atlas can notice them independently.
    name: "atlas merge generation",
    from: "this._requestClearModel=!0,",
    to: "this._requestClearModel=!0,this.__nxMergeGen=(this.__nxMergeGen||0)+1,",
  },
  {
    name: "shifted page version after delete",
    from: "t.texturePage--;e.version++}",
    to: `t.texturePage--;e.version=${NEXT}}`,
  },
  {
    name: "version after adding a glyph",
    from: "U.addGlyph($),U.version++,$}",
    to: `U.addGlyph($),U.version=${NEXT},$}`,
  },
  {
    name: "GlyphRenderer.invalidateAtlasTextures",
    from: "setAtlas(e){this._atlas=e;for(const e of this._atlasTextures)e.version=-1}",
    to: "setAtlas(e){this._atlas=e;this.invalidateAtlasTextures()}invalidateAtlasTextures(){for(const e of this._atlasTextures)e.version=-1}",
  },
  {
    // Off-by-one: the viewport-clear rectangle at offset 0 was not counted.
    name: "RectangleRenderer buffer size",
    from: "e.attributes.length<t+4&&(e.attributes=(0,n.expandFloat32Array)(e.attributes,this._terminal.rows*this._terminal.cols*8))",
    to: "e.attributes.length<t+8&&(e.attributes=(0,n.expandFloat32Array)(e.attributes,(this._terminal.rows*this._terminal.cols+1)*8))",
  },
  {
    // Full model rebuild when this renderer has not seen the latest merge, and again if a
    // merge happens while the model is being updated; then force every texture to re-upload.
    name: "WebglRenderer.renderRows merge handling",
    from: "this._glyphRenderer.value.beginFrame()?(this._clearModel(!0),this._updateModel(0,this._terminal.rows-1)):this._updateModel(e,t),",
    to:
      "(()=>{const a=this._charAtlas,g=()=>a&&a.__nxMergeGen||0;let m=g(),x=0,f=!1;" +
      "!a||this.__nxAtlas!==a||this.__nxGen!==m?(this._clearModel(!0),this._updateModel(0,this._terminal.rows-1)):this._updateModel(e,t);" +
      "for(;a&&g()!==m&&x++<32;)m=g(),f=!0,this._clearModel(!0),this._updateModel(0,this._terminal.rows-1);" +
      "this.__nxAtlas=a,this.__nxGen=m,f&&this._glyphRenderer.value.invalidateAtlasTextures()})(),",
  },

  // --- xterm.js PR #6043: keep the atlas within the renderer's texture capacity. ---
  {
    // Drop every page and cached glyph, and bump the merge generation so every renderer
    // sharing the atlas rebuilds its model (the glyphs are rasterized again on demand).
    name: "TextureAtlas evict all pages",
    from: "_createNewPage(){if(g.maxAtlasPages&&",
    to:
      "__nxEvictAll(){for(const e of this._pages)this._onRemoveTextureAtlasCanvas.fire(e.canvas),e.canvas.remove();" +
      "this._pages.length=0,this._activePages.length=0,this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1," +
      "this.__nxMergeGen=(this.__nxMergeGen||0)+1}" +
      "_createNewPage(){if(g.maxAtlasPages&&",
  },
  {
    // Once the pages have grown to the maximum texture size there are no four same-sized
    // pages left to merge; 0.18.0 merged whatever it found anyway (or crashed on an empty
    // list) and the page count kept growing past maxAtlasPages. Evict instead.
    name: "merge only four same-sized pages",
    from: "let t=-1,i=0;for(let s=0;s<e.length;s++)if(e[s].canvas.width!==i)t=s,i=e[s].canvas.width;else if(s-t==3)break;const s=e.slice(t,t+4),r=",
    to:
      "let t=-1,i=0;for(let s=0;s<e.length;s++)if(e[s].canvas.width!==i)t=s,i=e[s].canvas.width;else if(s-t==3)break;" +
      "const s=t<0?[]:e.slice(t,t+4);if(s.length<4||s.some((e=>e.canvas.width!==s[0].canvas.width||!e.glyphs.length)))this.__nxEvictAll();else{const r=",
  },
  {
    name: "close the merge branch",
    from: "this._onAddTextureAtlasCanvas.fire(n.canvas)}const e=new v(this._document,this._textureSize);",
    to: "this._onAddTextureAtlasCanvas.fire(n.canvas)}}const e=new v(this._document,this._textureSize);",
  },
  // --- xterm.js PR #6295 (fixes issue #6116): transparent theme background. ---
  // Underline (extended attributes), dim and italic are flag bits stored in a cell's bg
  // word, so updateBackgrounds() gave such cells a background rectangle in the default
  // background color, and _updateRectangle() forced its alpha to 1. With a transparent
  // theme background (a background image, allowTransparency) they became opaque black
  // blocks (fish underlines valid paths, codex and PSReadLine predictions use dim / italic).
  // Still present in addon-webgl 0.19.0. 50331648 is Attributes.CM_MASK; CM_DEFAULT is 0.
  {
    // Only a real background color (or inverse) needs a rectangle, not attribute flags.
    name: "background rectangle only for a non-default color",
    from: "(0!==a||l&&0!==h)&&(g=8*v++,this._updateRectangle(i,g,h,a,n,r,s))",
    to: "(0!==(50331648&a)||l&&0!==h)&&(g=8*v++,this._updateRectangle(i,g,h,a,n,r,s))",
  },
  {
    name: "background rectangle only for a non-default color (row end)",
    from: "(0!==a||l&&0!==h)&&(g=8*v++,this._updateRectangle(i,g,h,a,n,t.cols,s))",
    to: "(0!==(50331648&a)||l&&0!==h)&&(g=8*v++,this._updateRectangle(i,g,h,a,n,t.cols,s))",
  },
  {
    // 24-bit colors are packed without an alpha byte: make them opaque before the alpha is used.
    name: "opaque 24-bit inverse background",
    from: "case 50331648:l=(16777215&i)<<8;break;",
    to: "case 50331648:l=(16777215&i)<<8|255;break;",
  },
  {
    name: "opaque 24-bit background",
    from: "case 50331648:l=(16777215&s)<<8;break;",
    to: "case 50331648:l=(16777215&s)<<8|255;break;",
  },
  {
    name: "rectangle alpha from its color",
    from: "g=(l>>8&255)/255,v=1,this._addRectangle(",
    to: "g=(l>>8&255)/255,v=(255&l)/255,this._addRectangle(",
  },
  {
    // Defensive backstop: never index past the renderer's texture units.
    name: "clamp texture upload loop",
    from: "for(let e=0;e<this._atlas.pages.length;e++)this._atlas.pages[e].version!==this._atlasTextures[e].version&&",
    to: "for(let e=0;e<Math.min(this._atlas.pages.length,this._atlasTextures.length);e++)this._atlas.pages[e].version!==this._atlasTextures[e].version&&",
  },
];

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Apply the backport to the source of @xterm/addon-webgl/lib/addon-webgl.js.
 * Idempotent; throws if any anchor is missing or ambiguous.
 * @param {string} source
 * @returns {string}
 */
export function patchWebglAddon(source) {
  if (source.includes(PATCH_MARKER)) return source;
  let out = source;
  for (const { name, from, to } of REPLACEMENTS) {
    const n = count(out, from);
    if (n !== 1) {
      throw new Error(
        `[xterm-webgl-patch] "${name}": expected 1 match in @xterm/addon-webgl, found ${n}. ` +
          "The addon was probably upgraded; check whether it already contains xterm.js PR #5883 " +
          "and update or remove scripts/xterm-webgl-patch.mjs.",
      );
    }
    out = out.replace(from, () => to);
  }
  return PATCH_MARKER + out;
}

/** Matches the addon bundle's resolved path on any OS. */
export const WEBGL_ADDON_FILE = /[\\/]@xterm[\\/]addon-webgl[\\/]lib[\\/]addon-webgl\.js$/;
