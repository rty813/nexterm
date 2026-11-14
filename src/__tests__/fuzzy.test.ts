import { describe, expect, it } from "vitest";
import { bestScore, fuzzyScore } from "../utils/fuzzy";
import { looksLikeAddress } from "../utils/quickConnect";

describe("fuzzyScore", () => {
  it("matches characters in order, ignoring case and query spaces", () => {
    expect(fuzzyScore("nps", "New PowerShell tab")).not.toBeNull();
    expect(fuzzyScore("new ps", "New PowerShell tab")).not.toBeNull();
    expect(fuzzyScore("psn", "New PowerShell tab")).toBeNull();
  });

  it("ranks prefixes and word starts above scattered hits", () => {
    const prefix = fuzzyScore("split", "Split right")!;
    const inner = fuzzyScore("split", "Equalize splits")!;
    const scattered = fuzzyScore("split", "Save plain list to it")!;
    expect(prefix).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
  });

  it("matches Chinese labels", () => {
    expect(fuzzyScore("分屏", "向右分屏")).not.toBeNull();
    expect(fuzzyScore("右分", "向右分屏")!).toBeGreaterThan(fuzzyScore("向屏", "向右分屏")!);
  });

  it("an empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("bestScore", () => {
  it("prefers a label hit over a detail hit", () => {
    const label = bestScore("web", ["web-01", "root@10.0.0.1"])!;
    const detail = bestScore("web", ["prod", "root@web-01"])!;
    expect(label).toBeGreaterThan(detail);
    expect(bestScore("zzz", ["web", "host"])).toBeNull();
  });
});

describe("looksLikeAddress", () => {
  it("accepts addresses and connect commands", () => {
    for (const s of ["root@10.0.0.1", "ssh web-01", "ssh://a@b:2222", "tcp 127.0.0.1 47331", "telnet://router", "example.com", "10.0.0.1:22", "[::1]:22"]) {
      expect(looksLikeAddress(s), s).toBe(true);
    }
  });
  it("leaves plain search words alone", () => {
    for (const s of ["split", "new tab", "分屏", "web", ""]) {
      expect(looksLikeAddress(s), s).toBe(false);
    }
  });
});
