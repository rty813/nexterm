import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, FolderOpen, RefreshCw, X } from "lucide-react";
import { backend } from "../services/backend";
import type { TFunction } from "i18next";
import type { DiscoveryCandidate, ImportResult } from "../types/domain";

/** Result line: localized for the session importers that report counts, else the backend text. */
function importFeedback(res: ImportResult, sourceType: string, t: TFunction): string {
  if (sourceType !== "xshell_sessions" && sourceType !== "mobaxterm") return res.summary;
  const parts = [t("importModal.importedSessions", { count: res.sessions.length })];
  if (res.skipped) parts.push(t("importModal.skipped", { count: res.skipped }));
  if (res.passwordsSkipped) parts.push(t("importModal.passwordsSkipped", { count: res.passwordsSkipped }));
  if (res.keysMissing) parts.push(t("importModal.keysMissing", { count: res.keysMissing }));
  return parts.join(" · ");
}

/** Program each import source type comes from (shown as a tag on discovered sources). */
const SOURCE_NAME: Record<string, string> = {
  windterm_sessions: "WindTerm",
  windterm_quickbar: "WindTerm",
  windterm_theme: "WindTerm",
  xshell_sessions: "Xshell",
  mobaxterm: "MobaXterm",
  openssh_config: "OpenSSH",
};

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
    setError(null);
    setFeedback(null);
    try {
      const res = await backend.executeImport(sourceType, path);
      setFeedback(importFeedback(res, sourceType, t));
      onImported(res);
    } catch (err) {
      setError(String(err));
    }
  };

  const browseFile = async (
    sourceType:
      | "windterm_sessions"
      | "windterm_quickbar"
      | "openssh_config"
      | "windterm_theme"
  ) => {
    const title =
      sourceType === "windterm_sessions"
        ? t("importModal.browseSessions")
        : sourceType === "windterm_quickbar"
        ? t("importModal.browseQuickbar")
        : sourceType === "windterm_theme"
        ? t("importModal.browseTheme")
        : t("importModal.browseSsh");
    const exts =
      sourceType === "windterm_sessions"
        ? ["sessions", "json"]
        : sourceType === "windterm_quickbar"
        ? ["config", "json"]
        : sourceType === "windterm_theme"
        ? ["theme"]
        : undefined;

    const picked = await backend.pickFile(title, exts);
    if (picked) {
      await runImport(sourceType, picked);
    }
  };

  const browseXshellDir = async () => {
    const picked = await backend.pickDirectory(t("importModal.browseXshellDir"));
    if (picked) await runImport("xshell_sessions", picked);
  };

  const browseOther = async (sourceType: "xshell_sessions" | "mobaxterm") => {
    const xshell = sourceType === "xshell_sessions";
    const picked = await backend.pickFile(
      t(xshell ? "importModal.browseXshellFile" : "importModal.browseMoba"),
      xshell ? ["xsh", "xts"] : ["ini", "mxtsessions"],
    );
    if (picked) await runImport(sourceType, picked);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-panel modal-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t("importModal.title")}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <h4 className="section-heading">{t("importModal.manualHeading")}</h4>
          <div className="import-sources">
            <span className="import-source-name">WindTerm</span>
            <div className="import-source-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseFile("windterm_sessions")}>
                <FolderOpen size={13} /> {t("importModal.pick.sessions")}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseFile("windterm_quickbar")}>
                <FolderOpen size={13} /> {t("importModal.pick.quickbar")}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseFile("windterm_theme")}>
                <FolderOpen size={13} /> {t("importModal.pick.theme")}
              </button>
            </div>

            <span className="import-source-name">Xshell</span>
            <div className="import-source-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseXshellDir()}>
                <FolderOpen size={13} /> {t("importModal.pick.xshellDir")}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseOther("xshell_sessions")}>
                <FolderOpen size={13} /> {t("importModal.pick.xshellFile")}
              </button>
            </div>

            <span className="import-source-name">MobaXterm</span>
            <div className="import-source-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseOther("mobaxterm")}>
                <FolderOpen size={13} /> {t("importModal.pick.moba")}
              </button>
            </div>

            <span className="import-source-name">OpenSSH</span>
            <div className="import-source-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => void browseFile("openssh_config")}>
                <FolderOpen size={13} /> {t("importModal.pick.ssh")}
              </button>
            </div>
          </div>
          <p className="adv-hint">{t("importModal.credentialsNote")}</p>

          {feedback && (
            <div className="alert-success">
              <CheckCircle2 size={15} />
              <span>{feedback}</span>
            </div>
          )}

          {error && <div className="alert-error">{error}</div>}

          <div className="import-discovered-head">
            <h4 className="section-heading">{t("importModal.discoveredHeading")}</h4>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void refreshCandidates()}>
              <RefreshCw size={13} /> {t("importModal.rescan")}
            </button>
          </div>
          {loading ? (
            <div className="muted-box">{t("importModal.scanning")}</div>
          ) : candidates.length === 0 ? (
            <div className="muted-box">{t("importModal.empty")}</div>
          ) : (
            <div className="candidate-list">
              {candidates.map((c) => (
                <div key={`${c.sourceType}-${c.path}`} className="candidate-row">
                  <div className="candidate-info">
                    <strong>
                      <span className="import-source-tag">{SOURCE_NAME[c.sourceType] ?? c.sourceType}</span>
                      {t(`importModal.kind.${c.sourceType}`, { defaultValue: c.label })}
                    </strong>
                    <span className="candidate-path">{c.path}</span>
                  </div>
                  <div className="candidate-right">
                    <span className="folder-badge">
                      {t("importModal.itemCount", { count: c.itemCount })}
                    </span>
                    <button
                      type="button"
                      className="btn-primary btn-xs"
                      onClick={() => void runImport(c.sourceType, c.path)}
                    >
                      <Download size={12} /> {t("importModal.importBtn")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
