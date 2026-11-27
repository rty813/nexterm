import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, KeyRound } from "lucide-react";
import type { SessionConfig } from "../types/domain";
import { applyBatchLogin, credentialsFor, takesCredential, type BatchLogin } from "../utils/credentials";
import { useCredentials } from "../services/credentials";
import { backend } from "../services/backend";
import { CredentialManager } from "./CredentialManager";

type Own = Extract<BatchLogin, { kind: "own" }>;

/** Session manager: change the login (a credential, or user name / password / key) of the selected sessions. */
export const BatchLoginDialog: React.FC<{
  sessions: SessionConfig[];
  /** The changed sessions (those that could take the login). */
  onSave: (changed: SessionConfig[]) => void;
  onClose: () => void;
}> = ({ sessions, onSave, onClose }) => {
  const { t } = useTranslation();
  const { list, loaded } = useCredentials();
  const targets = useMemo(() => sessions.filter((s) => takesCredential(s.protocol)), [sessions]);
  const shared = new Set(targets.map((s) => s.credentialId ?? "")).size === 1 ? targets[0]?.credentialId ?? "" : "";
  const [kind, setKind] = useState<BatchLogin["kind"]>(shared ? "credential" : "own");
  const [credentialId, setCredentialId] = useState(shared);
  const [own, setOwnState] = useState<Own>({
    kind: "own",
    username: "",
    authType: "keep",
    password: "",
    privateKeyPath: "",
    passphrase: "",
    clearSecret: false,
  });
  const setOwn = (patch: Partial<Own>) => setOwnState((prev) => ({ ...prev, ...patch }));
  const [manageOpen, setManageOpen] = useState(false);

  const hasSsh = targets.some((s) => s.protocol === "ssh");
  const hasOther = targets.some((s) => s.protocol !== "ssh");
  const keyFields = hasSsh && own.authType !== "password";
  // Credentials at least one of the sessions can use.
  const usable = useMemo(
    () =>
      list
        .filter((c) => targets.some((s) => credentialsFor(s.protocol, [c]).length > 0))
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [list, targets]
  );
  const pending = kind === "credential" && !credentialId;
  const changed = useMemo(() => {
    if (pending) return [];
    const change: BatchLogin = kind === "credential" ? { kind, credentialId } : own;
    return targets.map((s) => applyBatchLogin(s, change, list)).filter((s): s is SessionConfig => s !== null);
  }, [pending, kind, credentialId, own, targets, list]);
  const skipped = pending ? 0 : sessions.length - changed.length;

  const pickKey = async () => {
    const picked = await backend.pickFile(t("sessionModal.selectKeyTitle"));
    if (picked) setOwn({ privateKeyPath: picked });
  };

  const title =
    sessions.length === 1
      ? t("manager.loginTitleOne", { name: sessions[0].label })
      : t("manager.loginTitle", { count: sessions.length });

  return (
    <>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          className="modal-panel onekey-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <div className="modal-header">
            <h3>{title}</h3>
          </div>
          <div className="modal-body">
            <div className="batch-login-kind" role="radiogroup">
              <label>
                <input type="radio" checked={kind === "credential"} onChange={() => setKind("credential")} />
                {t("manager.loginUseCredential")}
              </label>
              <label>
                <input type="radio" checked={kind === "own"} onChange={() => setKind("own")} />
                {t("manager.loginUseOwn")}
              </label>
            </div>

            {kind === "credential" ? (
              <label className="field">
                <span>{t("credentials.login")}</span>
                <div className="input-with-btn">
                  <select className="text-input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                    <option value="" disabled>
                      {!loaded ? "…" : usable.length ? t("manager.loginPickCredential") : t("credentials.empty")}
                    </option>
                    {usable.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.username ? `${c.name} (${c.username})` : c.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn-secondary" onClick={() => setManageOpen(true)} title={t("credentials.manage")}>
                    <KeyRound size={14} />
                  </button>
                </div>
              </label>
            ) : (
              <>
                <div className="form-grid-2">
                  <label className="field">
                    <span>{t("sessionModal.username")}</span>
                    <input
                      type="text"
                      className="text-input"
                      placeholder={t("manager.loginKeep")}
                      value={own.username}
                      onChange={(e) => setOwn({ username: e.target.value })}
                      autoFocus
                    />
                  </label>
                  {hasSsh && (
                    <label className="field">
                      <span>{t("sessionModal.authType")}</span>
                      <select
                        className="text-input"
                        value={own.authType}
                        onChange={(e) => setOwn({ authType: e.target.value as Own["authType"] })}
                      >
                        <option value="keep">{t("manager.loginKeepAuth")}</option>
                        <option value="password">{t("sessionModal.authPwd")}</option>
                        <option value="privatekey">{t("sessionModal.authKey")}</option>
                      </select>
                    </label>
                  )}
                </div>
                {(own.authType !== "privatekey" || hasOther) && (
                  <label className="field">
                    <span>{t("sessionModal.pwdLabel")}</span>
                    <input
                      type="password"
                      className="text-input"
                      placeholder={t("manager.loginKeep")}
                      value={own.password}
                      onChange={(e) => setOwn({ password: e.target.value })}
                    />
                  </label>
                )}
                {keyFields && (
                  <div className="form-grid-2">
                    <label className="field">
                      <span>{t("sessionModal.keyFile")}</span>
                      <div className="input-with-btn">
                        <input
                          type="text"
                          className="text-input"
                          placeholder={t("manager.loginKeep")}
                          value={own.privateKeyPath}
                          onChange={(e) => setOwn({ privateKeyPath: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => void pickKey()}
                          title={t("sessionModal.selectKeyTitle")}
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </label>
                    <label className="field">
                      <span>{t("sessionModal.passphrase")}</span>
                      <input
                        type="password"
                        className="text-input"
                        placeholder={t("manager.loginKeep")}
                        value={own.passphrase}
                        onChange={(e) => setOwn({ passphrase: e.target.value })}
                      />
                    </label>
                  </div>
                )}
                <label className="batch-login-check">
                  <input type="checkbox" checked={own.clearSecret} onChange={(e) => setOwn({ clearSecret: e.target.checked })} />
                  {t(keyFields ? "manager.loginClearSecretKey" : "manager.loginClearSecret")}
                </label>
                <p className="adv-hint">{t(keyFields ? "manager.loginOwnHintKey" : "manager.loginOwnHint")}</p>
              </>
            )}

            {skipped > 0 && <p className="adv-hint sync-warn">{t("manager.loginSkipped", { count: skipped })}</p>}
            <div className="modal-footer">
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t("sessionModal.cancel")}
              </button>
              <button type="button" className="btn-primary" disabled={changed.length === 0} onClick={() => onSave(changed)}>
                {t("manager.loginApply", { count: changed.length })}
              </button>
            </div>
          </div>
        </div>
      </div>
      {manageOpen && (
        <CredentialManager
          sessions={sessions}
          onClose={() => setManageOpen(false)}
          onCreated={(id, onekey) => {
            if (onekey) return;
            setKind("credential");
            setCredentialId(id);
          }}
        />
      )}
    </>
  );
};
