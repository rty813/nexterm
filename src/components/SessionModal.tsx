import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, X } from "lucide-react";
import { backend } from "../services/backend";
import { SessionAdvanced, advancedToSession, initialAdvanced } from "./SessionAdvanced";
import { ProtocolBadge } from "./ProtocolBadge";
import { GroupInput } from "./GroupInput";
import { AdbSessionFields } from "./AdbSessionFields";
import { useCloseGuard } from "./useCloseGuard";
import {
  DEFAULT_DESKTOP,
  type AdbConfig,
  hasDataType,
  isDesktopProtocol,
  type AuthType,
  type DesktopConfig,
  type DataType,
  type JumpHostConfig,
  type ProtocolType,
  type SerialConfig,
  type SessionConfig,
} from "../types/domain";

const BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
  921600, 1000000, 1500000, 2000000, 3000000,
];

const PROTOCOLS: ProtocolType[] = ["ssh", "rdp", "vnc", "adb", "powershell", "cmd", "wsl", "serial", "telnet", "tcp", "custom"];
const REMOTE: ProtocolType[] = ["ssh", "tcp", "telnet", "rdp", "vnc"];
/** Default port per network protocol: switching protocol replaces a port left at another's default. */
const DEFAULT_PORTS: Partial<Record<ProtocolType, number>> = { ssh: 22, telnet: 23, rdp: 3389, vnc: 5900, adb: 5555 };
const LOCAL: ProtocolType[] = ["powershell", "cmd", "wsl", "custom"];

interface SessionModalProps {
  initial?: SessionConfig | null;
  /** `initial` only prefills the form of a new session (e.g. from a quick connect address). */
  isNew?: boolean;
  /** Groups of the saved sessions, offered while typing a group. */
  groups?: string[];
  onClose: () => void;
  onSave: (session: SessionConfig, connectNow: boolean) => void;
  /** Connect without saving; offered only for a new session. */
  onConnect?: (session: SessionConfig) => void;
  /**
   * Settings of an open tab (tab / pane menu): same form, but the protocol is fixed and the
   * footer offers "apply to this tab" and "save to profile" instead of save / connect.
   */
  pane?: PaneMode;
}

export interface PaneMode {
  /** The tab's title, shown in the header. */
  title: string;
  /** The tab has a saved profile (same id). */
  isSaved: boolean;
  /** Offer to store the password the tab logged in with (quick tab, password login). */
  canRememberPassword: boolean;
  onApply: (session: SessionConfig, saveProfile: boolean, rememberPassword: boolean) => Promise<void>;
}

function makeUuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const SessionModal: React.FC<SessionModalProps> = ({
  initial,
  isNew = false,
  groups = [],
  onClose,
  onSave,
  onConnect,
  pane,
}) => {
  const { t } = useTranslation();
  const [newId] = useState(makeUuid);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [group, setGroup] = useState(
    initial?.group ?? t("sessionModal.defaultGroup")
  );
  const [protocol, setProtocol] = useState<ProtocolType>(
    initial?.protocol ?? "ssh"
  );
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState<number>(initial?.port || 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authType, setAuthType] = useState<AuthType>(
    initial?.authType ?? "password"
  );
  const [password, setPassword] = useState(initial?.password ?? "");
  const [privateKeyPath, setPrivateKeyPath] = useState(
    initial?.privateKeyPath ?? ""
  );
  const [passphrase, setPassphrase] = useState(initial?.passphrase ?? "");
  const [term, setTerm] = useState(initial?.term ?? "xterm-256color");
  const [keepAliveSecs, setKeepAliveSecs] = useState<number>(
    initial?.keepAliveSecs ?? 60
  );
  const [startupCommand, setStartupCommand] = useState(
    initial?.startupCommand ?? ""
  );
  const [workingDir, setWorkingDir] = useState(initial?.workingDir ?? "");
  const [shellCommand, setShellCommand] = useState(initial?.shellCommand ?? "");

  const [serialCfg, setSerialCfg] = useState<SerialConfig>({
    baudRate: initial?.serial?.baudRate ?? 115200,
    dataBits: initial?.serial?.dataBits ?? 8,
    parity: initial?.serial?.parity ?? "none",
    stopBits: initial?.serial?.stopBits ?? 1,
    flowControl: initial?.serial?.flowControl ?? "none",
  });
  const [dataType, setDataType] = useState<DataType>(initial?.dataType === "binary" ? "binary" : "text");
  const [autoLog, setAutoLog] = useState<boolean>(initial?.autoLog ?? false);
  const [antiIdleSecs, setAntiIdleSecs] = useState<number>(initial?.antiIdleSecs ?? 0);
  const [antiIdleString, setAntiIdleString] = useState(initial?.antiIdleString ?? "");
  const [advanced, setAdvanced] = useState(() => initialAdvanced(initial));
  const [desktop, setDesktopCfg] = useState<DesktopConfig>({ ...DEFAULT_DESKTOP, ...(initial?.desktop ?? {}) });
  const setDesktop = (patch: Partial<DesktopConfig>) => setDesktopCfg((d) => ({ ...d, ...patch }));
  const isDesktop = isDesktopProtocol(protocol);
  const [adbCfg, setAdbCfg] = useState<AdbConfig>({ serial: "", connect: "usb", view: "shell", ...(initial?.adb ?? {}) });
  const setAdb = (patch: Partial<AdbConfig>) => setAdbCfg((c) => ({ ...c, ...patch }));
  const [serialPorts, setSerialPorts] = useState<string[]>([]);

  useEffect(() => {
    if (protocol === "serial") {
      void backend.listSerialPorts().then(setSerialPorts);
    }
  }, [protocol]);

  const [jumpEnabled, setJumpEnabled] = useState(
    Boolean(initial?.jumpHost?.enabled)
  );
  const [jumpHost, setJumpHost] = useState(initial?.jumpHost?.host ?? "");
  const [jumpPort, setJumpPort] = useState<number>(
    initial?.jumpHost?.port ?? 22
  );
  const [jumpUser, setJumpUser] = useState(
    initial?.jumpHost?.username ?? ""
  );
  const [jumpAuth, setJumpAuth] = useState<AuthType>(
    initial?.jumpHost?.authType ?? "password"
  );
  const [jumpPassword, setJumpPassword] = useState(
    initial?.jumpHost?.password ?? ""
  );
  const [jumpKeyPath, setJumpKeyPath] = useState(
    initial?.jumpHost?.privateKeyPath ?? ""
  );

  const pickKeyFile = async (forJump: boolean) => {
    const picked = await backend.pickFile(t("sessionModal.selectKeyTitle"));
    if (picked) {
      if (forJump) setJumpKeyPath(picked);
      else setPrivateKeyPath(picked);
    }
  };

  const fallbackLabel = (): string =>
    protocol === "ssh"
      ? username
        ? `${username}@${host}`
        : host
      : protocol === "serial"
      ? `${host} (${serialCfg.baudRate})`
      : protocol === "tcp" || protocol === "telnet"
      ? `${protocol === "tcp" ? "TCP" : "Telnet"} ${host}:${port}`
      : protocol === "adb"
      ? adbCfg.connect === "wlan"
        ? `ADB ${host}`
        : `ADB ${adbCfg.serial || "auto"}`
      : isDesktop
      ? `${protocol.toUpperCase()} ${host}${port && port !== DEFAULT_PORTS[protocol] ? `:${port}` : ""}`
      : protocol.toUpperCase();

  const buildResult = (): SessionConfig => {
    const jumpCfg: JumpHostConfig | null =
      (protocol === "ssh" || isDesktop) && jumpEnabled && jumpHost.trim()
        ? {
            enabled: true,
            host: jumpHost.trim(),
            port: Number(jumpPort) || 22,
            username: jumpUser.trim(),
            authType: jumpAuth,
            password: jumpPassword || undefined,
            privateKeyPath: jumpKeyPath.trim() || undefined,
            passphrase: initial?.jumpHost?.passphrase ?? undefined,
          }
        : null;

    return {
      id: initial?.id ?? newId,
      label: label.trim() || fallbackLabel(),
      group: group.trim(),
      protocol,
      host: host.trim(),
      port: protocol === "serial" || (protocol === "adb" && adbCfg.connect !== "wlan") ? 0 : protocol === "adb" ? Number(port) || 5555 : Number(port) || DEFAULT_PORTS[protocol] || 0,
      username: username.trim(),
      authType: protocol === "ssh" ? authType : "none",
      password: password || (initial?.password === "" ? "" : undefined),
      privateKeyPath: privateKeyPath.trim() || undefined,
      passphrase: passphrase || undefined,
      jumpHost: jumpCfg,
      term: term.trim() || "xterm-256color",
      keepAliveSecs: Number(keepAliveSecs) || 0,
      startupCommand: startupCommand.trim() || undefined,
      workingDir: workingDir.trim() || undefined,
      shellCommand: shellCommand.trim() || undefined,
      serial: protocol === "serial" ? serialCfg : null,
      dataType: hasDataType(protocol) && dataType === "binary" ? "binary" : undefined,
      autoLog,
      antiIdleSecs: Number(antiIdleSecs) > 0 ? Number(antiIdleSecs) : undefined,
      antiIdleString: Number(antiIdleSecs) > 0 && antiIdleString ? antiIdleString : undefined,
      ...advancedToSession(advanced, protocol),
      desktop: isDesktop ? { ...desktop, domain: protocol === "rdp" ? desktop.domain.trim() : "" } : null,
      adb: protocol === "adb" ? { ...adbCfg, serial: adbCfg.connect === "wlan" ? "" : adbCfg.serial } : null,
    };
  };

  // Unsaved edits: the form as it would be saved, against how it opened.
  const currentJson = JSON.stringify(buildResult());
  const initialJson = useRef(currentJson);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { requestClose, prompt } = useCloseGuard(currentJson !== initialJson.current || rememberPassword, () => {
    if (!saving) onClose();
  });

  const applyToPane = async (saveProfile: boolean) => {
    if (!pane || saving) return;
    setSaving(true);
    setError("");
    try {
      await pane.onApply(buildResult(), saveProfile, rememberPassword);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  // Options most sessions never touch stay folded, unless this session uses them.
  const [moreOpen, setMoreOpen] = useState(
    () =>
      Boolean(initial?.jumpHost?.enabled || initial?.startupCommand || initial?.autoLog || initial?.antiIdleSecs) ||
      (initial?.term ?? "xterm-256color") !== "xterm-256color"
  );

  const isRemote = REMOTE.includes(protocol);
  const isLocal = LOCAL.includes(protocol);

  const pickProtocol = (p: ProtocolType) => {
    setProtocol(p);
    const fallback = DEFAULT_PORTS[p];
    if (fallback && (!port || Object.values(DEFAULT_PORTS).includes(port))) setPort(fallback);
  };

  return (
    <div className="modal-backdrop" onMouseDown={saving ? undefined : requestClose}>
      <div className="modal-panel modal-lg session-form" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {pane
              ? `${t("sessionForm.paneSettings")} · ${pane.title}`
              : initial && !isNew
              ? t("sessionModal.editTitle")
              : t("sessionModal.newTitle")}
          </h3>
          <button type="button" className="icon-btn" onClick={requestClose} title={t("sessionModal.cancel")} disabled={saving}>
            <X size={16} />
          </button>
        </div>
        {prompt}

        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
            const mode = submitter?.dataset.connect;
            if (pane) void applyToPane(mode === "save");
            else if (mode === "only" && onConnect) onConnect(buildResult());
            else onSave(buildResult(), mode === "1");
          }}
        >
          <div className="proto-picker" role="radiogroup" aria-label={t("sessionModal.protocol")}>
            {PROTOCOLS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={protocol === p}
                // An open tab keeps its protocol: a terminal can't turn into a desktop pane.
                disabled={Boolean(pane) && protocol !== p}
                title={pane && protocol !== p ? t("sessionForm.protocolFixed") : undefined}
                className={`proto-tile ${protocol === p ? "active" : ""}`}
                onClick={() => pickProtocol(p)}
              >
                <ProtocolBadge protocol={p} size={16} />
                <span>{t(`sessionForm.proto.${p}`)}</span>
              </button>
            ))}
          </div>

          <section className="form-section">
            <h4>{t("sessionForm.connection")}</h4>
            {isRemote && (
              <div className="form-grid-3">
                <label className="field col-span-2">
                  <span>{t("sessionModal.host")}</span>
                  <input
                    type="text"
                    className="text-input"
                    placeholder={t("sessionModal.hostPlaceholder")}
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    autoFocus={!initial}
                    required
                  />
                </label>
                <label className="field">
                  <span>{t("sessionModal.port")}</span>
                  <input
                    type="number"
                    className="text-input"
                    value={port}
                    min={1}
                    max={65535}
                    onChange={(e) => setPort(Number(e.target.value))}
                    required
                  />
                </label>
              </div>
            )}

            {protocol === "adb" && (
              <AdbSessionFields cfg={adbCfg} onCfg={setAdb} host={host} port={port} onHost={setHost} onPort={setPort} />
            )}

            {protocol === "serial" && (
              <div className="form-grid-2">
                <label className="field">
                  <span>{t("sessionModal.serialPort")}</span>
                  <input
                    type="text"
                    className="text-input"
                    list="serial-port-list"
                    placeholder="COM3"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                  />
                  <datalist id="serial-port-list">
                    {serialPorts.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </label>
                <label className="field">
                  <span>{t("sessionModal.baudRate")}</span>
                  <input
                    type="number"
                    className="text-input"
                    list="baud-rate-list"
                    min={50}
                    value={serialCfg.baudRate}
                    onChange={(e) => setSerialCfg({ ...serialCfg, baudRate: Number(e.target.value) || 115200 })}
                    required
                  />
                  <datalist id="baud-rate-list">
                    {BAUD_RATES.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </label>
              </div>
            )}

            {hasDataType(protocol) && (
              <div className="form-grid-2">
                <label className="field" title={t("sessionModal.dataTypeTip")}>
                  <span>{t("sessionModal.dataType")}</span>
                  <select className="text-input" value={dataType} onChange={(e) => setDataType(e.target.value as DataType)}>
                    <option value="text">{t("sessionModal.dataTypeText")}</option>
                    <option value="binary">{t("sessionModal.dataTypeBinary")}</option>
                  </select>
                </label>
                {dataType === "binary" && <p className="adv-hint field-hint-inline">{t("sessionModal.dataTypeTip")}</p>}
              </div>
            )}

            {protocol === "ssh" && (
              <>
                <div className="form-grid-2">
                  <label className="field">
                    <span>{t("sessionModal.username")}</span>
                    <input
                      type="text"
                      className="text-input"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>{t("sessionModal.authType")}</span>
                    <select className="text-input" value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
                      <option value="password">{t("sessionModal.authPwd")}</option>
                      <option value="privatekey">{t("sessionModal.authKey")}</option>
                    </select>
                  </label>
                </div>
                {authType === "password" ? (
                  <label className="field">
                    <span>{t("sessionModal.pwdLabel")}</span>
                    <input type="password" className="text-input" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                ) : (
                  <div className="form-grid-2">
                    <label className="field">
                      <span>{t("sessionModal.keyFile")}</span>
                      <div className="input-with-btn">
                        <input
                          type="text"
                          className="text-input"
                          placeholder="~/.ssh/id_ed25519"
                          value={privateKeyPath}
                          onChange={(e) => setPrivateKeyPath(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => void pickKeyFile(false)}
                          title={t("sessionModal.selectKeyTitle")}
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </label>
                    <label className="field">
                      <span>{t("sessionModal.passphrase")}</span>
                      <input type="password" className="text-input" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                    </label>
                  </div>
                )}
              </>
            )}

            {isDesktop && (
              <>
                <div className={protocol === "rdp" ? "form-grid-3" : "form-grid-2"}>
                  <label className="field" title={protocol === "vnc" ? t("desktop.vncUserTip") : undefined}>
                    <span>{protocol === "vnc" ? t("desktop.vncUser") : t("sessionModal.username")}</span>
                    <input type="text" className="text-input" value={username} onChange={(e) => setUsername(e.target.value)} />
                  </label>
                  {protocol === "rdp" && (
                    <label className="field">
                      <span>{t("desktop.domain")}</span>
                      <input
                        type="text"
                        className="text-input"
                        placeholder={t("desktop.domainPlaceholder")}
                        value={desktop.domain}
                        onChange={(e) => setDesktop({ domain: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>{t("sessionModal.pwdLabel")}</span>
                    <input type="password" className="text-input" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </div>
                <div className="form-grid-3">
                  <label className="field">
                    <span>{t("desktop.resolution")}</span>
                    <select
                      className="text-input"
                      value={desktop.resize}
                      onChange={(e) => setDesktop({ resize: e.target.value as DesktopConfig["resize"] })}
                    >
                      <option value="fit-window">{t("desktop.fitWindow")}</option>
                      <option value="fixed">{t("desktop.fixedSize")}</option>
                    </select>
                  </label>
                  {desktop.resize === "fixed" ? (
                    <label className="field">
                      <span>{t("desktop.size")}</span>
                      <div className="input-with-btn">
                        <input
                          type="number"
                          className="text-input"
                          min={200}
                          max={8192}
                          value={desktop.width}
                          onChange={(e) => setDesktop({ width: Number(e.target.value) || DEFAULT_DESKTOP.width })}
                        />
                        <input
                          type="number"
                          className="text-input"
                          min={200}
                          max={8192}
                          value={desktop.height}
                          onChange={(e) => setDesktop({ height: Number(e.target.value) || DEFAULT_DESKTOP.height })}
                        />
                      </div>
                    </label>
                  ) : (
                    <span />
                  )}
                  <label className="field">
                    <span>{t("desktop.scaleMode")}</span>
                    <select
                      className="text-input"
                      value={desktop.scale}
                      onChange={(e) => setDesktop({ scale: e.target.value as DesktopConfig["scale"] })}
                    >
                      <option value="fit">{t("desktop.scale.fit")}</option>
                      <option value="actual">{t("desktop.scale.actual")}</option>
                      <option value="stretch">{t("desktop.scale.stretch")}</option>
                    </select>
                  </label>
                </div>
                {protocol === "rdp" && (
                  <div className="form-grid-3">
                    <label className="field">
                      <span>{t("desktop.colorDepth")}</span>
                      <select
                        className="text-input"
                        value={desktop.colorDepth}
                        onChange={(e) => setDesktop({ colorDepth: Number(e.target.value) as DesktopConfig["colorDepth"] })}
                      >
                        <option value={32}>{t("desktop.depth32")}</option>
                        <option value={16}>{t("desktop.depth16")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("desktop.audio")}</span>
                      <select
                        className="text-input"
                        value={desktop.audio === "local" ? "local" : "off"}
                        onChange={(e) => setDesktop({ audio: e.target.value as DesktopConfig["audio"] })}
                      >
                        <option value="local">{t("desktop.audioLocal")}</option>
                        <option value="off">{t("desktop.audioOff")}</option>
                      </select>
                    </label>
                    <span />
                  </div>
                )}
                <div className="desktop-checks">
                  {protocol === "rdp" && (
                    <label className="checkbox-row" title={t("desktop.nlaTip")}>
                      <input type="checkbox" checked={desktop.nla} onChange={(e) => setDesktop({ nla: e.target.checked })} />
                      <span>{t("desktop.nla")}</span>
                    </label>
                  )}
                  <label className="checkbox-row" title={protocol === "vnc" ? t("desktop.vncClipboardTip") : undefined}>
                    <input type="checkbox" checked={desktop.clipboard} onChange={(e) => setDesktop({ clipboard: e.target.checked })} />
                    <span>{t("desktop.clipboard")}</span>
                  </label>
                  {protocol === "vnc" && (
                    <label className="checkbox-row">
                      <input type="checkbox" checked={desktop.viewOnly} onChange={(e) => setDesktop({ viewOnly: e.target.checked })} />
                      <span>{t("desktop.viewOnly")}</span>
                    </label>
                  )}
                </div>
              </>
            )}

            {protocol === "custom" && (
              <label className="field">
                <span>{t("sessionModal.customCmd")}</span>
                <input
                  type="text"
                  className="text-input"
                  placeholder="C:\Program Files\Git\bin\bash.exe --login -i"
                  value={shellCommand}
                  onChange={(e) => setShellCommand(e.target.value)}
                  required
                />
              </label>
            )}

            {isLocal && (
              <label className="field">
                <span>{t("sessionModal.workingDir")}</span>
                <input
                  type="text"
                  className="text-input"
                  placeholder={t("sessionModal.workingDirPlaceholder")}
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                />
              </label>
            )}
          </section>

          <section className="form-section">
            <h4>{t("sessionForm.nameAndGroup")}</h4>
            <div className="form-grid-2">
              <label className="field">
                <span>{t("sessionForm.label")}</span>
                <input
                  type="text"
                  className="text-input"
                  placeholder={fallbackLabel() || t("sessionModal.labelPlaceholder")}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t("sessionForm.group")}</span>
                <GroupInput
                  value={group}
                  onChange={setGroup}
                  groups={groups}
                  placeholder={t("sessionModal.groupPlaceholder")}
                />
              </label>
            </div>
          </section>

          <section className={`form-section form-more ${moreOpen ? "open" : ""}`}>
            <button type="button" className="form-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
              <ChevronRight size={14} />
              <span>{t("sessionForm.more")}</span>
              {!moreOpen && (
                <em>{t(protocol === "ssh" ? "sessionForm.moreHintSsh" : isDesktop ? "desktop.moreHint" : "sessionForm.moreHint")}</em>
              )}
            </button>

            {moreOpen && (
              <div className="form-more-body">
                {protocol === "serial" && (
                  <div className="form-grid-4">
                    <label className="field">
                      <span>{t("sessionModal.dataBits")}</span>
                      <select
                        className="text-input"
                        value={serialCfg.dataBits}
                        onChange={(e) => setSerialCfg({ ...serialCfg, dataBits: Number(e.target.value) })}
                      >
                        {[8, 7, 6, 5].map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("sessionModal.parity")}</span>
                      <select
                        className="text-input"
                        value={serialCfg.parity}
                        onChange={(e) => setSerialCfg({ ...serialCfg, parity: e.target.value as SerialConfig["parity"] })}
                      >
                        <option value="none">{t("sessionModal.parityNone")}</option>
                        <option value="odd">{t("sessionModal.parityOdd")}</option>
                        <option value="even">{t("sessionModal.parityEven")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("sessionModal.stopBits")}</span>
                      <select
                        className="text-input"
                        value={serialCfg.stopBits}
                        onChange={(e) => setSerialCfg({ ...serialCfg, stopBits: Number(e.target.value) })}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{t("sessionModal.flowControl")}</span>
                      <select
                        className="text-input"
                        value={serialCfg.flowControl}
                        onChange={(e) =>
                          setSerialCfg({ ...serialCfg, flowControl: e.target.value as SerialConfig["flowControl"] })
                        }
                      >
                        <option value="none">{t("sessionModal.flowNone")}</option>
                        <option value="software">XON/XOFF</option>
                        <option value="hardware">RTS/CTS</option>
                      </select>
                    </label>
                  </div>
                )}

                {(protocol === "ssh" || isDesktop) && (
                  <div className="JumpBox">
                    <label className="checkbox-row">
                      <input type="checkbox" checked={jumpEnabled} onChange={(e) => setJumpEnabled(e.target.checked)} />
                      <strong>{t("sessionModal.jumpToggle")}</strong>
                    </label>
                    {jumpEnabled && (
                      <div className="jump-fields">
                        <div className="form-grid-3">
                          <label className="field col-span-2">
                            <span>{t("sessionModal.jumpHost")}</span>
                            <input
                              type="text"
                              className="text-input"
                              placeholder="bastion.example.com"
                              value={jumpHost}
                              onChange={(e) => setJumpHost(e.target.value)}
                            />
                          </label>
                          <label className="field">
                            <span>{t("sessionModal.jumpPort")}</span>
                            <input type="number" className="text-input" value={jumpPort} onChange={(e) => setJumpPort(Number(e.target.value))} />
                          </label>
                        </div>
                        <div className="form-grid-2">
                          <label className="field">
                            <span>{t("sessionModal.jumpUser")}</span>
                            <input type="text" className="text-input" value={jumpUser} onChange={(e) => setJumpUser(e.target.value)} />
                          </label>
                          <label className="field">
                            <span>{t("sessionModal.jumpAuth")}</span>
                            <select className="text-input" value={jumpAuth} onChange={(e) => setJumpAuth(e.target.value as AuthType)}>
                              <option value="password">{t("sessionModal.authPwd")}</option>
                              <option value="privatekey">{t("sessionModal.authKey")}</option>
                            </select>
                          </label>
                        </div>
                        {jumpAuth === "password" ? (
                          <label className="field">
                            <span>{t("sessionModal.jumpPwd")}</span>
                            <input type="password" className="text-input" value={jumpPassword} onChange={(e) => setJumpPassword(e.target.value)} />
                          </label>
                        ) : (
                          <label className="field">
                            <span>{t("sessionModal.jumpKey")}</span>
                            <div className="input-with-btn">
                              <input type="text" className="text-input" value={jumpKeyPath} onChange={(e) => setJumpKeyPath(e.target.value)} />
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => void pickKeyFile(true)}
                                title={t("sessionModal.selectKeyTitle")}
                              >
                                <FolderOpen size={14} />
                              </button>
                            </div>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {!isDesktop && (
                <>
                <div className={protocol === "ssh" ? "form-grid-3" : "form-grid-2"}>
                  <label className="field">
                    <span>{t("sessionModal.termType")}</span>
                    <input type="text" className="text-input" value={term} onChange={(e) => setTerm(e.target.value)} />
                  </label>
                  {protocol === "ssh" && (
                    <label className="field">
                      <span>{t("sessionModal.keepAlive")}</span>
                      <input
                        type="number"
                        className="text-input"
                        value={keepAliveSecs}
                        min={0}
                        onChange={(e) => setKeepAliveSecs(Number(e.target.value))}
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>{t("sessionModal.startupCmd")}</span>
                    <input
                      type="text"
                      className="text-input"
                      placeholder={t("sessionModal.startupPlaceholder")}
                      value={startupCommand}
                      onChange={(e) => setStartupCommand(e.target.value)}
                    />
                  </label>
                </div>

                <div className="form-grid-2">
                  <label className="field">
                    <span>{t("sessionModal.antiIdle")}</span>
                    <input
                      type="number"
                      className="text-input"
                      value={antiIdleSecs}
                      min={0}
                      onChange={(e) => setAntiIdleSecs(Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>{t("sessionModal.antiIdleString")}</span>
                    <input
                      type="text"
                      className="text-input"
                      placeholder="\0"
                      disabled={!(antiIdleSecs > 0)}
                      value={antiIdleString}
                      onChange={(e) => setAntiIdleString(e.target.value)}
                    />
                  </label>
                </div>
                {antiIdleSecs > 0 && <p className="adv-hint field-hint-inline">{t("sessionModal.antiIdleTip")}</p>}

                <SessionAdvanced protocol={protocol} value={advanced} onChange={setAdvanced} />

                <label className="checkbox-row">
                  <input type="checkbox" checked={autoLog} onChange={(e) => setAutoLog(e.target.checked)} />
                  <span>{t("sessionModal.autoLog")}</span>
                </label>
                </>
                )}
              </div>
            )}
          </section>

          {pane ? (
            <>
              <p className="adv-hint">{t("sessionForm.reconnectHint")}</p>
              {pane.canRememberPassword && protocol === "ssh" && authType === "password" && !password && (
                <label className="checkbox-row">
                  <input type="checkbox" checked={rememberPassword} onChange={(e) => setRememberPassword(e.target.checked)} />
                  {t("pane.rememberPwd")}
                </label>
              )}
              {error && <p role="alert">{t("storageLoc.failed", { error })}</p>}
              <div className="modal-footer">
                <button type="button" className="btn-ghost" onClick={requestClose} disabled={saving}>
                  {t("sessionModal.cancel")}
                </button>
                <button type="submit" className="btn-secondary" data-connect="apply" disabled={saving}>
                  {t("sessionForm.applyToTab")}
                </button>
                <button type="submit" className="btn-primary" data-connect="save" disabled={saving}>
                  {t(pane.isSaved ? "sessionForm.updateProfile" : "sessionForm.saveProfile")}
                </button>
              </div>
            </>
          ) : (
          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={requestClose}>
              {t("sessionModal.cancel")}
            </button>
            {onConnect && (!initial || isNew) && (
              <button type="submit" className="btn-secondary" data-connect="only">
                {t("sessionModal.connectOnly")}
              </button>
            )}
            <button type="submit" className="btn-secondary">
              {t("sessionModal.saveOnly")}
            </button>
            <button type="submit" className="btn-primary" data-connect="1">
              {t("sessionModal.saveAndConnect")}
            </button>
          </div>
          )}
        </form>
      </div>
    </div>
  );
};
