import { describe, expect, it } from "vitest";
import { formatDuration, looksLikePrompt, osc133Exit } from "../utils/commandWatch";

describe("command watch", () => {
  it("recognizes shell prompts", () => {
    for (const p of ["alice@box:~$ ", "root@box:/# ", "PS C:\Users\me> ", "C:\>", "~ ❯ ", "me@mac ~ % ", "~> "]) {
      expect(looksLikePrompt(p)).toBe(true);
    }
    for (const p of ["", "   ", "Compiling foo v0.1.0", "[=====>    ] 50%", "Password:"]) {
      expect(looksLikePrompt(p)).toBe(false);
    }
  });

  it("reads OSC 133 exit codes and formats durations", () => {
    expect(osc133Exit("D;0")).toBe(0);
    expect(osc133Exit("D;2")).toBe(2);
    expect(osc133Exit("D")).toBeNull();
    expect(formatDuration(5_400)).toBe("5s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
  });
});

describe("progress output is not a prompt", () => {
  it("ignores bars and percentages", () => {
    for (const p of ["[ 50%", "Downloading 45.0 %", "######", "  ==>", "[====->"]) expect(looksLikePrompt(p)).toBe(false);
  });
});
