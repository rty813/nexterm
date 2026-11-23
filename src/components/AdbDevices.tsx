import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MonitorSmartphone, Play, ScrollText, Smartphone, Unplug } from "lucide-react";
import { adb } from "../services/adb";
import type { AdbDeviceInfo, SessionConfig } from "../types/domain";
import { adbDeviceLabel, adbSerialOf, adbSessionFor, isNetworkSerial, logcatSessionOf } from "../utils/adbSession";
import { useContextMenu } from "./ContextMenu";
import { ProtocolBadge } from "./ProtocolBadge";

const COLLAPSED_KEY = "nexterm.adbDevicesCollapsed";

/**
 * Sidebar section "ADB 设备": devices the adb server has connected (USB, or WLAN after
 * `adb connect` anywhere — Android Studio counts too) that no saved session covers. The
 * list follows the server live; nothing is shown until a server runs.
 */
export function AdbDeviceSource({
  filter,
  sessions,
  onOpen,
  onSave,
  onMirror,
}: {
  filter: string;
  sessions: SessionConfig[];
  onOpen: (session: SessionConfig) => void;
  onSave: (session: SessionConfig) => void;
  onMirror?: (serial: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AdbDeviceInfo[]>([]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const openMenu = useContextMenu();

  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    void adb.watchDevices((list) => alive && setDevices(list)).then((u) => {
      if (alive) un = u;
      else u();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  const saved = new Set(sessions.filter((s) => s.protocol === "adb").map(adbSerialOf).filter(Boolean));
  const keyword = filter.trim().toLowerCase();
  const shown = devices.filter(
    (d) => !saved.has(d.serial) && (!keyword || `${d.serial} ${d.model} ${d.product}`.toLowerCase().includes(keyword))
  );
  if (shown.length === 0) return null;

  const sessionOf = (d: AdbDeviceInfo) =>
    adbSessionFor(d.serial, { id: `adb-${d.serial}`, label: d.model ? `${adbDeviceLabel(d)}` : d.serial, group: t("adb.devicesGroup") });

  const fold = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  };

  return (
    <section className="plugin-session-source adb-device-source" aria-label={t("adb.devices")}>
      <div className="tree-folder-row plugin-source-header">
        <button type="button" className="plugin-source-toggle" aria-expanded={!collapsed} onClick={fold}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <Smartphone size={13} />
          <span className="folder-name">{t("adb.devices")}</span>
          <span className="folder-badge">{shown.length}</span>
        </button>
      </div>
      {!collapsed &&
        shown.map((d) => {
          const ready = d.state === "device";
          const session = sessionOf(d);
          return (
            <div
              key={d.serial}
              className={`tree-session-row plugin-source-session ${ready ? "" : "is-disabled"}`}
              tabIndex={0}
              title={`${d.serial}\n${d.product}${ready ? "" : `\n${t(`adb.state.${d.state.split(" ")[0]}`, { defaultValue: d.state })}`}`}
              onDoubleClick={() => ready && onOpen(session)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) onOpen(session);
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t("adb.openShell"), disabled: !ready, onClick: () => onOpen(session) },
                  ...(onMirror ? [{ label: t("adb.menuMirror"), disabled: !ready, onClick: () => onMirror(d.serial, session.label) }] : []),
                  { label: t("adb.menuLogcat"), disabled: !ready, onClick: () => onOpen(logcatSessionOf(session, `logcat-${d.serial}-${Date.now()}`, `Logcat · ${session.label}`)) },
                  { type: "separator" },
                  { label: t("adb.saveSession"), onClick: () => onSave({ ...session, id: crypto.randomUUID?.() ?? `adb-${Date.now()}` }) },
                  ...(isNetworkSerial(d.serial)
                    ? [{ label: t("adb.disconnectWlan"), onClick: () => void adb.disconnect(d.serial).catch(() => undefined) }]
                    : []),
                ])
              }
            >
              <span className="session-icon">
                <ProtocolBadge protocol="adb" size={13} />
                <span className={`session-open-dot status-${ready ? "connected" : "connecting"}`} />
              </span>
              <div className="session-row-text">
                <span className="session-row-label">{adbDeviceLabel(d)}</span>
                <span className="session-row-sub">
                  {d.serial}
                  {ready ? "" : ` · ${t(`adb.state.${d.state.split(" ")[0]}`, { defaultValue: d.state })}`}
                </span>
              </div>
              <div className="session-row-actions" onClick={(e) => e.stopPropagation()}>
                {isNetworkSerial(d.serial) && (
                  <button type="button" className="icon-btn-xs" title={t("adb.disconnectWlan")} onClick={() => void adb.disconnect(d.serial).catch(() => undefined)}>
                    <Unplug size={11} />
                  </button>
                )}
                {onMirror && (
                  <button type="button" className="icon-btn-xs" title={t("adb.menuMirror")} disabled={!ready} onClick={() => onMirror(d.serial, session.label)}>
                    <MonitorSmartphone size={11} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn-xs"
                  title={t("adb.menuLogcat")}
                  disabled={!ready}
                  onClick={() => onOpen(logcatSessionOf(session, `logcat-${d.serial}-${Date.now()}`, `Logcat · ${session.label}`))}
                >
                  <ScrollText size={11} />
                </button>
                <button type="button" className="icon-btn-xs" title={t("adb.openShell")} disabled={!ready} onClick={() => onOpen(session)}>
                  <Play size={11} />
                </button>
              </div>
            </div>
          );
        })}
    </section>
  );
}
