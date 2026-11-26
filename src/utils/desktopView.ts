import { DEFAULT_DESKTOP, type SessionConfig } from "../types/domain";

/**
 * Remote desktop pane logic without the DOM: frame messages from the backend
 * (`src-tauri/src/desktop/frame.rs`), where the picture sits in the pane, and pane
 * coordinates to remote desktop pixels.
 */

export const MSG_RESIZE = 1;
export const MSG_BATCH = 2;
export const MSG_CURSOR = 3;
export const MSG_CURSOR_HIDDEN = 4;
export const MSG_CURSOR_DEFAULT = 5;

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Byte offset of the rect's RGBA pixels in the message buffer. */
  offset: number;
}

export type DesktopFrame =
  | { kind: "resize"; width: number; height: number }
  | { kind: "batch"; seq: number; rects: FrameRect[] }
  | { kind: "cursor"; hotX: number; hotY: number; width: number; height: number; offset: number }
  | { kind: "cursorHidden" }
  | { kind: "cursorDefault" };

/** Decode one frame message; null if malformed (never throws on bad input). */
export function parseFrame(buf: ArrayBuffer): DesktopFrame | null {
  const view = new DataView(buf);
  if (view.byteLength < 1) return null;
  const u16 = (at: number) => view.getUint16(at, true);
  switch (view.getUint8(0)) {
    case MSG_RESIZE:
      if (view.byteLength < 5) return null;
      return { kind: "resize", width: u16(1), height: u16(3) };
    case MSG_BATCH: {
      if (view.byteLength < 7) return null;
      const seq = view.getUint32(1, true);
      const count = u16(5);
      const rects: FrameRect[] = [];
      let at = 7;
      for (let i = 0; i < count; i++) {
        if (at + 8 > view.byteLength) return null;
        const rect = { x: u16(at), y: u16(at + 2), w: u16(at + 4), h: u16(at + 6), offset: at + 8 };
        at = rect.offset + rect.w * rect.h * 4;
        if (at > view.byteLength) return null;
        rects.push(rect);
      }
      return { kind: "batch", seq, rects };
    }
    case MSG_CURSOR: {
      if (view.byteLength < 9) return null;
      const cursor = { kind: "cursor" as const, hotX: u16(1), hotY: u16(3), width: u16(5), height: u16(7), offset: 9 };
      if (9 + cursor.width * cursor.height * 4 > view.byteLength) return null;
      return cursor;
    }
    case MSG_CURSOR_HIDDEN:
      return { kind: "cursorHidden" };
    case MSG_CURSOR_DEFAULT:
      return { kind: "cursorDefault" };
    default:
      return null;
  }
}

export type ScaleMode = "fit" | "actual" | "stretch";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the remote picture is drawn in a `viewW` x `viewH` pane (CSS pixels).
 * `fit` keeps the aspect ratio and centers, `stretch` fills, `actual` draws one remote
 * pixel per device pixel from the top left (the pane scrolls).
 */
export function imageBox(viewW: number, viewH: number, remoteW: number, remoteH: number, mode: ScaleMode, dpr = 1): Box {
  if (remoteW <= 0 || remoteH <= 0 || viewW <= 0 || viewH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  if (mode === "stretch") return { x: 0, y: 0, w: viewW, h: viewH };
  if (mode === "actual") {
    const w = remoteW / dpr;
    const h = remoteH / dpr;
    return { x: Math.max(0, (viewW - w) / 2), y: Math.max(0, (viewH - h) / 2), w, h };
  }
  const scale = Math.min(viewW / remoteW, viewH / remoteH);
  const w = remoteW * scale;
  const h = remoteH * scale;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/** A point relative to the drawn picture (CSS pixels) in remote pixels, clamped to the desktop. */
export function toRemote(px: number, py: number, box: Box, remoteW: number, remoteH: number): { x: number; y: number } {
  if (box.w <= 0 || box.h <= 0) return { x: 0, y: 0 };
  const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.floor(v)), Math.max(0, max - 1));
  return { x: clamp((px * remoteW) / box.w, remoteW), y: clamp((py * remoteH) / box.h, remoteH) };
}

/**
 * Wheel delta (WheelEvent) in 1/120 notch units, positive = away from the user, as RDP and
 * the backend expect. Chromium reports 100 px per notch for a mouse wheel.
 */
/** Desktop toolbar position along the pane's top edge, 0 (left) .. 1 (right). */
export function clampToolbarX(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

/** The stored toolbar position; centered when missing or unreadable. */
export function parseToolbarX(raw: string | null | undefined): number {
  return raw ? clampToolbarX(Number(raw)) : 0.5;
}

export function wheelUnits(delta: number, deltaMode: number): number {
  if (!delta) return 0;
  const notches = deltaMode === 1 ? delta / 3 : deltaMode === 2 ? delta : delta / 100;
  const units = Math.round(-notches * 120);
  if (units === 0) return delta > 0 ? -1 : 1;
  return Math.max(-1200, Math.min(1200, units));
}

/** Desktop size to ask for: the pane in device pixels (the backend rounds it further). */
export function requestedSize(cssW: number, cssH: number, dpr: number): { width: number; height: number; scale: number } {
  const ratio = dpr > 0 ? dpr : 1;
  return {
    width: Math.max(200, Math.round(cssW * ratio)),
    height: Math.max(200, Math.round(cssH * ratio)),
    scale: Math.min(500, Math.max(100, Math.round(ratio * 100))),
  };
}

/**
 * What an RDP pane must ask for before connecting. With NLA the credentials go to the server
 * before any session (and logon screen) exists, so a missing user name or password can only
 * fail; without NLA the remote computer shows its own sign-in screen instead. null = nothing.
 */
export function missingDesktopCredentials(
  session: Pick<SessionConfig, "protocol" | "username" | "password" | "desktop" | "credentialHandoff" | "credentialId">
): { user: boolean; password: boolean } | null {
  if (session.protocol !== "rdp") return null;
  if (!{ ...DEFAULT_DESKTOP, ...(session.desktop ?? {}) }.nla) return null;
  const user = !session.username.trim();
  // A plugin hands its password over at connect time (`credentialHandoff`); a saved credential has one.
  const password = !session.password && !session.credentialHandoff && !session.credentialId;
  return user || password ? { user, password } : null;
}
