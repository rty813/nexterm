import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP } from "../types/domain";
import {
  MSG_BATCH,
  MSG_CURSOR,
  MSG_CURSOR_HIDDEN,
  MSG_RESIZE,
  imageBox,
  missingDesktopCredentials,
  parseFrame,
  requestedSize,
  toRemote,
  wheelUnits,
} from "../utils/desktopView";

function bytes(...parts: number[][]): ArrayBuffer {
  return new Uint8Array(parts.flat()).buffer;
}
const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];

describe("desktop frame messages", () => {
  it("parses resize, batches and cursors like desktop/frame.rs encodes them", () => {
    expect(parseFrame(bytes([MSG_RESIZE], u16(1920), u16(1080)))).toEqual({ kind: "resize", width: 1920, height: 1080 });

    const px = [1, 2, 3, 255, 4, 5, 6, 255];
    const batch = parseFrame(bytes([MSG_BATCH], u32(7), u16(2), u16(10), u16(20), u16(2), u16(1), px, u16(0), u16(0), u16(1), u16(1), px.slice(0, 4)));
    expect(batch).toEqual({
      kind: "batch",
      seq: 7,
      rects: [
        { x: 10, y: 20, w: 2, h: 1, offset: 15 },
        { x: 0, y: 0, w: 1, h: 1, offset: 31 },
      ],
    });

    const cursor = parseFrame(bytes([MSG_CURSOR], u16(3), u16(4), u16(1), u16(1), [9, 9, 9, 9]));
    expect(cursor).toEqual({ kind: "cursor", hotX: 3, hotY: 4, width: 1, height: 1, offset: 9 });
    expect(parseFrame(bytes([MSG_CURSOR_HIDDEN]))).toEqual({ kind: "cursorHidden" });
  });

  it("rejects truncated and unknown messages", () => {
    expect(parseFrame(new ArrayBuffer(0))).toBeNull();
    expect(parseFrame(bytes([MSG_RESIZE], u16(5)))).toBeNull();
    // Claims a 2x2 rect but carries one pixel.
    expect(parseFrame(bytes([MSG_BATCH], u32(1), u16(1), u16(0), u16(0), u16(2), u16(2), [0, 0, 0, 0]))).toBeNull();
    expect(parseFrame(bytes([99]))).toBeNull();
  });
});

describe("desktop geometry", () => {
  it("fits, stretches and shows actual size", () => {
    // 1600x900 pane, 1280x1024 desktop: height limits the scale.
    const fit = imageBox(1600, 900, 1280, 1024, "fit");
    expect(fit.h).toBe(900);
    expect(fit.w).toBeCloseTo(1125);
    expect(fit.x).toBeCloseTo((1600 - 1125) / 2);
    expect(imageBox(800, 600, 1920, 1080, "stretch")).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    // One remote pixel per device pixel at 150 %.
    expect(imageBox(800, 600, 1920, 1080, "actual", 1.5)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(imageBox(0, 600, 1920, 1080, "fit").w).toBe(0);
  });

  it("maps pane points to remote pixels and clamps them", () => {
    const box = { x: 0, y: 0, w: 960, h: 540 };
    expect(toRemote(480, 270, box, 1920, 1080)).toEqual({ x: 960, y: 540 });
    expect(toRemote(-5, 9999, box, 1920, 1080)).toEqual({ x: 0, y: 1079 });
  });

  it("converts wheel deltas to notch units (positive = up)", () => {
    expect(wheelUnits(100, 0)).toBe(-120);
    expect(wheelUnits(-100, 0)).toBe(120);
    expect(wheelUnits(3, 1)).toBe(-120);
    expect(wheelUnits(0.2, 0)).toBe(-1);
    expect(wheelUnits(0, 0)).toBe(0);
    expect(wheelUnits(100000, 0)).toBe(-1200);
  });

  it("asks for the pane size in device pixels", () => {
    expect(requestedSize(1000, 600, 1.25)).toEqual({ width: 1250, height: 750, scale: 125 });
    expect(requestedSize(50, 50, 1)).toEqual({ width: 200, height: 200, scale: 100 });
  });
});

describe("desktop credentials", () => {
  const rdp = { protocol: "rdp" as const, username: "", password: undefined, desktop: null };
  it("asks for what NLA needs and nothing else", () => {
    expect(missingDesktopCredentials(rdp)).toEqual({ user: true, password: true });
    expect(missingDesktopCredentials({ ...rdp, username: "alice" })).toEqual({ user: false, password: true });
    expect(missingDesktopCredentials({ ...rdp, username: "alice", password: "pw" })).toBeNull();
    // An empty saved password cannot pass NLA either.
    expect(missingDesktopCredentials({ ...rdp, username: "alice", password: "" })).toEqual({ user: false, password: true });
    expect(missingDesktopCredentials({ ...rdp, username: "alice", credentialHandoff: true })).toBeNull();
  });
  it("leaves the sign-in to the remote computer without NLA, and VNC alone", () => {
    expect(missingDesktopCredentials({ ...rdp, desktop: { ...DEFAULT_DESKTOP, nla: false } })).toBeNull();
    expect(missingDesktopCredentials({ ...rdp, protocol: "vnc" })).toBeNull();
  });
});
