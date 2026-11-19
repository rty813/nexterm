import { describe, expect, it } from "vitest";
import { commitNumberDraft, parseNumberDraft } from "../utils/numberDraft";

const font = { min: 9, max: 32 };

describe("number draft", () => {
  it("does not apply an empty or partial value while typing", () => {
    expect(parseNumberDraft("", font)).toBeNull();
    expect(parseNumberDraft("2", font)).toBeNull(); // on the way to "20"
    expect(parseNumberDraft("20", font)).toBe(20);
    expect(parseNumberDraft("33", font)).toBeNull();
    expect(parseNumberDraft("1.5", { integer: true })).toBeNull();
  });

  it("settles on blur: clamps, or keeps the current value when empty", () => {
    expect(commitNumberDraft("", 14, font)).toBe(14);
    expect(commitNumberDraft("2", 14, font)).toBe(9);
    expect(commitNumberDraft("99", 14, font)).toBe(32);
    expect(commitNumberDraft("2.6", 1, { integer: true, min: 1 })).toBe(3);
  });
});
