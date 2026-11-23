// Screen mirror helpers (pure): scrcpy packet headers, H.264 config parsing for WebCodecs,
// pointer -> device coordinates, and KeyboardEvent -> Android keycodes.

/** Video packet kinds from the 12-byte scrcpy header. */
export type MirrorPacket =
  | { kind: "session"; width: number; height: number }
  | { kind: "config"; data: Uint8Array }
  | { kind: "frame"; key: boolean; pts: number; data: Uint8Array };

/** In the high 32 bits of the 64-bit pts: bit 62 config, bit 61 key frame. */
const HI_CONFIG = 1 << 30;
const HI_KEY = 1 << 29;

export function parseMirrorPacket(buf: ArrayBuffer): MirrorPacket | null {
  if (buf.byteLength < 12) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) & 0x80) return { kind: "session", width: v.getUint32(4), height: v.getUint32(8) };
  const hi = v.getUint32(0);
  const lo = v.getUint32(4);
  const len = v.getUint32(8);
  const data = new Uint8Array(buf, 12, Math.min(len, buf.byteLength - 12));
  if (hi & HI_CONFIG) return { kind: "config", data };
  // pts in microseconds: below 2^53 for centuries, exact as a number.
  const pts = (hi & (HI_KEY - 1)) * 0x1_0000_0000 + lo;
  return { kind: "frame", key: (hi & HI_KEY) !== 0, pts, data };
}

/** The SPS NAL unit (type 7) of an Annex B buffer. */
export function findSps(data: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 3 < data.length; i++) {
    const three = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (!three) continue;
    const start = i + 3;
    if ((data[start] & 0x1f) !== 7) continue;
    let end = data.length;
    for (let j = start; j + 2 < data.length; j++) {
      if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))) {
        end = j;
        break;
      }
    }
    return data.subarray(start, end);
  }
  return null;
}

/** WebCodecs codec string ("avc1.640028") from the SPS profile / constraints / level bytes. */
export function avcCodecString(config: Uint8Array): string {
  const sps = findSps(config);
  if (!sps || sps.length < 4) return "avc1.42E01F";
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** Config + key frame in one chunk: WebCodecs wants SPS/PPS in the key frame (Annex B). */
export function joinBytes(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (!a) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Point in the displayed image -> device video pixels (clamped). */
export function toDevice(
  px: number,
  py: number,
  box: { w: number; h: number },
  video: { w: number; h: number }
): { x: number; y: number } {
  if (!box.w || !box.h) return { x: 0, y: 0 };
  const x = Math.round((px / box.w) * video.w);
  const y = Math.round((py / box.h) * video.h);
  return { x: Math.max(0, Math.min(video.w - 1, x)), y: Math.max(0, Math.min(video.h - 1, y)) };
}

/** Largest box with the video's aspect ratio inside the area. */
export function fitBox(areaW: number, areaH: number, videoW: number, videoH: number): { w: number; h: number } {
  if (!videoW || !videoH || !areaW || !areaH) return { w: 0, h: 0 };
  const s = Math.min(areaW / videoW, areaH / videoH);
  return { w: Math.floor(videoW * s), h: Math.floor(videoH * s) };
}

/** Android KeyEvent keycodes. */
export const KEYCODE = {
  HOME: 3,
  BACK: 4,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  APP_SWITCH: 187,
  MENU: 82,
} as const;

const NAMED: Record<string, number> = {
  Enter: KEYCODE.ENTER,
  NumpadEnter: KEYCODE.ENTER,
  Backspace: KEYCODE.DEL,
  Delete: KEYCODE.FORWARD_DEL,
  Tab: KEYCODE.TAB,
  Escape: KEYCODE.BACK,
  ArrowUp: KEYCODE.DPAD_UP,
  ArrowDown: KEYCODE.DPAD_DOWN,
  ArrowLeft: KEYCODE.DPAD_LEFT,
  ArrowRight: KEYCODE.DPAD_RIGHT,
  Home: KEYCODE.MOVE_HOME,
  End: KEYCODE.MOVE_END,
  PageUp: KEYCODE.PAGE_UP,
  PageDown: KEYCODE.PAGE_DOWN,
};

/** META_* bits for injected keys. */
export function metaState(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): number {
  return (e.shiftKey ? 0x1 : 0) | (e.altKey ? 0x2 : 0) | (e.ctrlKey ? 0x1000 : 0);
}

/**
 * A key the device should get as a keycode (navigation, editing, shortcuts). Plain
 * printable characters return null: they go as text, which works with every keyboard
 * layout and input method.
 */
export function keycodeFor(e: { code: string; key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number | null {
  if (NAMED[e.code] !== undefined) return NAMED[e.code];
  if (e.ctrlKey || e.altKey) {
    // Ctrl+A / Ctrl+C ...: letters and digits as keycodes so shortcuts work.
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter) return 29 + (letter[1].charCodeAt(0) - 65);
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit) return 7 + Number(digit[1]);
  }
  return null;
}

/** Text to inject for a key press (a printable character without Ctrl / Alt), else null. */
export function textFor(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  return [...e.key].length === 1 ? e.key : null;
}
