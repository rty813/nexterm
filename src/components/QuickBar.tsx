import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Settings2, Zap } from "lucide-react";
import type { QuickBarSettings, QuickCommand } from "../types/domain";
import { commandsOf, quickBarHeight, quickBarRowsAfterDrag, quickGroups } from "../utils/quickCommands";
import { useContextMenu } from "./ContextMenu";
import { QuickIcon } from "./QuickIcon";
import type { QuickManagerTarget } from "./QuickCommandManager";

interface QuickBarProps {
  commands: QuickCommand[];
  bar: QuickBarSettings;
  hasActivePane: boolean;
  /** Rows of chips; more than one wraps the commands and scrolls them vertically. */
  rows: number;
  onRowsChange: (rows: number) => void;
  onExecute: (cmd: QuickCommand) => void;
  /** Open the Quick Commands dialog (on a command, or adding one). */
  onManage: (target?: QuickManagerTarget) => void;
}

/**
 * Strip without a scrollbar whose edges fade out while more chips are hidden on that side.
 * A horizontal strip turns the mouse wheel into sideways scrolling; a vertical one (several
 * rows of wrapped chips) scrolls normally.
 */
const ScrollStrip: React.FC<{ className: string; vertical?: boolean; children: React.ReactNode }> = ({
  className,
  vertical,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pos = vertical ? el.scrollTop : el.scrollLeft;
    const view = vertical ? el.clientHeight : el.clientWidth;
    const total = vertical ? el.scrollHeight : el.scrollWidth;
    const start = pos > 1;
    const end = pos + view < total - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [vertical]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  });

  return (
    <div
      ref={ref}
      className={`${className} ${vertical ? "vscroll" : "hscroll"} ${edges.start ? "fade-start" : ""} ${edges.end ? "fade-end" : ""}`}
      onScroll={update}
      onWheel={(e) => {
        const el = ref.current;
        if (vertical || !el || el.scrollWidth <= el.clientWidth) return;
        el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }}
    >
      {children}
    </div>
  );
};

export const QuickBar: React.FC<QuickBarProps> = ({ commands, bar, hasActivePane, rows, onRowsChange, onExecute, onManage }) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const fallback = t("quickbar.defaultGroup");
  const groups = quickGroups(commands, bar, fallback);
  const multi = bar.multiGroups ?? true;
  const titles = bar.groupTitles ?? true;
  const [current, setCurrent] = useState<string | null>(null);
  const shownGroup = current && groups.includes(current) ? current : groups[0];
  const multiRow = rows > 1;
  /**
   * Several rows: groups listed down the left, and only the picked group's commands shown.
   * With "show several groups" on there is also "All" (null), every command without titles.
   */
  const sideGroups = multiRow && groups.length > 1;
  const sidePick = multi ? (current && groups.includes(current) ? current : null) : shownGroup;

  /** Dragging the top edge adds rows; double-clicking it goes back to one. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startRows = rows;
    let last = rows;
    const move = (ev: PointerEvent) => {
      const next = quickBarRowsAfterDrag(startRows, ev.clientY - startY);
      if (next === last) return;
      last = next;
      onRowsChange(next);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  /** Clicking a chip must not take focus away from the terminal. */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const chip = (qc: QuickCommand) => {
    const isAction = qc.kind === "action";
    const preview = isAction ? t(`actions.${qc.action ?? ""}`, qc.action ?? "") : qc.command.replace(/\r/g, "\n").trim();
    return (
      <button
        key={qc.id}
        type="button"
        className="quick-chip"
        disabled={!isAction && !hasActivePane}
        onMouseDown={keepFocus}
        onClick={() => onExecute(qc)}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: t("quickManager.editThis"), onClick: () => onManage({ id: qc.id }) },
            { label: t("quickManager.addInGroup"), onClick: () => onManage({ create: true, group: qc.group || fallback }) },
            { type: "separator" },
            { label: t("quickManager.title"), onClick: () => onManage() },
          ])
        }
        title={`${preview}${qc.shortcut ? `\n${qc.shortcut}` : ""}`}
      >
        <QuickIcon icon={qc.icon} size={12} />
        <span>{qc.label}</span>
        {qc.shortcut && <kbd className="quick-chip-kbd">{qc.shortcut}</kbd>}
      </button>
    );
  };

  return (
    <div className={`quickbar ${multiRow ? "multi-row" : ""}`} style={{ height: quickBarHeight(rows) }}>
      <div
        className="quickbar-resize"
        onPointerDown={startResize}
        onDoubleClick={() => onRowsChange(1)}
        title={t("quickbar.resize")}
      />
      <button type="button" className="quickbar-badge" onMouseDown={keepFocus} onClick={() => onManage()} title={t("quickManager.title")}>
        <Zap size={12} /> {t("quickbar.badge")}
      </button>
      {sideGroups && (
        <ScrollStrip className="quickbar-side-groups" vertical>
          {multi && (
            <button
              type="button"
              className={`side-group ${sidePick === null ? "active" : ""}`}
              onMouseDown={keepFocus}
              onClick={() => setCurrent(null)}
            >
              <span className="side-group-name">{t("quickbar.all")}</span>
              <span className="side-group-count">{commands.length}</span>
            </button>
          )}
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              className={`side-group ${sidePick === g ? "active" : ""}`}
              onMouseDown={keepFocus}
              onClick={() => setCurrent(g)}
              title={g}
            >
              <span className="side-group-name">{g}</span>
              <span className="side-group-count">{commandsOf(commands, g, fallback).length}</span>
            </button>
          ))}
        </ScrollStrip>
      )}
      {!multiRow && !multi && groups.length > 1 && (
        <>
          <ScrollStrip className="quickbar-groups">
            {groups.map((g) => (
              <button
                key={g}
                type="button"
                className={`group-chip ${shownGroup === g ? "active" : ""}`}
                onMouseDown={keepFocus}
                onClick={() => setCurrent(g)}
              >
                {g}
              </button>
            ))}
          </ScrollStrip>
          <span className="quickbar-sep" />
        </>
      )}

      <ScrollStrip key={multiRow ? `rows:${sidePick ?? ""}` : "row"} className="quickbar-items" vertical={multiRow}>
        {commands.length === 0 && (
          <span className="quickbar-empty" title={t("quickbar.empty")}>
            {t("quickbar.empty")}
          </span>
        )}
        {sideGroups
          ? sidePick
            ? commandsOf(commands, sidePick, fallback, bar.sortAlpha).map(chip)
            : groups.map((g) => {
                // "All": each group starts a new line, its name in front.
                const list = commandsOf(commands, g, fallback, bar.sortAlpha);
                if (!list.length) return null;
                return (
                  <div key={g} className="quick-group-line">
                    <span className="quick-group-tag" title={g}>
                      {g}
                    </span>
                    {list.map(chip)}
                  </div>
                );
              })
          : multi
          ? groups.map((g) => {
              const list = commandsOf(commands, g, fallback, bar.sortAlpha);
              if (!list.length) return null;
              return (
                <React.Fragment key={g}>
                  {titles && groups.length > 1 && <span className="quick-group-title">{g}</span>}
                  {list.map(chip)}
                </React.Fragment>
              );
            })
          : commandsOf(commands, shownGroup ?? fallback, fallback, bar.sortAlpha).map(chip)}
      </ScrollStrip>

      <button
        type="button"
        className="icon-btn-xs"
        onMouseDown={keepFocus}
        onClick={() => onManage({ create: true, group: sideGroups ? (sidePick ?? undefined) : multi ? undefined : shownGroup })}
        title={t("quickbar.add")}
      >
        <Plus size={13} />
      </button>
      <button type="button" className="icon-btn-xs" onMouseDown={keepFocus} onClick={() => onManage()} title={t("quickManager.title")}>
        <Settings2 size={13} />
      </button>
    </div>
  );
};
