import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Edit2,
  FolderInput,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ProtocolType, SessionConfig } from "../types/domain";
import { sessionTargetSummary } from "../utils/sessionSummary";
import { compactMenu, useContextMenu } from "./ContextMenu";
import { ProtocolBadge } from "./ProtocolBadge";
import { SessionModal } from "./SessionModal";
import { MoveGroupDialog } from "./MoveGroupDialog";
import { hasSavedPassword } from "../utils/paneSession";

type SortKey = "label" | "group" | "protocol" | "target";

const PROTOCOLS: ProtocolType[] = ["ssh", "serial", "powershell", "cmd", "wsl", "custom", "tcp"];

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SessionManagerProps {
  sessions: SessionConfig[];
  /** Save the whole session list (sessions.json). */
  onChange: (next: SessionConfig[]) => void;
  /** Open sessions as new tabs; the manager closes. */
  onConnect: (list: SessionConfig[]) => void;
  onClose: () => void;
}

/** Bulk session management, as a dialog over the workspace (like Settings). */
export const SessionManager: React.FC<SessionManagerProps> = ({ sessions, onChange, onConnect, onClose }) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [protoFilter, setProtoFilter] = useState<ProtocolType | "all">("all");
  const [groupFilter, setGroupFilter] = useState<string>("__all__");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "group", asc: true });
  const [editing, setEditing] = useState<{ open: boolean; session: SessionConfig | null }>({
    open: false,
    session: null,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);

  const persist = (next: SessionConfig[], message?: string) => {
    onChange(next);
    if (message) setNotice(message);
  };

  const groups = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.group || ""))).sort((a, b) => a.localeCompare(b, "zh")),
    [sessions]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = sessions.filter((s) => {
      if (protoFilter !== "all" && s.protocol !== protoFilter) return false;
      if (groupFilter !== "__all__" && (s.group || "") !== groupFilter) return false;
      if (!q) return true;
      return [s.label, s.group, s.host, s.username, sessionTargetSummary(s)]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    const keyOf = (s: SessionConfig) =>
      sort.key === "label"
        ? s.label
        : sort.key === "group"
        ? `${s.group}\u0000${s.label}`
        : sort.key === "protocol"
        ? `${s.protocol}\u0000${s.label}`
        : sessionTargetSummary(s);
    rows.sort((a, b) => keyOf(a).localeCompare(keyOf(b), "zh") * (sort.asc ? 1 : -1));
    return rows;
  }, [sessions, query, protoFilter, groupFilter, sort]);

  const selectedSessions = sessions.filter((s) => selected.has(s.id));
  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id));

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, asc: !prev.asc } : { key, asc: true }));

  const onRowClick = (e: React.MouseEvent, id: string) => {
    setNotice(null);
    setSelected((prev) => {
      if (e.shiftKey && lastClicked.current) {
        const ids = visible.map((s) => s.id);
        const a = ids.indexOf(lastClicked.current);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          const next = new Set(e.ctrlKey ? prev : []);
          ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => next.add(x));
          return next;
        }
      }
      lastClicked.current = id;
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  };

  const toggleCheck = (id: string) => {
    lastClicked.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((s) => next.delete(s.id));
      else visible.forEach((s) => next.add(s.id));
      return next;
    });

  const connect = (list: SessionConfig[]) => {
    if (list.length === 0) return;
    onConnect(list);
  };

  const duplicate = (list: SessionConfig[]) => {
    const suffix = t("sidebar.copySuffix");
    const copies = list.map((s) => ({ ...s, id: uid(), label: `${s.label} (${suffix})` }));
    persist([...sessions, ...copies], t("manager.duplicated", { count: copies.length }));
    setSelected(new Set(copies.map((c) => c.id)));
  };

  const deleteSelected = () => {
    const count = selected.size;
    persist(
      sessions.filter((s) => !selected.has(s.id)),
      t("manager.deleted", { count })
    );
    setSelected(new Set());
    setConfirmDelete(false);
  };

  const moveSelected = (group: string) => {
    const count = selected.size;
    persist(
      sessions.map((s) => (selected.has(s.id) ? { ...s, group: group.trim() } : s)),
      t("manager.moved", { count, group: group.trim() || t("manager.noGroup") })
    );
    setMoveOpen(false);
  };

  const saveEdited = (saved: SessionConfig, connectNow: boolean) => {
    const idx = sessions.findIndex((s) => s.id === saved.id);
    const next = idx >= 0 ? sessions.map((s) => (s.id === saved.id ? saved : s)) : [...sessions, saved];
    persist(next);
    setEditing({ open: false, session: null });
    setSelected(new Set([saved.id]));
    if (connectNow) connect([saved]);
  };

  // Keyboard: Escape, Delete, Ctrl+A, Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing.open || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // An open question first, then the dialog.
        if (confirmDelete) setConfirmDelete(false);
        else if (moveOpen) setMoveOpen(false);
        else onClose();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" && selected.size > 0) {
        e.preventDefault();
        setConfirmDelete(true);
      } else if (e.ctrlKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(visible.map((s) => s.id)));
      } else if (e.key === "Enter" && selected.size > 0) {
        e.preventDefault();
        connect(selectedSessions);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const rowMenu = (e: React.MouseEvent, s: SessionConfig) => {
    e.preventDefault();
    const targets = selected.has(s.id) ? selectedSessions : [s];
    if (!selected.has(s.id)) setSelected(new Set([s.id]));
    openMenu(
      e,
      compactMenu([
        { label: t("manager.connect", { count: targets.length }), onClick: () => connect(targets) },
        { type: "separator" },
        targets.length === 1 && {
          label: t("sidebar.edit"),
          onClick: () => setEditing({ open: true, session: targets[0] }),
        },
        { label: t("sidebar.duplicate"), onClick: () => duplicate(targets) },
        { label: t("manager.moveTo"), onClick: () => setMoveOpen(true) },
        { type: "separator" },
        {
          label: t("manager.deleteN", { count: targets.length }),
          danger: true,
          onClick: () => setConfirmDelete(true),
        },
      ])
    );
  };

  const sortIcon = (key: SortKey) =>
    sort.key === key ? sort.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null;

  return (
    <>
    <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal-panel manager-panel" role="dialog" aria-label={t("manager.title")} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3>{t("manager.title")}</h3>
        <button type="button" className="icon-btn" onClick={onClose} title={t("titlebar.close")}>
          <X size={16} />
        </button>
      </div>
      <div className="manager-toolbar">
        <button type="button" className="btn-primary btn-sm" onClick={() => setEditing({ open: true, session: null })}>
          <Plus size={13} /> {t("sidebar.newBtn")}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={selected.size === 0}
          onClick={() => connect(selectedSessions)}
        >
          <Play size={13} /> {t("manager.connect", { count: selected.size })}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={selected.size !== 1}
          onClick={() => setEditing({ open: true, session: selectedSessions[0] })}
        >
          <Edit2 size={13} /> {t("sidebar.edit")}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={selected.size === 0}
          onClick={() => duplicate(selectedSessions)}
        >
          <Copy size={13} /> {t("sidebar.duplicate")}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={selected.size === 0}
          onClick={() => setMoveOpen(true)}
        >
          <FolderInput size={13} /> {t("manager.moveTo")}
        </button>
        <button
          type="button"
          className="btn-danger btn-sm"
          disabled={selected.size === 0}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={13} /> {t("manager.deleteN", { count: selected.size })}
        </button>

        <div className="manager-filters">
          <select
            className="text-input input-sm"
            value={protoFilter}
            onChange={(e) => setProtoFilter(e.target.value as ProtocolType | "all")}
          >
            <option value="all">{t("manager.allProtocols")}</option>
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            className="text-input input-sm"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="__all__">{t("manager.allGroups")}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g || t("manager.noGroup")}
              </option>
            ))}
          </select>
          <div className="manager-search">
            <Search size={13} />
            <input
              type="text"
              className="text-input input-sm"
              placeholder={t("sidebar.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div className="manager-banner banner-danger">
          <span>{t("manager.confirmDelete", { count: selected.size })}</span>
          <button type="button" className="btn-danger btn-sm" onClick={deleteSelected}>
            {t("manager.confirmDeleteBtn")}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>
            {t("sessionModal.cancel")}
          </button>
        </div>
      )}


      <div className="manager-table-wrap">
        <table className="manager-table">
          <thead>
            <tr>
              <th className="col-check">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />
              </th>
              <th onClick={() => toggleSort("label")}>
                {t("manager.colName")} {sortIcon("label")}
              </th>
              <th onClick={() => toggleSort("group")}>
                {t("manager.colGroup")} {sortIcon("group")}
              </th>
              <th onClick={() => toggleSort("protocol")}>
                {t("manager.colProtocol")} {sortIcon("protocol")}
              </th>
              <th onClick={() => toggleSort("target")}>
                {t("manager.colTarget")} {sortIcon("target")}
              </th>
              <th>{t("manager.colAuth")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr
                key={s.id}
                className={selected.has(s.id) ? "selected" : ""}
                onClick={(e) => onRowClick(e, s.id)}
                onDoubleClick={() => connect([s])}
                onContextMenu={(e) => rowMenu(e, s)}
              >
                <td className="col-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleCheck(s.id)} />
                </td>
                <td>
                  <span className="manager-name">
                    <ProtocolBadge protocol={s.protocol} size={13} />
                    {s.label}
                  </span>
                </td>
                <td className="muted">{s.group || "—"}</td>
                <td className="muted">{s.protocol.toUpperCase()}</td>
                <td className="mono">{sessionTargetSummary(s)}</td>
                <td className="muted">
                  {s.protocol === "ssh"
                    ? s.authType === "privatekey"
                      ? t("manager.authKey")
                      : hasSavedPassword(s)
                      ? t("manager.authSavedPwd")
                      : t("manager.authPwd")
                    : "—"}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="manager-empty">
                  {t("sidebar.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="manager-footer">
        <span>{t("manager.summary", { total: sessions.length, shown: visible.length, selected: selected.size })}</span>
        <span className="muted">{notice ?? t("manager.hint")}</span>
      </div>
    </div>
    </div>

    {/* A sibling, not a child: its backdrop clicks must not close the manager too. */}
    {moveOpen && (
      <MoveGroupDialog
        count={selected.size}
        groups={groups}
        current={new Set(selectedSessions.map((s) => s.group || "")).size === 1 ? selectedSessions[0]?.group || "" : null}
        onPick={moveSelected}
        onClose={() => setMoveOpen(false)}
      />
    )}
    {editing.open && (
      <SessionModal
        initial={editing.session}
        groups={groups.filter(Boolean)}
        onClose={() => setEditing({ open: false, session: null })}
        onSave={saveEdited}
      />
    )}
    </>
  );
};
