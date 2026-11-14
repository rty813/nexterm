import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow, monitorFromPoint, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { currentWindowLabel, isTauriRuntime } from "../services/backend";

export type MenuItem =
  | { type: "separator" }
  | {
      /** A row of color dots (WindTerm's highlight row). */
      type: "colors";
      colors: { color: string; label: string }[];
      /** Color currently applied, drawn with a ring; clicking it again calls onClear. */
      current: string | null;
      disabled?: boolean;
      onPick: (color: string) => void;
      onClear: () => void;
      clearLabel: string;
    }
  | {
      type?: "item";
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      /** Color swatch shown instead of an icon. */
      swatch?: string;
      onClick?: () => void;
      /** Opens a submenu on hover. */
      children?: MenuItem[];
    };

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type OpenMenu = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => void;

const ContextMenuContext = createContext<OpenMenu>(() => undefined);

export const useContextMenu = (): OpenMenu => useContext(ContextMenuContext);

export const ContextMenuProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const usePopup = isTauriRuntime() && currentWindowLabel() !== MENU_HOST;

  const open = useCallback<OpenMenu>(
    (e, items) => {
      e.preventDefault?.();
      if (!usePopup) {
        setMenu({ x: e.clientX, y: e.clientY, items });
        return;
      }
      // Desktop: the menu is drawn by a transparent always-on-top window, so it can
      // extend past this window's edges like a native menu. Inline as a fallback.
      openPopupMenu(e.clientX, e.clientY, items).catch(() => setMenu({ x: e.clientX, y: e.clientY, items }));
    },
    [usePopup]
  );

  useEffect(() => {
    if (!usePopup) return;
    const win = getCurrentWindow();
    const unAction = win.listen<PopupAction>("ctx-menu-action", (ev) => runPopupAction(ev.payload));
    const unClosed = win.listen<{ id: number; reason: string }>("ctx-menu-closed", (ev) => {
      // Back to the window the menu came from, unless the user clicked another app.
      if (ev.payload.reason !== "blur") void win.setFocus();
    });
    // Create the host ahead of the first right click.
    const warm = window.setTimeout(() => void ensureMenuHost().catch(() => undefined), 1500);
    return () => {
      window.clearTimeout(warm);
      void unAction.then((f) => f());
      void unClosed.then((f) => f());
    };
  }, [usePopup]);

  return (
    <ContextMenuContext.Provider value={open}>
      {children}
      {menu && <ContextMenuRoot menu={menu} onClose={() => setMenu(null)} />}
    </ContextMenuContext.Provider>
  );
};

const ContextMenuRoot: React.FC<{ menu: MenuState; onClose: () => void }> = ({ menu, onClose }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && (e.target as HTMLElement)?.closest?.(".context-menu")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={rootRef}>
      <MenuPanel items={menu.items} x={menu.x} y={menu.y} onClose={onClose} />
    </div>
  );
};

const MenuPanel: React.FC<{
  items: MenuItem[];
  x: number;
  y: number;
  /** Width of the parent item, to flip a submenu to the left side. */
  parentLeft?: number;
  /** Area the menu must stay inside (CSS px); defaults to this window. */
  bounds?: { w: number; h: number };
  onClose: () => void;
}> = ({ items, x, y, parentLeft, bounds, onClose }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = bounds?.w ?? window.innerWidth;
    const vh = bounds?.h ?? window.innerHeight;
    let left = x;
    if (left + width > vw - 4) {
      left = parentLeft !== undefined ? parentLeft - width : vw - width - 4;
    }
    // Opens upward when there is no room below, like a native menu.
    let top = y;
    if (top + height > vh - 4) top = parentLeft === undefined && y - height >= 4 ? y - height : vh - height - 4;
    setPos({ left: Math.max(4, left), top: Math.max(4, top) });
  }, [x, y, parentLeft, bounds?.w, bounds?.h]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.type === "separator" ? (
          <div key={i} className="context-menu-sep" />
        ) : item.type === "colors" ? (
          <div
            key={i}
            className={`context-menu-colors ${item.disabled ? "disabled" : ""}`}
            onMouseEnter={() => {
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setOpenSub(null), 150);
            }}
          >
            {item.colors.map((c) => {
              const on = item.current?.toLowerCase() === c.color.toLowerCase();
              return (
                <button
                  key={c.color}
                  type="button"
                  disabled={item.disabled}
                  className={`menu-dot ${on ? "on" : ""}`}
                  style={{ background: c.color }}
                  title={on ? item.clearLabel : c.label}
                  onClick={() => {
                    onClose();
                    if (on) item.onClear();
                    else item.onPick(c.color);
                  }}
                />
              );
            })}
            {item.current && (
              <button
                type="button"
                className="menu-dot menu-dot-clear"
                title={item.clearLabel}
                onClick={() => {
                  onClose();
                  item.onClear();
                }}
              >
                ×
              </button>
            )}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            className={`context-menu-item ${item.danger ? "danger" : ""} ${openSub?.index === i ? "sub-open" : ""}`}
            disabled={item.disabled}
            onMouseEnter={(e) => {
              window.clearTimeout(timer.current);
              if (item.children) {
                const r = e.currentTarget.getBoundingClientRect();
                setOpenSub({ index: i, x: r.right - 2, y: r.top - 4, left: r.left });
              } else {
                timer.current = window.setTimeout(() => setOpenSub(null), 150);
              }
            }}
            onClick={(e) => {
              if (item.children) {
                const r = e.currentTarget.getBoundingClientRect();
                setOpenSub({ index: i, x: r.right - 2, y: r.top - 4, left: r.left });
                return;
              }
              onClose();
              item.onClick?.();
            }}
          >
            <span className="context-menu-icon">
              {item.checked ? "✓" : item.swatch ? <span className="menu-swatch" style={{ background: item.swatch }} /> : item.icon}
            </span>
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
            {item.children && <span className="context-menu-arrow">›</span>}
          </button>
        )
      )}
      {openSub && (() => {
        const parent = items[openSub.index];
        if (!parent || parent.type === "separator" || parent.type === "colors" || !parent.children) return null;
        return (
          <MenuPanel
            items={parent.children}
            x={openSub.x}
            y={openSub.y}
            parentLeft={openSub.left}
            bounds={bounds}
            onClose={onClose}
          />
        );
      })()}
    </div>
  );
};

/** Drop leading, trailing and doubled separators left over after filtering items. */
export function compactMenu(items: (MenuItem | false | null | undefined)[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === "separator" && (out.length === 0 || out[out.length - 1].type === "separator")) {
      continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === "separator") out.pop();
  return out;
}

// ---------------------------------------------------------------- popup host

/** Label of the window that draws context menus on the desktop. */
export const MENU_HOST = "ctx-menu";

type WireItem =
  | { type: "separator" }
  | {
      type: "colors";
      colors: { color: string; label: string }[];
      current: string | null;
      disabled?: boolean;
      clearLabel: string;
    }
  | {
      type: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      swatch?: string;
      children?: WireItem[];
    };

interface PopupOpen {
  id: number;
  from: string;
  x: number;
  y: number;
  /** Size of the monitor work area the host covers, in CSS px. */
  w: number;
  h: number;
  items: WireItem[];
  css: string;
  className: string;
}

interface PopupAction {
  id: number;
  path: number[];
  op?: "pick" | "clear";
  color?: string;
}

function toWire(items: MenuItem[]): WireItem[] {
  return items.map((it): WireItem => {
    if (it.type === "separator") return { type: "separator" };
    if (it.type === "colors") {
      return { type: "colors", colors: it.colors, current: it.current, disabled: it.disabled, clearLabel: it.clearLabel };
    }
    return {
      type: "item",
      label: it.label,
      shortcut: it.shortcut,
      disabled: it.disabled,
      danger: it.danger,
      checked: it.checked,
      swatch: it.swatch,
      children: it.children ? toWire(it.children) : undefined,
    };
  });
}

/** The menu this window showed last; picks come back as an index path. */
let popupCurrent: { id: number; items: MenuItem[] } | null = null;
let popupSeq = 0;
let hostPromise: Promise<WebviewWindow> | null = null;

function runPopupAction(a: PopupAction) {
  if (!popupCurrent || popupCurrent.id !== a.id) return;
  let list = popupCurrent.items;
  let item: MenuItem | undefined;
  for (let i = 0; i < a.path.length; i++) {
    item = list[a.path[i]];
    if (!item) return;
    if (i < a.path.length - 1) {
      if (item.type === "separator" || item.type === "colors" || !item.children) return;
      list = item.children;
    }
  }
  if (!item || item.type === "separator") return;
  if (item.type === "colors") {
    if (a.op === "pick" && a.color) item.onPick(a.color);
    else if (a.op === "clear") item.onClear();
    return;
  }
  item.onClick?.();
}

/** The hidden, transparent window that draws menus (created once, shared by all windows). */
export function ensureMenuHost(): Promise<WebviewWindow> {
  if (!hostPromise) {
    hostPromise = (async () => {
      const existing = await WebviewWindow.getByLabel(MENU_HOST);
      if (existing) return existing;
      let resolveReady = () => {};
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
        window.setTimeout(resolve, 5000);
      });
      const unReady = await listen("ctx-menu-ready", () => resolveReady());
      try {
        const w = new WebviewWindow(MENU_HOST, {
          url: "index.html#ctxmenu",
          title: "Nexterm Menu",
          transparent: true,
          decorations: false,
          shadow: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          visible: false,
          focus: false,
          x: 0,
          y: 0,
          width: 800,
          height: 600,
        });
        await new Promise<void>((resolve, reject) => {
          void w.once("tauri://created", () => resolve());
          void w.once("tauri://error", (e) => reject(new Error(String(e.payload))));
        });
        await ready;
        return w;
      } finally {
        unReady();
      }
    })().catch((err) => {
      hostPromise = null;
      throw err;
    });
  }
  return hostPromise;
}

async function openPopupMenu(clientX: number, clientY: number, items: MenuItem[]): Promise<void> {
  const win = getCurrentWindow();
  const [pos, scale, host] = await Promise.all([win.innerPosition(), win.scaleFactor(), ensureMenuHost()]);
  const px = pos.x + clientX * scale;
  const py = pos.y + clientY * scale;
  const mon = (await monitorFromPoint(px, py)) ?? (await currentMonitor());
  if (!mon) throw new Error("no monitor");
  const wa = mon.workArea;
  // The host covers the monitor's work area; the menu is placed inside it.
  await Promise.all([
    host.setPosition(new PhysicalPosition(wa.position.x, wa.position.y)),
    host.setSize(new PhysicalSize(wa.size.width, wa.size.height)),
  ]);
  popupCurrent = { id: ++popupSeq, items };
  const payload: PopupOpen = {
    id: popupCurrent.id,
    from: win.label,
    x: (px - wa.position.x) / mon.scaleFactor,
    y: (py - wa.position.y) / mon.scaleFactor,
    w: wa.size.width / mon.scaleFactor,
    h: wa.size.height / mon.scaleFactor,
    items: toWire(items),
    css: document.documentElement.style.cssText,
    className: document.documentElement.className,
  };
  await emitTo(MENU_HOST, "ctx-menu-open", payload);
}

/** Page of the menu host window: draws one menu at a time and reports the pick back. */
export const MenuHost: React.FC = () => {
  const [menu, setMenu] = useState<PopupOpen | null>(null);
  const menuRef = useRef<PopupOpen | null>(null);
  menuRef.current = menu;
  const shownAt = useRef(0);

  const close = useCallback((reason: string) => {
    const m = menuRef.current;
    if (!m) return;
    menuRef.current = null;
    setMenu(null);
    void emitTo(m.from, "ctx-menu-closed", { id: m.id, reason });
    // Hide after the empty frame is drawn, so the next show never flashes this menu.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!menuRef.current) void getCurrentWindow().hide();
      })
    );
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.listen<PopupOpen>("ctx-menu-open", (e) => {
      document.documentElement.style.cssText = e.payload.css;
      document.documentElement.className = `${e.payload.className} ctxmenu-host`;
      setMenu(e.payload);
    });
    void un.then(() => emit("ctx-menu-ready"));
    const onBlur = () => {
      if (Date.now() - shownAt.current > 250) close("blur");
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close("escape");
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      void un.then((f) => f());
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  useLayoutEffect(() => {
    if (!menu) return;
    shownAt.current = Date.now();
    const win = getCurrentWindow();
    void win.show().then(() => win.setFocus());
  }, [menu]);

  if (!menu) return null;
  const send = (path: number[], op?: "pick" | "clear", color?: string) => {
    const action: PopupAction = { id: menu.id, path, op, color };
    void emitTo(menu.from, "ctx-menu-action", action);
  };
  const fromWire = (list: WireItem[], path: number[]): MenuItem[] =>
    list.map((it, i): MenuItem => {
      const p = [...path, i];
      if (it.type === "separator") return it;
      if (it.type === "colors") return { ...it, onPick: (c: string) => send(p, "pick", c), onClear: () => send(p, "clear") };
      return {
        ...it,
        onClick: it.children ? undefined : () => send(p),
        children: it.children ? fromWire(it.children, p) : undefined,
      };
    });

  return (
    <div
      className="ctx-backdrop"
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest(".context-menu")) close("outside");
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuPanel
        key={menu.id}
        items={fromWire(menu.items, [])}
        x={menu.x}
        y={menu.y}
        bounds={{ w: menu.w, h: menu.h }}
        onClose={() => close("action")}
      />
    </div>
  );
};
