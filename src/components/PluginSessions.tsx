import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight, Folder, LoaderCircle, Play, Puzzle, RotateCw, Settings2, X } from "lucide-react";
import { plugins } from "../plugins/platform";
import { sessionSourceKey, type PluginSessionItem } from "../plugins/model";
import type { SessionOpenState } from "./SessionSidebar";
import { ProtocolBadge } from "./ProtocolBadge";
import { useContextMenu } from "./ContextMenu";

export function PluginSessionSources({filter, selectedId, onSelect, openState, onFocus}: {
  filter: string;
  selectedId: string | null;
  onSelect: (key: string) => void;
  openState: Record<string, SessionOpenState>;
  onFocus: (key: string) => boolean;
}) {
  useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, {keyword: string; page: number}>>({});
  const openMenu = useContextMenu();
  const keyword = filter.trim().toLocaleLowerCase();
  return <>{plugins.sessionSources().map(source => {
    const key = sessionSourceKey(source.pluginId, source.id);
    const folded = collapsed[key] && !keyword;
    const items = source.catalog.items.filter(item => `${source.title} ${item.label} ${item.description ?? ""} ${item.group ?? ""}`.toLocaleLowerCase().includes(keyword));
    const pageCount = Math.max(1, Math.ceil(items.length / 100));
    const page = Math.min(pages[key]?.keyword === keyword ? pages[key].page : 0, pageCount - 1);
    const changePage = (page: number) => setPages(previous => ({...previous, [key]: {keyword, page}}));
    const groups = new Map<string, PluginSessionItem[]>();
    for (const item of items.slice(page * 100, (page + 1) * 100)) { const group = item.group ?? ""; if (!groups.has(group)) groups.set(group, []); groups.get(group)!.push(item); }
    const connectingLabel = source.connecting === undefined ? undefined : source.catalog.items.find(item => item.id === source.connecting)?.label ?? "";
    const activate = (item: PluginSessionItem, forceNew: boolean) => {
      const itemKey = sessionSourceKey(source.pluginId, source.id, item.id);
      if (!forceNew && openState[itemKey] && onFocus(itemKey)) return;
      void plugins.connectSource(source.pluginId, source.id, item.id);
    };
    return <section className="plugin-session-source" key={key} aria-label={source.title} aria-busy={source.busy || source.catalog.state === "loading"}>
      <div className="tree-folder-row plugin-source-header">
        <button type="button" className="plugin-source-toggle" aria-expanded={!folded} title={source.pluginName} onClick={() => setCollapsed(previous => ({...previous, [key]: !previous[key]}))}>
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Puzzle size={13} /><span className="folder-name">{source.title}</span><span className="folder-badge">{items.length}</span>
        </button>
        {source.refreshCommand && <button type="button" className="icon-btn-xs" title={t("plugin.refreshSource", {title: source.title})} aria-label={t("plugin.refreshSource", {title: source.title})} disabled={source.busy || source.catalog.state === "loading" || plugins.locked} onClick={() => void plugins.refreshSource(source.pluginId, source.id)}>{source.busy || source.catalog.state === "loading" ? <LoaderCircle size={12} className="plugin-session-spinner" /> : <RotateCw size={12} />}</button>}
        {source.settingsView && <button type="button" className="icon-btn-xs" title={t("plugin.sourceSettings", {title: source.title})} aria-label={t("plugin.sourceSettings", {title: source.title})} disabled={plugins.locked} onClick={() => plugins.open(source.pluginId, source.settingsView!)}><Settings2 size={12} /></button>}
      </div>
      {!folded && <>
        {connectingLabel !== undefined && <p className="plugin-source-message plugin-source-connecting" role="status"><LoaderCircle size={12} className="plugin-session-spinner" />{t("plugin.connectingItem", {label: connectingLabel})}</p>}
        {(source.error || source.catalog.message) && <p className={`plugin-source-message ${source.error || source.catalog.state === "error" ? "plugin-source-error" : ""}`} role={source.error || source.catalog.state === "error" ? "alert" : "status"}>{source.error || source.catalog.message}</p>}
        {["signedOut", "error"].includes(source.catalog.state) && source.settingsView ? <button type="button" className="btn-secondary plugin-source-login" onClick={() => plugins.open(source.pluginId, source.settingsView!)}><Settings2 size={12} />{source.catalog.state === "signedOut" ? t("plugin.signIn") : t("plugin.settings")}</button> : source.catalog.state === "loading" ? <p className="plugin-source-message">{t("plugin.loading")}</p> : source.catalog.state === "ready" && !items.length ? <p className="plugin-source-message">{keyword ? t("plugin.noMatch") : t("plugin.noSessions")}</p> : null}
        {pageCount > 1 && <div className="plugin-source-pages"><button type="button" className="icon-btn-xs" title={t("plugin.prevPage")} aria-label={t("plugin.prevPageOf", {title: source.title})} disabled={page === 0} onClick={() => changePage(page - 1)}><ChevronLeft size={13} /></button><label><select aria-label={t("plugin.pageOf", {title: source.title})} value={page} onChange={event => changePage(Number(event.target.value))}>{Array.from({length:pageCount}, (_, index) => <option key={index} value={index}>{index + 1} / {pageCount}</option>)}</select></label><button type="button" className="icon-btn-xs" title={t("plugin.nextPage")} aria-label={t("plugin.nextPageOf", {title: source.title})} disabled={page + 1 >= pageCount} onClick={() => changePage(page + 1)}><ChevronRight size={13} /></button></div>}
        {[...groups].map(([group, children]) => <div key={group}>
          {group && <div className="plugin-source-group"><Folder size={12} /><span>{group}</span></div>}
          {children.map(item => {
            const itemKey = sessionSourceKey(source.pluginId, source.id, item.id);
            const open = openState[itemKey];
            const connecting = source.connecting === item.id;
            return <div key={item.id} aria-busy={connecting} className={`tree-session-row plugin-source-session ${selectedId === itemKey ? "selected" : ""} ${open ? "is-open" : ""} ${connecting ? "is-connecting" : ""}`} tabIndex={0} aria-label={item.label} title={`${item.label}\n${item.description ?? ""}\n${source.pluginName}${open ? ` · ${t("plugin.openCount", {count: open.count})}` : ""}`} onClick={() => onSelect(itemKey)} onDoubleClick={event => activate(item, event.ctrlKey || event.metaKey)} onKeyDown={event => {if (event.key === "Enter") {event.preventDefault(); activate(item, event.ctrlKey || event.metaKey);}}} onContextMenu={event => {
              onSelect(itemKey);
              openMenu(event, [...(open ? [{label: t("plugin.switchTo"), onClick: () => onFocus(itemKey)}] : []), {label: open ? t("plugin.connectAnother") : t("plugin.connect"), onClick: () => activate(item, true)}]);
            }}>
              <span className="session-icon"><ProtocolBadge protocol="ssh" size={13} />{open && <span className={`session-open-dot status-${open.status}`} />}</span>
              <div className="session-row-text"><span className="session-row-label">{item.label}</span><span className="session-row-sub">{item.description ?? source.title}</span></div>
              <div className="session-row-actions" onClick={event => event.stopPropagation()}><button type="button" className="icon-btn-xs" title={open ? t("plugin.switchTo") : t("plugin.connect")} aria-label={t("plugin.connectItem", {label: item.label})} disabled={source.busy || plugins.locked} onClick={event => activate(item, event.ctrlKey || event.metaKey)}>{connecting ? <LoaderCircle size={11} className="plugin-session-spinner" /> : <Play size={11} />}</button></div>
            </div>;
          })}
        </div>)}
      </>}
    </section>;
  })}</>;
}

export function PluginAccountDialog() {
  const prompt = plugins.accountPrompt!;
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus();};
  }, []);
  return createPortal(<dialog ref={dialog} className="plugin-settings-dialog plugin-account-dialog" aria-labelledby={titleId} onCancel={event => {event.preventDefault(); plugins.chooseSessionAccount(undefined);}}>
    <div className="modal-header"><div className="plugin-settings-dialog-heading"><h3 id={titleId}>{t("plugin.chooseAccount")}</h3><p>{prompt.title}</p></div><button type="button" className="icon-btn" title={t("plugin.cancel")} aria-label={t("plugin.cancelAccount")} onClick={() => plugins.chooseSessionAccount(undefined)}><X size={16} /></button></div>
    <div className="plugin-account-form"><div className="plugin-account-list" role="group" aria-label={t("plugin.account")}>{prompt.choices.map((item, index) => <button key={item.id} type="button" className="plugin-account-choice" autoFocus={index === 0} title={item.label} onClick={() => plugins.chooseSessionAccount(item.id)}><span>{item.label}</span><Play size={12} /></button>)}</div><div className="plugin-actions"><button type="button" className="btn-secondary" onClick={() => plugins.chooseSessionAccount(undefined)}>{t("plugin.cancel")}</button></div></div>
  </dialog>, document.body);
}
