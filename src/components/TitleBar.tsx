import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Minus, Square, X } from "lucide-react";
import { isTauriRuntime } from "../services/backend";

/** When the user last started dragging the window by our title bar (for docking). */
let titleDragAt = 0;
export const titleDragStartedRecently = (ms = 3000) => Date.now() - titleDragAt < ms;

const INTERACTIVE = "button, input, select, textarea, a, [role='button'], .no-drag, .quick-connect-bar";

/**
 * Our own window title bar (the native frame is off): drag to move, double-click to
 * maximize, and minimize / maximize / close buttons. `children` (the toolbar) sit in it.
 */
export const TitleBar: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => {
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

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
    e.preventDefault();
    if (e.detail === 2) {
      withWindow((w) => w.toggleMaximize());
      return;
    }
    titleDragAt = Date.now();
    withWindow((w) => w.startDragging());
  };

  return (
    <div className="app-titlebar" onMouseDown={onMouseDown} onContextMenu={(e) => e.preventDefault()}>
      <div className="titlebar-logo">&gt;_</div>
      <div className="titlebar-content">{children ?? <span className="titlebar-title">{title}</span>}</div>
      {desktop && (
        <div className="titlebar-controls">
          <button type="button" className="titlebar-btn" title={t("titlebar.minimize")} onClick={() => withWindow((w) => w.minimize())}>
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="titlebar-btn"
            title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
            onClick={() => withWindow((w) => w.toggleMaximize())}
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
