import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Columns2, Download, LoaderCircle, Puzzle, RotateCw, Settings2, ShieldOff, TerminalSquare, Trash2, X } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "../services/backend";
import { Endpoint, plugins, type Runtime } from "../plugins/platform";
import { isModalLocation, statusLabelPrefix, type DockedViewLocation, type InstalledPlugin, type PluginPackage, type PluginView } from "../plugins/model";
import type { PackageReadResult } from "../plugins/packageReader.worker";
import { backgroundDocument, viewDocument } from "../plugins/sandbox";
import type { MenuItem } from "./ContextMenu";
import "../styles/plugins.css";
import { PluginAccountDialog } from "./PluginSessions";

export function usePluginPlatform() { useSyncExternalStore(plugins.subscribe, plugins.snapshot); return plugins; }

function PluginFrame({runtime, view}: {runtime: Runtime; view: PluginView}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const endpoint = useRef<Endpoint>();
  const connected = useRef(false);
  const source = useMemo(() => viewDocument(runtime.entry.bundle.files[view.file], isModalLocation(view.location)), [runtime, view.file, view.location]);
  useEffect(() => () => { if (endpoint.current) {runtime.clients.delete(endpoint.current); endpoint.current.close();} }, [runtime]);
  return <iframe ref={frame} title={view.title} className="plugin-frame" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={source} onLoad={() => {
    if (connected.current) { plugins.stop(runtime.entry.bundle.manifest.id, t("plugin.viewNavigation")); return; }
    connected.current = true;
    const channel = new MessageChannel();
    const client = new Endpoint(channel.port1, (method, value) => {
      if (method === "views.dismiss" && isModalLocation(view.location)) {
        const key = runtime.entry.bundle.manifest.id + ":" + view.id;
        if (plugins.modalView?.view === view && plugins.runtimes.get(runtime.entry.bundle.manifest.id) === runtime) plugins.close(key);
        return Promise.resolve();
      }
      return plugins.dispatch(runtime, "view", method, value);
    });
    endpoint.current = client; runtime.clients.add(client);
    frame.current?.contentWindow?.postMessage("nexterm:init", "*", [channel.port2]);
    for (const [name, value] of runtime.events) client.event(name, value);
  }} />;
}

function Background({entry}: {entry: InstalledPlugin}) {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<Runtime>();
  const frame = useRef<HTMLIFrameElement>(null);
  const connected = useRef(false);
  const source = useMemo(() => backgroundDocument(entry.bundle.files[entry.bundle.manifest.main]), [entry]);
  useEffect(() => {
    let active = true;
    void plugins.start(entry).then(value => {if (active) setRuntime(value);}).catch(() => {if (active) plugins.stop(entry.bundle.manifest.id, t("plugin.startFailed"));});
    return () => {active = false; plugins.stop(entry.bundle.manifest.id, plugins.failures.get(entry.bundle.manifest.id));};
  }, [entry]);
  useEffect(() => {
    if (!runtime) return;
    let heartbeat = Date.now();
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.kind === "heartbeat") heartbeat = Date.now();
      if (event.data?.kind === "failure") plugins.stop(entry.bundle.manifest.id, t("plugin.crashed"));
    };
    const timer = window.setInterval(() => {
      if (document.hidden) heartbeat = Date.now();
      else if (Date.now() - heartbeat > 15000) plugins.stop(entry.bundle.manifest.id, t("plugin.unresponsive"));
    }, 3000);
    window.addEventListener("message", receive);
    return () => {window.clearInterval(timer); window.removeEventListener("message", receive);};
  }, [runtime, entry]);
  if (!runtime || plugins.runtimes.get(entry.bundle.manifest.id) !== runtime) return null;
  return <iframe ref={frame} title={entry.bundle.manifest.name + " background"} hidden sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} onLoad={() => {
    if (connected.current) return;
    connected.current = true;
    const channel = new MessageChannel();
    runtime.background = new Endpoint(channel.port1, (method, value) => plugins.dispatch(runtime, "background", method, value));
    frame.current?.contentWindow?.postMessage("nexterm:init", "*", [channel.port2]);
    plugins.emit();
  }} />;
}

function PluginViewDialog({runtime, view}: {runtime: Runtime; view: PluginView}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const manifest = runtime.entry.bundle.manifest;
  const isSettings = view.location === "settings";
  const settings = isSettings ? (manifest.contributes.views ?? []).filter(item => item.location === "settings") : [];
  const close = () => plugins.close(manifest.id + ":" + view.id);
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className={isSettings ? "plugin-settings-dialog" : "plugin-settings-dialog plugin-content-dialog"} aria-labelledby={titleId} onCancel={event => {event.preventDefault(); close();}} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") {event.preventDefault(); close();}
  }} onMouseDown={event => {if (event.target === event.currentTarget) close();}}>
    <div className="modal-header">
      <div className="plugin-settings-dialog-heading"><h3 id={titleId}>{isSettings ? manifest.name : view.title}</h3><p>{isSettings ? view.title : manifest.name}</p></div>
      {settings.length > 1 && <select className="text-input" aria-label={t("plugin.settingsPage")} value={view.id} onChange={event => plugins.open(manifest.id, event.target.value)}>{settings.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
      <button type="button" className="icon-btn" title={t("plugin.close")} aria-label={isSettings ? t("plugin.closeSettings") : t("plugin.closeView", {title: view.title})} autoFocus onClick={close}><X size={16} /></button>
    </div>
    <div className="plugin-settings-dialog-body"><PluginFrame key={view.id} runtime={runtime} view={view} /></div>
  </dialog>, document.body);
}

export function PluginHost({locked = false}: {locked?: boolean}) {
  usePluginPlatform();
  useEffect(() => {plugins.load();}, []);
  const selected = plugins.modalView;
  useEffect(() => {if (locked && selected) plugins.close(selected.pluginId + ":" + selected.view.id);}, [locked, selected]);
  const runtime = selected && plugins.runtimes.get(selected.pluginId);
  return <>{plugins.entries.filter(entry => entry.enabled && !plugins.failures.has(entry.bundle.manifest.id)).map(entry => <Background key={entry.revision} entry={entry} />)}
    {!locked && selected && runtime && <PluginViewDialog key={runtime.entry.revision} runtime={runtime} view={selected.view} />}
    {!locked && plugins.accountPrompt && <PluginAccountDialog key={plugins.accountPrompt.pluginId + ":" + plugins.accountPrompt.sourceId} />}
  </>;
}

export function PluginBadges() {
  usePluginPlatform();
  const { t } = useTranslation();
  const items = plugins.entries.flatMap(entry => (entry.bundle.manifest.contributes.statusBar ?? []).filter(item => plugins.runtimes.has(entry.bundle.manifest.id) && !entry.hidden.includes(item.id)).map(item => ({entry, item})));
  if (!items.length) return null;
  return <div className="plugin-badges" role="group" aria-label={t("plugin.statusGroup")}>
    {items.map(({entry, item}) => {
      const status = plugins.runtimes.get(entry.bundle.manifest.id)?.status.get(item.id) ?? item;
      const prefix = statusLabelPrefix(item.text, status.text);
      return <button type="button" key={entry.bundle.manifest.id + ":" + item.id} aria-label={status.text || entry.bundle.manifest.name} title={[status.text, status.tooltip ?? entry.bundle.manifest.name].filter(Boolean).join("\n")} onClick={() => plugins.run(entry.bundle.manifest.id, item.command)}>{prefix && <span className="plugin-status-label">{prefix}</span>}{status.text.slice(prefix.length)}</button>;
    })}
  </div>;
}

export function PluginToolbar() {
  usePluginPlatform();
  const items = plugins.entries.flatMap(entry => (entry.bundle.manifest.contributes.toolbar ?? []).filter(item => plugins.runtimes.has(entry.bundle.manifest.id) && !entry.hidden.includes(item.id)).map(item => ({entry, item})));
  if (!items.length) return null;
  return <div className="plugin-toolbar">{items.map(({entry, item}) => <button type="button" className="btn-ghost" aria-label={item.text} title={item.tooltip ?? item.text} key={entry.bundle.manifest.id + item.id} onClick={() => plugins.run(entry.bundle.manifest.id, item.command)}><Puzzle size={14} /><span>{item.text}</span></button>)}</div>;
}

export function PluginViews({location}: {location: DockedViewLocation}) {
  usePluginPlatform();
  const { t } = useTranslation();
  const views = plugins.opened.filter(item => item.view.location === location);
  const active = plugins.active[location];
  if (!views.length) return null;
  return <section className={`plugin-region plugin-region-${location}`}>
    <div className="plugin-view-tabs" role="tablist">
      {location === "tab" && <button type="button" title={t("plugin.terminalWorkspace")} aria-selected={!active} role="tab" onClick={() => {delete plugins.active.tab; plugins.emit();}}><TerminalSquare size={14} />{t("plugin.terminal")}</button>}
      {views.map(({pluginId, view}) => <div key={pluginId + view.id} className={`plugin-view-tab ${active === pluginId + ":" + view.id ? "active" : ""}`}>
        <button type="button" role="tab" aria-selected={active === pluginId + ":" + view.id} title={view.title} onClick={() => plugins.open(pluginId, view.id)}>{view.title}</button>
        <button type="button" title={t("plugin.close")} aria-label={t("plugin.closeView", {title: view.title})} onClick={() => plugins.close(pluginId + ":" + view.id)}><X size={12} /></button>
      </div>)}
    </div>
    <div className="plugin-view-content" hidden={!active}>{views.map(({pluginId, view}) => {
      const runtime = plugins.runtimes.get(pluginId);
      return runtime && <div className="plugin-view-page" hidden={active !== pluginId + ":" + view.id} key={pluginId + view.id}><PluginFrame runtime={runtime} view={view} /></div>;
    })}</div>
  </section>;
}

export function PluginActivity() {
  usePluginPlatform();
  const { t } = useTranslation();
  const views = plugins.entries.flatMap(entry => (entry.bundle.manifest.contributes.views ?? []).flatMap(view => !isModalLocation(view.location) && plugins.runtimes.has(entry.bundle.manifest.id) && !entry.hidden.includes(view.id) ? [{entry, view, location: view.location}] : []));
  if (!views.length) return null;
  return <nav className="plugin-activity" aria-label={t("plugin.activity")}>{views.map(({entry, view, location}) => <button type="button" key={entry.bundle.manifest.id + view.id} title={view.title} aria-label={view.title} className={plugins.active[location] === entry.bundle.manifest.id + ":" + view.id ? "active" : ""} onClick={() => {
    const key = entry.bundle.manifest.id + ":" + view.id;
    if (plugins.active[location] === key) plugins.close(key); else plugins.open(entry.bundle.manifest.id, view.id);
  }}>{view.location === "sidebar" ? <Columns2 size={17} /> : <Puzzle size={17} />}</button>)}</nav>;
}

export function pluginContextMenu(selection: string): MenuItem[] {
  if (plugins.locked) return [];
  return plugins.entries.flatMap(entry => (entry.bundle.manifest.contributes.menus ?? []).filter(item => plugins.runtimes.has(entry.bundle.manifest.id) && (!item.selectionOnly || selection)).map(item => ({label: `${entry.bundle.manifest.name}: ${item.title}`, onClick: () => plugins.run(entry.bundle.manifest.id, item.command, {selection: item.selectionOnly ? selection.slice(0, 16384) : undefined})})));
}

export function PluginManager() {
  usePluginPlatform();
  const { t } = useTranslation();
  const [candidate, setCandidate] = useState<PluginPackage>();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const reader = useRef<Worker>();
  useEffect(() => {
    const input = file.current;
    const cancelled = () => setProgress("");
    input?.addEventListener("cancel", cancelled);
    return () => {input?.removeEventListener("cancel", cancelled); reader.current?.terminate(); reader.current = undefined;};
  }, []);
  const cancelRead = () => {reader.current?.terminate(); reader.current = undefined; setProgress("");};
  const readFile = (picked: File) => {
    cancelRead(); setCandidate(undefined); setError(""); setProgress(t("plugin.reading", {name: picked.name}));
    try {
      const worker = new Worker(new URL("../plugins/packageReader.worker.ts", import.meta.url), {type: "module"});
      reader.current = worker;
      const finish = (result: PackageReadResult) => {
        if (reader.current !== worker) return;
        cancelRead();
        if ("bundle" in result) setCandidate(result.bundle); else setError(t("plugin.readFailed", {error: result.code ? t(`plugin.${result.code}`) : result.error}));
      };
      worker.onmessage = (event: MessageEvent<PackageReadResult>) => finish(event.data);
      worker.onerror = worker.onmessageerror = () => finish({error: t("plugin.verifierFailed")});
      worker.postMessage(picked);
    } catch {cancelRead(); setError(t("plugin.readStartFailed"));}
  };
  const perform = (action: () => void | Promise<void>) => {try {const result = action(); setError(""); if (result) void result.catch(() => setError(t("plugin.actionFailedNative")));} catch {setError(t("plugin.actionFailedStorage"));}};
  return <div className="plugin-manager">
    <div className="plugin-manager-heading"><h3>{t("plugin.title")}</h3><button type="button" className="btn-secondary" disabled={!!progress} onClick={() => {setProgress(t("plugin.choosing")); file.current?.click();}}><Download size={14} />{t("plugin.install")}</button></div>
    <input ref={file} type="file" accept=".nexterm-plugin,application/json" hidden onChange={event => {
      const input = event.currentTarget; const picked = input.files?.[0]; input.value = "";
      if (picked) readFile(picked); else setProgress("");
    }} />
    {progress && <div className="plugin-install-progress"><span role="status"><LoaderCircle aria-hidden="true" size={16} />{progress}</span>{reader.current && <button type="button" className="btn-ghost" onClick={cancelRead}>{t("plugin.cancelRead")}</button>}</div>}
    {(error || plugins.lastError) && <p className="plugin-error" role="alert">{error || plugins.lastError}</p>}
    {candidate && !progress && <section className="plugin-install-review">
      <strong>{candidate.manifest.name} <small>{candidate.manifest.version}</small></strong><code>{candidate.manifest.id}</code>
      <p>{t("plugin.permNetwork", {value: [...candidate.manifest.permissions.network, ...(candidate.manifest.permissions.networkRequest ? [t("plugin.networkOnDemand")] : [])].join(t("plugin.listSeparator")) || t("plugin.none")})}</p>
      <p>{t("plugin.permSessions", {value: candidate.manifest.permissions.sessions ? t("plugin.sessionsConfirm") : t("plugin.none")})}</p>
      <p>{t("plugin.permCredentials", {value: candidate.manifest.permissions.credentials ? t("plugin.credentialsStore") : t("plugin.none")})}</p>
      <p>{t("plugin.trustWarning")}</p>
      <div className="plugin-actions"><button type="button" className="btn-primary" onClick={() => perform(() => {plugins.install(candidate); setCandidate(undefined);})}>{plugins.entries.some(entry => entry.bundle.manifest.id === candidate.manifest.id) ? t("plugin.authorizeReplace") : t("plugin.authorizeInstall")}</button><button type="button" className="btn-secondary" onClick={() => setCandidate(undefined)}>{t("plugin.cancel")}</button></div>
    </section>}
    {!plugins.entries.length && <p className="plugin-empty">{t("plugin.empty")}</p>}
    <div className="plugin-installed-list">{plugins.entries.map((entry, index) => {
      const manifest = entry.bundle.manifest;
      const settings = (manifest.contributes.views ?? []).filter(view => view.location === "settings");
      return <section className="plugin-installed" key={manifest.id}>
        <div className="plugin-installed-title"><label><input type="checkbox" checked={entry.enabled} onChange={event => perform(() => plugins.toggle(manifest.id, event.target.checked))} /><strong>{manifest.name}</strong><small>{manifest.version}</small></label>
          <div className="plugin-actions">{settings.length > 0 && <button type="button" className="btn-ghost" title={t("plugin.settings")} aria-label={t("plugin.settingsOf", {name: manifest.name})} disabled={!plugins.runtimes.has(manifest.id)} onClick={() => perform(() => plugins.open(manifest.id, settings[0].id))}><Settings2 size={14} /></button>}<button type="button" className="btn-ghost" title={t("plugin.moveUp")} disabled={!index} onClick={() => perform(() => plugins.move(manifest.id, -1))}><ArrowUp size={14} /></button><button type="button" className="btn-ghost" title={t("plugin.moveDown")} disabled={index === plugins.entries.length - 1} onClick={() => perform(() => plugins.move(manifest.id, 1))}><ArrowDown size={14} /></button><button type="button" className="btn-ghost" title={t("plugin.reload")} disabled={!entry.enabled} onClick={() => perform(() => plugins.toggle(manifest.id, true))}><RotateCw size={14} /></button><button type="button" className="btn-ghost" title={t("plugin.uninstall")} onClick={() => {void (async () => {const approved = isTauriRuntime() ? await confirm(t("plugin.uninstallConfirm", {name: manifest.name}), {title: t("plugin.uninstallTitle"), kind: "warning"}) : window.confirm(t("plugin.uninstallConfirm", {name: manifest.name})); if (approved) perform(() => plugins.remove(manifest.id));})().catch(() => setError(t("plugin.uninstallDialogFailed")));}}><Trash2 size={14} /></button></div>
        </div>
        <code>{manifest.id}</code>
        {!!entry.approvedOrigins?.length && <div className="plugin-actions"><small title={entry.approvedOrigins.join("\n")}>{t("plugin.rememberedOrigins", {count: entry.approvedOrigins.length})}</small><button type="button" className="btn-ghost" title={t("plugin.revokeNetwork")} aria-label={t("plugin.revokeNetworkOf", {name: manifest.name})} onClick={() => perform(() => plugins.revokeNetwork(manifest.id))}><ShieldOff size={14} /></button></div>}
        {plugins.failures.has(manifest.id) && <p className="plugin-error" role="alert">{plugins.failures.get(manifest.id)}</p>}
        <div className="plugin-contributions">{[...(manifest.contributes.statusBar ?? []), ...(manifest.contributes.toolbar ?? []), ...(manifest.contributes.views ?? []).filter(view => !isModalLocation(view.location)), ...(manifest.contributes.sessionSources ?? [])].map(item => <label key={item.id}><input type="checkbox" checked={!entry.hidden.includes(item.id)} onChange={() => perform(() => plugins.hide(manifest.id, item.id))} />{"title" in item ? item.title : item.text}</label>)}</div>
      </section>;
    })}</div>
  </div>;
}
