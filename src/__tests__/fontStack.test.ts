import { describe, expect, it } from "vitest";
import { formatFontStack, parseFontStack, primaryFont, setPrimaryFont } from "../utils/fontStack";

const DEFAULT = "'Cascadia Mono', Consolas, 'Roboto Mono', 'Microsoft YaHei UI', monospace";

describe("font stack", () => {
  it("parses quoted and bare names", () => {
    expect(parseFontStack(DEFAULT)).toEqual(["Cascadia Mono", "Consolas", "Roboto Mono", "Microsoft YaHei UI", "monospace"]);
    expect(parseFontStack(` "Fira Code" ,  , JetBrains   Mono`)).toEqual(["Fira Code", "JetBrains Mono"]);
    expect(parseFontStack("")).toEqual([]);
  });

  it("quotes everything but generic keywords", () => {
    expect(formatFontStack(["Consolas", "等距更纱黑体 SC", "monospace"])).toBe("'Consolas', '等距更纱黑体 SC', monospace");
  });

  it("reads the first choice", () => {
    expect(primaryFont(DEFAULT)).toBe("Cascadia Mono");
    expect(primaryFont("  ")).toBe("");
  });

  it("replaces the first choice and keeps the fallbacks", () => {
    expect(setPrimaryFont(DEFAULT, "JetBrains Mono")).toBe(
      "'JetBrains Mono', 'Consolas', 'Roboto Mono', 'Microsoft YaHei UI', monospace",
    );
  });

  it("does not repeat a font that was already a fallback", () => {
    expect(setPrimaryFont(DEFAULT, "consolas")).toBe("'consolas', 'Roboto Mono', 'Microsoft YaHei UI', monospace");
  });

  it("keeps a generic first entry as a fallback", () => {
    expect(setPrimaryFont("monospace", "Fira Code")).toBe("'Fira Code', monospace");
  });

  it("adds default fallbacks to an empty stack", () => {
    expect(setPrimaryFont("", "Fira Code")).toBe("'Fira Code', 'Consolas', 'Microsoft YaHei UI', monospace");
  });
});
