import { afterEach, describe, expect, it, vi } from "vitest";
import { utf8Base64, zmodemDrop } from "../utils/zmodemDrop";

const file = (name: string) => new File(["x"], name);

describe("zmodemDrop", () => {
  afterEach(() => vi.useRealTimers());

  it("hands the dropped files to the pane's upload request once", () => {
    zmodemDrop.queue("p1", [file("a.txt")], () => undefined);
    expect(zmodemDrop.has("p1")).toBe(true);
    expect(zmodemDrop.take("p1")?.map((f) => f.name)).toEqual(["a.txt"]);
    expect(zmodemDrop.take("p1")).toBeNull();
  });

  it("expires when rz never answers, and a new drop replaces the old one", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    zmodemDrop.queue("p2", [file("old")], expired, 1000);
    zmodemDrop.queue("p2", [file("new")], expired, 1000);
    vi.advanceTimersByTime(999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(zmodemDrop.take("p2")).toBeNull();
  });

  it("encodes non-ASCII file names for headers", () => {
    expect(atob(utf8Base64("报告.pdf"))).toBe(String.fromCharCode(...new TextEncoder().encode("报告.pdf")));
  });
});
