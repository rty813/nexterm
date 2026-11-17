import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, HardDrive } from "lucide-react";
import type { StorageLocationInfo, StorageMode } from "../types/domain";
import { backend } from "../services/backend";
import { commandHistory } from "../utils/commandHistory";

type Choice = { mode: StorageMode; customPath: string; askAtStartup: boolean; migrate: boolean };

const choiceOf = (info: StorageLocationInfo): Choice => ({
  mode: info.mode,
  customPath: info.customPath,
  askAtStartup: info.askAtStartup,
  migrate: true,
});

/** WindTerm's profiles directory choice: program folder, user folder or a chosen one. */
const StorageForm: React.FC<{ info: StorageLocationInfo; value: Choice; onChange: (c: Choice) => void }> = ({ info, value, onChange }) => {
  const { t } = useTranslation();
  const set = (patch: Partial<Choice>) => onChange({ ...value, ...patch });
  const option = (mode: StorageMode, label: string, hint: string, path: React.ReactNode, disabled = false) => (
    <label className={`storage-option ${value.mode === mode ? "active" : ""} ${disabled ? "disabled" : ""}`}>
      <input type="radio" name="storage-mode" checked={value.mode === mode} disabled={disabled} onChange={() => set({ mode })} />
      <div>
        <b>{label}</b>
        <div className="adv-hint">{hint}</div>
        {path}
      </div>
    </label>
  );
  return (
    <div className="storage-form">
      {option(
        "app",
        t("storageLoc.app"),
        info.appDirWritable ? t("storageLoc.appHint") : t("storageLoc.appReadonly"),
        <div className="adv-hint mono">{info.appDir}</div>,
        !info.appDirWritable && info.mode !== "app",
      )}
      {option("user", t("storageLoc.user"), t("storageLoc.userHint"), <div className="adv-hint mono">{info.userDir}</div>)}
      {option(
        "custom",
        t("storageLoc.custom"),
        t("storageLoc.customHint"),
        <div className="input-with-btn">
          <input
            type="text"
            className="text-input mono"
            placeholder={t("storageLoc.customPh")}
            value={value.customPath}
            onFocus={() => set({ mode: "custom" })}
            onChange={(e) => set({ mode: "custom", customPath: e.target.value })}
          />
          <button
            type="button"
            className="icon-btn"
            title={t("storageLoc.browse")}
            onClick={async () => {
              const dir = await backend.pickDirectory(t("storageLoc.browse"), value.customPath || info.currentDir);
              if (dir) set({ mode: "custom", customPath: dir });
            }}
          >
            <FolderOpen size={14} />
          </button>
        </div>,
      )}
      <label className="checkbox-row">
        <input type="checkbox" checked={value.migrate} onChange={(e) => set({ migrate: e.target.checked })} />
        <span>{t("storageLoc.migrate")}</span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={value.askAtStartup} onChange={(e) => set({ askAtStartup: e.target.checked })} />
        <span>{t("storageLoc.askAtStartup")}</span>
      </label>
    </div>
  );
};

async function applyChoice(c: Choice) {
  // Copying the folder must include the history still held in memory.
  commandHistory.flush();
  return backend.setStorageLocation(c.mode, c.mode === "custom" ? c.customPath.trim() : "", c.askAtStartup, c.migrate);
}

async function restart() {
  commandHistory.flush();
  await backend.restartApp();
}

/** Settings > Startup: where the configuration is stored; a change restarts the app. */
export const StorageLocationSettings: React.FC = () => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<StorageLocationInfo | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    void backend.storageLocationInfo().then((i) => {
      setInfo(i);
      if (i) setChoice(choiceOf(i));
    });
  }, []);

  if (!info || !choice) return null;
  return (
    <>
      <h4 className="section-heading">{t("storageLoc.section")}</h4>
      <div className="adv-hint mono storage-current">{t("storageLoc.current", { dir: info.currentDir })}</div>
      {info.fallbackError && <div className="lock-err">{t("storageLoc.fallback", { error: info.fallbackError })}</div>}
      <StorageForm
        info={info}
        value={choice}
        onChange={(c) => {
          setChoice(c);
          setMessage(null);
          setError(null);
        }}
      />
      <div className="settings-inline">
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy}
          onClick={async () => {
            if (choice.mode === "custom" && !choice.customPath.trim()) {
              setError(t("storageLoc.needPath"));
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const out = await applyChoice(choice);
              setNeedsRestart(out.restartRequired);
              setMessage(out.restartRequired ? (out.keptExisting ? `${t("storageLoc.restartMessage")} ${t("storageLoc.keptExisting")}` : t("storageLoc.restartMessage")) : t("storageLoc.saved"));
            } catch (e) {
              setError(t("storageLoc.failed", { error: String(e) }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("storageLoc.apply")}
        </button>
        {needsRestart && (
          <button type="button" className="btn-primary btn-sm" onClick={() => void restart()}>
            {t("storageLoc.restartNow")}
          </button>
        )}
      </div>
      {message && <p className="adv-hint">{message}</p>}
      {error && <div className="lock-err">{error}</div>}
      <p className="adv-hint">{t("storageLoc.note")}</p>
    </>
  );
};

/** Asked at startup: on a first run, with "ask at every startup", or when the saved folder failed. */
export const StorageLocationPrompt: React.FC<{ info: StorageLocationInfo; onClose: () => void }> = ({ info, onClose }) => {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<Choice>(() => choiceOf(info));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (choice.mode === "custom" && !choice.customPath.trim()) {
      setError(t("storageLoc.needPath"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await applyChoice(choice);
      if (out.restartRequired) await restart();
      else onClose();
    } catch (e) {
      setError(t("storageLoc.failed", { error: String(e) }));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-panel confirm-panel wide">
        <div className="modal-header">
          <h3>
            <HardDrive size={16} /> {t("storageLoc.title")}
          </h3>
        </div>
        <div className="modal-body">
          <p className="confirm-message">{t("storageLoc.intro")}</p>
          {info.fallbackError && <div className="lock-err">{t("storageLoc.fallback", { error: info.fallbackError })}</div>}
          <StorageForm info={info} value={choice} onChange={setChoice} />
          {error && <div className="lock-err">{error}</div>}
        </div>
        <div className="modal-footer">
          {!info.firstRun && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
              {t("storageLoc.useCurrent")}
            </button>
          )}
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
            {t("storageLoc.ok")}
          </button>
        </div>
      </div>
    </div>
  );
};
