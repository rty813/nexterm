import React from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import type { UpdateProgress } from "../types/domain";
import { formatUpdateSize, updatePercent } from "../utils/updateCheck";

/** Bottom-right card while an update downloads: version, progress bar, size and Cancel. */
export const UpdateProgressCard: React.FC<{ version: string; progress: UpdateProgress; onCancel: () => void }> = ({
  version,
  progress,
  onCancel,
}) => {
  const { t } = useTranslation();
  const pct = updatePercent(progress);
  return (
    <div className="update-progress-card" role="status" aria-live="polite">
      <div className="update-progress-head">
        <Download size={14} />
        <span className="update-progress-title">{t("update.downloadingTitle", { version })}</span>
      </div>
      <div
        className={`update-progress-track${pct === null ? " indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div className="update-progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="update-progress-foot">
        <span>
          {pct !== null && `${pct}% · `}
          {formatUpdateSize(progress)}
        </span>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t("update.cancel")}
        </button>
      </div>
    </div>
  );
};
