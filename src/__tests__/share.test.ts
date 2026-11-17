import { describe, expect, it } from "vitest";
import type { ShareInfo, ShareViewer } from "../services/backend";
import { DEFAULT_SHARE_OPTIONS, remaining, shareErrorKey, shareOfPane, summarizeShare } from "../utils/share";

const viewer = (id: number, patch: Partial<ShareViewer> = {}): ShareViewer => ({
  id,
  name: `v${id}`,
  pending: false,
  control: false,
  asking: false,
  ...patch,
});

const share = (viewers: ShareViewer[], paneId = "p1"): ShareInfo => ({
  id: "s1",
  paneId,
  title: "prod",
  url: "https://relay/s#k=x",
  qrSvg: "",
  state: "online",
  message: null,
  expiresAt: null,
  options: DEFAULT_SHARE_OPTIONS,
  viewers,
});

describe("session shares", () => {
  it("defaults to read-only friendly options", () => {
    expect(DEFAULT_SHARE_OPTIONS).toEqual({ expiresMinutes: 240, scrollback: false, approve: false, single: false });
  });

  it("finds the share of a pane", () => {
    const list = [share([], "a"), share([], "b")];
    expect(shareOfPane(list, "b")?.paneId).toBe("b");
    expect(shareOfPane(list, "c")).toBeUndefined();
  });

  it("summarizes viewers, control and requests", () => {
    const s = share([viewer(1), viewer(2, { control: true }), viewer(3, { asking: true }), viewer(4, { pending: true })]);
    const sum = summarizeShare(s);
    expect(sum.watching).toBe(3);
    expect(sum.controller?.id).toBe(2);
    expect(sum.requests.map((v) => v.id)).toEqual([3, 4]);
  });

  it("a viewer with control is not a request", () => {
    const sum = summarizeShare(share([viewer(1, { control: true, asking: true })]));
    expect(sum.requests).toEqual([]);
  });

  it("time left", () => {
    expect(remaining(null, 0)).toBeNull();
    expect(remaining(90 * 60_000, 0)).toEqual({ hours: 1, minutes: 30 });
    expect(remaining(30_001, 0)).toEqual({ hours: 0, minutes: 1 });
    expect(remaining(0, 5000)).toEqual({ hours: 0, minutes: 0 });
  });

  it("maps backend errors to messages", () => {
    expect(shareErrorKey("no-relay")).toBe("share.errNoRelay");
    expect(shareErrorKey(new Error("old-relay"))).toBe("share.errOldRelay");
    expect(shareErrorKey("too-many")).toBe("share.errTooMany");
    expect(shareErrorKey("relay answered HTTP 500")).toBeNull();
  });
});
