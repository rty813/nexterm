import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pause, Play, Plus, Save, Send, Square, Trash2, X } from "lucide-react";
import type { SenderItem } from "../types/domain";

/** A pane the sender can type into. */
export interface SenderTarget {
  paneId: string;
  title: string;
  visible: boolean;
}

const EOL: Record<SenderItem["eol"], string> = { cr: "\r", lf: "\n", crlf: "\r\n", none: "" };

function uid(): string {
  return `snd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newSender(partial: Partial<SenderItem> = {}): SenderItem {
  return {
    id: uid(),
    name: "",
    text: "",
    lineDelay: 0,
    repeat: 1,
    interval: 1000,
    eol: "cr",
    target: "active",
    ...partial,
  };
}

interface Running {
  id: string;
  round: number;
  line: number;
  paused: boolean;
}

/**
 * WindTerm Sender: send saved text to one or more sessions, line by line with a delay,
 * repeated a number of times (or until stopped). Docked on the right like the forwarding panel.
 */
export const SenderPanel: React.FC<{
  items: SenderItem[];
  targets: SenderTarget[];
  activePaneId: string | null;
  /** Pane the panel was opened for (pane menu). */
  preferredPaneId: string | null;
  onChange: (items: SenderItem[]) => void;
  /** Send raw text (no line ending added) to the given panes. */
  onSend: (paneIds: string[], text: string) => void;
  onClose: () => void;
}> = ({ items, targets, activePaneId, preferredPaneId, onChange, onSend, onClose }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SenderItem>(() => items[0] ?? newSender());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preferredPaneId ? [preferredPaneId] : []));
  const [running, setRunning] = useState<Running | null>(null);
  const stopRef = useRef(false);
  const pauseRef = useRef(false);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const activeRef = useRef(activePaneId);
  activeRef.current = activePaneId;

  useEffect(() => {
    if (preferredPaneId) setSelected(new Set([preferredPaneId]));
  }, [preferredPaneId]);
  useEffect(() => () => void (stopRef.current = true), []);

  const resolveTargets = (item: SenderItem): string[] => {
    const live = targetsRef.current;
    switch (item.target) {
      case "all":
        return live.map((x) => x.paneId);
      case "visible":
        return live.filter((x) => x.visible).map((x) => x.paneId);
      case "selected":
        return live.filter((x) => selected.has(x.paneId)).map((x) => x.paneId);
      default: {
        const id = preferredPaneId && live.some((x) => x.paneId === preferredPaneId) ? preferredPaneId : activeRef.current;
        return id ? [id] : [];
      }
    }
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (stopRef.current) return resolve();
        if (pauseRef.current || Date.now() - started < ms) window.setTimeout(tick, Math.min(100, Math.max(10, ms)));
        else resolve();
      };
      tick();
    });

  const run = async (item: SenderItem) => {
    const ids = resolveTargets(item);
    if (!ids.length || !item.text) return;
    stopRef.current = false;
    pauseRef.current = false;
    const lines = item.text.replace(/\r\n/g, "\n").split("\n");
    // A trailing newline in the editor does not mean an extra empty line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const eol = EOL[item.eol];
    const rounds = item.repeat <= 0 ? Infinity : item.repeat;
    for (let round = 1; round <= rounds && !stopRef.current; round++) {
      if (item.lineDelay > 0) {
        for (let i = 0; i < lines.length && !stopRef.current; i++) {
          setRunning({ id: item.id, round, line: i + 1, paused: pauseRef.current });
          await sleep(0);
          if (stopRef.current) break;
          onSend(resolveTargets(item), lines[i] + eol);
          if (i < lines.length - 1) await sleep(item.lineDelay);
        }
      } else {
        setRunning({ id: item.id, round, line: lines.length, paused: false });
        onSend(ids, lines.join(eol) + eol);
      }
      if (round < rounds) await sleep(Math.max(0, item.interval));
    }
    setRunning(null);
  };

  const save = () => {
    const named = { ...draft, name: draft.name.trim() || draft.text.split("\n")[0].slice(0, 30) || t("sender.untitled") };
    const exists = items.some((i) => i.id === named.id);
    onChange(exists ? items.map((i) => (i.id === named.id ? named : i)) : [...items, named]);
    setDraft(named);
  };

  const busy = running !== null;
  const targetCount = resolveTargets(draft).length;

  return (
    <aside className="side-panel sender-panel">
      <div className="side-panel-header">
        <Send size={14} /> {t("sender.title")}
        <button type="button" className="icon-btn-xs" title={t("forward.close")} onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="side-panel-body">
        <div className="sender-list">
          {items.map((item) => (
            <div
              key={item.id}
              className={`sender-item ${draft.id === item.id ? "active" : ""}`}
              onClick={() => !busy && setDraft(item)}
              title={item.text}
            >
              <span className="sender-name">{item.name || t("sender.untitled")}</span>
              <button
                type="button"
                className="icon-btn-xs"
                title={t("sender.sendNow")}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void run(item);
                }}
              >
                <Play size={11} />
              </button>
              <button
                type="button"
                className="icon-btn-xs danger-hover"
                title={t("sender.delete")}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(items.filter((i) => i.id !== item.id));
                  if (draft.id === item.id) setDraft(newSender());
                }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => setDraft(newSender())}>
            <Plus size={12} /> {t("sender.new")}
          </button>
        </div>

        <input
          className="text-input input-sm"
          placeholder={t("sender.namePh")}
          value={draft.name}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <textarea
          className="text-input mono sender-text"
          placeholder={t("sender.textPh")}
          value={draft.text}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) {
              e.preventDefault();
              void run(draft);
            }
          }}
        />
        <div className="form-grid-2">
          <label className="field">
            <span>{t("sender.eol")}</span>
            <select className="text-input input-sm" value={draft.eol} disabled={busy} onChange={(e) => setDraft({ ...draft, eol: e.target.value as SenderItem["eol"] })}>
              <option value="cr">CR (Enter)</option>
              <option value="lf">LF</option>
              <option value="crlf">CR LF</option>
              <option value="none">{t("sender.eolNone")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("sender.lineDelay")}</span>
            <input
              type="number"
              min={0}
              step={50}
              className="text-input input-sm"
              value={draft.lineDelay}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, lineDelay: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="field">
            <span>{t("sender.repeat")}</span>
            <input
              type="number"
              min={0}
              className="text-input input-sm"
              value={draft.repeat}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, repeat: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
          </label>
          <label className="field">
            <span>{t("sender.interval")}</span>
            <input
              type="number"
              min={0}
              step={100}
              className="text-input input-sm"
              value={draft.interval}
              disabled={busy || draft.repeat === 1}
              onChange={(e) => setDraft({ ...draft, interval: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t("sender.target")}</span>
          <select className="text-input input-sm" value={draft.target} disabled={busy} onChange={(e) => setDraft({ ...draft, target: e.target.value as SenderItem["target"] })}>
            <option value="active">{t("sender.targetActive")}</option>
            <option value="visible">{t("sender.targetVisible")}</option>
            <option value="all">{t("sender.targetAll")}</option>
            <option value="selected">{t("sender.targetSelected")}</option>
          </select>
        </label>
        {draft.target === "selected" && (
          <div className="sender-targets">
            {targets.map((x) => (
              <label key={x.paneId} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selected.has(x.paneId)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(x.paneId);
                    else next.delete(x.paneId);
                    setSelected(next);
                  }}
                />
                <span>{x.title}</span>
              </label>
            ))}
          </div>
        )}
        <p className="adv-hint">{t("sender.hint", { count: targetCount })}</p>
        {running ? (
          <div className="sender-running">
            <span>
              {t("sender.progress", {
                round: running.round,
                rounds: draft.repeat <= 0 ? "∞" : draft.repeat,
                line: running.line,
              })}
            </span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                pauseRef.current = !pauseRef.current;
                setRunning((r) => (r ? { ...r, paused: pauseRef.current } : r));
              }}
            >
              {running.paused ? <Play size={12} /> : <Pause size={12} />} {running.paused ? t("sender.resume") : t("sender.pause")}
            </button>
            <button type="button" className="btn-danger btn-sm" onClick={() => (stopRef.current = true)}>
              <Square size={12} /> {t("sender.stop")}
            </button>
          </div>
        ) : (
          <div className="sender-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={save} disabled={!draft.text}>
              <Save size={12} /> {t("sender.save")}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!draft.text}
              onClick={() => setDraft(newSender({ ...draft, id: uid(), name: draft.name ? `${draft.name} 2` : "" }))}
            >
              <Copy size={12} /> {t("sender.copy")}
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={!draft.text || targetCount === 0} onClick={() => void run(draft)}>
              <Send size={12} /> {t("sender.send")} (Ctrl+Enter)
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
