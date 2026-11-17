import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, X } from "lucide-react";
import { backend } from "../services/backend";
import { SessionAdvanced, advancedToSession, initialAdvanced } from "./SessionAdvanced";
import { ProtocolBadge } from "./ProtocolBadge";
import { useCloseGuard } from "./useCloseGuard";
import {
  hasDataType,
  type AuthType,
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

const PROTOCOLS: ProtocolType[] = ["ssh", "powershell", "cmd", "wsl", "serial", "telnet", "tcp", "custom"];
const REMOTE: ProtocolType[] = ["ssh", "tcp", "telnet"];
const LOCAL: ProtocolType[] = ["powershell", "cmd", "wsl", "custom"];

interface SessionModalProps {
  initial?: SessionConfig | null;
  /** Groups of the saved sessions, offered while typing a group. */
  groups?: string[];
  onClose: () => void;
  onSave: (session: SessionConfig, connectNow: boolean) => void;
}

function makeUuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const SessionModal: React.FC<SessionModalProps> = ({
  initial,
  groups = [],
  onClose,
  onSave,
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
      : protocol.toUpperCase();

  const buildResult = (): SessionConfig => {
    const jumpCfg: JumpHostConfig | null =
      protocol === "ssh" && jumpEnabled && jumpHost.trim()
        ? {
            enabled: true,
            host: jumpHost.trim(),
            port: Number(jumpPort) || 22,
            username: jumpUser.trim(),
            authType: jumpAuth,
            password: jumpPassword || undefined,
            privateKeyPath: jumpKeyPath.trim() || undefined,
          }
        : null;

    return {
      id: initial?.id ?? newId,
      label: label.trim() || fallbackLabel(),
      group: group.trim(),
      protocol,
      host: host.trim(),
      port: protocol === "serial" ? 0 : Number(port) || (protocol === "ssh" ? 22 : 0),
      username: username.trim(),
      authType: protocol === "ssh" ? authType : "none",
      password: password || undefined,
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
    };
  };

  // Unsaved edits: the form as it would be saved, against how it opened.
  const currentJson = JSON.stringify(buildResult());
  const initialJson = useRef(currentJson);
  const { requestClose, prompt } = useCloseGuard(currentJson !== initialJson.current, onClose);

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
    if (p === "ssh" && (!port || port === 23)) setPort(22);
    if (p === "telnet" && (!port || port === 22)) setPort(23);
  };

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal-panel modal-lg session-form" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{initial ? t("sessionModal.editTitle") : t("sessionModal.newTitle")}</h3>
          <button type="button" className="icon-btn" onClick={requestClose} title={t("sessionModal.cancel")}>
            <X size={16} />
          </button>
        </div>
        {prompt}

        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
            onSave(buildResult(), submitter?.dataset.connect === "1");
          }}
        >
          <div className="proto-picker" role="radiogroup" aria-label={t("sessionModal.protocol")}>
            {PROTOCOLS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={protocol === p}
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
                <input
                  type="text"
                  className="text-input"
                  list="session-group-list"
                  placeholder={t("sessionModal.groupPlaceholder")}
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                />
                <datalist id="session-group-list">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
            </div>
          </section>

          <section className={`form-section form-more ${moreOpen ? "open" : ""}`}>
            <button type="button" className="form-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
              <ChevronRight size={14} />
              <span>{t("sessionForm.more")}</span>
              {!moreOpen && <em>{t(protocol === "ssh" ? "sessionForm.moreHintSsh" : "sessionForm.moreHint")}</em>}
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

                {protocol === "ssh" && (
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
              </div>
            )}
          </section>

          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={requestClose}>
              {t("sessionModal.cancel")}
            </button>
            <button type="submit" className="btn-secondary">
              {t("sessionModal.saveOnly")}
            </button>
            <button type="submit" className="btn-primary" data-connect="1">
              {t("sessionModal.saveAndConnect")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
