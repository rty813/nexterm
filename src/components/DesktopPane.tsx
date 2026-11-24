import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Keyboard, Maximize2, Minimize2, RotateCw, Scan } from "lucide-react";
import { backend, type DesktopInput } from "../services/backend";
import { DEFAULT_DESKTOP, type TerminalLeafNode } from "../types/domain";
import {
  imageBox,
  missingDesktopCredentials,
  parseFrame,
  requestedSize,
  toRemote,
  wheelUnits,
  type Box,
  type ScaleMode,
} from "../utils/desktopView";
import type { PaneApi, PaneExtras, ReconnectCredentials } from "./TerminalPane";

interface DesktopPaneProps {
  leaf: TerminalLeafNode;
  visible: boolean;
  isActive: boolean;
  extras: PaneExtras;
  onActivate: (paneId: string) => void;
  onReconnectPane: (paneId: string, creds?: ReconnectCredentials) => void;
}

const noop = () => {};

/** Cursor image as a CSS `cursor` value (browsers ignore cursors over 128 px). */
function cursorCss(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, hotX: number, hotY: number): string {
  if (width > 128 || height > 128) return "default";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "default";
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return `url(${canvas.toDataURL("image/png")}) ${hotX} ${hotY}, default`;
}

/**
 * An RDP / VNC pane: the backend runs the protocol (`src-tauri/src/desktop/`) and sends the
 * changed parts of the remote screen; this draws them on a canvas the size of the remote
 * desktop (scaled by CSS) and returns keyboard and mouse input.
 */
export const DesktopPane: React.FC<DesktopPaneProps> = ({ leaf, visible, isActive, extras, onActivate, onReconnectPane }) => {
  const { t } = useTranslation();
  const paneId = leaf.paneId;
  const desktop = { ...DEFAULT_DESKTOP, ...(leaf.session.desktop ?? {}) };
  const viewOnly = leaf.session.protocol === "vnc" && desktop.viewOnly;
  const isVnc = leaf.session.protocol === "vnc";

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [remote, setRemote] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const [view, setView] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [scale, setScale] = useState<ScaleMode>(desktop.scale);
  const [cursor, setCursor] = useState("default");
  const [fullscreen, setFullscreen] = useState(false);

  // ---- credentials: NLA signs in before the session exists, so ask before connecting.
  const isRdp = leaf.session.protocol === "rdp";
  const [authOpen, setAuthOpen] = useState(() => missingDesktopCredentials(leaf.session) !== null);
  /** Only the user name is missing: the password comes from a saved credential. */
  const asksPassword = !(leaf.session.credentialId && !leaf.session.username.trim());
  const [userInput, setUserInput] = useState(leaf.session.username);
  const [passwordInput, setPasswordInput] = useState("");
  const [remember, setRemember] = useState(true);
  const authOpenRef = useRef(authOpen);
  authOpenRef.current = authOpen;
  const submitAuth = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || (asksPassword && isRdp && desktop.nla && !passwordInput)) return;
    setAuthOpen(false);
    setPasswordInput("");
    onReconnectPane(paneId, { username: userInput.trim(), password: asksPassword ? passwordInput : undefined, remember });
  };

  const dpr = window.devicePixelRatio || 1;
  const box: Box = imageBox(view.w, view.h, remote.w, remote.h, scale, dpr);
  const boxRef = useRef(box);
  boxRef.current = box;

  // ---- frames from the backend
  const onFrame = useCallback(
    (buf: ArrayBuffer) => {
      const frame = parseFrame(buf);
      const canvas = canvasRef.current;
      if (!frame || !canvas) return;
      switch (frame.kind) {
        case "resize":
          canvas.width = frame.width;
          canvas.height = frame.height;
          setRemote({ w: frame.width, h: frame.height });
          break;
        case "batch": {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            for (const r of frame.rects) {
              if (r.w === 0 || r.h === 0) continue;
              const pixels = new Uint8ClampedArray(buf, r.offset, r.w * r.h * 4);
              ctx.putImageData(new ImageData(pixels, r.w, r.h), r.x, r.y);
            }
          }
          // Drawn: release the next batch (flow control in `desktop/frame.rs`).
          backend.desktopAck(paneId, frame.seq);
          break;
        }
        case "cursor":
          setCursor(cursorCss(new Uint8ClampedArray(buf, frame.offset, frame.width * frame.height * 4), frame.width, frame.height, frame.hotX, frame.hotY));
          break;
        case "cursorHidden":
          setCursor("none");
          break;
        case "cursorDefault":
          setCursor("default");
          break;
      }
    },
    [paneId]
  );

  // ---- connect (again on every reconnect)
  useEffect(() => {
    if (authOpenRef.current) return;
    const el = containerRef.current;
    const w = el?.clientWidth || 1280;
    const h = el?.clientHeight || 800;
    const size = requestedSize(w, h, window.devicePixelRatio || 1);
    void backend.desktopConnect(paneId, leaf.session, size.width, size.height, size.scale, onFrame).catch((err) => {
      console.warn("desktop connect failed", err);
    });
    // The pane closing disconnects through `disconnect_terminal` (App), which also ends
    // desktop sessions; nothing to do on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, leaf.reconnectCount, authOpen]);

  // ---- pane size: layout, and the remote desktop follows it ("fit-window")
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      setView({ w, h });
      if (desktop.resize === "fit-window") {
        const size = requestedSize(w, h, window.devicePixelRatio || 1);
        backend.desktopResize(paneId, size.width, size.height, size.scale);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneId, desktop.resize]);

  // ---- input
  const send = useCallback((events: DesktopInput[]) => {
    if (!viewOnly) backend.desktopInput(paneId, events);
  }, [paneId, viewOnly]);

  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef(0);
  const flushMove = useCallback(() => {
    moveFrame.current = 0;
    const p = pendingMove.current;
    pendingMove.current = null;
    if (p) send([{ type: "move", x: p.x, y: p.y }]);
  }, [send]);

  const remotePoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const r = remoteRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return toRemote(e.clientX - rect.left, e.clientY - rect.top, { x: 0, y: 0, w: rect.width, h: rect.height }, r.w, r.h);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    pendingMove.current = remotePoint(e);
    // One move per frame is plenty; mouse input never happens while the window is hidden.
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove);
  };

  const onPointerButton = (down: boolean) => (e: React.PointerEvent) => {
    if (down) {
      containerRef.current?.focus();
      onActivate(paneId);
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
    if (moveFrame.current) {
      cancelAnimationFrame(moveFrame.current);
      flushMove();
    }
    const p = remotePoint(e);
    send([{ type: "button", x: p.x, y: p.y, button: e.button, down }]);
    e.preventDefault();
  };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (scale !== "actual") e.preventDefault();
      const p = remotePoint(e);
      const dy = wheelUnits(e.deltaY, e.deltaMode);
      const dx = -wheelUnits(e.deltaX, e.deltaMode);
      if (dx || dy) send([{ type: "wheel", x: p.x, y: p.y, dx, dy }]);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, scale]);

  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    // Typing in the sign-in card is not remote input.
    if (authOpen || (e.target as HTMLElement).closest?.("input, textarea, select")) return;
    // A local input method is composing: its result is typed on the remote side through
    // the remote's own input method instead.
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    e.preventDefault();
    e.stopPropagation();
    send([{ type: "key", code: e.code, key: e.key, down }]);
  };

  const onFocus = () => {
    // VNC has no clipboard sync of its own: offer the local text when the pane is entered.
    if (isVnc && desktop.clipboard && !viewOnly) {
      void backend.readClipboard().then((text) => text && send([{ type: "clipboard", text }]));
    }
  };

  const onBlur = () => send([{ type: "releaseAll" }]);

  // VNC server clipboard -> local clipboard.
  useEffect(() => {
    if (!isVnc || !desktop.clipboard) return;
    const un = backend.onDesktopClipboard((p) => {
      if (p.instanceId === paneId) void backend.writeClipboard(p.text);
    });
    return () => void un.then((f) => f());
  }, [paneId, isVnc, desktop.clipboard]);

  // Focus follows the active pane, like terminals.
  useEffect(() => {
    if (isActive && visible && !authOpen) containerRef.current?.focus({ preventScroll: true });
  }, [isActive, visible, authOpen]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // The app's pane commands (focus, paste, sync input) reach this pane too.
  useEffect(() => {
    const typeText = (text: string) => send([{ type: "text", text }]);
    const api: PaneApi = {
      copy: noop,
      paste: () => void backend.readClipboard().then((text) => text && typeText(text)),
      selectAll: noop,
      clear: noop,
      find: noop,
      focus: () => containerRef.current?.focus(),
      toggleTimestamps: noop,
      reset: noop,
      clearScrollback: noop,
      saveToFile: noop,
      pasteText: typeText,
      foldAll: noop,
      unfoldAll: noop,
      sendText: typeText,
    };
    extras.registerTerminal(paneId, api);
    return () => extras.registerTerminal(paneId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, send]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().then(() => el.focus());
  };

  const nextScale = () => setScale((s) => (s === "fit" ? "actual" : s === "actual" ? "stretch" : "fit"));

  const failed = leaf.status === "disconnected" || leaf.status === "error";
  const connecting = !authOpen && leaf.status === "connecting" && remote.w === 0;

  return (
    <div
      ref={containerRef}
      className={`desktop-pane ${scale === "actual" ? "desktop-scroll" : ""}`}
      tabIndex={0}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDown={() => onActivate(paneId)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="desktop-canvas"
        style={{
          left: box.x,
          top: box.y,
          width: box.w || undefined,
          height: box.h || undefined,
          cursor: viewOnly ? "default" : cursor,
          visibility: remote.w ? "visible" : "hidden",
        }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerButton(true)}
        onPointerUp={onPointerButton(false)}
      />

      <div className="desktop-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        {!isVnc || !viewOnly ? (
          <button type="button" className="btn-ghost btn-xs" title={t("desktop.ctrlAltDel")} onClick={() => send([{ type: "ctrlAltDel" }])}>
            <Keyboard size={13} />
          </button>
        ) : null}
        <button type="button" className="btn-ghost btn-xs" title={t(`desktop.scale.${scale}`)} onClick={nextScale}>
          <Scan size={13} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("pane.reconnect")} onClick={() => onReconnectPane(paneId)}>
          <RotateCw size={13} />
        </button>
      </div>

      {connecting && (
        <div className="desktop-status">
          {t("desktop.connecting", { target: `${leaf.session.host}:${leaf.session.port}` })}
        </div>
      )}

      {authOpen && (
        <div className="pane-auth-overlay" onMouseDown={(e) => e.stopPropagation()}>
          <form className="pane-auth-card" onSubmit={submitAuth}>
            <div className="pane-auth-header">
              <KeyRound size={16} />
              <span>
                {t("desktop.authTitle")} — {leaf.session.host}
                {leaf.session.port && leaf.session.port !== 3389 ? `:${leaf.session.port}` : ""}
              </span>
            </div>
            <input
              type="text"
              className="text-input"
              autoFocus={!userInput.trim()}
              placeholder={t("desktop.userPlaceholder")}
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              required
            />
            {asksPassword && (
              <input
                type="password"
                className="text-input"
                autoFocus={Boolean(userInput.trim())}
                placeholder={t("desktop.passwordPlaceholder")}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                required={desktop.nla}
              />
            )}
            <p className="adv-hint">{t("desktop.authHint")}</p>
            <div className="pane-auth-footer">
              <label className="checkbox-row">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>{t(asksPassword ? "pane.rememberPwd" : "pane.rememberUser")}</span>
              </label>
              <button type="submit" className="btn-primary btn-sm">
                {t("pane.connectNow")}
              </button>
            </div>
          </form>
        </div>
      )}

      {failed && !authOpen && (
        <div className="pane-disconnect-banner">
          <span>
            {leaf.status === "error" ? t("pane.connFailed") : t("pane.sessionEnded")}
            {leaf.statusMessage ? `: ${leaf.statusMessage}` : ""}
          </span>
          <div className="banner-actions">
            {isRdp && (
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => {
                  setUserInput(leaf.session.username);
                  setAuthOpen(true);
                }}
              >
                {t("desktop.enterCredentials")}
              </button>
            )}
            <button type="button" className="btn-primary btn-xs" onClick={() => onReconnectPane(paneId)}>
              <RotateCw size={12} /> {t("pane.reconnect")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
