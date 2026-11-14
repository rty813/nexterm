import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Copy, Play, Save, Square, X } from "lucide-react";
import { backend, isTauriRuntime, type TunnelStatus } from "../services/backend";
import type { TunnelConfig } from "../types/domain";

/** A connected SSH tab the panel can forward through. */
export interface ForwardTarget {
  paneId: string;
  title: string;
  summary: string;
  sessionId: string;
  /** Rules stored in the session config. */
  saved: TunnelConfig[];
}

const EMPTY_RULE: TunnelConfig = {
  name: "",
  kind: "local",
  listenHost: "127.0.0.1",
  listenPort: 0,
  targetHost: "localhost",
  targetPort: 0,
  enabled: true,
};

function sameRule(a: TunnelConfig, b: TunnelConfig): boolean {
  return (
    a.kind === b.kind &&
    a.listenPort === b.listenPort &&
    (a.kind === "dynamic" || (a.targetHost === b.targetHost && a.targetPort === b.targetPort))
  );
}

function describe(c: TunnelConfig, boundPort?: number): { from: string; to: string } {
  const port = boundPort ?? c.listenPort;
  if (c.kind === "dynamic") return { from: `${c.listenHost || "127.0.0.1"}:${port}`, to: "SOCKS5" };
  if (c.kind === "remote") return { from: `⇠ ${c.listenHost || "localhost"}:${port}`, to: `${c.targetHost}:${c.targetPort}` };
  return { from: `${c.listenHost || "127.0.0.1"}:${port}`, to: `${c.targetHost}:${c.targetPort}` };
}

/** Docked panel: start / stop port forwards on an already connected SSH session. */
export const PortForwardPanel: React.FC<{
  targets: ForwardTarget[];
  preferredPaneId: string | null;
  onClose: () => void;
  onSaveRule: (sessionId: string, rule: TunnelConfig) => void;
}> = ({ targets, preferredPaneId, onClose, onSaveRule }) => {
  const { t } = useTranslation();
  const [paneId, setPaneId] = useState<string | null>(null);
  const [running, setRunning] = useState<TunnelStatus[]>([]);
  const [draft, setDraft] = useState<TunnelConfig>(EMPTY_RULE);
  const [saveToSession, setSaveToSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the active tab when it is an SSH session; keep the choice otherwise.
  useEffect(() => {
    const valid = (id: string | null) => Boolean(id && targets.some((x) => x.paneId === id));
    if (valid(preferredPaneId)) setPaneId(preferredPaneId);
    else if (!valid(paneId)) setPaneId(targets[0]?.paneId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredPaneId, targets.map((x) => x.paneId).join(",")]);

  const target = targets.find((x) => x.paneId === paneId) ?? null;

  const refresh = useCallback(async () => {
    if (!paneId) {
      setRunning([]);
      return;
    }
    try {
      setRunning(await backend.tunnelList(paneId));
    } catch {
      setRunning([]);
    }
  }, [paneId]);

  useEffect(() => {
    setError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const start = async (rule: TunnelConfig, save: boolean) => {
    if (!paneId || !target) return;
    if (rule.kind !== "dynamic" && (!rule.targetHost.trim() || !rule.targetPort)) {
      setError(t("forward.needTarget"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setRunning(await backend.tunnelStart(paneId, { ...rule, enabled: true }));
      if (save && !target.saved.some((s) => sameRule(s, rule))) onSaveRule(target.sessionId, { ...rule, enabled: true });
      if (rule === draft) setDraft({ ...EMPTY_RULE, kind: draft.kind });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    if (!paneId) return;
    setRunning(await backend.tunnelStop(paneId, id).catch(() => running));
  };

  const savedIdle = target ? target.saved.filter((s) => !running.some((r) => sameRule(r.config, s))) : [];
  const set = (patch: Partial<TunnelConfig>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <aside className="side-panel forward-panel">
      <div className="side-panel-header">
        <ArrowRightLeft size={14} />
        <span>{t("forward.title")}</span>
        <button type="button" className="icon-btn-xs" onClick={onClose} title={t("forward.close")}>
          <X size={13} />
        </button>
      </div>

      {targets.length === 0 ? (
        <div className="side-panel-empty">{isTauriRuntime() ? t("forward.noSsh") : t("forward.preview")}</div>
      ) : (
        <div className="side-panel-body">
          <label className="field">
            <span>{t("forward.session")}</span>
            <select className="text-input input-sm" value={paneId ?? ""} onChange={(e) => setPaneId(e.target.value)}>
              {targets.map((x) => (
                <option key={x.paneId} value={x.paneId}>
                  {x.title} — {x.summary}
                </option>
              ))}
            </select>
          </label>

          <h4 className="section-heading">{t("forward.running", { count: running.length })}</h4>
          {running.length === 0 && <p className="adv-hint">{t("forward.none")}</p>}
          {running.map((r) => {
            const d = describe(r.config, r.boundPort);
            const saved = target?.saved.some((s) => sameRule(s, { ...r.config, listenPort: r.boundPort })) ?? false;
            return (
              <div key={r.id} className="fwd-row">
                <span className={`fwd-kind fwd-${r.config.kind}`}>{r.config.kind[0].toUpperCase()}</span>
                <div className="fwd-text">
                  <span className="mono">{d.from}</span>
                  <span className="muted">→ {d.to}</span>
                  {r.config.name && <span className="fwd-name">{r.config.name}</span>}
                </div>
                <span className="fwd-count" title={t("forward.countTip", { active: r.active, total: r.total })}>
                  {r.active}/{r.total}
                </span>
                {r.config.kind !== "remote" && (
                  <button
                    type="button"
                    className="icon-btn-xs"
                    title={t("forward.copyAddr")}
                    onClick={() => void backend.writeClipboard(`${r.config.listenHost || "127.0.0.1"}:${r.boundPort}`)}
                  >
                    <Copy size={11} />
                  </button>
                )}
                {!saved && target && (
                  <button
                    type="button"
                    className="icon-btn-xs"
                    title={t("forward.saveRule")}
                    onClick={() => onSaveRule(target.sessionId, { ...r.config, listenPort: r.boundPort })}
                  >
                    <Save size={11} />
                  </button>
                )}
                <button type="button" className="icon-btn-xs danger-hover" title={t("forward.stop")} onClick={() => void stop(r.id)}>
                  <Square size={11} />
                </button>
              </div>
            );
          })}

          {savedIdle.length > 0 && (
            <>
              <h4 className="section-heading">{t("forward.saved")}</h4>
              {savedIdle.map((s, i) => {
                const d = describe(s);
                return (
                  <div key={i} className="fwd-row idle">
                    <span className={`fwd-kind fwd-${s.kind}`}>{s.kind[0].toUpperCase()}</span>
                    <div className="fwd-text">
                      <span className="mono">{d.from}</span>
                      <span className="muted">→ {d.to}</span>
                      {s.name && <span className="fwd-name">{s.name}</span>}
                    </div>
                    <button type="button" className="icon-btn-xs" title={t("forward.start")} disabled={busy} onClick={() => void start(s, false)}>
                      <Play size={11} />
                    </button>
                  </div>
                );
              })}
            </>
          )}

          <h4 className="section-heading">{t("forward.add")}</h4>
          <form
            className="fwd-form"
            onSubmit={(e) => {
              e.preventDefault();
              void start(draft, saveToSession);
            }}
          >
            <div className="fwd-kinds">
              {(["local", "remote", "dynamic"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`fwd-kind-btn ${draft.kind === k ? "active" : ""}`}
                  onClick={() =>
                    set({ kind: k, listenHost: k === "remote" ? "" : draft.listenHost || "127.0.0.1" })
                  }
                  title={t(`forward.kindTip.${k}`)}
                >
                  {t(`forward.kind.${k}`)}
                </button>
              ))}
            </div>
            <p className="adv-hint">{t(`forward.kindTip.${draft.kind}`)}</p>
            <div className="fwd-pair">
              <input
                type="text"
                className="text-input input-sm"
                placeholder={draft.kind === "remote" ? "localhost" : "127.0.0.1"}
                title={draft.kind === "remote" ? t("adv.remoteListenHost") : t("adv.localListenHost")}
                value={draft.listenHost}
                onChange={(e) => set({ listenHost: e.target.value })}
              />
              <input
                type="number"
                className="text-input input-sm port-input"
                placeholder={draft.kind === "remote" ? t("forward.port") : t("forward.portAuto")}
                min={0}
                max={65535}
                value={draft.listenPort || ""}
                onChange={(e) => set({ listenPort: Number(e.target.value) })}
              />
            </div>
            {draft.kind !== "dynamic" && (
              <div className="fwd-pair">
                <input
                  type="text"
                  className="text-input input-sm"
                  placeholder={draft.kind === "remote" ? t("forward.localTargetPh") : t("forward.remoteTargetPh")}
                  title={draft.kind === "remote" ? t("adv.localTarget") : t("adv.remoteTarget")}
                  value={draft.targetHost}
                  onChange={(e) => set({ targetHost: e.target.value })}
                />
                <input
                  type="number"
                  className="text-input input-sm port-input"
                  placeholder={t("forward.port")}
                  min={1}
                  max={65535}
                  value={draft.targetPort || ""}
                  onChange={(e) => set({ targetPort: Number(e.target.value) })}
                />
              </div>
            )}
            <input
              type="text"
              className="text-input input-sm"
              placeholder={t("forward.namePh")}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <label className="checkbox-row">
              <input type="checkbox" checked={saveToSession} onChange={(e) => setSaveToSession(e.target.checked)} />
              <span>{t("forward.alsoSave")}</span>
            </label>
            {error && <div className="alert-error">{error}</div>}
            <button type="submit" className="btn-primary btn-sm" disabled={busy || !paneId}>
              <Play size={12} /> {t("forward.start")}
            </button>
          </form>
        </div>
      )}
    </aside>
  );
};
