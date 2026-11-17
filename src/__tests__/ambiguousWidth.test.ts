import { describe, expect, it } from "vitest";
import { ambiguousIsWide, isAmbiguous, isCjkCharset, WIDE_AMBIGUOUS_VERSION, wideAmbiguousProvider } from "../utils/ambiguousWidth";
import type { IUnicodeVersionProvider } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const cp = (s: string) => s.codePointAt(0)!;

describe("ambiguous width", () => {
  it("recognizes the characters BBS menus use", () => {
    for (const ch of "●◆■□★☆─│┼┐╮╯╱╲·∵∴‥⊕°×÷αЖ“”") expect(isAmbiguous(cp(ch)), ch).toBe(true);
    for (const ch of "aZ~中田￣︳") expect(isAmbiguous(cp(ch)), ch).toBe(false);
    // Private use (Nerd Font icons) stays narrow.
    expect(isAmbiguous(0xe0a0)).toBe(false);
  });

  it("auto follows the charset", () => {
    expect(isCjkCharset("GBK")).toBe(true);
    expect(isCjkCharset("Shift_JIS")).toBe(true);
    expect(isCjkCharset("euc-kr")).toBe(true);
    expect(isCjkCharset("")).toBe(false);
    expect(isCjkCharset("UTF-8")).toBe(false);
    expect(ambiguousIsWide(undefined, "GBK")).toBe(true);
    expect(ambiguousIsWide({ ambiguousWidth: "narrow" }, "GBK")).toBe(false);
    expect(ambiguousIsWide({ ambiguousWidth: "wide" }, "")).toBe(true);
    expect(ambiguousIsWide({ ambiguousWidth: "auto" }, "UTF-8")).toBe(false);
  });

  it("widens only width-1 ambiguous characters", () => {
    const base: IUnicodeVersionProvider = {
      version: "t",
      wcwidth: (c) => (c === 0x0301 ? 0 : c === 0x4e2d ? 2 : 1),
      charProperties: (c) => ((c === 0x0301 ? 0 : c === 0x4e2d ? 2 : 1) << 1) | (5 << 3),
    };
    const p = wideAmbiguousProvider(base);
    expect(p.version).toBe(WIDE_AMBIGUOUS_VERSION);
    expect(p.wcwidth(cp("●"))).toBe(2);
    expect(p.wcwidth(cp("a"))).toBe(1);
    expect(p.wcwidth(0x0301)).toBe(0); // combining acute stays zero width
    expect(p.wcwidth(0x4e2d)).toBe(2);
    const props = p.charProperties(cp("│"), 0);
    expect((props >> 1) & 3).toBe(2);
    expect(props >> 3).toBe(5); // other bits kept
  });

  it("widens the real Unicode 11 table", () => {
    const caught: IUnicodeVersionProvider[] = [];
    new Unicode11Addon().activate({ unicode: { register: (p: IUnicodeVersionProvider) => caught.push(p) } } as never);
    const p = wideAmbiguousProvider(caught[0]);
    const width = (s: string) => [...s].reduce((n, ch) => n + p.wcwidth(ch.codePointAt(0)!), 0);
    expect(width("│├┼┤x")).toBe(9);
    expect(width("━━ ■")).toBe(7);
    expect(width("通州abc")).toBe(7);
    expect(caught[0].wcwidth(cp("●"))).toBe(1);
  });
});

describe("relay pages' ambiguous table", () => {
  it("matches the desktop one", async () => {
    // @ts-expect-error plain JS module served to the phone and share pages
    const relay = (await import("../../relay/public/ambiguous.js")) as { isAmbiguous: (cp: number) => boolean };
    for (let c = 0; c < 0x30000; c++) if (relay.isAmbiguous(c) !== isAmbiguous(c)) expect(c.toString(16)).toBe("same");
    expect(relay.isAmbiguous(0xe0100)).toBe(isAmbiguous(0xe0100));
  });
});
