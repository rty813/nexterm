import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Unlock } from "lucide-react";

interface LockOverlayProps {
  expectedPasscode?: string | null;
  onUnlock: () => void;
}

export const LockOverlay: React.FC<LockOverlayProps> = ({
  expectedPasscode,
  onUnlock,
}) => {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!expectedPasscode || code === expectedPasscode) {
      onUnlock();
    } else {
      setError(true);
      setCode("");
    }
  };

  return (
    <div className="lock-overlay">
      <form className="lock-card" onSubmit={handleSubmit}>
        <Lock size={32} className="lock-icon" />
        <h3>{t("lock.title")}</h3>
        <p>{t("lock.desc")}</p>
        {expectedPasscode && (
          <input
            type="password"
            autoFocus
            className="text-input"
            placeholder={t("lock.placeholder")}
            value={code}
            onChange={(e) => {
              setError(false);
              setCode(e.target.value);
            }}
          />
        )}
        {error && <span className="lock-err">{t("lock.wrongCode")}</span>}
        <button type="submit" className="btn-primary btn-block">
          <Unlock size={14} /> {t("lock.unlockBtn")}
        </button>
      </form>
    </div>
  );
};
