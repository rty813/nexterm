import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { anyInstalled, posixHookCommand, type HookStatus } from "../utils/agentHooks";
import { useTranslation } from "react-i18next";
import { backend } from "../services/backend";
import { Globe, Highlighter, Keyboard, Monitor, Mouse, PanelTop, Puzzle, RefreshCw, ScrollText, Settings2, TerminalSquare, X, Zap } from "lucide-react";
import type { AppSettings, SessionConfig, SyncCategory, ThemeDefinition, UpdateInfo } from "../types/domain";
import { LogTransferSettings, MouseSettingsEditor, TerminalSettings, XServerSettingsEditor } from "./SettingsTerminal";

import { PluginManager } from "./StatusPlugins";
export type SettingsTab = "general" | "terminal" | "mouse" | "logs" | "xserver" | "remote" | "sync" | "highlight" | "triggers" | "keys" | "toolbar" | "plugins";
import { KeymapEditor, ToolbarEditor } from "./SettingsExtra";
import { HighlightEditor } from "./HighlightEditor";
import { TriggerEditor } from "./TriggerEditor";
import { RemoteSettingsEditor } from "./SettingsRemote";
import { SyncSettingsEditor } from "./SettingsSync";
import { useCloseGuard } from "./useCloseGuard";
import { FontFamilyField } from "./FontFamilyField";

const settingsSections = [
  { id: "general", icon: Settings2 },
  { id: "terminal", icon: TerminalSquare },
  { id: "mouse", icon: Mouse },
  { id: "logs", icon: ScrollText },
  { id: "xserver", icon: Monitor },
  { id: "remote", icon: Globe },
  { id: "sync", icon: RefreshCw },
  { id: "highlight", icon: Highlighter },
  { id: "triggers", icon: Zap },
  { id: "keys", icon: Keyboard },
  { id: "toolbar", icon: PanelTop },
  { id: "plugins", icon: Puzzle },
] as const;

interface SettingsModalProps {
  settings: AppSettings;
  themes: ThemeDefinition[];
  onClose: () => void;
  onSave: (next: AppSettings) => void;
  /** Open on a given tab (e.g. "toolbar" from the toolbar's context menu). */
  initialTab?: SettingsTab;
  navigationVersion?: number;
  /** Saved sessions, for "open at startup". */
  sessions?: SessionConfig[];
  /** Install / remove the Claude Code and Codex status hooks on this computer. */
  onAgentHooksLocal: (install: boolean) => Promise<void>;
  /** Hook install status on this computer (null: could not be read). */
  localHookStatus: () => Promise<HookStatus | null>;
  onTestNotification: () => void;
  /** Imported / synced data was written to this computer. */
  onConfigApplied?: (categories: SyncCategory[]) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  themes,
  onClose,
  onSave,
  initialTab = "general",
  navigationVersion = 0,
  onAgentHooksLocal,
  localHookStatus,
  onTestNotification,
  onConfigApplied,
  sessions = [],
}) => {
  // Hook install status on this computer (undefined while reading).
  const [hookStatus, setHookStatus] = useState<HookStatus | null | undefined>(undefined);
  const refreshHooks = useCallback(() => {
    void localHookStatus().then(setHookStatus);
  }, [localHookStatus]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => refreshHooks(), []);
  const hooksOn = anyInstalled(hookStatus);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const settingsId = useId();
  const navigation = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLFormElement>(null);
  useEffect(() => setTab(initialTab), [initialTab, navigationVersion]);
  useEffect(() => {
    navigation.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (content.current) content.current.scrollTop = 0;
  }, [tab]);
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>({
    ...settings,
    language: settings.language || "zh-CN",
  });
  const [initialJson] = useState(() => JSON.stringify(draft));
  const { requestClose, prompt } = useCloseGuard(JSON.stringify(draft) !== initialJson, onClose);

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal-panel modal-lg settings-panel" role="dialog" aria-modal="true" aria-labelledby={`${settingsId}-title`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id={`${settingsId}-title`}>{t("settingsModal.title")}</h3>
          <button type="button" className="icon-btn" aria-label={t("settingsModal.cancel")} onClick={requestClose}>
            <X size={16} />
          </button>
        </div>
        {prompt}

        <div className="settings-layout">
        <div ref={navigation} className="adv-tabs settings-tabs" role="tablist" aria-label={t("settingsModal.title")} aria-orientation="vertical" onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const currentIndex = settingsSections.findIndex(section => section.id === tab);
          let nextIndex: number;
          switch (event.key) {
            case "ArrowDown": nextIndex = (currentIndex + 1) % settingsSections.length; break;
            case "ArrowUp": nextIndex = (currentIndex + settingsSections.length - 1) % settingsSections.length; break;
            case "Home": nextIndex = 0; break;
            case "End": nextIndex = settingsSections.length - 1; break;
            default: return;
          }
          event.preventDefault();
          setTab(settingsSections[nextIndex].id);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
        }}>
          {settingsSections.map(({ id, icon: Icon }) => (
            <button key={id} id={`${settingsId}-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`${settingsId}-panel`} tabIndex={tab === id ? 0 : -1} className={`adv-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <Icon size={16} aria-hidden="true" />
              <span>
              {t(`settingsModal.tab.${id}`)}
              </span>
            </button>
          ))}
        </div>

        <form
          ref={content}
          id={`${settingsId}-panel`}
          className="modal-body"
          role="tabpanel"
          aria-labelledby={`${settingsId}-${tab}`}
          tabIndex={0}
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft);
          }}
        >
          {tab === "keys" && <KeymapEditor draft={draft} onChange={setDraft} />}
          {tab === "plugins" && <PluginManager />}
          {tab === "toolbar" && <ToolbarEditor draft={draft} onChange={setDraft} />}
          {tab === "highlight" && <HighlightEditor draft={draft} onChange={setDraft} />}
          {tab === "triggers" && <TriggerEditor draft={draft} onChange={setDraft} />}
          {tab === "terminal" && <TerminalSettings draft={draft} onChange={setDraft} sessions={sessions} />}
          {tab === "mouse" && <MouseSettingsEditor draft={draft} onChange={setDraft} />}
          {tab === "logs" && <LogTransferSettings draft={draft} onChange={setDraft} />}
          {tab === "xserver" && <XServerSettingsEditor draft={draft} onChange={setDraft} />}
          {tab === "remote" && <RemoteSettingsEditor draft={draft} onChange={setDraft} saved={settings} />}
          {tab === "sync" && (
            <SyncSettingsEditor
              draft={draft}
              onChange={setDraft}
              saved={settings}
              onApplied={(categories) => onConfigApplied?.(categories)}
            />
          )}
          <div className={tab === "general" ? "settings-general" : "hidden"}>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("settingsModal.language")}</span>
              <select
                className="text-input"
                value={draft.language}
                onChange={(e) =>
                  setDraft({ ...draft, language: e.target.value })
                }
              >
                <option value="zh-CN">{t("settingsModal.langZh")}</option>
                <option value="en-US">{t("settingsModal.langEn")}</option>
              </select>
            </label>

            <label className="field">
              <span>{t("settingsModal.theme")}</span>
              <select
                className="text-input"
                value={draft.themeId}
                onChange={(e) =>
                  setDraft({ ...draft, themeId: e.target.value })
                }
              >
                {themes.map((th) => (
                  <option key={th.id} value={th.id}>
                    {th.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <FontFamilyField
            value={draft.fontFamily}
            onChange={(fontFamily) => setDraft({ ...draft, fontFamily })}
          />

          <div className="form-grid-3">
            <label className="field">
              <span>{t("settingsModal.fontSize")}</span>
              <input
                type="number"
                className="text-input"
                min={9}
                max={32}
                value={draft.fontSize}
                onChange={(e) =>
                  setDraft({ ...draft, fontSize: Number(e.target.value) || 14 })
                }
              />
            </label>

            <label className="field">
              <span>{t("settingsModal.cursorStyle")}</span>
              <select
                className="text-input"
                value={draft.cursorStyle}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cursorStyle: e.target.value as AppSettings["cursorStyle"],
                  })
                }
              >
                <option value="block">{t("settingsModal.cursorBlock")}</option>
                <option value="bar">{t("settingsModal.cursorBar")}</option>
                <option value="underline">
                  {t("settingsModal.cursorUnderline")}
                </option>
              </select>
            </label>

            <label className="field">
              <span>{t("settingsModal.scrollback")}</span>
              <input
                type="number"
                className="text-input"
                min={1000}
                max={500000}
                step={1000}
                value={draft.scrollback}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    scrollback: Number(e.target.value) || 10000,
                  })
                }
              />
            </label>
          </div>

          <label className="checkbox-row" title={t("fullHistory.enabledTip")}>
            <input
              type="checkbox"
              checked={draft.fullHistory !== false}
              onChange={(e) => setDraft({ ...draft, fullHistory: e.target.checked })}
            />
            <span>{t("fullHistory.enabled")}</span>
          </label>
          {draft.fullHistory !== false && (
            <>
              <div className="form-grid-2">
                <label className="field">
                  <span>{t("fullHistory.memoryMb")}</span>
                  <input
                    type="number"
                    className="text-input"
                    min={4}
                    max={4096}
                    value={draft.fullHistoryMemoryMb ?? 32}
                    onChange={(e) => setDraft({ ...draft, fullHistoryMemoryMb: Math.max(4, Number(e.target.value) || 32) })}
                  />
                </label>
                <label className="field">
                  <span>{t("fullHistory.diskMb")}</span>
                  <input
                    type="number"
                    className="text-input"
                    min={0}
                    max={102400}
                    value={draft.fullHistoryDiskMb ?? 2048}
                    onChange={(e) => setDraft({ ...draft, fullHistoryDiskMb: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
              </div>
              <p className="adv-hint">{t("fullHistory.hint")}</p>
            </>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.cursorBlink}
              onChange={(e) =>
                setDraft({ ...draft, cursorBlink: e.target.checked })
              }
            />
            <span>{t("settingsModal.cursorBlink")}</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.syntaxHighlight !== false}
              onChange={(e) =>
                setDraft({ ...draft, syntaxHighlight: e.target.checked })
              }
            />
            <span>{t("settingsModal.syntaxHighlight")}</span>
          </label>


          <h4 className="section-heading">{t("settingsModal.terminalBehavior")}</h4>
          <div className="form-grid-2">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(draft.showTimestamps)}
                onChange={(e) => setDraft({ ...draft, showTimestamps: e.target.checked })}
              />
              <span>{t("settingsModal.showTimestamps")}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(draft.timestampMs)}
                onChange={(e) => setDraft({ ...draft, timestampMs: e.target.checked })}
              />
              <span>{t("settingsModal.timestampMs")}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.gutterLineNumbers !== false}
                onChange={(e) => setDraft({ ...draft, gutterLineNumbers: e.target.checked })}
              />
              <span>{t("settingsModal.gutterLineNumbers")}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.highlightCurrentLine !== false}
                onChange={(e) => setDraft({ ...draft, highlightCurrentLine: e.target.checked })}
              />
              <span>{t("settingsModal.highlightCurrentLine")}</span>
            </label>
          </div>

          <h4 className="section-heading">{t("settingsModal.windowSection")}</h4>
          <div className="form-grid-2">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(draft.showStatusBar)}
                onChange={(e) => setDraft({ ...draft, showStatusBar: e.target.checked })}
              />
              <span>{t("settingsModal.showStatusBar")}</span>
            </label>
            <label className="checkbox-row" title={t("settingsModal.serverMonitorTip")}>
              <input
                type="checkbox"
                checked={draft.serverMonitor !== false}
                disabled={!draft.showStatusBar}
                onChange={(e) => setDraft({ ...draft, serverMonitor: e.target.checked })}
              />
              <span>{t("settingsModal.serverMonitor")}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(draft.alwaysOnTop)}
                onChange={(e) => setDraft({ ...draft, alwaysOnTop: e.target.checked })}
              />
              <span>{t("toolbar.alwaysOnTop")}</span>
            </label>
            <label className="field">
              <span>
                {t("toolbar.opacity")} {Math.round((draft.windowOpacity ?? 1) * 100)}%
              </span>
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={draft.windowOpacity ?? 1}
                onChange={(e) => setDraft({ ...draft, windowOpacity: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="settings-section-title">{t("agent.section")}</div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.tabActivity !== false}
              onChange={(e) => setDraft({ ...draft, tabActivity: e.target.checked })}
            />
            <span>{t("agent.tabActivity")}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.tabHostname !== false}
              onChange={(e) => setDraft({ ...draft, tabHostname: e.target.checked })}
            />
            <span>{t("tabbar.hostSetting")}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.tabCommand !== false}
              onChange={(e) => setDraft({ ...draft, tabCommand: e.target.checked })}
            />
            <span>{t("tabbar.cmdSetting")}</span>
          </label>
          <label className="checkbox-row" title={t("tabbar.shellIntegrationTip")}>
            <input
              type="checkbox"
              checked={draft.shellIntegration !== false}
              onChange={(e) => setDraft({ ...draft, shellIntegration: e.target.checked })}
            />
            <span>{t("tabbar.shellIntegration")}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.agentScreenDetect !== false}
              onChange={(e) => setDraft({ ...draft, agentScreenDetect: e.target.checked })}
            />
            <span>{t("agent.screenDetect")}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.agentNotify !== false}
              onChange={(e) => setDraft({ ...draft, agentNotify: e.target.checked })}
            />
            <span>{t("agent.notifySetting")}</span>
          </label>
          <AgentHookStatusLine status={hookStatus} />
          <div className="agent-hooks-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onAgentHooksLocal(true).then(refreshHooks)}
            >
              {hooksOn ? t("agent.reinstallLocal") : t("agent.installLocal")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={hookStatus !== undefined && !hooksOn}
              onClick={() => void onAgentHooksLocal(false).then(refreshHooks)}
            >
              {t("agent.uninstallLocal")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => void backend.writeClipboard(posixHookCommand(true))}>
              {t("agent.copyPosixInstall")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => void backend.writeClipboard(posixHookCommand(false))}>
              {t("agent.copyPosixRemove")}
            </button>
            <button type="button" className="btn-ghost" onClick={onTestNotification}>
              {t("agent.testNotify")}
            </button>
          </div>
          <p className="adv-hint">{t("agent.hint")}</p>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.closeToTray !== false}
              onChange={(e) => setDraft({ ...draft, closeToTray: e.target.checked })}
            />
            <span>{t("settingsModal.closeToTray")}</span>
          </label>

          <h4 className="section-heading">{t("update.section")}</h4>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.checkUpdates !== false}
              onChange={(e) => setDraft({ ...draft, checkUpdates: e.target.checked })}
            />
            <span>{t("update.checkAtStartup")}</span>
          </label>
          <UpdateCheckRow />


          <label className="field">
            <span>{t("settingsModal.lockPasscode")}</span>
            <input
              type="password"
              className="text-input"
              placeholder={t("settingsModal.lockPasscodePlaceholder")}
              value={draft.lockPasscode ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  lockPasscode: e.target.value || null,
                })
              }
            />
          </label>

          </div>

          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={requestClose}>
              {t("settingsModal.cancel")}
            </button>
            <button type="submit" className="btn-primary">
              {t("settingsModal.save")}
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
};

/** "Claude Code: installed · Codex: not used here" for the hooks on this computer. */
const AgentHookStatusLine: React.FC<{ status: HookStatus | null | undefined }> = ({ status }) => {
  const { t } = useTranslation();
  if (status === undefined) return <p className="adv-hint">{t("agent.checking")}</p>;
  if (status === null) return <p className="adv-hint">{t("agent.checkFailed")}</p>;
  const item = (app: string, st: HookStatus["claude"]) => (
    <span className={`hook-state hook-${st}`}>
      {app}：{t(`agent.hookState.${st}`)}
    </span>
  );
  return (
    <div className="hook-status-line">
      {item("Claude Code", status.claude)}
      {item("Codex", status.codex)}
      {item("Gemini CLI", status.gemini)}
      {status.outdated && <span className="hook-state hook-outdated">{t("agent.outdatedHint")}</span>}
    </div>
  );
};

/** "Check now" with the result inline: up to date, a newer release (with a download link) or the error. */
const UpdateCheckRow: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "checking" } | { kind: "done"; info: UpdateInfo } | { kind: "failed"; error: string }
  >({ kind: "idle" });
  const [version, setVersion] = useState("");
  useEffect(() => {
    void backend.appVersion().then(setVersion);
  }, []);
  const check = () => {
    setState({ kind: "checking" });
    backend
      .checkUpdate()
      .then((info) => setState({ kind: "done", info }))
      .catch((e) => setState({ kind: "failed", error: String(e) }));
  };
  return (
    <div className="agent-hooks-row">
      {version && <span className="adv-hint">{t("update.currentVersion", { version })}</span>}
      <button type="button" className="btn-secondary" disabled={state.kind === "checking"} onClick={check}>
        {state.kind === "checking" ? t("update.checking") : t("update.checkNow")}
      </button>
      {state.kind === "done" && !state.info.available && (
        <span className="adv-hint">{t("update.upToDate", { version: state.info.current })}</span>
      )}
      {state.kind === "done" && state.info.available && (
        <>
          <span className="adv-hint">{t("update.message", { current: state.info.current, latest: state.info.latest })}</span>
          <button type="button" className="btn-primary" onClick={() => void backend.openExternal(state.info.url)}>
            {t("update.download")}
          </button>
        </>
      )}
      {state.kind === "failed" && <span className="adv-hint">{t("update.failed", { error: state.error })}</span>}
    </div>
  );
};
