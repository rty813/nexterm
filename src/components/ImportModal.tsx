import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, FileText, FolderOpen, RefreshCw, X } from "lucide-react";
import { backend } from "../services/backend";
import type { TFunction } from "i18next";
import type { DiscoveryCandidate, ImportResult } from "../types/domain";
import { syncErrorKey } from "../utils/configSync";
import { ImportSourceIcon, type ImportApp } from "./ImportSourceIcon";

/** Session importers whose result is reported with localized counts. */
const SESSION_SOURCES = ["windterm_sessions", "xshell_sessions", "mobaxterm", "securecrt", "finalshell"];

/** Result line: localized for the session importers that report counts, else the backend text. */
function importFeedback(res: ImportResult, sourceType: string, t: TFunction): string {
  if (!SESSION_SOURCES.includes(sourceType)) return res.summary;
  const parts = [t("importModal.importedSessions", { count: res.sessions.length })];
  if (sourceType === "windterm_sessions") {
    const count = res.sessions.filter((session) => session.password).length;
    if (count) parts.push(t("importModal.windtermPasswords", { count }));
    if (res.passwordsSkipped) parts.push(t("importModal.windtermSkipped", { count: res.passwordsSkipped }));
    return parts.join(" · ");
  }
  if (res.skipped) parts.push(t("importModal.skipped", { count: res.skipped }));
  if (res.passwordsSkipped) parts.push(t("importModal.passwordsSkipped", { count: res.passwordsSkipped }));
  if (res.keysMissing) {
    const key = sourceType === "xshell_sessions" ? "keysMissing" : "keysMissingOther";
    parts.push(t(`importModal.${key}`, { count: res.keysMissing }));
  }
  return parts.join(" · ");
}

/** A file or folder picker on an app's card. */
interface Pick {
  sourceType: string;
  dir?: boolean;
  /** Button text under `importModal.pick`. */
  label: string;
  /** Dialog title under `importModal`. */
  title: string;
  exts?: string[];
}

interface AppCard {
  app: ImportApp;
  name: string;
  /** Discovered source types shown on this card. */
  sourceTypes: string[];
  picks: Pick[];
}

const APPS: AppCard[] = [
  {
    app: "windterm",
    name: "WindTerm",
    sourceTypes: ["windterm_sessions", "windterm_quickbar", "windterm_theme"],
    picks: [
      { sourceType: "windterm_sessions", label: "sessions", title: "browseSessions", exts: ["sessions", "json"] },
      { sourceType: "windterm_quickbar", label: "quickbar", title: "browseQuickbar", exts: ["config", "json"] },
      { sourceType: "windterm_theme", label: "theme", title: "browseTheme", exts: ["theme"] },
    ],
  },
  {
    app: "xshell",
    name: "Xshell",
    sourceTypes: ["xshell_sessions"],
    picks: [
      { sourceType: "xshell_sessions", dir: true, label: "xshellDir", title: "browseXshellDir" },
      { sourceType: "xshell_sessions", label: "xshellFile", title: "browseXshellFile", exts: ["xsh", "xts"] },
    ],
  },
  {
    app: "mobaxterm",
    name: "MobaXterm",
    sourceTypes: ["mobaxterm"],
    picks: [{ sourceType: "mobaxterm", label: "moba", title: "browseMoba", exts: ["ini", "mxtsessions"] }],
  },
  {
    app: "securecrt",
    name: "SecureCRT",
    sourceTypes: ["securecrt"],
    picks: [
      { sourceType: "securecrt", dir: true, label: "secureCrtDir", title: "browseSecureCrtDir" },
      { sourceType: "securecrt", label: "secureCrtFile", title: "browseSecureCrtFile", exts: ["xml", "ini"] },
    ],
  },
  {
    app: "finalshell",
    name: "FinalShell",
    sourceTypes: ["finalshell"],
    picks: [
      { sourceType: "finalshell", dir: true, label: "finalShellDir", title: "browseFinalShellDir" },
      { sourceType: "finalshell", label: "finalShellFile", title: "browseFinalShellFile", exts: ["json"] },
    ],
  },
  {
    app: "openssh",
    name: "OpenSSH",
    sourceTypes: ["openssh_config"],
    picks: [{ sourceType: "openssh_config", label: "ssh", title: "browseSsh" }],
  },
];

interface ImportModalProps {
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  onClose,
  onImported,
}) => {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withLogin, setWithLogin] = useState(false);
  const [master, setMaster] = useState("");
  const [importing, setImporting] = useState(false);

  const refreshCandidates = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await backend.scanImportCandidates();
      setCandidates(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshCandidates();
  }, []);

  const runImport = async (sourceType: string, path: string) => {
    if (importing) return;
    setImporting(true);
    setError(null);
    setFeedback(null);
    try {
      const password = sourceType === "windterm_sessions" && withLogin ? master : undefined;
      setMaster("");
      const res = await backend.executeImport(sourceType, path, password);
      setFeedback(importFeedback(res, sourceType, t));
      onImported(res);
    } catch (err) {
      const reason = String(err);
      const known = syncErrorKey(reason);
      setError(["windtermProfile", "windtermMasterRequired", "windtermDecryptFailed"].includes(reason)
        ? t(`importModal.${reason}`) : known ? t(known) : reason);
    } finally {
      setImporting(false);
    }
  };

  const browse = async (pick: Pick) => {
    const title = t(`importModal.${pick.title}`);
    const picked = pick.dir ? await backend.pickDirectory(title) : await backend.pickFile(title, pick.exts);
    if (picked) await runImport(pick.sourceType, picked);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-panel modal-lg import-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t("importModal.title")}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" aria-busy={importing}>
          <div className="import-grid-head">
            <span className="adv-hint">{loading ? t("importModal.scanning") : t("importModal.gridHint")}</span>
            <button type="button" className="btn-ghost btn-sm" disabled={loading} onClick={() => void refreshCandidates()}>
              <RefreshCw size={13} className={loading ? "spin" : undefined} /> {t("importModal.rescan")}
            </button>
          </div>

          {importing && <div role="status">{t("importModal.importing")}</div>}
          {feedback && (
            <div className="alert-success">
              <CheckCircle2 size={15} />
              <span>{feedback}</span>
            </div>
          )}
          {error && <div className="alert-error">{error}</div>}

          <div className="import-grid">
            {APPS.map((card) => {
              const found = candidates.filter((c) => card.sourceTypes.includes(c.sourceType));
              return (
                <section key={card.app} className={`import-card${found.length ? " is-detected" : ""}`}>
                  <header className="import-card-head">
                    <ImportSourceIcon app={card.app} />
                    <div className="import-card-title">
                      <strong>{card.name}</strong>
                      <span>{t(`importModal.desc.${card.app}`)}</span>
                    </div>
                    {found.length > 0 && <span className="import-card-badge">{t("importModal.detected")}</span>}
                  </header>

                  {found.length > 0 && (
                    <ul className="import-found">
                      {found.map((c) => (
                        <li key={`${c.sourceType}-${c.path}`} title={c.path}>
                          <div className="import-found-info">
                            <span className="import-found-kind">
                              {t(`importModal.kind.${c.sourceType}`, { defaultValue: c.label })}
                              {c.itemCount > 0 && (
                                <em>{t("importModal.itemCount", { count: c.itemCount })}</em>
                              )}
                            </span>
                            <span className="import-found-path">{c.path}</span>
                          </div>
                          <button
                            type="button"
                            className="btn-primary btn-xs"
                            disabled={importing}
                            onClick={() => void runImport(c.sourceType, c.path)}
                          >
                            <Download size={12} /> {t("importModal.importBtn")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {card.app === "windterm" && (
                    <div className="import-card-option">
                      <label className="checkbox-row"><input type="checkbox" checked={withLogin} disabled={importing} onChange={(event) => {
                        setWithLogin(event.target.checked);
                        setMaster("");
                      }} />{t("importModal.windtermLogin")}</label>
                      {withLogin && <>
                        <p className="adv-hint">{t("importModal.windtermStorage")}</p>
                        <label>{t("importModal.windtermMaster")}<input type="password" autoComplete="off" value={master}
                          disabled={importing} onChange={(event) => setMaster(event.target.value)} /></label>
                      </>}
                    </div>
                  )}

                  <div className="import-card-actions">
                    {card.picks.map((pick) => (
                      <button
                        key={pick.label}
                        type="button"
                        className="import-pick"
                        title={t(`importModal.${pick.title}`)}
                        disabled={importing}
                        onClick={() => void browse(pick)}
                      >
                        {pick.dir ? <FolderOpen size={13} /> : <FileText size={13} />}
                        <span>{t(`importModal.pick.${pick.label}`)}</span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <p className="adv-hint">{t("importModal.credentialsNote")}</p>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-primary" onClick={onClose}>
            {t("importModal.done")}
          </button>
        </div>
      </div>
    </div>
  );
};
