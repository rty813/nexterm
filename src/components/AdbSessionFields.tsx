import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Link2, RefreshCw, Wifi } from "lucide-react";
import { adb } from "../services/adb";
import type { AdbConfig, AdbDeviceInfo, AdbStatus } from "../types/domain";
import { adbDeviceLabel, splitAdbAddress } from "../utils/adbSession";

/** ADB part of the session form: connection kind, the device, WLAN pairing. */
export function AdbSessionFields({
  cfg,
  onCfg,
  host,
  port,
  onHost,
  onPort,
}: {
  cfg: AdbConfig;
  onCfg: (patch: Partial<AdbConfig>) => void;
  host: string;
  port: number;
  onHost: (host: string) => void;
  onPort: (port: number) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AdbStatus | null>(null);
  const [devices, setDevices] = useState<AdbDeviceInfo[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairAddr, setPairAddr] = useState("");
  const [pairCode, setPairCode] = useState("");

  const refresh = async () => {
    const s = await adb.status();
    setStatus(s);
    if (!s.path && !s.serverVersion) return;
    try {
      if (!s.serverVersion) await adb.startServer();
      setDevices(await adb.devices());
      setMessage("");
    } catch (e) {
      setMessage(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    let un: (() => void) | undefined;
    void adb.watchDevices(setDevices).then((u) => (un = u));
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (what: string, fn: () => Promise<string | void>) => {
    setBusy(what);
    setMessage("");
    try {
      const out = await fn();
      if (out) setMessage(out);
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy("");
    }
  };

  const fetchTools = () =>
    run("download", async () => {
      const un = await adb.onDownloadProgress(setDownload);
      try {
        await adb.download();
        return t("adb.downloaded");
      } finally {
        un();
        setDownload(null);
      }
    });

  const usbDevices = devices.filter((d) => d.transport === "usb");
  const wlan = cfg.connect === "wlan";
  const noAdb = status !== null && !status.path && !status.serverVersion;

  return (
    <>
      <div className="form-grid-2">
        <label className="field">
          <span>{t("adb.connectKind")}</span>
          <select className="text-input" value={cfg.connect} onChange={(e) => onCfg({ connect: e.target.value as AdbConfig["connect"] })}>
            <option value="usb">{t("adb.usb")}</option>
            <option value="wlan">{t("adb.wlan")}</option>
          </select>
        </label>
        {!wlan && (
          <label className="field">
            <span>{t("adb.device")}</span>
            <div className="input-with-btn">
              <select className="text-input" value={cfg.serial} onChange={(e) => onCfg({ serial: e.target.value })}>
                <option value="">{t("adb.autoDevice")}</option>
                {cfg.serial && !usbDevices.some((d) => d.serial === cfg.serial) && (
                  <option value={cfg.serial}>
                    {cfg.serial} ({t("adb.notConnected")})
                  </option>
                )}
                {usbDevices.map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {adbDeviceLabel(d)} · {d.serial}
                    {d.state !== "device" ? ` (${d.state})` : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => void refresh()} title={t("adb.refresh")}>
                <RefreshCw size={14} />
              </button>
            </div>
          </label>
        )}
      </div>

      {wlan && (
        <div className="form-grid-3">
          <label className="field col-span-2">
            <span>{t("adb.address")}</span>
            <input
              type="text"
              className="text-input"
              placeholder="192.168.1.5"
              value={host}
              list="adb-wlan-devices"
              onChange={(e) => {
                const v = e.target.value;
                // Pasting "ip:port" fills both fields.
                if (/:\d+$/.test(v.trim())) {
                  const { host: h, port: p } = splitAdbAddress(v);
                  onHost(h);
                  onPort(p);
                } else onHost(v);
              }}
              required
            />
            <datalist id="adb-wlan-devices">
              {devices
                .filter((d) => d.transport === "tcp")
                .map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {adbDeviceLabel(d)}
                  </option>
                ))}
            </datalist>
          </label>
          <label className="field">
            <span>{t("sessionModal.port")}</span>
            <input type="number" className="text-input" value={port || 5555} min={1} max={65535} onChange={(e) => onPort(Number(e.target.value))} />
          </label>
        </div>
      )}

      <div className="adb-form-actions">
        {noAdb ? (
          <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => void fetchTools()}>
            <Download size={14} />
            {busy === "download" && download
              ? t("adb.downloading", { pct: download.total ? Math.round((download.received / download.total) * 100) : 0 })
              : t("adb.downloadTools")}
          </button>
        ) : (
          <>
            {wlan && (
              <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => setPairOpen((v) => !v)}>
                <Link2 size={14} />
                {t("adb.pair")}
              </button>
            )}
            {!wlan && usbDevices.some((d) => d.state === "device") && (
              <button
                type="button"
                className="btn-secondary"
                disabled={Boolean(busy)}
                title={t("adb.toWlanTip")}
                onClick={() =>
                  void run("tcpip", async () => {
                    const serial = cfg.serial || usbDevices.find((d) => d.state === "device")!.serial;
                    const addr = await adb.enableWlan(serial);
                    const { host: h, port: p } = splitAdbAddress(addr);
                    onCfg({ connect: "wlan" });
                    onHost(h);
                    onPort(p);
                    return t("adb.toWlanDone", { addr });
                  })
                }
              >
                <Wifi size={14} />
                {t("adb.toWlan")}
              </button>
            )}
          </>
        )}
        {status?.path && <span className="adv-hint" title={status.path}>adb: {status.path}</span>}
      </div>

      {wlan && pairOpen && (
        <div className="form-grid-3 adb-pair">
          <label className="field">
            <span>{t("adb.pairAddress")}</span>
            <input type="text" className="text-input" placeholder="192.168.1.5:37123" value={pairAddr} onChange={(e) => setPairAddr(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("adb.pairCode")}</span>
            <input type="text" className="text-input" inputMode="numeric" maxLength={6} value={pairCode} onChange={(e) => setPairCode(e.target.value)} />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button
              type="button"
              className="btn-primary"
              disabled={Boolean(busy) || !pairAddr.trim() || !pairCode.trim()}
              onClick={() => void run("pair", () => adb.pair(pairAddr, pairCode))}
            >
              {t("adb.pairNow")}
            </button>
          </div>
          <p className="adv-hint col-span-3">{t("adb.pairHint")}</p>
        </div>
      )}
      {message && <p className="adv-hint adb-message">{message}</p>}
    </>
  );
}
