import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Eye, Keyboard, Share2, X } from "lucide-react";
import { backend, type ShareInfo, type ShareOptions, type ShareViewer } from "../services/backend";
import { shareStore, useShareStore } from "../services/shares";
import { DEFAULT_SHARE_OPTIONS, SHARE_EXPIRY_CHOICES, remaining, shareErrorKey, shareOfPane } from "../utils/share";
import "../styles/share.css";

const EXPIRY_LABEL: Record<number, string> = { 60: "h1", 240: "h4", 1440: "h24", 0: "never" };

/** Share one pane through the relay: create the link, then manage its viewers (share.rs). */
export const ShareDialog: React.FC<{ paneId: string; title: string }> = ({ paneId, title }) => {
  const { t } = useTranslation();
  const { shares } = useShareStore();
  const share = shareOfPane(shares, paneId);
  const [draft, setDraft] = useState<ShareOptions>(DEFAULT_SHARE_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const options = share?.options ?? draft;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const close = () => shareStore.closeDialog();
  const setOption = (patch: Partial<ShareOptions>) => {
    const next = { ...options, ...patch };
    if (share) void backend.shareUpdate(share.id, next);
    else setDraft(next);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await backend.shareStart(paneId, draft);
    } catch (e) {
      const key = shareErrorKey(e);
      setError(key ? t(key) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="modal-panel share-panel">
        <div className="modal-header">
          <h3>
            <Share2 size={15} /> {t("share.title", { title })}
          </h3>
          <button type="button" className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {share ? <ShareLink share={share} now={now} copied={copied} setCopied={setCopied} /> : <p className="adv-hint">{t("share.intro")}</p>}

          <div className="share-options">
            <label className="share-expiry">
              <span>{t("share.expires")}</span>
              <select
                className="text-input"
                value={options.expiresMinutes}
                onChange={(e) => setOption({ expiresMinutes: Number(e.target.value) })}
              >
                {SHARE_EXPIRY_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {t(`share.exp.${EXPIRY_LABEL[m]}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={options.scrollback} onChange={(e) => setOption({ scrollback: e.target.checked })} />
              <span>{t("share.scrollback")}</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={options.approve} onChange={(e) => setOption({ approve: e.target.checked })} />
              <span>{t("share.approve")}</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={options.single} onChange={(e) => setOption({ single: e.target.checked })} />
              <span>{t("share.single")}</span>
            </label>
          </div>

          {share && <ViewerList share={share} />}
          {error && <div className="lock-err">{error}</div>}

          <div className="modal-footer">
            {share ? (
              <button type="button" className="btn-danger" onClick={() => void backend.shareStop(share.id)}>
                {t("share.stop")}
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void create()}>
                {busy ? t("share.creating") : t("share.create")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ShareLink: React.FC<{ share: ShareInfo; now: number; copied: boolean; setCopied: (v: boolean) => void }> = ({
  share,
  now,
  copied,
  setCopied,
}) => {
  const { t } = useTranslation();
  const left = remaining(share.expiresAt, now);
  const expiry = !left
    ? t("share.noExpiry")
    : left.hours > 0
      ? t("share.expiresInH", { h: left.hours, m: left.minutes })
      : t("share.expiresInM", { m: left.minutes });
  return (
    <>
      <div className={`share-status share-${share.state}`}>
        <span className="share-dot" />
        <b>{t(`share.state.${share.state}`)}</b>
        <span className="adv-hint">· {expiry}</span>
        {share.message && share.state === "error" && <span className="lock-err">{share.message}</span>}
      </div>
      <div className="remote-pair">
        <div className="remote-qr" dangerouslySetInnerHTML={{ __html: share.qrSvg }} />
        <div className="remote-pair-side">
          <code className="share-url mono">{share.url}</code>
          <div className="remote-pair-actions">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                void backend.writeClipboard(share.url);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy size={12} /> {copied ? t("share.copied") : t("share.copy")}
            </button>
          </div>
          <p className="adv-hint">{t("share.warn")}</p>
        </div>
      </div>
    </>
  );
};

const ViewerList: React.FC<{ share: ShareInfo }> = ({ share }) => {
  const { t } = useTranslation();
  const name = (v: ShareViewer) => v.name || t("share.guest");
  return (
    <div className="field">
      <span>{t("share.viewers", { count: share.viewers.filter((v) => !v.pending).length })}</span>
      {share.viewers.length ? (
        <ul className="remote-phones share-viewers">
          {share.viewers.map((v) => (
            <li key={v.id} className={v.control ? "is-control" : ""}>
              {v.control ? <Keyboard size={13} /> : <Eye size={13} />}
              <span className="remote-phone-name">{name(v)}</span>
              <span className={`adv-hint ${v.asking || v.pending ? "share-asking" : ""}`}>
                {v.pending ? t("share.waiting") : v.control ? t("share.controlling") : v.asking ? t("share.asking") : t("share.watching")}
              </span>
              <span className="share-viewer-actions">
                {v.pending ? (
                  <>
                    <button type="button" className="btn-primary btn-sm" onClick={() => void backend.shareApprove(share.id, v.id, true)}>
                      {t("share.allow")}
                    </button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void backend.shareApprove(share.id, v.id, false)}>
                      {t("share.deny")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className={v.asking && !v.control ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
                      onClick={() => void backend.shareGrant(share.id, v.id, !v.control)}
                    >
                      {v.control ? t("share.revoke") : t("share.grant")}
                    </button>
                    {v.asking && !v.control && (
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void backend.shareGrant(share.id, v.id, false)}>
                        {t("share.deny")}
                      </button>
                    )}
                    <button type="button" className="icon-btn" title={t("share.kick")} onClick={() => void backend.shareKick(share.id, v.id)}>
                      <X size={13} />
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="adv-hint">{t("share.noViewers")}</div>
      )}
      <div className="adv-hint">{t("share.controlNote")}</div>
    </div>
  );
};
