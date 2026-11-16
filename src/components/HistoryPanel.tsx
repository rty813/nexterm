import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, History, Play, Trash2, X } from "lucide-react";
import { commandHistory } from "../utils/commandHistory";
import { backend } from "../services/backend";
import { confirmAsk } from "../utils/confirm";

/** Docked list of the command history (WindTerm History pane): search, send, copy, delete. */
export const HistoryPanel: React.FC<{
  hasActivePane: boolean;
  /** historyKeyOf / label of the active pane's session. */
  activeKey: string | null;
  activeLabel: string;
  perSessionDefault: boolean;
  /** Type the command into the active pane; `run` adds Enter. */
  onInsert: (command: string, run: boolean) => void;
  onClose: () => void;
}> = ({ hasActivePane, activeKey, activeLabel, perSessionDefault, onInsert, onClose }) => {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyThis, setOnlyThis] = useState(perSessionDefault);
  const scoped = onlyThis && activeKey !== null;
  useEffect(() => commandHistory.subscribe(() => setVersion((v) => v + 1)), []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...commandHistory.all()].reverse().filter((e) => !scoped || e.key === activeKey);
    return (q ? all.filter((e) => e.command.toLowerCase().includes(q)) : all).slice(0, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, version, scoped, activeKey]);

  return (
    <aside className="side-panel history-panel">
      <div className="side-panel-header">
        <History size={14} /> {t("history.title")}
        <button type="button" className="icon-btn-xs" title={t("forward.close")} onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="side-panel-body">
        <input
          className="text-input input-sm"
          placeholder={t("history.search")}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="history-scope">
          <button type="button" className={`adv-tab ${scoped ? "active" : ""}`} disabled={activeKey === null} onClick={() => setOnlyThis(true)} title={activeLabel}>
            {t("history.scopeThis")}
          </button>
          <button type="button" className={`adv-tab ${!scoped ? "active" : ""}`} onClick={() => setOnlyThis(false)}>
            {t("history.scopeAll")}
          </button>
          {scoped && <span className="history-scope-name" title={activeLabel}>{activeLabel}</span>}
        </div>
        {!commandHistory.enabled && <p className="adv-hint">{t("history.disabled")}</p>}
        {rows.length === 0 ? (
          <div className="side-panel-empty">{t("history.empty")}</div>
        ) : (
          <div className="history-list">
            {rows.map((e) => (
              <div
                key={`${e.key ?? ""}\u0000${e.command}`}
                className="history-row"
                title={`${new Date(e.time).toLocaleString()} · ${t("history.times", { count: e.count })}${e.session ? ` · ${e.session}` : ""}`}
                onDoubleClick={() => hasActivePane && onInsert(e.command, true)}
              >
                <span className="history-cmd mono">{e.command}</span>
                {!scoped && e.session && <span className="history-session">{e.session}</span>}
                <span className="history-actions">
                  <button type="button" className="icon-btn-xs" title={t("history.insert")} disabled={!hasActivePane} onClick={() => onInsert(e.command, false)}>
                    <Copy size={11} />
                  </button>
                  <button type="button" className="icon-btn-xs" title={t("history.run")} disabled={!hasActivePane} onClick={() => onInsert(e.command, true)}>
                    <Play size={11} />
                  </button>
                  <button type="button" className="icon-btn-xs danger-hover" title={t("history.delete")} onClick={() => commandHistory.remove(e.command, e.key)}>
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="sender-actions">
          <button type="button" className="btn-ghost btn-sm" disabled={!rows.length} onClick={() => void backend.writeClipboard(rows.map((r) => r.command).join("\n"))}>
            {t("history.copyAll")}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm danger-hover"
            disabled={!commandHistory.all().length}
            onClick={() => void confirmAsk(t("history.clearConfirm")).then((ok) => ok && commandHistory.clear())}
          >
            <Trash2 size={12} /> {t("history.clear")}
          </button>
        </div>
        <p className="adv-hint">{t("history.hint")}</p>
      </div>
    </aside>
  );
};
