import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, RefreshCw, MonitorSmartphone, Share2, X } from "lucide-react";
import type { AppSettings } from "../types/domain";
import { backend, type RemotePairing, type RemoteStatus } from "../services/backend";
import { remoteOf } from "../utils/settingsDefaults";
import { confirmAsk } from "../utils/confirm";
import { useShareStore } from "../services/shares";
import { summarizeShare } from "../utils/share";

type Props = { draft: AppSettings; onChange: (next: AppSettings) => void; saved: AppSettings };

/** Remote access: relay address, pairing QR code, connected devices. */
export const RemoteSettingsEditor: React.FC<Props> = ({ draft, onChange, saved }) => {
  const { t } = useTranslation();
  const r = remoteOf(draft);
  const set = (patch: Partial<typeof r>) => onChange({ ...draft, remote: { ...r, ...patch } });
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [copied, setCopied] = useState(false);
  const { shares } = useShareStore();
  // The QR code points at the saved relay address (what the computer connects to).
  const savedUrl = remoteOf(saved).relayUrl;
  const dirty = JSON.stringify(remoteOf(saved)) !== JSON.stringify(r);

  useEffect(() => {
    void backend.remoteStatus().then(setStatus);
    const un = backend.onRemoteState(setStatus);
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    void backend.remotePairing().then(setPairing);
  }, [savedUrl]);

  const state = status?.state ?? "off";
  return (
    <div className="settings-general">
      <div className={`xserver-status ${state === "online" ? "on" : ""}`}>
        <MonitorSmartphone size={16} />
        <div>
          <b>{t(`remote.state.${state}`)}</b>
          {status?.message && <div className="lock-err">{status.message}</div>}
          {dirty && <div className="adv-hint">{t("remote.saveFirst")}</div>}
        </div>
      </div>
      <p className="adv-hint">{t("remote.hint")}</p>
      <div className="form-grid-2">
        <label className="checkbox-row">
          <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>{t("remote.enabled")}</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={r.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
          <span>{t("remote.readOnly")}</span>
        </label>
      </div>
      <label className="field">
        <span>{t("remote.relayUrl")}</span>
        <input
          className="text-input mono"
          placeholder="https://relay.example.com"
          value={r.relayUrl}
          onChange={(e) => set({ relayUrl: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{t("remote.hostToken")}</span>
        <input
          className="text-input mono"
          type="password"
          autoComplete="off"
          placeholder={t("remote.hostTokenPh")}
          value={r.hostToken}
          onChange={(e) => set({ hostToken: e.target.value })}
        />
      </label>

      {pairing?.url ? (
        <div className="remote-pair">
          <div className="remote-qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <div className="remote-pair-side">
            <b>{t("remote.scan")}</b>
            <p className="adv-hint">{t("remote.scanHint")}</p>
            <div className="remote-pair-actions">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  void backend.writeClipboard(pairing.url);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy size={12} /> {copied ? t("remote.copied") : t("remote.copyLink")}
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                title={t("remote.resetTip")}
                onClick={() => {
                  void confirmAsk(t("remote.resetConfirm")).then(async (ok) => {
                    if (ok) setPairing(await backend.remotePairing(true));
                  });
                }}
              >
                <RefreshCw size={12} /> {t("remote.reset")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="adv-hint">{t("remote.noRelay")}</p>
      )}

      <div className="field">
        <span>{t("remote.phones")}</span>
        {status?.phones.length ? (
          <ul className="remote-phones">
            {status.phones.map((p) => (
              <li key={p.id}>
                <MonitorSmartphone size={13} />
                <span className="remote-phone-name">{p.name || t("remote.phone")}</span>
                <span className="adv-hint">{p.watching ? t("remote.watching") : t("remote.idle")}</span>
                <button type="button" className="icon-btn" title={t("remote.kick")} onClick={() => void backend.remoteKick(p.id)}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="adv-hint">{t("remote.noPhones")}</div>
        )}
      </div>

      <div className="field">
        <span>{t("share.active")}</span>
        {shares.length ? (
          <ul className="remote-phones share-active-list">
            {shares.map((s) => {
              const sum = summarizeShare(s);
              return (
                <li key={s.id}>
                  <Share2 size={13} />
                  <span className="remote-phone-name">{s.title}</span>
                  <span className="adv-hint">
                    {sum.controller
                      ? t("share.badgeControl", { name: sum.controller.name || t("share.guest") })
                      : t("share.badge", { count: sum.watching })}
                  </span>
                  <button type="button" className="icon-btn" title={t("share.stop")} onClick={() => void backend.shareStop(s.id)}>
                    <X size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="adv-hint">{t("share.noActive")}</div>
        )}
      </div>
    </div>
  );
};
