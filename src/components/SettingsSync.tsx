import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudCog, Download, FolderOpen, RefreshCw, Upload } from "lucide-react";
import type { AppSettings, ConfigBundleInfo, SyncCategory, SyncOutcome, SyncSettings, SyncStateInfo } from "../types/domain";
import { backend } from "../services/backend";
import { DEFAULT_SYNC_CATEGORIES, SYNC_CATEGORIES, syncOf } from "../utils/settingsDefaults";
import { exportFileName, syncErrorKey, syncReady } from "../utils/configSync";
import { confirmAsk } from "../utils/confirm";
import { NumberInput } from "./NumberInput";

type Props = {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
  saved: AppSettings;
  /** Data was written to this computer (the settings dialog closes when settings changed). */
  onApplied: (categories: SyncCategory[]) => void;
};

type Notice = { kind: "ok" | "err"; text: string } | null;

const CategoryPicker: React.FC<{ value: SyncCategory[]; onChange: (next: SyncCategory[]) => void; only?: SyncCategory[] | null }> = ({
  value,
  onChange,
  only,
}) => {
  const { t } = useTranslation();
  const list = only ? SYNC_CATEGORIES.filter((c) => only.includes(c)) : SYNC_CATEGORIES;
  return (
    <div className="sync-categories">
      {list.map((c) => (
        <label key={c} className="checkbox-row" title={t(`cfgSync.catHint.${c}`)}>
          <input
            type="checkbox"
            checked={value.includes(c)}
            onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
          />
          <span>{t(`cfgSync.cat.${c}`)}</span>
        </label>
      ))}
    </div>
  );
};

/** Settings > Sync & Backup: cloud sync target, export to / import from a file. */
export const SyncSettingsEditor: React.FC<Props> = ({ draft, onChange, saved, onApplied }) => {
  const { t, i18n } = useTranslation();
  const s = syncOf(draft);
  const set = (patch: Partial<SyncSettings>) => onChange({ ...draft, sync: { ...s, ...patch } });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState<SyncOutcome | null>(null);
  const [state, setState] = useState<SyncStateInfo | null>(null);

  const [exportCats, setExportCats] = useState<SyncCategory[]>([...DEFAULT_SYNC_CATEGORIES]);
  const [exportPassword, setExportPassword] = useState("");
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<ConfigBundleInfo | null>(null);
  const [importCats, setImportCats] = useState<SyncCategory[]>([...SYNC_CATEGORIES]);
  const [importPassword, setImportPassword] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");

  useEffect(() => {
    void backend.syncState().then(setState);
  }, []);

  const errText = (e: unknown) => {
    const key = syncErrorKey(e);
    return key ? t(key) : String(e);
  };
  const fmtTime = (v: string | number) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || !v ? "" : d.toLocaleString(i18n.language);
  };
  const describe = (info: ConfigBundleInfo | null) =>
    info
      ? t("cfgSync.fileInfo", { device: info.device || "?", time: fmtTime(info.exportedAt) || "?" }) +
        (info.encrypted ? ` · ${t("cfgSync.encrypted")}` : "")
      : t("cfgSync.remoteNone");

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setNotice({ kind: "err", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  /** Sync uses the target as typed here; keep it saved so auto sync and other windows agree. */
  const persistTarget = async () => {
    if (JSON.stringify(syncOf(saved)) === JSON.stringify(s)) return;
    await backend.saveSettings({ ...saved, sync: s });
    await backend.emitSettingsChanged();
  };

  const syncNow = (action: "auto" | "push" | "pull" | "merge") =>
    run(action, async () => {
      if ((action === "push" || action === "pull") && !(await confirmAsk(t(`cfgSync.confirm.${action}`)))) return;
      await persistTarget();
      const out = await backend.syncRun(s, action);
      setState(await backend.syncState());
      setConflict(out.result === "conflict" ? out : null);
      setNotice({ kind: out.result === "conflict" ? "err" : "ok", text: t(`cfgSync.result.${out.result}`) });
      if (out.applied.length) onApplied(out.applied);
    });

  const ready = syncReady(s);
  const disabled = busy !== null;

  return (
    <div className="settings-general">
      {/* ------------------------------------------------ cloud sync */}
      <div className="xserver-status">
        <CloudCog size={16} />
        <div>
          <b>{t("cfgSync.title")}</b>
          <div className="adv-hint">
            {state?.lastSync
              ? t("cfgSync.lastSync", { time: fmtTime(state.lastSync), result: t(`cfgSync.result.${state.lastResult}`, { defaultValue: state.lastResult }) })
              : t("cfgSync.neverSynced")}
          </div>
        </div>
      </div>
      <p className="adv-hint">{t("cfgSync.hint")}</p>

      <label className="field">
        <span>{t("cfgSync.provider")}</span>
        <select className="text-input" value={s.provider} onChange={(e) => set({ provider: e.target.value as SyncSettings["provider"] })}>
          {(["none", "s3", "webdav", "gist", "folder"] as const).map((p) => (
            <option key={p} value={p}>
              {t(`cfgSync.providers.${p}`)}
            </option>
          ))}
        </select>
      </label>

      {s.provider === "s3" && (
        <>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("cfgSync.s3.endpoint")}</span>
              <input
                className="text-input mono"
                placeholder="https://<account>.r2.cloudflarestorage.com"
                value={s.s3.endpoint}
                onChange={(e) => set({ s3: { ...s.s3, endpoint: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>{t("cfgSync.s3.region")}</span>
              <input className="text-input mono" placeholder="us-east-1 / auto" value={s.s3.region} onChange={(e) => set({ s3: { ...s.s3, region: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.s3.bucket")}</span>
              <input className="text-input mono" value={s.s3.bucket} onChange={(e) => set({ s3: { ...s.s3, bucket: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.s3.prefix")}</span>
              <input className="text-input mono" value={s.s3.prefix} onChange={(e) => set({ s3: { ...s.s3, prefix: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.s3.accessKeyId")}</span>
              <input className="text-input mono" autoComplete="off" value={s.s3.accessKeyId} onChange={(e) => set({ s3: { ...s.s3, accessKeyId: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.s3.secretAccessKey")}</span>
              <input
                className="text-input mono"
                type="password"
                autoComplete="off"
                value={s.s3.secretAccessKey}
                onChange={(e) => set({ s3: { ...s.s3, secretAccessKey: e.target.value } })}
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={s.s3.pathStyle} onChange={(e) => set({ s3: { ...s.s3, pathStyle: e.target.checked } })} />
            <span>{t("cfgSync.s3.pathStyle")}</span>
          </label>
          <p className="adv-hint">{t("cfgSync.s3.hint")}</p>
        </>
      )}

      {s.provider === "webdav" && (
        <>
          <label className="field">
            <span>{t("cfgSync.webdav.url")}</span>
            <input
              className="text-input mono"
              placeholder="https://dav.jianguoyun.com/dav/nexterm/"
              value={s.webdav.url}
              onChange={(e) => set({ webdav: { ...s.webdav, url: e.target.value } })}
            />
          </label>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("cfgSync.webdav.username")}</span>
              <input className="text-input" autoComplete="off" value={s.webdav.username} onChange={(e) => set({ webdav: { ...s.webdav, username: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.webdav.password")}</span>
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                value={s.webdav.password}
                onChange={(e) => set({ webdav: { ...s.webdav, password: e.target.value } })}
              />
            </label>
          </div>
          <p className="adv-hint">{t("cfgSync.webdav.hint")}</p>
        </>
      )}

      {s.provider === "gist" && (
        <>
          <label className="field">
            <span>{t("cfgSync.gist.token")}</span>
            <div className="sync-row">
              <input
                className="text-input mono"
                type="password"
                autoComplete="off"
                placeholder="ghp_… / github_pat_…"
                value={s.gist.token}
                onChange={(e) => set({ gist: { ...s.gist, token: e.target.value } })}
              />
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void backend.openExternal("https://github.com/settings/tokens/new?scopes=gist&description=Nexterm%20config%20sync")}
              >
                {t("cfgSync.gist.create")}
              </button>
            </div>
          </label>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("cfgSync.gist.gistId")}</span>
              <input
                className="text-input mono"
                placeholder={t("cfgSync.gist.gistIdPh")}
                value={s.gist.gistId}
                onChange={(e) => set({ gist: { ...s.gist, gistId: e.target.value.trim().split("/").pop() ?? "" } })}
              />
            </label>
            <label className="field">
              <span>{t("cfgSync.gist.apiUrl")}</span>
              <input
                className="text-input mono"
                placeholder="https://api.github.com"
                value={s.gist.apiUrl}
                onChange={(e) => set({ gist: { ...s.gist, apiUrl: e.target.value } })}
              />
            </label>
          </div>
          <p className="adv-hint">{t("cfgSync.gist.hint")}</p>
        </>
      )}

      {s.provider === "folder" && (
        <>
          <label className="field">
            <span>{t("cfgSync.folder.path")}</span>
            <div className="sync-row">
              <input className="text-input mono" value={s.folder.path} onChange={(e) => set({ folder: { path: e.target.value } })} />
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void backend.pickDirectory(t("cfgSync.folder.pick"), s.folder.path || undefined).then((p) => p && set({ folder: { path: p } }))}
              >
                <FolderOpen size={12} /> {t("cfgSync.browse")}
              </button>
            </div>
          </label>
          <p className="adv-hint">{t("cfgSync.folder.hint")}</p>
        </>
      )}

      {s.provider !== "none" && (
        <>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("cfgSync.fileName")}</span>
              <input className="text-input mono" value={s.fileName} onChange={(e) => set({ fileName: e.target.value })} />
            </label>
            <label className="field">
              <span>{t("cfgSync.password")}</span>
              <input
                className="text-input"
                type="password"
                autoComplete="new-password"
                placeholder={t("cfgSync.passwordPh")}
                value={s.password}
                onChange={(e) => set({ password: e.target.value })}
              />
            </label>
          </div>
          {!s.password && (
            <p className="adv-hint sync-warn">{t(s.categories.includes("credentials") ? "cfgSync.plainCredWarn" : "cfgSync.plainWarn")}</p>
          )}

          <div className="field">
            <span>{t("cfgSync.content")}</span>
            <CategoryPicker value={s.categories} onChange={(categories) => set({ categories })} />
          </div>

          <div className="form-grid-2">
            <label className="checkbox-row">
              <input type="checkbox" checked={s.autoSync} onChange={(e) => set({ autoSync: e.target.checked })} />
              <span>{t("cfgSync.autoSync")}</span>
            </label>
            <label className="field sync-inline">
              <span>{t("cfgSync.interval")}</span>
              <NumberInput min={0} step={5} disabled={!s.autoSync} value={s.intervalMin} onChange={(intervalMin) => set({ intervalMin })} />
            </label>
          </div>

          <div className="remote-pair-actions">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={disabled || !ready}
              onClick={() =>
                void run("test", async () => {
                  const info = await backend.syncTest(s);
                  setNotice({ kind: "ok", text: `${t("cfgSync.testOk")} ${describe(info)}` });
                })
              }
            >
              {t("cfgSync.test")}
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={disabled || !ready} onClick={() => void syncNow("auto")}>
              <RefreshCw size={12} className={busy === "auto" ? "spin" : ""} /> {t("cfgSync.syncNow")}
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={disabled || !ready} onClick={() => void syncNow("push")} title={t("cfgSync.pushTip")}>
              <Upload size={12} /> {t("cfgSync.push")}
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={disabled || !ready} onClick={() => void syncNow("pull")} title={t("cfgSync.pullTip")}>
              <Download size={12} /> {t("cfgSync.pull")}
            </button>
          </div>

          {conflict && (
            <div className="sync-conflict">
              <b>{t("cfgSync.conflictTitle")}</b>
              <div className="adv-hint">{t("cfgSync.conflictBody", { device: conflict.remoteDevice || "?", time: fmtTime(conflict.remoteTime) || "?" })}</div>
              <div className="remote-pair-actions">
                <button type="button" className="btn-primary btn-sm" disabled={disabled} onClick={() => void syncNow("merge")}>
                  {t("cfgSync.merge")}
                </button>
                <button type="button" className="btn-secondary btn-sm" disabled={disabled} onClick={() => void syncNow("push")}>
                  {t("cfgSync.keepLocal")}
                </button>
                <button type="button" className="btn-secondary btn-sm" disabled={disabled} onClick={() => void syncNow("pull")}>
                  {t("cfgSync.keepRemote")}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {notice && <div className={notice.kind === "err" ? "lock-err" : "sync-ok"}>{notice.text}</div>}

      {/* ------------------------------------------------ export / import */}
      <h4 className="sync-section">{t("cfgSync.exportTitle")}</h4>
      <CategoryPicker value={exportCats} onChange={setExportCats} />
      <div className="sync-row">
        <input
          className="text-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("cfgSync.passwordPh")}
          value={exportPassword}
          onChange={(e) => setExportPassword(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={disabled || !exportCats.length}
          onClick={() =>
            void run("export", async () => {
              const path = await backend.pickSavePath(t("cfgSync.export"), exportFileName(), [{ name: "JSON", extensions: ["json"] }]);
              if (!path) return;
              await backend.configExport(path, exportCats, exportPassword);
              setNotice({ kind: "ok", text: t("cfgSync.exported", { path }) });
            })
          }
        >
          <Upload size={12} /> {t("cfgSync.export")}
        </button>
      </div>
      {!exportPassword && (exportCats.includes("sessions") || exportCats.includes("credentials")) && (
        <p className="adv-hint sync-warn">{t(exportCats.includes("credentials") ? "cfgSync.plainCredWarn" : "cfgSync.plainWarn")}</p>
      )}

      <h4 className="sync-section">{t("cfgSync.importTitle")}</h4>
      <div className="sync-row">
        <input className="text-input mono" readOnly value={importPath ?? ""} placeholder={t("cfgSync.noFile")} />
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={disabled}
          onClick={() =>
            void run("pick", async () => {
              const path = await backend.pickFile(t("cfgSync.pickFile"), ["json"]);
              if (!path) return;
              setImportPath(path);
              setImportInfo(null);
              const info = await backend.configInspect(path);
              setImportInfo(info);
              setImportCats(info.categories ?? [...SYNC_CATEGORIES]);
            })
          }
        >
          <FolderOpen size={12} /> {t("cfgSync.browse")}
        </button>
      </div>
      {importPath && importInfo && (
        <>
          <div className="adv-hint">{describe(importInfo)}</div>
          <CategoryPicker value={importCats} onChange={setImportCats} only={importInfo.categories} />
          <div className="form-grid-2">
            <label className="field">
              <span>{t("cfgSync.importMode")}</span>
              <select className="text-input" value={importMode} onChange={(e) => setImportMode(e.target.value as "merge" | "replace")}>
                <option value="merge">{t("cfgSync.modeMerge")}</option>
                <option value="replace">{t("cfgSync.modeReplace")}</option>
              </select>
            </label>
            {importInfo.encrypted && (
              <label className="field">
                <span>{t("cfgSync.filePassword")}</span>
                <input className="text-input" type="password" autoComplete="off" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} />
              </label>
            )}
          </div>
          <div className="remote-pair-actions">
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={disabled || !importCats.length}
              onClick={() =>
                void run("import", async () => {
                  if (importMode === "replace" && !(await confirmAsk(t("cfgSync.confirm.replace")))) return;
                  const applied = await backend.configImport(importPath, importPassword, importCats, importMode);
                  setNotice({ kind: "ok", text: t("cfgSync.imported", { list: applied.map((c) => t(`cfgSync.cat.${c}`)).join(", ") || "-" }) });
                  if (applied.length) onApplied(applied);
                })
              }
            >
              <Download size={12} /> {t("cfgSync.import")}
            </button>
          </div>
        </>
      )}
      <p className="adv-hint">{t("cfgSync.backupHint")}</p>
    </div>
  );
};
