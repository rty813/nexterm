import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Minus, Pin, Square, X } from "lucide-react";
import { isTauriRuntime } from "../services/backend";

/** When the user last started dragging the window by our title bar (for docking). */
let titleDragAt = 0;
export const titleDragStartedRecently = (ms = 3000) => Date.now() - titleDragAt < ms;

const INTERACTIVE = "button, input, select, textarea, a, [role='button'], .no-drag, .quick-connect-bar";

/**
 * Our own window title bar (the native frame is off): drag to move, double-click to
 * maximize, and pin (always on top) / minimize / maximize / close buttons. `children`
 * (the toolbar) sit in it.
 */
export const TitleBar: React.FC<{
  title: string;
  children?: React.ReactNode;
  status?: React.ReactNode;
  /** Always on top (settings.alwaysOnTop); the pin button shows when onTogglePin is given. */
  pinned?: boolean;
  onTogglePin?: () => void;
}> = ({ title, children, status, pinned = false, onTogglePin }) => {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const desktop = isTauriRuntime();

  useEffect(() => {
    if (!desktop) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      setMaximized(await win.isMaximized());
      un = await win.onResized(() => void win.isMaximized().then(setMaximized));
    });
    return () => un?.();
  }, [desktop]);

  const withWindow = (fn: (w: import("@tauri-apps/api/window").Window) => Promise<unknown>) => {
    if (!desktop) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => fn(getCurrentWindow()).catch(() => undefined));
  };

  /**
   * Maximize / restore without losing the terminal's keyboard focus: clicking a button
   * moves DOM focus to it, and the native resize can leave WebView2 without keyboard
   * focus. Remember what had focus, then give native + DOM focus back.
   */
  const toggleMaximize = () => {
    const active = document.activeElement;
    const prev = active instanceof HTMLElement && active !== document.body ? active : null;
    withWindow(async (w) => {
      await w.toggleMaximize();
      await w.setFocus().catch(() => undefined);
      const refocus = () => {
        if (prev?.isConnected) prev.focus({ preventScroll: true });
      };
      refocus();
      // The resize settles a frame or two later and can take focus away again.
      requestAnimationFrame(() => requestAnimationFrame(refocus));
      setTimeout(refocus, 150);
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Window control buttons: keep DOM focus where it is (in the terminal).
    if ((e.target as HTMLElement).closest(".titlebar-controls")) {
      e.preventDefault();
      return;
    }
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    e.preventDefault();
    if (e.detail === 2) {
      toggleMaximize();
      return;
    }
    titleDragAt = Date.now();
    withWindow((w) => w.startDragging());
  };

  return (
    <div className="app-titlebar" onMouseDown={onMouseDown} onContextMenu={(e) => e.preventDefault()}>
      <div className="titlebar-logo">&gt;_</div>
      <div className="titlebar-content">{children ?? <span className="titlebar-title">{title}</span>}</div>
      {status}
      {desktop && (
        <div className="titlebar-controls">
          {onTogglePin && (
            <button
              type="button"
              className={`titlebar-btn titlebar-pin ${pinned ? "active" : ""}`}
              title={pinned ? t("titlebar.unpin") : t("titlebar.pin")}
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              <Pin size={13} fill={pinned ? "currentColor" : "none"} style={pinned ? undefined : { transform: "rotate(45deg)" }} />
            </button>
          )}
          <button type="button" className="titlebar-btn" title={t("titlebar.minimize")} onClick={() => withWindow((w) => w.minimize())}>
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="titlebar-btn"
            title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
            onClick={toggleMaximize}
          >
            {maximized ? <Copy size={12} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} />}
          </button>
          <button type="button" className="titlebar-btn titlebar-close" title={t("titlebar.close")} onClick={() => withWindow((w) => w.close())}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
};
