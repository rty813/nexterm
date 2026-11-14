import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, FolderOpen, RefreshCw, X } from "lucide-react";
import { backend } from "../services/backend";
import type { DiscoveryCandidate, ImportResult } from "../types/domain";

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
      setFeedback(res.summary);
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
          <div className="import-manual-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void browseFile("windterm_sessions")}
            >
              <FolderOpen size={14} /> {t("importModal.browseSessions")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void browseFile("windterm_quickbar")}
            >
              <FolderOpen size={14} /> {t("importModal.browseQuickbar")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void browseFile("openssh_config")}
            >
              <FolderOpen size={14} /> {t("importModal.browseSsh")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void browseFile("windterm_theme")}
            >
              <FolderOpen size={14} /> {t("importModal.browseTheme")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void refreshCandidates()}
            >
              <RefreshCw size={13} /> {t("importModal.rescan")}
            </button>
          </div>

          {feedback && (
            <div className="alert-success">
              <CheckCircle2 size={15} />
              <span>{feedback}</span>
            </div>
          )}

          {error && <div className="alert-error">{error}</div>}

          <h4 className="section-heading">
            {t("importModal.discoveredHeading")}
          </h4>
          {loading ? (
            <div className="muted-box">{t("importModal.scanning")}</div>
          ) : candidates.length === 0 ? (
            <div className="muted-box">{t("importModal.empty")}</div>
          ) : (
            <div className="candidate-list">
              {candidates.map((c) => (
                <div key={`${c.sourceType}-${c.path}`} className="candidate-row">
                  <div className="candidate-info">
                    <strong>{c.label}</strong>
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
