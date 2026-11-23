import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Activity, X } from "lucide-react";
import { isTauriRuntime } from "../services/backend";
import { useServerMonitor } from "../hooks/useServerMonitor";
import type { MonitorState } from "../services/serverMonitor";
import { formatBytes, formatRate, formatServerUptime, type ServerStats } from "../utils/serverStats";

/** A connected SSH tab whose host can be monitored. */
export interface MonitorTarget {
  paneId: string;
  title: string;
  summary: string;
}

const pct = (n: number | null) => (n == null ? "-" : `${Math.round(n)}%`);

/** Bar colour by load: calm, busy, critical. */
function level(p: number | null): string {
  if (p == null) return "";
  return p >= 90 ? "crit" : p >= 70 ? "warn" : "";
}

const Meter: React.FC<{ label: string; percent: number | null; detail: string }> = ({ label, percent, detail }) => (
  <div className="mon-meter">
    <div className="mon-meter-head">
      <span>{label}</span>
      <span className="mono">{detail}</span>
    </div>
    <div className="mon-bar">
      <div className={`mon-bar-fill ${level(percent)}`} style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
    </div>
  </div>
);

const StatsView: React.FC<{ s: ServerStats; stale: boolean }> = ({ s, stale }) => {
  const { t } = useTranslation();
  const nics = s.nics.filter((n) => !n.virtual);
  const shownNics = nics.length ? nics : s.nics.filter((n) => n.name !== "lo");
  return (
    <>
      {stale && <p className="adv-hint">{t("monitor.stale")}</p>}
      {s.battery && (
        <Meter
          label={t("monitor.battery")}
          percent={100 - s.battery.level}
          detail={`${s.battery.level}% · ${t(`monitor.batteryStatus.${s.battery.status.replace(/ /g, "_")}`)}${
            s.battery.plugged ? ` · ${s.battery.plugged}` : ""
          }${s.battery.temperature != null ? ` · ${s.battery.temperature.toFixed(1)}°C` : ""}`}
        />
      )}
      <Meter
        label={t("monitor.cpu")}
        percent={s.cpuPercent}
        detail={`${pct(s.cpuPercent)}${s.cores ? ` · ${t("monitor.cores", { count: s.cores })}` : ""}`}
      />
      <Meter label={t("monitor.memory")} percent={s.memPercent} detail={`${formatBytes(s.memUsed)} / ${formatBytes(s.memTotal)}`} />
      {s.swapTotal > 0 && (
        <Meter label={t("monitor.swap")} percent={s.swapPercent} detail={`${formatBytes(s.swapUsed)} / ${formatBytes(s.swapTotal)}`} />
      )}
      <div className="mon-kv">
        <span>{t("monitor.load")}</span>
        <span className="mono">{s.load ? s.load.map((n) => n.toFixed(2)).join("  ") : "-"}</span>
        <span>{t("monitor.uptime")}</span>
        <span className="mono">{formatServerUptime(s.uptime)}</span>
      </div>

      <h4 className="section-heading">{t("monitor.network")}</h4>
      {shownNics.length === 0 ? (
        <p className="adv-hint">-</p>
      ) : (
        <table className="mon-table">
          <thead>
            <tr>
              <th>{t("monitor.nic")}</th>
              <th>↓ {t("monitor.rx")}</th>
              <th>↑ {t("monitor.tx")}</th>
            </tr>
          </thead>
          <tbody>
            {shownNics.map((n) => (
              <tr key={n.name} title={t("monitor.nicTotal", { rx: formatBytes(n.rxTotal), tx: formatBytes(n.txTotal) })}>
                <td className="mono">{n.name}</td>
                <td className="mono">{formatRate(n.rxRate)}</td>
                <td className="mono">{formatRate(n.txRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 className="section-heading">{t("monitor.disks")}</h4>
      {s.disks.length === 0 ? (
        <p className="adv-hint">-</p>
      ) : (
        s.disks.map((d) => (
          <div key={`${d.filesystem}-${d.mount}`} title={d.filesystem}>
            <Meter
              label={d.mount}
              percent={d.percent}
              detail={`${formatBytes(d.used)} / ${formatBytes(d.size)} · ${d.percent}%`}
            />
          </div>
        ))
      )}
    </>
  );
};

function stateBody(state: MonitorState | null, t: TFunction): React.ReactNode {
  if (!state || state.status === "loading") return <div className="side-panel-empty">{t("monitor.loading")}</div>;
  if (state.status === "unsupported")
    return <div className="side-panel-empty">{state.os ? t("monitor.unsupportedOs", { os: state.os }) : t("monitor.unsupported")}</div>;
  return null;
}

/** Side panel with the resources of one SSH host (polled only while open). */
export const ServerMonitorPanel: React.FC<{
  targets: MonitorTarget[];
  preferredPaneId: string | null;
  onClose: () => void;
}> = ({ targets, preferredPaneId, onClose }) => {
  const { t } = useTranslation();
  const [paneId, setPaneId] = useState<string | null>(preferredPaneId);
  useEffect(() => {
    if (preferredPaneId && targets.some((x) => x.paneId === preferredPaneId)) setPaneId(preferredPaneId);
    // Only when the preferred pane changes (the target list is rebuilt every render).
  }, [preferredPaneId]);
  const current = targets.find((x) => x.paneId === paneId) ?? targets[0] ?? null;
  const state = useServerMonitor(current?.paneId ?? null);

  return (
    <aside className="side-panel monitor-panel">
      <div className="side-panel-header">
        <Activity size={14} />
        <span>{t("monitor.title")}</span>
        <button type="button" className="icon-btn-xs" onClick={onClose} title={t("monitor.close")}>
          <X size={13} />
        </button>
      </div>
      {!current ? (
        <div className="side-panel-empty">{isTauriRuntime() ? t("monitor.noSsh") : t("monitor.preview")}</div>
      ) : (
        <div className="side-panel-body">
          {targets.length > 1 && (
            <label className="field">
              <span>{t("monitor.session")}</span>
              <select className="text-input input-sm" value={current.paneId} onChange={(e) => setPaneId(e.target.value)}>
                {targets.map((x) => (
                  <option key={x.paneId} value={x.paneId}>
                    {x.title} — {x.summary}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state?.status === "ok" ? <StatsView s={state.stats} stale={state.stale} /> : stateBody(state, t)}
        </div>
      )}
    </aside>
  );
};

