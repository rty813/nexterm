import { describe, expect, it } from "vitest";
import type { AppSettings } from "../types/domain";
import { logRotationOf } from "../utils/settingsDefaults";

const s = (patch: Partial<AppSettings>) => patch as AppSettings;

describe("logRotationOf", () => {
  it("uses the saved rotation", () => {
    expect(logRotationOf(s({ logRotation: "daily", logMaxSizeMb: 10 }))).toBe("daily");
  });

  it("falls back to the older size split", () => {
    expect(logRotationOf(s({ logMaxSizeMb: 10 }))).toBe("size");
    expect(logRotationOf(s({}))).toBe("session");
  });
});
