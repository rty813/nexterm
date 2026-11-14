import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { backend } from "../services/backend";
import {
  DEFAULT_TERMINAL_OPTIONS,
  type HighlightSystem,
  type ProtocolType,
  type ProxyConfig,
  type TerminalOptions,
  type TunnelConfig,
  type X11Config,
  metaKeyOf,
  type MetaKeyMapping,
} from "../types/domain";
import { TAB_COLORS } from "./TerminalPane";

export interface AdvancedState {
  proxy: ProxyConfig;
  tunnels: TunnelConfig[];
  x11: X11Config;
  charset: string;
  system: HighlightSystem | "";
  skipHostKeyCheck: boolean;
  termOptions: TerminalOptions;
  tabColor: string | null;
}

export function initialAdvanced(s?: Partial<{
  proxy: ProxyConfig | null;
  tunnels: TunnelConfig[];
  x11: X11Config | null;
  charset: string;
  system: HighlightSystem | "";
  skipHostKeyCheck: boolean;
  termOptions: TerminalOptions;
  tabColor: string | null;
}> | null): AdvancedState {
  return {
    proxy: s?.proxy ?? { kind: "none", host: "", port: 1080 },
    tunnels: s?.tunnels ?? [],
    x11: s?.x11 ?? { enabled: false, display: "localhost:0.0" },
    charset: s?.charset ?? "",
    system: s?.system ?? "",
    skipHostKeyCheck: s?.skipHostKeyCheck ?? false,
    termOptions: { ...DEFAULT_TERMINAL_OPTIONS, ...(s?.termOptions ?? {}) },
    tabColor: s?.tabColor ?? null,
  };
}

/** Fields to merge into the saved SessionConfig. */
export function advancedToSession(a: AdvancedState, protocol: ProtocolType) {
  const network = protocol === "ssh" || protocol === "telnet" || protocol === "tcp";
  return {
    proxy: network && a.proxy.kind !== "none" && a.proxy.host.trim() ? a.proxy : null,
    tunnels: protocol === "ssh" ? a.tunnels.filter((t) => t.listenPort > 0) : [],
    x11: protocol === "ssh" && a.x11.enabled ? a.x11 : null,
    charset: a.charset,
    system: a.system,
    skipHostKeyCheck: protocol === "ssh" ? a.skipHostKeyCheck : false,
    termOptions: a.termOptions,
    tabColor: a.tabColor,
  };
}

type Section = "connection" | "tunnels" | "terminal";

export const SessionAdvanced: React.FC<{
  protocol: ProtocolType;
  value: AdvancedState;
  onChange: (next: AdvancedState) => void;
}> = ({ protocol, value: v, onChange }) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("connection");
  const [charsets, setCharsets] = useState<string[]>([]);
  useEffect(() => {
    void backend.listCharsets().then(setCharsets);
  }, []);

  const isSsh = protocol === "ssh";
  const network = isSsh || protocol === "telnet" || protocol === "tcp";
  const set = (patch: Partial<AdvancedState>) => onChange({ ...v, ...patch });
  const setOpt = (patch: Partial<TerminalOptions>) => set({ termOptions: { ...v.termOptions, ...patch } });
  const setTunnel = (i: number, patch: Partial<TunnelConfig>) =>
    set({ tunnels: v.tunnels.map((tn, j) => (j === i ? { ...tn, ...patch } : tn)) });

  const sections: { id: Section; label: string; show: boolean }[] = [
    { id: "connection", label: t("adv.connection"), show: true },
    { id: "tunnels", label: t("adv.tunnels", { count: v.tunnels.length }), show: isSsh },
    { id: "terminal", label: t("adv.terminal"), show: true },
  ];

  return (
    <div className="adv-box">
      <div className="adv-tabs">
        {sections
          .filter((s) => s.show)
          .map((s) => (
            <button
              key={s.id}
              type="button"
              className={`adv-tab ${section === s.id ? "active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
      </div>

      {section === "connection" && (
        <div className="adv-body">
          <div className="form-grid-2">
            <label className="field">
              <span>{t("adv.charset")}</span>
              <select className="text-input" value={v.charset} onChange={(e) => set({ charset: e.target.value })}>
                <option value="">UTF-8 ({t("adv.default")})</option>
                {charsets.filter((c) => c !== "UTF-8").map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("adv.system")}</span>
              <select className="text-input" value={v.system} onChange={(e) => set({ system: e.target.value as HighlightSystem | "" })}>
                <option value="">{t("adv.systemAuto")}</option>
                <option value="linux">Linux</option>
                <option value="macos">macOS</option>
                <option value="powershell">PowerShell</option>
                <option value="cmd">CMD</option>
                <option value="routeros">RouterOS</option>
                <option value="none">{t("adv.systemNone")}</option>
              </select>
            </label>
          </div>

          {network && (
            <>
              <div className="form-grid-3">
                <label className="field">
                  <span>{t("adv.proxy")}</span>
                  <select
                    className="text-input"
                    value={v.proxy.kind}
                    onChange={(e) => set({ proxy: { ...v.proxy, kind: e.target.value as ProxyConfig["kind"] } })}
                  >
                    <option value="none">{t("adv.proxyNone")}</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                    <option value="http">HTTP</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t("adv.proxyHost")}</span>
                  <input
                    type="text"
                    className="text-input"
                    disabled={v.proxy.kind === "none"}
                    value={v.proxy.host}
                    placeholder="127.0.0.1"
                    onChange={(e) => set({ proxy: { ...v.proxy, host: e.target.value } })}
                  />
                </label>
                <label className="field">
                  <span>{t("sessionModal.port")}</span>
                  <input
                    type="number"
                    className="text-input"
                    disabled={v.proxy.kind === "none"}
                    value={v.proxy.port}
                    min={1}
                    max={65535}
                    onChange={(e) => set({ proxy: { ...v.proxy, port: Number(e.target.value) } })}
                  />
                </label>
              </div>
              {v.proxy.kind !== "none" && v.proxy.kind !== "socks4" && (
                <div className="form-grid-2">
                  <label className="field">
                    <span>{t("adv.proxyUser")}</span>
                    <input
                      type="text"
                      className="text-input"
                      value={v.proxy.username ?? ""}
                      onChange={(e) => set({ proxy: { ...v.proxy, username: e.target.value || null } })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("adv.proxyPwd")}</span>
                    <input
                      type="password"
                      className="text-input"
                      value={v.proxy.password ?? ""}
                      onChange={(e) => set({ proxy: { ...v.proxy, password: e.target.value || null } })}
                    />
                  </label>
                </div>
              )}
            </>
          )}

          {isSsh && (
            <>
              <div className="form-grid-2">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={v.x11.enabled}
                    onChange={(e) => set({ x11: { ...v.x11, enabled: e.target.checked } })}
                  />
                  <span>{t("adv.x11")}</span>
                </label>
                <label className="field">
                  <span>{t("adv.x11Display")}</span>
                  <input
                    type="text"
                    className="text-input"
                    disabled={!v.x11.enabled}
                    placeholder="auto"
                    title={t("adv.x11DisplayTip")}
                    value={v.x11.display}
                    onChange={(e) => set({ x11: { ...v.x11, display: e.target.value } })}
                  />
                </label>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={!v.skipHostKeyCheck}
                  onChange={(e) => set({ skipHostKeyCheck: !e.target.checked })}
                />
                <span>{t("adv.verifyHostKey")}</span>
              </label>
            </>
          )}
        </div>
      )}

      {section === "tunnels" && isSsh && (
        <div className="adv-body">
          <p className="adv-hint">{t("adv.tunnelsHint")}</p>
          {v.tunnels.map((tn, i) => (
            <div key={i} className="tunnel-row">
              <input
                type="checkbox"
                checked={tn.enabled}
                title={t("adv.tunnelEnabled")}
                onChange={(e) => setTunnel(i, { enabled: e.target.checked })}
              />
              <select
                className="text-input input-sm"
                value={tn.kind}
                onChange={(e) => setTunnel(i, { kind: e.target.value as TunnelConfig["kind"] })}
              >
                <option value="local">{t("adv.tunnelLocal")}</option>
                <option value="remote">{t("adv.tunnelRemote")}</option>
                <option value="dynamic">{t("adv.tunnelDynamic")}</option>
              </select>
              <input
                type="text"
                className="text-input input-sm"
                placeholder={t("adv.tunnelName")}
                value={tn.name}
                onChange={(e) => setTunnel(i, { name: e.target.value })}
              />
              <input
                type="text"
                className="text-input input-sm"
                title={tn.kind === "remote" ? t("adv.remoteListenHost") : t("adv.localListenHost")}
                value={tn.listenHost}
                onChange={(e) => setTunnel(i, { listenHost: e.target.value })}
              />
              <input
                type="number"
                className="text-input input-sm port-input"
                title={tn.kind === "remote" ? t("adv.remoteListenPort") : t("adv.localListenPort")}
                value={tn.listenPort || ""}
                onChange={(e) => setTunnel(i, { listenPort: Number(e.target.value) })}
              />
              {tn.kind !== "dynamic" ? (
                <>
                  <span className="tunnel-arrow">→</span>
                  <input
                    type="text"
                    className="text-input input-sm"
                    title={tn.kind === "remote" ? t("adv.localTarget") : t("adv.remoteTarget")}
                    value={tn.targetHost}
                    onChange={(e) => setTunnel(i, { targetHost: e.target.value })}
                  />
                  <input
                    type="number"
                    className="text-input input-sm port-input"
                    value={tn.targetPort || ""}
                    onChange={(e) => setTunnel(i, { targetPort: Number(e.target.value) })}
                  />
                </>
              ) : (
                <span className="tunnel-arrow muted">SOCKS5</span>
              )}
              <button
                type="button"
                className="icon-btn-xs danger-hover"
                onClick={() => set({ tunnels: v.tunnels.filter((_, j) => j !== i) })}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() =>
              set({
                tunnels: [
                  ...v.tunnels,
                  { name: "", kind: "local", listenHost: "127.0.0.1", listenPort: 0, targetHost: "localhost", targetPort: 0, enabled: true },
                ],
              })
            }
          >
            <Plus size={13} /> {t("adv.addTunnel")}
          </button>
        </div>
      )}

      {section === "terminal" && (
        <div className="adv-body">
          <div className="form-grid-3">
            <label className="field">
              <span>{t("adv.backspace")}</span>
              <select
                className="text-input"
                value={v.termOptions.backspaceKey}
                onChange={(e) => setOpt({ backspaceKey: e.target.value as TerminalOptions["backspaceKey"] })}
              >
                <option value="del">DEL (^?)</option>
                <option value="ctrl-h">Ctrl+H (^H)</option>
              </select>
            </label>
            <label className="field">
              <span>{t("adv.delete")}</span>
              <select
                className="text-input"
                value={v.termOptions.deleteKey}
                onChange={(e) => setOpt({ deleteKey: e.target.value as TerminalOptions["deleteKey"] })}
              >
                <option value="vt">VT220 (ESC[3~)</option>
                <option value="del">DEL (^?)</option>
              </select>
            </label>
            <label className="field">
              <span>{t("adv.enter")}</span>
              <select
                className="text-input"
                value={v.termOptions.enterKey}
                onChange={(e) => setOpt({ enterKey: e.target.value as TerminalOptions["enterKey"] })}
              >
                <option value="cr">CR</option>
                <option value="crlf">CR LF</option>
                <option value="lf">LF</option>
              </select>
            </label>
          </div>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("adv.bell")}</span>
              <select
                className="text-input"
                value={v.termOptions.bell}
                onChange={(e) => setOpt({ bell: e.target.value as TerminalOptions["bell"] })}
              >
                <option value="visual">{t("adv.bellVisual")}</option>
                <option value="sound">{t("adv.bellSound")}</option>
                <option value="none">{t("adv.bellNone")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("adv.metaKey")}</span>
              <select
                className="text-input"
                value={metaKeyOf(v.termOptions)}
                onChange={(e) => {
                  const metaKey = e.target.value as MetaKeyMapping;
                  setOpt({ metaKey, altIsMeta: metaKey === "alt" || metaKey === "leftAlt" || metaKey === "rightAlt" });
                }}
              >
                <option value="alt">{t("adv.metaAlt")}</option>
                <option value="leftAlt">{t("adv.metaLeftAlt")}</option>
                <option value="rightAlt">{t("adv.metaRightAlt")}</option>
                <option value="win">{t("adv.metaWin")}</option>
                <option value="none">{t("adv.metaNone")}</option>
              </select>
            </label>
          </div>
          <div className="field">
            <span>{t("adv.tabColor")}</span>
            <div className="swatch-row">
              <button
                type="button"
                className={`swatch swatch-none ${!v.tabColor ? "active" : ""}`}
                onClick={() => set({ tabColor: null })}
                title={t("menu.noColor")}
              />
              {TAB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${v.tabColor === c ? "active" : ""}`}
                  style={{ background: c }}
                  onClick={() => set({ tabColor: c })}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
