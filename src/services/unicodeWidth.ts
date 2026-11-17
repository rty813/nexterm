import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WIDE_AMBIGUOUS_VERSION, wideAmbiguousProvider } from "../utils/ambiguousWidth";

let v11: IUnicodeVersionProvider | null = null;
let wide: IUnicodeVersionProvider | null = null;

/**
 * Registers Unicode 11 widths on `term`, plus the variant with two-column ambiguous
 * characters (`WIDE_AMBIGUOUS_VERSION`). Does not change the active version.
 */
export function registerUnicodeWidths(term: Terminal) {
  if (!v11) {
    // The addon only hands its provider to `unicode.register`: catch it there.
    const caught: IUnicodeVersionProvider[] = [];
    new Unicode11Addon().activate({ unicode: { register: (p: IUnicodeVersionProvider) => caught.push(p) } } as unknown as Terminal);
    if (!caught[0]) return;
    v11 = caught[0];
    wide = wideAmbiguousProvider(v11);
  }
  const have = term.unicode.versions;
  if (!have.includes(v11.version)) term.unicode.register(v11);
  if (wide && !have.includes(WIDE_AMBIGUOUS_VERSION)) term.unicode.register(wide);
}
