import { backend } from "./backend";

/**
 * Forwards what watched panes show to the phone remote (see src-tauri/src/remote.rs).
 * The desktop xterm.js is the source of truth: a phone that opens a tab first gets the
 * serialized screen plus the output xterm has not parsed yet, then every chunk that
 * arrives after it, so the two never drift.
 *
 * Nothing here waits on timers: the phone is often used while this window is minimized
 * or covered, where WebView2 throttles timers (and xterm's parsing) to about once a second.
 */

/** Record kinds of `remote_feed`. */
const F_OUTPUT = 1;
const F_SIZE = 2;
const F_SNAPSHOT = 3;
const F_SNAPSHOT_ALL = 4;
const FLUSH_BYTES = 256 * 1024;

export interface MirrorPane {
  /** Screen + scrollback as VT sequences. */
  serialize: () => string;
  size: () => { cols: number; rows: number };
  /** A phone took over the size (null: given back). */
  setSizeOverride: (size: { cols: number; rows: number } | null) => void;
}

const enc = new TextEncoder();
const panes = new Map<string, MirrorPane>();
const watched = new Set<string>();
const sizes = new Map<string, { cols: number; rows: number }>();
const pending = new Map<string, Uint8Array[]>();
/** Output received and not yet parsed by the pane's xterm, oldest first. */
const unparsed = new Map<string, Uint8Array[]>();
let pendingBytes = 0;
let flushQueued = false;
let started = false;

function record(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}

function sizeBytes(cols: number, rows: number): Uint8Array {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint16(0, cols, true);
  v.setUint16(2, rows, true);
  return b;
}

function queue(paneId: string, rec: Uint8Array) {
  const list = pending.get(paneId) ?? [];
  list.push(rec);
  pending.set(paneId, list);
  pendingBytes += rec.length;
  if (pendingBytes >= FLUSH_BYTES) flush();
  else if (!flushQueued) {
    // Chunks of one IPC batch go out together.
    flushQueued = true;
    queueMicrotask(flush);
  }
}

function flush() {
  flushQueued = false;
  pendingBytes = 0;
  for (const [paneId, list] of pending) {
    const body = new Uint8Array(list.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of list) {
      body.set(r, at);
      at += r.length;
    }
    void backend.remoteFeed(paneId, body);
  }
  pending.clear();
}

/** all: every watcher resets (the desktop rewrote the screen); else only phones waiting for one. */
function snapshot(paneId: string, all = false) {
  const pane = panes.get(paneId);
  if (!pane || !watched.has(paneId)) return;
  const { cols, rows } = pane.size();
  const screen = enc.encode(pane.serialize());
  const rest = unparsed.get(paneId) ?? [];
  const payload = new Uint8Array(4 + screen.length + rest.reduce((n, c) => n + c.length, 0));
  payload.set(sizeBytes(cols, rows));
  payload.set(screen, 4);
  let at = 4 + screen.length;
  for (const c of rest) {
    payload.set(c, at);
    at += c.length;
  }
  // Output already queued goes first, to the phones that are in sync.
  queue(paneId, record(all ? F_SNAPSHOT_ALL : F_SNAPSHOT, payload));
  flush();
}

function start() {
  if (started) return;
  started = true;
  void backend.remoteWatchState().then((s) => {
    for (const id of s.watched) watched.add(id);
    for (const sz of s.sizes) {
      sizes.set(sz.paneId, { cols: sz.cols, rows: sz.rows });
      panes.get(sz.paneId)?.setSizeOverride({ cols: sz.cols, rows: sz.rows });
    }
    for (const id of s.watched) snapshot(id);
  });
  void backend.onRemoteWatch((list) => {
    watched.clear();
    for (const id of list) watched.add(id);
  });
  void backend.onRemoteSnapshot((paneId) => snapshot(paneId));
  void backend.onRemoteSize(({ paneId, cols, rows }) => {
    const size = cols && rows ? { cols, rows } : null;
    if (size) sizes.set(paneId, size);
    else sizes.delete(paneId);
    panes.get(paneId)?.setSizeOverride(size);
  });
}

export const remoteMirror = {
  register(paneId: string, pane: MirrorPane): () => void {
    start();
    panes.set(paneId, pane);
    const size = sizes.get(paneId);
    if (size) pane.setSizeOverride(size);
    // Mounted after a phone asked for it (tab moved to this window).
    snapshot(paneId);
    return () => {
      if (panes.get(paneId) === pane) {
        panes.delete(paneId);
        unparsed.delete(paneId);
      }
    };
  },

  isWatched(paneId: string): boolean {
    return watched.has(paneId);
  },

  /** Output arrived for the pane (before xterm parses it). */
  received(paneId: string, bytes: Uint8Array) {
    const list = unparsed.get(paneId);
    if (list) list.push(bytes);
    else unparsed.set(paneId, [bytes]);
    if (watched.has(paneId)) queue(paneId, record(F_OUTPUT, bytes));
  },

  /** xterm parsed the oldest received chunk (write callbacks run in order). */
  parsed(paneId: string) {
    unparsed.get(paneId)?.shift();
  },

  resized(paneId: string, cols: number, rows: number) {
    if (watched.has(paneId)) queue(paneId, record(F_SIZE, sizeBytes(cols, rows)));
  },

  /** The desktop changed the screen without output (clear, reset, fold): resend it. */
  refresh(paneId: string) {
    if (!watched.has(paneId)) return;
    window.setTimeout(() => snapshot(paneId, true), 50);
  },

  /** Desktop takes the size back from the phone. */
  release(paneId: string) {
    void backend.remoteRelease(paneId);
  },
};
