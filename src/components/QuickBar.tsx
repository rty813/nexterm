import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Settings2, Zap } from "lucide-react";
import type { QuickBarSettings, QuickCommand } from "../types/domain";
import { commandsOf, quickGroups } from "../utils/quickCommands";
import { useContextMenu } from "./ContextMenu";
import { QuickIcon } from "./QuickIcon";
import type { QuickManagerTarget } from "./QuickCommandManager";

interface QuickBarProps {
  commands: QuickCommand[];
  bar: QuickBarSettings;
  hasActivePane: boolean;
  onExecute: (cmd: QuickCommand) => void;
  /** Open the Quick Commands dialog (on a command, or adding one). */
  onManage: (target?: QuickManagerTarget) => void;
}

/**
 * Horizontal strip without a scrollbar: the mouse wheel scrolls it sideways and
 * the edges fade out while more chips are hidden on that side.
 */
const ScrollStrip: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

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
      className={`${className} hscroll ${edges.left ? "fade-left" : ""} ${edges.right ? "fade-right" : ""}`}
      onScroll={update}
      onWheel={(e) => {
        const el = ref.current;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }}
    >
      {children}
    </div>
  );
};

export const QuickBar: React.FC<QuickBarProps> = ({ commands, bar, hasActivePane, onExecute, onManage }) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const fallback = t("quickbar.defaultGroup");
  const groups = quickGroups(commands, bar, fallback);
  const multi = bar.multiGroups ?? true;
  const titles = bar.groupTitles ?? true;
  const [current, setCurrent] = useState<string | null>(null);
  const shownGroup = current && groups.includes(current) ? current : groups[0];

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
    <div className="quickbar">
      <button type="button" className="quickbar-badge" onMouseDown={keepFocus} onClick={() => onManage()} title={t("quickManager.title")}>
        <Zap size={12} /> {t("quickbar.badge")}
      </button>
      {!multi && groups.length > 1 && (
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

      <ScrollStrip className="quickbar-items">
        {commands.length === 0 && (
          <span className="quickbar-empty" title={t("quickbar.empty")}>
            {t("quickbar.empty")}
          </span>
        )}
        {multi
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
        onClick={() => onManage({ create: true, group: multi ? undefined : shownGroup })}
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
