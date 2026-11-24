import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Package, Play, RefreshCw, Square, Trash2, Upload, X } from "lucide-react";
import { adb } from "../services/adb";
import { backend } from "../services/backend";
import type { AdbAppAction, AdbAppInfo, AdbProcessInfo } from "../types/domain";
import { formatBytes } from "../utils/serverStats";
import type { ConfirmAnswer, ConfirmRequest } from "./ConfirmDialog";
import { useContextMenu } from "./ContextMenu";

interface Target {
  paneId: string;
  title: string;
  summary: string;
}

type Tab = "apps" | "processes";

/** Apps (install / uninstall / stop / clear / launch / export) and processes of an ADB pane's device. */
export const AdbDevicePanel: React.FC<{
  targets: Target[];
  paneId: string;
  onPane: (paneId: string) => void;
  ask: (req: ConfirmRequest) => Promise<ConfirmAnswer>;
  onToast: (message: string) => void;
  onClose: () => void;
}> = ({ targets, paneId, onPane, ask, onToast, onClose }) => {
  const { t } = useTranslation();
  const current = targets.find((x) => x.paneId === paneId) ?? null;
  const [tab, setTab] = useState<Tab>("apps");
  const [filter, setFilter] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [apps, setApps] = useState<AdbAppInfo[] | null>(null);
  const [procs, setProcs] = useState<AdbProcessInfo[] | null>(null);
  const [sort, setSort] = useState<"cpu" | "rss" | "name">("cpu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const openMenu = useContextMenu();

  const load = async (which: Tab = tab) => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      if (which === "apps") setApps(await adb.apps({ instanceId: current.paneId }, true));
      else setProcs(await adb.processes({ instanceId: current.paneId }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setApps(null);
    setProcs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.paneId]);
  useEffect(() => {
    if ((tab === "apps" && !apps) || (tab === "processes" && !procs)) void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, apps, procs, current?.paneId]);

  // Processes refresh every 3 s while shown.
  useEffect(() => {
    if (tab !== "processes" || !current) return;
    const id = window.setInterval(() => {
      if (!document.hidden) void adb.processes({ instanceId: current.paneId }).then(setProcs, () => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, [tab, current?.paneId]);

  const needle = filter.trim().toLowerCase();
  const shownApps = useMemo(
    () => (apps ?? []).filter((a) => (showSystem || !a.system) && (!needle || a.package.toLowerCase().includes(needle))),
    [apps, showSystem, needle]
  );
  const shownProcs = useMemo(() => {
    const list = (procs ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || String(p.pid) === needle || p.user.includes(needle));
    return [...list].sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : sort === "rss" ? b.rss - a.rss : a.name.localeCompare(b.name)));
  }, [procs, needle, sort]);

  const act = async (app: AdbAppInfo, action: AdbAppAction) => {
    if (!current) return;
    const destructive = action === "uninstall" || action === "clear" || action === "uninstallKeepData";
    if (destructive) {
      const a = await ask({
        title: t(`adbPanel.actions.${action}`),
        message: t("adbPanel.confirm", { action: t(`adbPanel.actions.${action}`), pkg: app.package }),
        danger: true,
      });
      if (!a.ok) return;
    }
    try {
      const out = await adb.appAction(current.paneId, app.package, action);
      onToast(out || t("adbPanel.done"));
      if (action !== "launch" && action !== "forceStop") void load("apps");
    } catch (e) {
      onToast(String(e));
    }
  };

  const exportApk = async (app: AdbAppInfo) => {
    if (!current) return;
    const dir = await backend.pickDirectory(t("adbPanel.exportTo"));
    if (!dir) return;
    try {
      const files = await adb.exportApk(current.paneId, app.package, dir);
      onToast(t("adbPanel.exported", { path: files.join(", ") }));
    } catch (e) {
      onToast(String(e));
    }
  };

  const install = async (paths: string[]) => {
    if (!current) return;
    for (const path of paths.filter((p) => /\.apk$/i.test(p))) {
      onToast(t("adbPanel.installing", { name: path.split(/[\\/]/).pop() }));
      try {
        await adb.install(current.paneId, path);
        onToast(t("adbPanel.installed", { name: path.split(/[\\/]/).pop() }));
      } catch (e) {
        onToast(String(e));
      }
    }
    void load("apps");
  };

  const pickApk = async () => {
    const path = await backend.pickFile(t("adbPanel.install"), ["apk"]);
    if (path) await install([path]);
  };

  const kill = async (p: AdbProcessInfo, signal: number) => {
    if (!current) return;
    try {
      await adb.kill(current.paneId, [p.pid], signal);
      void load("processes");
    } catch (e) {
      onToast(String(e));
    }
  };

  const appMenu = (e: React.MouseEvent, app: AdbAppInfo) =>
    openMenu(e, [
      { label: t("adbPanel.actions.launch"), onClick: () => void act(app, "launch") },
      { label: t("adbPanel.actions.forceStop"), onClick: () => void act(app, "forceStop") },
      { type: "separator" },
      { label: t("adbPanel.actions.clear"), danger: true, onClick: () => void act(app, "clear") },
      app.disabled
        ? { label: t("adbPanel.actions.enable"), onClick: () => void act(app, "enable") }
        : { label: t("adbPanel.actions.disable"), onClick: () => void act(app, "disable") },
      { label: t("adbPanel.actions.uninstall"), danger: true, onClick: () => void act(app, "uninstall") },
      { label: t("adbPanel.actions.uninstallKeepData"), onClick: () => void act(app, "uninstallKeepData") },
      { type: "separator" },
      { label: t("adbPanel.exportApk"), onClick: () => void exportApk(app) },
      { label: t("adbPanel.copyPackage"), onClick: () => void backend.writeClipboard(app.package) },
    ]);

  return (
    <aside
      className={`side-panel adb-panel ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (tab === "apps") {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // The webview gives dropped files' bytes, not paths: copy each APK to a staging
        // folder first (the same one the file browser uses), then install from there.
        const files = [...e.dataTransfer.files].filter((f) => /\.apk$/i.test(f.name));
        if (!files.length) return;
        void (async () => {
          const paths: string[] = [];
          for (const f of files) {
            const token = `apk-${Math.random().toString(36).slice(2, 10)}`;
            const base = await backend.sftpStage(token, f.name, f);
            paths.push(`${base}\\${f.name}`);
          }
          await install(paths);
        })().catch((err) => onToast(String(err)));
      }}
    >
      <div className="side-panel-header">
        <Boxes size={14} />
        <span>{t("adbPanel.title")}</span>
        <button type="button" className="icon-btn-xs" onClick={onClose} title={t("adbPanel.close")}>
          <X size={13} />
        </button>
      </div>
      {!current ? (
        <div className="side-panel-empty">{t("mirror.noDevice")}</div>
      ) : (
        <div className="side-panel-body adb-panel-body">
          {targets.length > 1 && (
            <select className="text-input input-sm" value={paneId} onChange={(e) => onPane(e.target.value)}>
              {targets.map((x) => (
                <option key={x.paneId} value={x.paneId}>
                  {x.title} — {x.summary}
                </option>
              ))}
            </select>
          )}
          <div className="seg-tabs">
            <button type="button" className={tab === "apps" ? "active" : ""} onClick={() => setTab("apps")}>
              {t("adbPanel.apps")}
            </button>
            <button type="button" className={tab === "processes" ? "active" : ""} onClick={() => setTab("processes")}>
              {t("adbPanel.processes")}
            </button>
          </div>
          <div className="adb-panel-tools">
            <input className="text-input input-sm" placeholder={t("adbPanel.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {tab === "apps" ? (
              <>
                <label className="checkbox-row" title={t("adbPanel.systemTip")}>
                  <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
                  {t("adbPanel.system")}
                </label>
                <button type="button" className="icon-btn-xs" title={t("adbPanel.install")} onClick={() => void pickApk()}>
                  <Upload size={13} />
                </button>
              </>
            ) : (
              <select className="text-input input-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} title={t("adbPanel.sort")}>
                <option value="cpu">CPU</option>
                <option value="rss">{t("adbPanel.memory")}</option>
                <option value="name">{t("adbPanel.name")}</option>
              </select>
            )}
            <button type="button" className="icon-btn-xs" title={t("adbPanel.refresh")} onClick={() => void load()} disabled={busy}>
              <RefreshCw size={13} className={busy ? "spin" : ""} />
            </button>
          </div>
          {error && <p className="adv-hint adb-message">{error}</p>}

          {tab === "apps" ? (
            <div className="adb-list">
              {apps && shownApps.length === 0 && <div className="side-panel-empty">{t("adbPanel.none")}</div>}
              {shownApps.map((a) => (
                <div key={a.package} className={`adb-row ${a.disabled ? "disabled" : ""}`} onContextMenu={(e) => appMenu(e, a)} title={a.apk}>
                  <Package size={13} className="muted-icon" />
                  <div className="adb-row-main">
                    <div className="adb-row-title">{a.package}</div>
                    <div className="adb-row-sub">
                      {a.versionName ?? ""}
                      {a.versionCode ? ` (${a.versionCode})` : ""}
                      {a.system ? ` · ${t("adbPanel.systemApp")}` : ""}
                      {a.disabled ? ` · ${t("adbPanel.disabledApp")}` : ""}
                    </div>
                  </div>
                  <button type="button" className="icon-btn-xs" title={t("adbPanel.actions.launch")} onClick={() => void act(a, "launch")}>
                    <Play size={12} />
                  </button>
                  <button type="button" className="icon-btn-xs" title={t("adbPanel.actions.forceStop")} onClick={() => void act(a, "forceStop")}>
                    <Square size={11} />
                  </button>
                  {!a.system && (
                    <button type="button" className="icon-btn-xs" title={t("adbPanel.actions.uninstall")} onClick={() => void act(a, "uninstall")}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
              {tab === "apps" && <p className="adv-hint">{t("adbPanel.dropHint")}</p>}
            </div>
          ) : (
            <table className="mon-table adb-proc-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>{t("adbPanel.name")}</th>
                  <th>CPU</th>
                  <th>{t("adbPanel.memory")}</th>
                </tr>
              </thead>
              <tbody>
                {shownProcs.map((p) => (
                  <tr
                    key={p.pid}
                    title={`${p.user} · PPID ${p.ppid} · ${p.state}`}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: t("adbPanel.kill"), onClick: () => void kill(p, 15) },
                        { label: t("adbPanel.killForce"), danger: true, onClick: () => void kill(p, 9) },
                        { label: t("adbPanel.copyPid"), onClick: () => void backend.writeClipboard(String(p.pid)) },
                      ])
                    }
                  >
                    <td className="mono">{p.pid}</td>
                    <td className="mono adb-proc-name">{p.name}</td>
                    <td className="mono">{p.cpu.toFixed(1)}</td>
                    <td className="mono">{formatBytes(p.rss * 1024)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </aside>
  );
};
