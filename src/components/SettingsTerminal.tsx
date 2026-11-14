import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Monitor, Play, Square } from "lucide-react";
import type { AppSettings, ClipboardPermission, MouseSettings, SessionConfig, TabMouseAction } from "../types/domain";
import { backend, type XServerStatus } from "../services/backend";
import { autoCompleteOf, historyOf, modemOf, mouseOf, sftpOf, xserverOf } from "../utils/settingsDefaults";
import { commandHistory } from "../utils/commandHistory";

type Props = { draft: AppSettings; onChange: (next: AppSettings) => void };

const Check: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <label className="checkbox-row">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);

const Num: React.FC<{ value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; step?: number; disabled?: boolean }> = ({
  value,
  onChange,
  label,
  min = 0,
  max,
  step = 1,
  disabled,
}) => (
  <label className="field">
    <span>{label}</span>
    <input
      type="number"
      className="text-input"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : min);
      }}
    />
  </label>
);

/** Settings > Terminal: confirmations, history, completion, folding, display details, startup. */
export const TerminalSettings: React.FC<Props & { sessions: SessionConfig[] }> = ({ draft, onChange, sessions }) => {
  const { t } = useTranslation();
  const history = historyOf(draft);
  const ac = autoCompleteOf(draft);
  const set = (patch: Partial<AppSettings>) => onChange({ ...draft, ...patch });
  const setAc = (patch: Partial<typeof ac>) => set({ autoComplete: { ...ac, ...patch } });
  const ids = new Set(draft.startupSessionIds ?? []);

  return (
    <div className="settings-general">
      <h4 className="section-heading">{t("st.confirm")}</h4>
      <div className="form-grid-2">
        <Check checked={draft.askBeforeCloseTab !== false} onChange={(v) => set({ askBeforeCloseTab: v })} label={t("st.askCloseTab")} />
        <Check checked={draft.askBeforeCloseWindow !== false} onChange={(v) => set({ askBeforeCloseWindow: v })} label={t("st.askCloseWindow")} />
        <Check checked={draft.pasteConfirm !== false} onChange={(v) => set({ pasteConfirm: v })} label={t("st.pasteConfirm")} />
        <Check checked={draft.pasteConfirmAltScreen === true} onChange={(v) => set({ pasteConfirmAltScreen: v })} label={t("st.pasteConfirmAlt")} />
      </div>

      <h4 className="section-heading">{t("st.history")}</h4>
      <div className="form-grid-3">
        <Check checked={history.enabled} onChange={(v) => set({ history: { ...history, enabled: v } })} label={t("st.historyOn")} />
        <Num label={t("st.historyDays")} value={history.days} min={0} max={3650} disabled={!history.enabled} onChange={(v) => set({ history: { ...history, days: v } })} />
        <Num label={t("st.historySize")} value={history.size} min={100} max={100000} step={100} disabled={!history.enabled} onChange={(v) => set({ history: { ...history, size: v } })} />
      </div>
      <Check
        checked={history.perSession}
        disabled={!history.enabled}
        onChange={(v) => set({ history: { ...history, perSession: v } })}
        label={t("st.historyPerSession")}
      />
      <div className="settings-inline">
        <span className="adv-hint">{t("st.historyCount", { count: commandHistory.all().length })}</span>
        <button type="button" className="btn-ghost btn-sm" onClick={() => window.confirm(t("history.clearConfirm")) && commandHistory.clear()}>
          {t("history.clear")}
        </button>
      </div>

      <h4 className="section-heading">{t("st.autoComplete")}</h4>
      <div className="form-grid-3">
        <Check checked={ac.enabled} onChange={(v) => setAc({ enabled: v })} label={t("st.acOn")} />
        <Num label={t("st.acThreshold")} value={ac.threshold} min={1} max={10} disabled={!ac.enabled} onChange={(v) => setAc({ threshold: v })} />
        <Num label={t("st.acRows")} value={ac.visibleRows} min={3} max={20} disabled={!ac.enabled} onChange={(v) => setAc({ visibleRows: v })} />
      </div>
      <div className="form-grid-3">
        <Check checked={ac.history} disabled={!ac.enabled} onChange={(v) => setAc({ history: v })} label={t("st.acHistory")} />
        <Check checked={ac.quickCommands} disabled={!ac.enabled} onChange={(v) => setAc({ quickCommands: v })} label={t("st.acQuick")} />
        <Check checked={ac.commandNames} disabled={!ac.enabled} onChange={(v) => setAc({ commandNames: v })} label={t("st.acNames")} />
        <Check checked={ac.commandOptions} disabled={!ac.enabled} onChange={(v) => setAc({ commandOptions: v })} label={t("st.acOptions")} />
        <Check checked={ac.preselect} disabled={!ac.enabled} onChange={(v) => setAc({ preselect: v })} label={t("st.acPreselect")} />
      </div>
      <p className="adv-hint">{t("st.acHint")}</p>

      <h4 className="section-heading">{t("st.display")}</h4>
      <div className="form-grid-2">
        <Check checked={draft.foldMargin !== false} onChange={(v) => set({ foldMargin: v })} label={t("st.foldMargin")} />
        <Check checked={Boolean(draft.showWrapMarks)} onChange={(v) => set({ showWrapMarks: v })} label={t("st.wrapMarks")} />
        <Check checked={Boolean(draft.alternateRowColors)} onChange={(v) => set({ alternateRowColors: v })} label={t("st.altRows")} />
        <label className="field">
          <span>{t("st.whitespace")}</span>
          <select className="text-input" value={draft.showWhitespace ?? "none"} onChange={(e) => set({ showWhitespace: e.target.value as AppSettings["showWhitespace"] })}>
            <option value="none">{t("st.wsNone")}</option>
            <option value="all">{t("st.wsAll")}</option>
            <option value="leading">{t("st.wsLeading")}</option>
            <option value="trailing">{t("st.wsTrailing")}</option>
          </select>
        </label>
      </div>

      <h4 className="section-heading">{t("st.clipboard")}</h4>
      <div className="form-grid-2">
        <Check checked={Boolean(draft.copyOnSelect)} onChange={(v) => set({ copyOnSelect: v })} label={t("settingsModal.copyOnSelect")} />
        <span />
        <PermissionSelect label={t("st.remoteWrite")} value={draft.remoteClipboardWrite ?? "allow"} onChange={(v) => set({ remoteClipboardWrite: v })} />
        <PermissionSelect label={t("st.remoteRead")} value={draft.remoteClipboardRead ?? "ask"} onChange={(v) => set({ remoteClipboardRead: v })} />
      </div>
      <p className="adv-hint">{t("st.clipboardHint")}</p>

      <h4 className="section-heading">{t("st.startup")}</h4>
      <div className="form-grid-2">
        <label className="field">
          <span>{t("st.startupSessions")}</span>
          <select className="text-input" value={draft.startupSessions ?? "none"} onChange={(e) => set({ startupSessions: e.target.value as AppSettings["startupSessions"] })}>
            <option value="none">{t("st.startupNone")}</option>
            <option value="last">{t("st.startupLast")}</option>
            <option value="selected">{t("st.startupSelected")}</option>
          </select>
        </label>
        <Num
          label={t("st.lockTimeout")}
          value={draft.lockScreenTimeout ?? 0}
          min={0}
          max={1440}
          onChange={(v) => set({ lockScreenTimeout: v })}
        />
      </div>
      {draft.startupSessions === "selected" && (
        <div className="startup-list">
          {sessions.length === 0 && <span className="adv-hint">{t("st.noSessions")}</span>}
          {sessions.map((x) => (
            <label key={x.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={ids.has(x.id)}
                onChange={(e) => {
                  const next = (draft.startupSessionIds ?? []).filter((id) => id !== x.id);
                  if (e.target.checked) next.push(x.id);
                  set({ startupSessionIds: next });
                }}
              />
              <span>
                {x.group ? `${x.group} › ` : ""}
                {x.label}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="adv-hint">{t("st.lockHint")}</p>

      <h4 className="section-heading">{t("st.ssh")}</h4>
      <Check checked={draft.reuseSshConnection !== false} onChange={(v) => set({ reuseSshConnection: v })} label={t("st.reuseSsh")} />
      <p className="adv-hint">{t("st.reuseSshHint")}</p>
    </div>
  );
};

const PermissionSelect: React.FC<{ label: string; value: ClipboardPermission; onChange: (v: ClipboardPermission) => void }> = ({ label, value, onChange }) => {
  const { t } = useTranslation();
  return (
    <label className="field">
      <span>{label}</span>
      <select className="text-input" value={value} onChange={(e) => onChange(e.target.value as ClipboardPermission)}>
        <option value="allow">{t("st.permAllow")}</option>
        <option value="ask">{t("st.permAsk")}</option>
        <option value="deny">{t("st.permDeny")}</option>
      </select>
    </label>
  );
};

/** Settings > Mouse: clicks, wheel, mouse tracking, tab bar clicks. */
export const MouseSettingsEditor: React.FC<Props> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const m = mouseOf(draft);
  const set = (patch: Partial<MouseSettings>) => onChange({ ...draft, mouse: { ...m, ...patch }, rightClickAction: undefined });
  const setTrack = (patch: Partial<MouseSettings["tracking"]>) => set({ tracking: { ...m.tracking, ...patch } });
  const tabOptions: TabMouseAction[] = ["close", "rename", "duplicate", "reconnect", "none"];

  return (
    <div className="settings-general">
      <h4 className="section-heading">{t("mouse.terminal")}</h4>
      <div className="form-grid-3">
        <label className="field">
          <span>{t("mouse.right")}</span>
          <select className="text-input" value={m.rightClick} onChange={(e) => set({ rightClick: e.target.value as MouseSettings["rightClick"] })}>
            <option value="menu">{t("mouse.rightMenu")}</option>
            <option value="paste">{t("mouse.rightPaste")}</option>
            <option value="copyPaste">{t("mouse.rightCopyPaste")}</option>
            <option value="none">{t("mouse.none")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("mouse.middle")}</span>
          <select className="text-input" value={m.middleClick} onChange={(e) => set({ middleClick: e.target.value as MouseSettings["middleClick"] })}>
            <option value="paste">{t("mouse.middlePaste")}</option>
            <option value="pasteSelection">{t("mouse.middleSelection")}</option>
            <option value="menu">{t("mouse.rightMenu")}</option>
            <option value="none">{t("mouse.none")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("mouse.double")}</span>
          <select className="text-input" value={m.doubleClick} onChange={(e) => set({ doubleClick: e.target.value as MouseSettings["doubleClick"] })}>
            <option value="word">{t("mouse.doubleWord")}</option>
            <option value="wordCopy">{t("mouse.doubleWordCopy")}</option>
            <option value="line">{t("mouse.doubleLine")}</option>
            <option value="none">{t("mouse.none")}</option>
          </select>
        </label>
      </div>
      <p className="adv-hint">{t("mouse.shiftHint")}</p>
      <div className="form-grid-2">
        <Num
          label={t("settingsModal.wheelLines")}
          value={draft.wheelScrollLines ?? 3}
          min={1}
          max={20}
          onChange={(v) => onChange({ ...draft, wheelScrollLines: v })}
        />
        <Check checked={m.ctrlWheelZoom} onChange={(v) => set({ ctrlWheelZoom: v })} label={t("mouse.ctrlWheel")} />
      </div>
      <label className="field">
        <span>{t("settingsModal.wordSeparators")}</span>
        <input
          type="text"
          className="text-input mono"
          placeholder={" ()[]{}',\";:<>|"}
          value={draft.wordSeparators ?? ""}
          onChange={(e) => onChange({ ...draft, wordSeparators: e.target.value })}
        />
      </label>

      <h4 className="section-heading">{t("mouse.tracking")}</h4>
      <p className="adv-hint">{t("mouse.trackingHint")}</p>
      <div className="form-grid-3">
        <Check checked={m.tracking.click} onChange={(v) => setTrack({ click: v })} label={t("mouse.tClick")} />
        <Check checked={m.tracking.doubleClick} onChange={(v) => setTrack({ doubleClick: v })} label={t("mouse.tDouble")} />
        <Check checked={m.tracking.middleClick} onChange={(v) => setTrack({ middleClick: v })} label={t("mouse.tMiddle")} />
        <Check checked={m.tracking.rightClick} onChange={(v) => setTrack({ rightClick: v })} label={t("mouse.tRight")} />
        <Check checked={m.tracking.move} onChange={(v) => setTrack({ move: v })} label={t("mouse.tMove")} />
        <Check checked={m.tracking.wheel} onChange={(v) => setTrack({ wheel: v })} label={t("mouse.tWheel")} />
      </div>

      <h4 className="section-heading">{t("mouse.tabbar")}</h4>
      <div className="form-grid-2">
        {(["tabDoubleClick", "tabMiddleClick"] as const).map((key) => (
          <label key={key} className="field">
            <span>{t(`mouse.${key}`)}</span>
            <select
              className="text-input"
              value={draft[key] ?? (key === "tabDoubleClick" ? "close" : "rename")}
              onChange={(e) => onChange({ ...draft, [key]: e.target.value as TabMouseAction })}
            >
              {tabOptions.map((o) => (
                <option key={o} value={o}>
                  {t(`mouse.tab.${o}`)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <Check
        checked={draft.tabHoverSwitch ?? true}
        onChange={(v) => onChange({ ...draft, tabHoverSwitch: v })}
        label={t("mouse.tabHoverSwitch")}
      />
    </div>
  );
};

/** Settings > Logs & Transfers: log options and X / Y / ZModem. */
export const LogTransferSettings: React.FC<Props> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const modem = modemOf(draft);
  const set = (patch: Partial<AppSettings>) => onChange({ ...draft, ...patch });
  const setModem = (patch: Partial<typeof modem>) => set({ modem: { ...modem, ...patch } });
  const sftp = sftpOf(draft);
  const setSftp = (patch: Partial<typeof sftp>) => set({ sftp: { ...sftp, ...patch } });

  return (
    <div className="settings-general">
      <h4 className="section-heading">{t("lg.section")}</h4>
      <div className="form-grid-2">
        <label className="field">
          <span>{t("settingsModal.logDir")}</span>
          <div className="input-with-btn">
            <input
              type="text"
              className="text-input"
              placeholder={t("settingsModal.logDirPlaceholder")}
              value={draft.logDir ?? ""}
              onChange={(e) => set({ logDir: e.target.value || null })}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={async () => {
                const dir = await backend.pickDirectory(t("settingsModal.logDir"));
                if (dir) set({ logDir: dir });
              }}
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </label>
        <label className="field">
          <span>{t("settingsModal.logFilePattern")}</span>
          <input type="text" className="text-input mono" value={draft.logFilePattern ?? ""} onChange={(e) => set({ logFilePattern: e.target.value })} />
        </label>
      </div>
      <p className="adv-hint">{t("lg.patternHint")}</p>
      <div className="form-grid-3">
        <label className="field">
          <span>{t("lg.type")}</span>
          <select className="text-input" value={draft.logType ?? "text"} onChange={(e) => set({ logType: e.target.value as "text" | "raw" })}>
            <option value="text">{t("lg.typeText")}</option>
            <option value="raw">{t("lg.typeRaw")}</option>
          </select>
        </label>
        <Num label={t("lg.maxSize")} value={draft.logMaxSizeMb ?? 0} min={0} max={10240} onChange={(v) => set({ logMaxSizeMb: v })} />
        <Check checked={draft.logTimestamp !== false} disabled={draft.logType === "raw"} onChange={(v) => set({ logTimestamp: v })} label={t("settingsModal.logTimestamp")} />
      </div>
      <label className="field">
        <span>{t("lg.linePattern")}</span>
        <input
          type="text"
          className="text-input mono"
          disabled={draft.logType === "raw" || draft.logTimestamp === false}
          placeholder="[%Y-%m-%d %H:%M:%S] %v"
          value={draft.logLinePattern ?? ""}
          onChange={(e) => set({ logLinePattern: e.target.value })}
        />
      </label>
      <p className="adv-hint">{t("lg.lineHint")}</p>

      <h4 className="section-heading">{t("modem.section")}</h4>
      <label className="field">
        <span>{t("settingsModal.zmodemDir")}</span>
        <input
          type="text"
          className="text-input"
          placeholder={t("zmodem.defaultDir")}
          value={draft.zmodemDownloadDir ?? ""}
          onChange={(e) => set({ zmodemDownloadDir: e.target.value })}
        />
      </label>
      <div className="form-grid-3">
        <label className="field">
          <span>{t("modem.zCmd")}</span>
          <input className="text-input mono" value={modem.zmodemUploadCommand} onChange={(e) => setModem({ zmodemUploadCommand: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("modem.xCmd")}</span>
          <input className="text-input mono" value={modem.xmodemUploadCommand} onChange={(e) => setModem({ xmodemUploadCommand: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("modem.yCmd")}</span>
          <input className="text-input mono" value={modem.ymodemUploadCommand} onChange={(e) => setModem({ ymodemUploadCommand: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("modem.xPacket")}</span>
          <select className="text-input" value={modem.xmodemPacket} onChange={(e) => setModem({ xmodemPacket: Number(e.target.value) as 128 | 1024 })}>
            <option value={128}>128 B</option>
            <option value={1024}>1 KB (XMODEM-1K)</option>
          </select>
        </label>
        <label className="field">
          <span>{t("modem.yPacket")}</span>
          <select className="text-input" value={modem.ymodemPacket} onChange={(e) => setModem({ ymodemPacket: Number(e.target.value) as 128 | 1024 })}>
            <option value={1024}>1 KB</option>
            <option value={128}>128 B</option>
          </select>
        </label>
      </div>
      <p className="adv-hint">{t("modem.hint")}</p>

      <h4 className="section-heading">{t("sftp.settingsTitle")}</h4>
      <div className="form-grid-3">
        <label className="field">
          <span>{t("sftp.concurrency")}</span>
          <input
            type="number"
            min={1}
            max={16}
            className="text-input"
            value={sftp.concurrency}
            onChange={(e) => setSftp({ concurrency: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="field">
          <span>{t("sftp.conflictTitle")}</span>
          <select className="text-input" value={sftp.conflict} onChange={(e) => setSftp({ conflict: e.target.value as typeof sftp.conflict })}>
            {(["ask", "overwrite", "newer", "rename", "skip"] as const).map((v) => (
              <option key={v} value={v}>
                {t(`sftp.conflict.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("sftp.protocol")}</span>
          <select className="text-input" value={sftp.protocol} onChange={(e) => setSftp({ protocol: e.target.value as typeof sftp.protocol })}>
            {(["auto", "sftp", "scp"] as const).map((v) => (
              <option key={v} value={v}>
                {t(`sftp.protocolOpt.${v}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={sftp.preserveTimes} onChange={(e) => setSftp({ preserveTimes: e.target.checked })} />
        <span>{t("sftp.preserveTimes")}</span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={sftp.followCwd} onChange={(e) => setSftp({ followCwd: e.target.checked })} />
        <span>{t("sftp.followCwd")}</span>
      </label>
      <label className="field">
        <span>{t("sftp.downloadDir")}</span>
        <input
          type="text"
          className="text-input"
          placeholder={t("sftp.downloadDirHint")}
          value={sftp.downloadDir}
          onChange={(e) => setSftp({ downloadDir: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{t("sftp.editor")}</span>
        <input type="text" className="text-input mono" value={sftp.editor} onChange={(e) => setSftp({ editor: e.target.value })} />
      </label>
      <p className="adv-hint">{t("sftp.editorHint")}</p>
    </div>
  );
};

/** Settings > X Server: the bundled VcXsrv used for SSH X11 forwarding. */
export const XServerSettingsEditor: React.FC<Props> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const x = xserverOf(draft);
  const set = (patch: Partial<typeof x>) => onChange({ ...draft, xserver: { ...x, ...patch } });
  const [status, setStatus] = useState<XServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void backend.xserverStatus().then(setStatus);
    const un = backend.onXServerState(setStatus);
    return () => void un.then((f) => f());
  }, []);

  return (
    <div className="settings-general">
      <div className={`xserver-status ${status?.running ? "on" : ""}`}>
        <Monitor size={16} />
        <div>
          <b>{status?.running ? t("xs.running", { display: status.display ?? 0 }) : t("xs.stopped")}</b>
          <div className="adv-hint mono">{status?.executable ?? t("xs.notFound")}</div>
          {(error || status?.message) && <div className="lock-err">{error || status?.message}</div>}
        </div>
        <div className="xserver-actions">
          {status?.running ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => void backend.xserverStop().then(setStatus)}>
              <Square size={12} /> {t("xs.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={busy || !status?.executable}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setStatus(await backend.xserverStart());
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Play size={12} /> {t("xs.start")}
            </button>
          )}
        </div>
      </div>
      <p className="adv-hint">{t("xs.hint")}</p>
      <div className="form-grid-2">
        <Check checked={x.enabled} onChange={(v) => set({ enabled: v })} label={t("xs.enabled")} />
        <Check checked={x.autoStart} onChange={(v) => set({ autoStart: v })} label={t("xs.autoStart")} />
      </div>
      <label className="field">
        <span>{t("xs.path")}</span>
        <div className="input-with-btn">
          <input className="text-input mono" placeholder={t("xs.pathPh")} value={x.path} onChange={(e) => set({ path: e.target.value })} />
          <button
            type="button"
            className="icon-btn"
            onClick={async () => {
              const f = await backend.pickFile("vcxsrv.exe", ["exe"]);
              if (f) set({ path: f });
            }}
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </label>
      <div className="form-grid-3">
        <label className="field">
          <span>{t("xs.display")}</span>
          <input
            type="number"
            className="text-input"
            min={-1}
            max={63}
            value={x.display}
            onChange={(e) => set({ display: Math.max(-1, Math.min(63, Math.floor(Number(e.target.value) || 0))) })}
          />
        </label>
        <label className="field">
          <span>{t("xs.mode")}</span>
          <select className="text-input" value={x.windowMode} onChange={(e) => set({ windowMode: e.target.value as typeof x.windowMode })}>
            <option value="multiwindow">{t("xs.multi")}</option>
            <option value="rootless">{t("xs.rootless")}</option>
            <option value="windowed">{t("xs.windowed")}</option>
            <option value="fullscreen">{t("xs.fullscreen")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("xs.layout")}</span>
          <input className="text-input mono" value={x.xkbLayout} placeholder="auto" onChange={(e) => set({ xkbLayout: e.target.value })} />
        </label>
      </div>
      <div className="form-grid-3">
        <Check checked={x.clipboard} onChange={(v) => set({ clipboard: v })} label={t("xs.clipboard")} />
        <Check checked={x.primarySelection} onChange={(v) => set({ primarySelection: v })} label={t("xs.primary")} />
        <Check checked={x.keyhook} onChange={(v) => set({ keyhook: v })} label={t("xs.keyhook")} />
        <Check checked={x.trayIcon} onChange={(v) => set({ trayIcon: v })} label={t("xs.tray")} />
        <Check checked={x.disableAccessControl} onChange={(v) => set({ disableAccessControl: v })} label={t("xs.noAccessControl")} />
      </div>
      <label className="field">
        <span>{t("xs.extra")}</span>
        <input className="text-input mono" value={x.extraArgs} placeholder="-dpi auto" onChange={(e) => set({ extraArgs: e.target.value })} />
      </label>
    </div>
  );
};
