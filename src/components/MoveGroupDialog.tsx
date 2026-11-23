import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Folder, FolderInput, FolderPlus, Inbox, Search, X } from "lucide-react";
import { filterGroupOptions, groupOptions } from "../utils/sessionTree";

interface MoveGroupDialogProps {
  /** How many sessions are moved (title). */
  count: number;
  /** Groups of the saved sessions; parent folders are offered too. */
  groups: string[];
  /** The group the moved sessions are in now, if they share one (marked in the list). */
  current: string | null;
  onPick: (group: string) => void;
  onClose: () => void;
}

type Row = { kind: "none" } | { kind: "group"; group: string } | { kind: "new"; group: string };

/** "Move to group": click a group (or type a new one) and the sessions move right away. */
export const MoveGroupDialog: React.FC<MoveGroupDialogProps> = ({ count, groups, current, onPick, onClose }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo(() => groupOptions(groups), [groups]);
  // Start on the current group (row 0 is "no group").
  const [active, setActive] = useState(() => (current ? options.indexOf(current) + 1 : 0));
  const typed = query.trim().replace(/\s*>\s*/g, ">");
  const rows = useMemo<Row[]>(() => {
    if (!typed) return [{ kind: "none" }, ...options.map((group) => ({ kind: "group" as const, group }))];
    const matches = filterGroupOptions(options, typed).filter((group) => group.toLowerCase().includes(typed.toLowerCase()));
    const exact = options.some((group) => group.toLowerCase() === typed.toLowerCase());
    // Existing matches first, so Enter on a partial name picks a group rather than creating one.
    return [...matches.map((group) => ({ kind: "group" as const, group })), ...(exact ? [] : [{ kind: "new" as const, group: typed }])];
  }, [options, typed]);

  useLayoutEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (row: Row) => onPick(row.kind === "none" ? "" : row.group);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[active]) pick(rows[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const label = (row: Row) => {
    if (row.kind === "none") return <span className="muted">{t("manager.noGroup")}</span>;
    if (row.kind === "new") return <span>{t("sessionForm.newGroup", { name: row.group.split(">").join(" › ") })}</span>;
    const parts = row.group.split(">");
    // Browsing: a tree (indent + own name); searching: the full path.
    if (!typed) return <span className="group-pick-name">{parts[parts.length - 1]}</span>;
    return <span className="group-pick-name">{parts.join(" › ")}</span>;
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-panel group-pick-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-pick-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <h3 id="group-pick-title">
            <FolderInput size={15} /> {t("manager.moveTitle", { count })}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} title={t("sessionModal.cancel")}>
            <X size={16} />
          </button>
        </div>
        <div className="group-pick-search">
          <Search size={13} />
          <input
            autoFocus
            className="text-input"
            placeholder={t("manager.moveSearch")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <ul ref={listRef} className="group-pick-list" role="listbox">
          {rows.map((row, i) => {
            const value = row.kind === "none" ? "" : row.group;
            const isCurrent = row.kind !== "new" && current !== null && value === current;
            const Icon = row.kind === "none" ? Inbox : row.kind === "new" ? FolderPlus : Folder;
            return (
              <li
                key={`${row.kind}:${value}`}
                role="option"
                aria-selected={i === active}
                className={`group-pick-item ${i === active ? "active" : ""} ${row.kind === "new" ? "new" : ""}`}
                title={row.kind === "group" ? row.group.split(">").join(" › ") : undefined}
                style={!typed && row.kind === "group" ? { paddingLeft: 12 + (row.group.split(">").length - 1) * 18 } : undefined}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(row)}
              >
                <Icon size={14} className="group-pick-icon" />
                {label(row)}
                {isCurrent && <Check size={13} className="group-pick-check" />}
              </li>
            );
          })}
        </ul>
        <div className="group-pick-hint">{t("manager.moveHint")}</div>
      </div>
    </div>
  );
};
