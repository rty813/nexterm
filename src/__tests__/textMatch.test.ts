import { describe, expect, it } from "vitest";
import { buildMatcher, contrastText } from "../utils/textMatch";

const all = (re: RegExp | null, s: string) => (re ? [...s.matchAll(re)].map((m) => m[0]) : []);

describe("buildMatcher", () => {
  it("handles case, whole word, regex and literal escaping", () => {
    expect(all(buildMatcher("error", {}).re, "Error error ERRORS")).toEqual(["Error", "error", "ERROR"]);
    expect(all(buildMatcher("error", { caseSensitive: true }).re, "Error error")).toEqual(["error"]);
    expect(all(buildMatcher("err", { wholeWord: true }).re, "err error err_x 中err")).toEqual(["err"]);
    expect(all(buildMatcher("a.c", {}).re, "abc a.c")).toEqual(["a.c"]);
    expect(all(buildMatcher("a.c", { regex: true }).re, "abc a.c")).toEqual(["abc", "a.c"]);
    expect(all(buildMatcher(String.raw`\d+ms`,{ regex: true }).re, "took 12ms and 7ms")).toEqual(["12ms", "7ms"]);
    expect(all(buildMatcher("错误", { wholeWord: true }).re, "发生错误 错误")).toEqual(["错误"]);
  });

  it("reports bad and empty-matching patterns", () => {
    expect(buildMatcher("(", { regex: true }).error).toBeTruthy();
    expect(buildMatcher("a*", { regex: true }).error).toBe("empty");
    expect(buildMatcher("", {}).re).toBeNull();
  });

  it("picks readable text color", () => {
    expect(contrastText("#fde047")).toBe("#111111");
    expect(contrastText("#1e3a8a")).toBe("#ffffff");
  });
});
