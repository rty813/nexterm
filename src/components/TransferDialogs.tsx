import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FolderOpen, ShieldAlert, ShieldQuestion, Upload, X } from "lucide-react";
import {
  backend,
  currentWindowLabel,
  isTauriRuntime,
  type HostKeyPromptPayload,
  type ZmodemProgressPayload,
  type ZmodemRequestPayload,
} from "../services/backend";
import { zmodemDrop } from "../utils/zmodemDrop";

/** SSH host key confirmation, one prompt at a time (queued by the backend). */
export const HostKeyDialog: React.FC<{ labelFor: (instanceId: string) => string; owns: (instanceId: string) => boolean }> = ({
  labelFor,
  owns,
}) => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<HostKeyPromptPayload[]>([]);
  const ownsRef = React.useRef(owns);
  ownsRef.current = owns;

  useEffect(() => {
    // Every window receives the event; only the one showing the pane answers.
    const un = backend.onHostKeyPrompt((p) => ownsRef.current(p.instanceId) && setQueue((q) => [...q, p]));
    // Answered on a phone.
    const unResolved = backend.onHostKeyResolved((id) => setQueue((q) => q.filter((p) => p.requestId !== id)));
    return () => {
      void un.then((f) => f());
      void unResolved.then((f) => f());
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const answer = (decision: "reject" | "acceptOnce" | "acceptAndSave") => {
    void backend.respondHostKey(current.requestId, decision);
    setQueue((q) => q.slice(1));
  };
  const target = current.port === 22 ? current.host : `[${current.host}]:${current.port}`;

  return (
    <div className="modal-backdrop">
      <div className={`modal-panel hostkey-panel ${current.changed ? "danger" : ""}`}>
        <div className="modal-header">
          <h3>
            {current.changed ? <ShieldAlert size={16} /> : <ShieldQuestion size={16} />}{" "}
            {current.changed ? t("hostKey.changedTitle") : t("hostKey.newTitle")}
          </h3>
        </div>
        <div className="modal-body">
          <p>{current.changed ? t("hostKey.changedDesc", { host: target }) : t("hostKey.newDesc", { host: target })}</p>
          <div className="hostkey-facts">
            <span>{t("hostKey.session")}</span>
            <b>{labelFor(current.instanceId)}</b>
            <span>{t("hostKey.keyType")}</span>
            <b>{current.keyType}</b>
            <span>{t("hostKey.fingerprint")}</span>
            <code>{current.fingerprint}</code>
            <span>known_hosts</span>
            <code>{current.knownHosts}</code>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={() => answer("reject")}>
            {t("hostKey.reject")}
          </button>
          <button type="button" className="btn-secondary" onClick={() => answer("acceptOnce")}>
            {t("hostKey.acceptOnce")}
          </button>
          <button
            type="button"
            className={current.changed ? "btn-danger" : "btn-primary"}
            onClick={() => answer("acceptAndSave")}
          >
            {current.changed ? t("hostKey.replace") : t("hostKey.acceptSave")}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TransferView {
  instanceId: string;
  direction: "receive" | "send";
  /** ask: waiting for the user (no system dialogs, or the dialog failed); staging: copying dropped files. */
  phase: "ask" | "staging" | "running" | "finished";
  progress?: ZmodemProgressPayload;
  /** Dropped files being copied: bytes done / total. */
  staged?: { done: number; total: number };
  /** Temporary folder of dropped files, removed when the transfer ends. */
  dropToken?: string;
}

function fmtBytes(n = 0): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * ZModem: when the remote runs `rz` / `sz`, ask for the files to send / the folder to
 * save in right away (system dialog), or send the files dropped on that terminal; then
 * show the progress.
 */
export const ZmodemDialog: React.FC<{
  labelFor: (instanceId: string) => string;
  owns: (instanceId: string) => boolean;
  downloadDir: string;
  onDownloadDirChange: (dir: string) => void;
}> = ({ labelFor, owns, downloadDir, onDownloadDirChange }) => {
  const { t } = useTranslation();
  const [views, setViews] = useState<Record<string, TransferView>>({});
  const ownsRef = React.useRef(owns);
  ownsRef.current = owns;
  const dirRef = React.useRef({ downloadDir, onDownloadDirChange });
  dirRef.current = { downloadDir, onDownloadDirChange };

  const put = (id: string, patch: Partial<TransferView>) =>
    setViews((v) => (v[id] ? { ...v, [id]: { ...v[id], ...patch } } : v));

  const close = (id: string) =>
    setViews((v) => {
      const { [id]: _gone, ...rest } = v;
      return rest;
    });

  const refuse = (id: string) => {
    void backend.zmodemCancel(id);
    close(id);
  };

  /** rz: send dropped files, else pick files now. */
  const startSend = async (id: string) => {
    const dropped = zmodemDrop.take(id);
    if (dropped) {
      const token = `drop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const total = dropped.reduce((n, f) => n + f.size, 0);
      put(id, { phase: "staging", dropToken: token, staged: { done: 0, total } });
      try {
        const paths: string[] = [];
        let before = 0;
        for (const f of dropped) {
          paths.push(await backend.zmodemStageFile(token, f, (w) => put(id, { staged: { done: before + w, total } })));
          before += f.size;
        }
        put(id, { phase: "running" });
        await backend.zmodemStart(id, paths, null);
      } catch (e) {
        void backend.zmodemCancel(id);
        void backend.zmodemUnstage(token);
        put(id, { phase: "finished", progress: { instanceId: id, state: "error", message: String(e) } });
      }
      return;
    }
    const files = await backend.pickFiles(t("zmodem.pickFiles"));
    if (files.length === 0) return refuse(id);
    put(id, { phase: "running" });
    await backend.zmodemStart(id, files, null);
  };

  /** sz: pick the folder to save in now (starts at the last one). */
  const startReceive = async (id: string) => {
    const dir = await backend.pickDirectory(t("zmodem.saveTo"), dirRef.current.downloadDir);
    if (!dir) return refuse(id);
    if (dir !== dirRef.current.downloadDir) dirRef.current.onDownloadDirChange(dir);
    put(id, { phase: "running" });
    await backend.zmodemStart(id, [], dir);
  };

  const startRef = React.useRef({ startSend, startReceive });
  startRef.current = { startSend, startReceive };

  useEffect(() => {
    // Files dropped before a crash or quit.
    if (currentWindowLabel() === "main") void backend.zmodemUnstage(null);
    const un1 = backend.onZmodemRequest((p: ZmodemRequestPayload) => {
      if (!ownsRef.current(p.instanceId)) return;
      setViews((v) => ({ ...v, [p.instanceId]: { instanceId: p.instanceId, direction: p.direction, phase: "ask" } }));
      // Desktop: straight to the system dialog (or the dropped files); the card shows progress.
      if (!isTauriRuntime()) return;
      const run = p.direction === "send" ? startRef.current.startSend : startRef.current.startReceive;
      void run(p.instanceId).catch(() => undefined);
    });
    const un2 = backend.onZmodemProgress((p) =>
      setViews((v) => {
        const cur = v[p.instanceId];
        if (!cur) return v;
        const phase = p.state === "running" ? "running" : "finished";
        if (phase === "finished" && cur.dropToken) void backend.zmodemUnstage(cur.dropToken);
        return { ...v, [p.instanceId]: { ...cur, phase, progress: p } };
      })
    );
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
    };
  }, []);

  // A finished transfer that went well clears itself after a while.
  useEffect(() => {
    const done = Object.values(views).filter((v) => v.phase === "finished" && v.progress?.state === "done");
    if (!done.length) return;
    const timer = window.setTimeout(() => done.forEach((v) => close(v.instanceId)), 6000);
    return () => window.clearTimeout(timer);
  }, [views]);

  const start = (view: TransferView) =>
    void (view.direction === "send" ? startSend(view.instanceId) : startReceive(view.instanceId));

  const list = Object.values(views);
  if (list.length === 0) return null;

  return (
    <div className="zmodem-stack">
      {list.map((view) => {
        const p = view.progress;
        const pct = p?.total ? Math.min(100, Math.round(((p.transferred ?? 0) * 100) / p.total)) : 0;
        return (
          <div key={view.instanceId} className="zmodem-card">
            <div className="zmodem-head">
              {view.direction === "send" ? <Upload size={14} /> : <Download size={14} />}
              <b>{view.direction === "send" ? t("zmodem.sendTitle") : t("zmodem.receiveTitle")}</b>
              <span className="muted">· {labelFor(view.instanceId)}</span>
              {view.phase === "finished" && (
                <button type="button" className="icon-btn-xs" onClick={() => close(view.instanceId)}>
                  <X size={12} />
                </button>
              )}
            </div>

            {view.phase === "ask" && (
              <>
                <p className="zmodem-text">
                  {view.direction === "send" ? t("zmodem.sendAsk") : t("zmodem.receiveAsk")}
                </p>
                {view.direction === "receive" && (
                  <div className="zmodem-dir">
                    <span className="mono">{downloadDir || t("zmodem.defaultDir")}</span>
                    <button
                      type="button"
                      className="icon-btn-xs"
                      title={t("zmodem.changeDir")}
                      onClick={async () => {
                        const dir = await backend.pickDirectory(t("zmodem.changeDir"));
                        if (dir) onDownloadDirChange(dir);
                      }}
                    >
                      <FolderOpen size={12} />
                    </button>
                  </div>
                )}
                <div className="zmodem-actions">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => refuse(view.instanceId)}
                  >
                    {t("zmodem.refuse")}
                  </button>
                  <button type="button" className="btn-primary btn-sm" onClick={() => start(view)}>
                    {view.direction === "send" ? t("zmodem.chooseFiles") : t("zmodem.accept")}
                  </button>
                </div>
              </>
            )}

            {view.phase === "staging" && (
              <>
                <p className="zmodem-text">
                  {t("zmodem.preparing")} — {fmtBytes(view.staged?.done)} / {fmtBytes(view.staged?.total)}
                </p>
                <div className="zmodem-bar">
                  <div style={{ width: `${view.staged?.total ? Math.round((view.staged.done * 100) / view.staged.total) : 0}%` }} />
                </div>
              </>
            )}

            {view.phase === "running" && (
              <>
                <p className="zmodem-text">
                  {p?.fileName
                    ? `${p.fileName}${p.fileCount ? ` (${p.fileIndex}/${p.fileCount})` : ""} — ${fmtBytes(p.transferred)} / ${fmtBytes(p.total)}`
                    : t("zmodem.waiting")}
                </p>
                <div className="zmodem-bar">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="zmodem-actions">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void backend.zmodemCancel(view.instanceId)}>
                    {t("zmodem.cancel")}
                  </button>
                </div>
              </>
            )}

            {view.phase === "finished" && (
              <>
                <p className={`zmodem-text ${p?.state === "done" ? "ok" : "warn"}`}>{p?.message}</p>
                {p?.state === "done" && view.direction === "receive" && p.files?.[0] && (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void backend.revealLog(p.files![0])}>
                    <FolderOpen size={12} /> {t("zmodem.openFolder")}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
