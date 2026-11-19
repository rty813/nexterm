import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowUpCircle, Copy, LoaderCircle, Plus, RotateCw, Search, Store, Trash2, X } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "../services/backend";
import { plugins } from "../plugins/platform";
import { pluginStores, storeError } from "../plugins/storeService";
import { describePlugin, latestVersion, type StoreOffer } from "../plugins/store";
import { usePluginPlatform } from "./StatusPlugins";

export function usePluginStores() { useSyncExternalStore(pluginStores.subscribe, pluginStores.snapshot); usePluginPlatform(); return pluginStores; }
/** Re-checks stores when the store page opens, at most every few minutes. */
const STALE_MS = 5 * 60 * 1000;
/** These rows live inside the settings <form>: Enter must act here, not save the settings. */
const onEnter = (action: () => void) => (event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); action(); } };
const ask = (message: string, title: string) => isTauriRuntime() ? confirm(message, {title, kind: "warning"}) : Promise.resolve(window.confirm(message));

function permissionLabel(t: TFunction, value: string) {
  return value === "networkRequest" ? t("plugin.networkOnDemand") : value === "sessions" ? t("pluginStore.permSessions") : value === "credentials" ? t("pluginStore.permCredentials") : value;
}

/** The authorization step for every install: a local file, a store package or an update. */
export function InstallReviewPanel({perform}: {perform: (action: () => void) => void}) {
  const stores = usePluginStores();
  const { t } = useTranslation();
  const review = stores.review;
  if (!review) return null;
  const manifest = review.bundle.manifest;
  const installed = plugins.entries.find(entry => entry.bundle.manifest.id === manifest.id);
  const from = (storeName?: string) => storeName ? t("pluginStore.fromStore", {name: storeName}) : t("pluginStore.fromFile");
  const sourceChanged = installed && installed.source?.storeId !== review.source?.storeId;
  return <section className="plugin-install-review">
    <strong>{manifest.name} <small>{installed ? `${installed.bundle.manifest.version} → ${manifest.version}` : manifest.version}</small></strong><code>{manifest.id}</code>
    <p>{t("pluginStore.source", {value: from(review.storeName)})}</p>
    {sourceChanged && <p className="plugin-warning" role="alert">{t("pluginStore.sourceChanged", {from: from(installed.source?.storeName), to: from(review.storeName)})}</p>}
    {!!review.added?.length && <p className="plugin-warning" role="alert">{t("pluginStore.addedPermissions", {value: review.added.map(value => permissionLabel(t, value)).join(t("plugin.listSeparator"))})}</p>}
    <p>{t("plugin.permNetwork", {value: [...manifest.permissions.network, ...(manifest.permissions.networkRequest ? [t("plugin.networkOnDemand")] : [])].join(t("plugin.listSeparator")) || t("plugin.none")})}</p>
    <p>{t("plugin.permSessions", {value: manifest.permissions.sessions ? t("plugin.sessionsConfirm") : t("plugin.none")})}</p>
    <p>{t("plugin.permCredentials", {value: manifest.permissions.credentials ? t("plugin.credentialsStore") : t("plugin.none")})}</p>
    <p>{review.source ? t("pluginStore.trustStore", {name: review.storeName}) : t("plugin.trustWarning")}</p>
    <div className="plugin-actions"><button type="button" className="btn-primary" onClick={() => perform(() => stores.approveReview())}>{installed ? t("plugin.authorizeReplace") : t("plugin.authorizeInstall")}</button><button type="button" className="btn-secondary" onClick={() => stores.clearReview()}>{t("plugin.cancel")}</button></div>
  </section>;
}

function AddStore({onDone}: {onDone: () => void}) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = address.trim().length > 0 && !busy;
  const add = async () => {
    if (!ready) return;
    setBusy(true); setError("");
    try { await pluginStores.addAddress(address); onDone(); } catch (reason) { setError(storeError(reason)); } finally { setBusy(false); }
  };
  return <section className="plugin-store-add">
    <div className="plugin-store-add-row" onKeyDown={onEnter(() => void add())}>
      <input className="text-input" autoFocus value={address} onChange={event => setAddress(event.target.value)} placeholder={t("pluginStore.addressPlaceholder")} aria-label={t("pluginStore.address")} />
      <button type="button" className="btn-primary" disabled={!ready} onClick={() => void add()}>{busy ? <LoaderCircle className="plugin-spin" size={14} /> : <Plus size={14} />}{t("pluginStore.add")}</button>
      <button type="button" className="btn-ghost" title={t("plugin.cancel")} aria-label={t("plugin.cancel")} onClick={onDone}><X size={14} /></button>
    </div>
    {error && <p className="plugin-error" role="alert">{error}</p>}
  </section>;
}

function StoreRow({id}: {id: string}) {
  const stores = usePluginStores();
  const { t } = useTranslation();
  const store = stores.stores.find(item => item.id === id)!;
  const state = stores.states.get(id);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const status = !store.enabled ? t("pluginStore.disabled") : state?.status === "loading" ? t("pluginStore.loading") : state?.status === "error" ? state.error : state?.index ? t("pluginStore.ready", {count: state.index.plugins.length}) : "";
  return <section className="plugin-installed">
    <div className="plugin-installed-title"><label><input type="checkbox" checked={store.enabled} onChange={event => stores.setEnabled(id, event.target.checked)} /><Store size={14} /><strong>{store.name}</strong></label>
      <div className="plugin-actions">
        <button type="button" className="btn-ghost" title={t("pluginStore.refresh")} disabled={!store.enabled || state?.status === "loading"} onClick={() => void stores.refresh(id)}><RotateCw size={14} /></button>
        <button type="button" className="btn-ghost" title={copied ? t("pluginStore.copied") : t("pluginStore.copyAddress")} onClick={() => void navigator.clipboard.writeText(store.urls[0]).then(() => {setCopied(true); window.setTimeout(() => setCopied(false), 1500);}, () => setError(t("pluginStore.copyFailed")))}><Copy size={14} /></button>
        <button type="button" className="btn-ghost" title={t("pluginStore.remove")} onClick={() => void ask(t("pluginStore.removeConfirm", {name: store.name}), t("pluginStore.remove")).then(approved => {if (approved) stores.remove(id);}, () => undefined)}><Trash2 size={14} /></button>
      </div>
    </div>
    <code title={store.urls.join("\n")}>{store.urls[0]}{store.urls.length > 1 ? ` (+${store.urls.length - 1})` : ""} · {t("pluginStore.fingerprint", {value: store.id})}</code>
    {status && <small className={`plugin-store-status${state?.status === "error" ? " plugin-error" : ""}`}>{state?.status === "loading" && <LoaderCircle className="plugin-spin" size={12} />}{status}</small>}
    {error && <p className="plugin-error" role="alert">{error}</p>}
  </section>;
}

/** Store tab of the plugin manager: configured stores and everything they offer. */
export function PluginStorePanel() {
  const stores = usePluginStores();
  const { t, i18n } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void stores.load().then(() => {for (const store of stores.stores) if (store.enabled && Date.now() - (stores.states.get(store.id)?.checkedAt ?? 0) > STALE_MS) void stores.refresh(store.id);});
  }, [stores]);
  const offers: StoreOffer[] = stores.catalogs().flatMap(catalog => catalog.index.plugins.flatMap(plugin => {
    const version = latestVersion(plugin);
    return version ? [{store: catalog.store, url: catalog.url, plugin, version}] : [];
  }));
  const needle = query.trim().toLowerCase();
  const visible = offers.filter(offer => !needle || [offer.plugin.name, offer.plugin.id, describePlugin(offer.plugin, i18n.language) ?? "", ...(offer.plugin.tags ?? [])].some(value => value.toLowerCase().includes(needle)));
  const install = async (offer: StoreOffer) => {
    setBusy(offer.store.id + offer.plugin.id); setError("");
    try { await stores.requestInstall(offer); } catch (reason) { setError(`${offer.plugin.name}: ${storeError(reason)}`); } finally { setBusy(""); }
  };
  return <div className="plugin-store">
    <div className="plugin-manager-heading"><h4>{t("pluginStore.stores")}</h4>{!adding && <button type="button" className="btn-secondary" onClick={() => setAdding(true)}><Plus size={14} />{t("pluginStore.addStore")}</button>}</div>
    {adding && <AddStore onDone={() => setAdding(false)} />}
    {!stores.stores.length && !adding && <p className="plugin-empty">{t("pluginStore.noStores")}</p>}
    {stores.lastError && <p className="plugin-error" role="alert">{stores.lastError}</p>}
    <div className="plugin-installed-list">{stores.stores.map(store => <StoreRow key={store.id} id={store.id} />)}</div>
    {!!offers.length && <>
      <div className="plugin-manager-heading"><h4>{t("pluginStore.available")}</h4><label className="plugin-store-search" onKeyDown={onEnter(() => undefined)}><Search size={13} /><input className="text-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("pluginStore.search")} aria-label={t("pluginStore.search")} /></label></div>
      {error && <p className="plugin-error" role="alert">{error}</p>}
      <div className="plugin-installed-list">{visible.map(offer => {
        const installed = plugins.entries.find(entry => entry.bundle.manifest.id === offer.plugin.id);
        const fromHere = installed?.source?.storeId === offer.store.id;
        const current = installed && fromHere && installed.bundle.manifest.version === offer.version.version;
        const label = !installed ? t("pluginStore.install") : !fromHere ? t("pluginStore.installFromHere") : current ? t("pluginStore.installed") : t("pluginStore.updateTo", {version: offer.version.version});
        const description = describePlugin(offer.plugin, i18n.language);
        return <section className="plugin-installed" key={offer.store.id + offer.plugin.id}>
          <div className="plugin-installed-title"><span><strong>{offer.plugin.name}</strong> <small>{offer.version.version}</small></span>
            <button type="button" className={current ? "btn-ghost" : "btn-secondary"} disabled={current || !!busy} onClick={() => void install(offer)}>{busy === offer.store.id + offer.plugin.id && <LoaderCircle className="plugin-spin" size={14} />}{label}</button></div>
          {description && <p className="plugin-store-description">{description}</p>}
          <small>{[offer.plugin.id, offer.plugin.author, t("pluginStore.fromStore", {name: offer.store.name}), ...(installed && !fromHere ? [t("pluginStore.installedElsewhere", {version: installed.bundle.manifest.version})] : [])].filter(Boolean).join(" · ")}</small>
        </section>;
      })}</div>
      {!visible.length && <p className="plugin-empty">{t("pluginStore.noMatch")}</p>}
    </>}
  </div>;
}

/** Update button on an installed plugin's row. */
export function InstalledUpdate({pluginId, onError}: {pluginId: string; onError: (message: string) => void}) {
  const stores = usePluginStores();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const update = stores.updates().find(item => item.entry.bundle.manifest.id === pluginId);
  const entry = plugins.entries.find(item => item.bundle.manifest.id === pluginId);
  if (!entry?.source) return null;
  return <small className="plugin-store-source">{t("pluginStore.fromStore", {name: entry.source.storeName})}
    {update && <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
      setBusy(true);
      void stores.update([update.offer]).then(result => {if (result.failed.length) onError(result.failed.join("\n"));}).finally(() => setBusy(false));
    }}>{busy ? <LoaderCircle className="plugin-spin" size={14} /> : <ArrowUpCircle size={14} />}{t("pluginStore.updateTo", {version: update.offer.version.version})}</button>}
  </small>;
}

/** Shown in the main window after the startup check when installed plugins have updates. */
export function PluginUpdateNotice({onOpen}: {onOpen: () => void}) {
  const stores = usePluginStores();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const updates = stores.updates();
  if (stores.noticeDismissed || (!updates.length && !message)) return null;
  const dismiss = () => {stores.noticeDismissed = true; setMessage(""); stores.emit();};
  const names = updates.map(({entry, offer}) => `${entry.bundle.manifest.name} ${entry.bundle.manifest.version} → ${offer.version.version}`);
  return <div className="plugin-update-notice" role="status">
    <ArrowUpCircle size={16} aria-hidden="true" />
    <span title={names.join("\n")}>{message || (updates.length === 1 ? t("pluginStore.noticeOne", {name: names[0]}) : t("pluginStore.noticeMany", {count: updates.length}))}</span>
    {!!updates.length && <button type="button" className="btn-primary" disabled={busy} onClick={() => {
      setBusy(true);
      void stores.update(updates.map(item => item.offer)).then(result => {
        const parts = [
          ...(result.installed ? [t("pluginStore.updated", {count: result.installed})] : []),
          ...(result.review ? [t("pluginStore.needsReview", {count: result.review})] : []),
          ...(result.failed.length ? [t("pluginStore.updateFailed", {value: result.failed.join("; ")})] : []),
        ];
        setMessage(parts.join(" "));
        if (result.review) { stores.view = "installed"; onOpen(); }
      }).finally(() => setBusy(false));
    }}>{busy && <LoaderCircle className="plugin-spin" size={14} />}{t("pluginStore.updateAll")}</button>}
    <button type="button" className="btn-secondary" onClick={() => {stores.view = "installed"; onOpen();}}>{t("pluginStore.details")}</button>
    <button type="button" className="btn-ghost" title={t("pluginStore.later")} aria-label={t("pluginStore.later")} onClick={dismiss}><X size={14} /></button>
  </div>;
}
