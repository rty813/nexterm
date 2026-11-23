import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { anyInstalled, posixHookCommand, type HookStatus } from "../utils/agentHooks";
import { useTranslation } from "react-i18next";
import { backend } from "../services/backend";
import { Globe, Keyboard, Monitor, Mouse, Palette, PanelTop, Puzzle, RefreshCw, ScrollText, Search, Settings2, TerminalSquare, X, Zap } from "lucide-react";
import { findSettingElement, searchSettings, type SettingsSearchHit } from "../utils/settingsSearch";
import { closeActionOf, withCloseAction, type CloseAction } from "../utils/closeAction";
import type { AppSettings, HttpProxyMode, HttpProxySettings, SessionConfig, SyncCategory, ThemeDefinition, UpdateInfo } from "../types/domain";
import { LogTransferSettings, MouseSettingsEditor, TerminalSettings, XServerSettingsEditor } from "./SettingsTerminal";

import { PluginManager } from "./StatusPlugins";
export type SettingsTab = "general" | "theme" | "terminal" | "mouse" | "logs" | "xserver" | "remote" | "sync" | "triggers" | "keys" | "toolbar" | "plugins";
import { KeymapEditor, ToolbarEditor } from "./SettingsExtra";
import { TriggerEditor } from "./TriggerEditor";
import { RemoteSettingsEditor } from "./SettingsRemote";
import { SyncSettingsEditor } from "./SettingsSync";
import { useCloseGuard } from "./useCloseGuard";
import { FontFamilyField } from "./FontFamilyField";
import { NumberInput } from "./NumberInput";
import { ThemeSettings } from "./SettingsTheme";

const settingsSections = [
  { id: "general", icon: Settings2 },
  { id: "theme", icon: Palette },
  { id: "terminal", icon: TerminalSquare },
  { id: "mouse", icon: Mouse },
  { id: "logs", icon: ScrollText },
  { id: "xserver", icon: Monitor },
  { id: "remote", icon: Globe },
  { id: "sync", icon: RefreshCw },
  { id: "triggers", icon: Zap },
  { id: "keys", icon: Keyboard },
  { id: "toolbar", icon: PanelTop },
  { id: "plugins", icon: Puzzle },
] as const;

interface SettingsModalProps {
  settings: AppSettings;
  themes: ThemeDefinition[];
  /** The user's own themes (edited in the Theme tab). */
  customThemes: ThemeDefinition[];
  onSaveThemes: (list: ThemeDefinition[]) => Promise<void>;
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
  /** Download and install an update the check found (`canInstall`). */
  onInstallUpdate?: (info: UpdateInfo) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  themes,
  customThemes,
  onSaveThemes,
  onClose,
  onSave,
  initialTab = "general",
  navigationVersion = 0,
  onAgentHooksLocal,
  localHookStatus,
  onTestNotification,
  onConfigApplied,
  onInstallUpdate,
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
  const { t, i18n } = useTranslation();

  // Option search: the results replace the tab list while there is a query.
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  const [jump, setJump] = useState<{ tab: SettingsTab; label: string; seq: number } | null>(null);
  const hits = useMemo(() => {
    const languages = [i18n.language, ...["zh-CN", "en-US"].filter((l) => l !== i18n.language)];
    const fixed = languages.map((l) => i18n.getFixedT(l));
    return searchSettings(query, (key) => fixed.map((tl) => String(tl(key))), settingsSections.map((s) => s.id));
  }, [query, i18n, i18n.language]);
  useEffect(() => setActiveHit(0), [query]);
  const openHit = (hit: SettingsSearchHit, index: number) => {
    setActiveHit(index);
    setTab(hit.tab);
    setJump(hit.isTab ? null : { tab: hit.tab, label: hit.label, seq: Date.now() });
  };
  // Scroll to the chosen option and flash it once its tab has rendered.
  useEffect(() => {
    if (!jump || jump.tab !== tab || !content.current) return;
    const root = content.current;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const el = findSettingElement(root, jump.label);
      if (!el) {
        // Some tabs fill in after loading; give them a few frames.
        if (++tries < 20) frame = requestAnimationFrame(find);
        return;
      }
      el.scrollIntoView({ block: "center" });
      el.classList.remove("settings-flash");
      void el.offsetWidth;
      el.classList.add("settings-flash");
      el.addEventListener("animationend", () => el.classList.remove("settings-flash"), { once: true });
    };
    frame = requestAnimationFrame(find);
    return () => cancelAnimationFrame(frame);
  }, [jump, tab]);

  const [draft, setDraft] = useState<AppSettings>({
    ...settings,
    language: settings.language || "zh-CN",
  });
  const [initialJson] = useState(() => JSON.stringify(draft));
  const { requestClose, prompt } = useCloseGuard(JSON.stringify(draft) !== initialJson, onClose);

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal-panel modal-lg settings-panel" role="dialog" aria-modal="true" aria-labelledby={`${settingsId}-title`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.stopPropagation();
          searchInput.current?.focus();
          searchInput.current?.select();
        }
      }}>
        <div className="modal-header">
          <h3 id={`${settingsId}-title`}>{t("settingsModal.title")}</h3>
          <button type="button" className="icon-btn" aria-label={t("settingsModal.cancel")} onClick={requestClose}>
            <X size={16} />
          </button>
        </div>
        {prompt}

        <div className="settings-layout">
        <div className="settings-nav">
        <div className="settings-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            className="text-input"
            value={query}
            placeholder={t("settingsSearch.placeholder")}
            aria-label={t("settingsSearch.placeholder")}
            aria-controls={`${settingsId}-results`}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              } else if (hits.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : hits.length - 1;
                const next = (activeHit + step) % hits.length;
                setActiveHit(next);
                document.getElementById(`${settingsId}-hit-${next}`)?.scrollIntoView({ block: "nearest" });
              } else if (e.key === "Enter" && hits[activeHit]) {
                e.preventDefault();
                openHit(hits[activeHit], activeHit);
              }
            }}
          />
          {query && (
            <button type="button" className="icon-btn" aria-label={t("settingsSearch.clear")} onClick={() => { setQuery(""); searchInput.current?.focus(); }}>
              <X size={13} />
            </button>
          )}
        </div>
        {query.trim() ? (
          <div id={`${settingsId}-results`} className="settings-search-results" role="listbox" aria-label={t("settingsSearch.results")}>
            {hits.length === 0 && <p className="settings-search-empty">{t("settingsSearch.noResults")}</p>}
            {hits.map((hit, i) => {
              const Icon = settingsSections.find((s) => s.id === hit.tab)?.icon ?? Settings2;
              return (
                <button
                  key={`${hit.tab}:${hit.key}`}
                  id={`${settingsId}-hit-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeHit}
                  tabIndex={-1}
                  className={`settings-search-hit ${i === activeHit ? "active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => openHit(hit, i)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="settings-search-hit-text">
                    <span className="settings-search-hit-label">{hit.label}</span>
                    {!hit.isTab && <span className="settings-search-hit-tab">{t(`settingsModal.tab.${hit.tab}`)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
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
        )}
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
          {tab === "theme" && (
            <ThemeSettings draft={draft} onChange={setDraft} themes={themes} customThemes={customThemes} onSaveThemes={onSaveThemes} />
          )}
          {tab === "toolbar" && <ToolbarEditor draft={draft} onChange={setDraft} />}
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
              <div className="input-with-btn">
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
                <button type="button" className="btn-secondary btn-sm" onClick={() => setTab("theme")}>
                  {t("themeSettings.more")}
                </button>
              </div>
            </label>
          </div>

          <FontFamilyField
            value={draft.fontFamily}
            onChange={(fontFamily) => setDraft({ ...draft, fontFamily })}
          />

          <div className="form-grid-3">
            <label className="field">
              <span>{t("settingsModal.fontSize")}</span>
              <NumberInput
                min={9}
                max={32}
                value={draft.fontSize}
                onChange={(fontSize) => setDraft({ ...draft, fontSize })}
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
              <NumberInput
                min={1000}
                max={500000}
                step={1000}
                integer
                value={draft.scrollback}
                onChange={(scrollback) =>
                  setDraft({
                    ...draft,
                    scrollback,
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
                  <NumberInput
                    min={4}
                    max={4096}
                    value={draft.fullHistoryMemoryMb ?? 32}
                    onChange={(fullHistoryMemoryMb) => setDraft({ ...draft, fullHistoryMemoryMb })}
                  />
                </label>
                <label className="field">
                  <span>{t("fullHistory.diskMb")}</span>
                  <NumberInput
                    min={0}
                    max={102400}
                    value={draft.fullHistoryDiskMb ?? 2048}
                    onChange={(fullHistoryDiskMb) => setDraft({ ...draft, fullHistoryDiskMb })}
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

          <div className="form-grid-2">
            <label className="field" title={t("conpty.tip")}>
              <span>{t("conpty.label")}</span>
              <select
                className="text-input"
                value={draft.conpty ?? "auto"}
                onChange={(e) => setDraft({ ...draft, conpty: e.target.value as AppSettings["conpty"] })}
              >
                <option value="auto">{t("conpty.auto")}</option>
                <option value="bundled">{t("conpty.bundled")}</option>
                <option value="system">{t("conpty.system")}</option>
              </select>
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

          <label className="field">
            <span>{t("settingsModal.closeAction")}</span>
            <select
              className="text-input"
              value={closeActionOf(draft)}
              onChange={(e) => setDraft(withCloseAction(draft, e.target.value as CloseAction))}
            >
              <option value="ask">{t("settingsModal.closeAsk")}</option>
              <option value="tray">{t("settingsModal.closeTray")}</option>
              <option value="quit">{t("settingsModal.closeQuit")}</option>
            </select>
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
          <UpdateCheckRow onInstall={onInstallUpdate} />

          <h4 className="section-heading">{t("httpProxy.section")}</h4>
          <HttpProxyEditor
            value={draft.httpProxy ?? { mode: "system" }}
            onChange={(httpProxy) => setDraft({ ...draft, httpProxy })}
          />


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

/** Direct / system / custom proxy for the app's own HTTP requests, with a connection test. */
const HttpProxyEditor: React.FC<{ value: HttpProxySettings; onChange: (v: HttpProxySettings) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const [test, setTest] = useState<{ kind: "idle" } | { kind: "testing" } | { kind: "ok"; ms: number } | { kind: "failed"; error: string }>({
    kind: "idle",
  });
  const update = (v: HttpProxySettings) => {
    setTest({ kind: "idle" });
    onChange(v);
  };
  const run = () => {
    setTest({ kind: "testing" });
    backend
      .testHttpProxy(value.mode, value.url ?? "")
      .then((ms) => setTest({ kind: "ok", ms }))
      .catch((e) => setTest({ kind: "failed", error: String(e) }));
  };
  return (
    <>
      <div className="form-grid-2">
        <label className="field">
          <span>{t("httpProxy.mode")}</span>
          <select className="text-input" value={value.mode} onChange={(e) => update({ ...value, mode: e.target.value as HttpProxyMode })}>
            <option value="system">{t("httpProxy.system")}</option>
            <option value="direct">{t("httpProxy.direct")}</option>
            <option value="custom">{t("httpProxy.custom")}</option>
          </select>
        </label>
        {value.mode === "custom" && (
          <label className="field">
            <span>{t("httpProxy.url")}</span>
            <input
              className="text-input"
              value={value.url ?? ""}
              placeholder="http://127.0.0.1:7890"
              spellCheck={false}
              onChange={(e) => update({ ...value, url: e.target.value })}
            />
          </label>
        )}
      </div>
      <span className="adv-hint">{t(`httpProxy.${value.mode}Hint`)}</span>
      <div className="agent-hooks-row">
        <button type="button" className="btn-secondary" disabled={test.kind === "testing"} onClick={run}>
          {test.kind === "testing" ? t("httpProxy.testing") : t("httpProxy.test")}
        </button>
        {test.kind === "ok" && <span className="adv-hint">{t("httpProxy.testOk", { ms: test.ms })}</span>}
        {test.kind === "failed" && <span className="adv-hint">{t("httpProxy.testFailed", { error: test.error })}</span>}
      </div>
    </>
  );
};

/** "Check now" with the result inline: up to date, a newer release (install / download) or the error. */
const UpdateCheckRow: React.FC<{ onInstall?: (info: UpdateInfo) => void }> = ({ onInstall }) => {
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
          {state.info.canInstall && onInstall ? (
            <button type="button" className="btn-primary" onClick={() => onInstall(state.info)}>
              {t("update.install")}
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => void backend.openExternal(state.info.url)}>
              {t("update.download")}
            </button>
          )}
        </>
      )}
      {state.kind === "failed" && <span className="adv-hint">{t("update.failed", { error: state.error })}</span>}
    </div>
  );
};
