import { DEFAULT_LOGCAT, type AdbConfig, type AdbDeviceInfo, type SessionConfig } from "../types/domain";

/** "192.168.1.5:5555", "[fe80::1]:5555", mDNS names: WLAN serials (Rust `is_network_serial`). */
export function isNetworkSerial(serial: string): boolean {
  if (serial.includes("._adb-tls-connect.") || serial.includes("._adb._tcp")) return true;
  const i = serial.lastIndexOf(":");
  if (i <= 0) return false;
  const port = serial.slice(i + 1);
  return /^\d{1,5}$/.test(port) && Number(port) <= 65535;
}

/** "host:port" -> parts (IPv6 in brackets). Missing port: 5555. */
export function splitAdbAddress(addr: string): { host: string; port: number } {
  const a = addr.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : 5555 };
  const i = a.lastIndexOf(":");
  if (i > 0 && a.indexOf(":") === i && /^\d+$/.test(a.slice(i + 1))) return { host: a.slice(0, i), port: Number(a.slice(i + 1)) };
  return { host: a, port: 5555 };
}

/** Readable device name: model, else serial. */
export function adbDeviceLabel(d: Pick<AdbDeviceInfo, "model" | "serial">): string {
  return d.model ? `${d.model}` : d.serial;
}

/**
 * A session for a device the adb server lists (sidebar, quick connect). `via`: the device is
 * on the adb server of that SSH pane's host; the serial is then kept as that server names it
 * (a WLAN device there is already connected by that server).
 */
export function adbSessionFor(
  serial: string,
  opts: { id: string; label?: string; view?: AdbConfig["view"]; group?: string; via?: string | null }
): SessionConfig {
  const wlan = !opts.via && isNetworkSerial(serial) && !serial.includes("._adb");
  const { host, port } = wlan ? splitAdbAddress(serial) : { host: "", port: 0 };
  return {
    id: opts.id,
    label: opts.label ?? serial,
    group: opts.group ?? "",
    protocol: "adb",
    host,
    port,
    username: "",
    authType: "none",
    term: "xterm-256color",
    keepAliveSecs: 0,
    adb: {
      serial: wlan ? "" : serial,
      connect: wlan ? "wlan" : "usb",
      view: opts.view ?? "shell",
      ...(opts.via ? { via: opts.via } : {}),
    },
  };
}

/** The logcat tab of an ADB session (same device, its own tab). */
export function logcatSessionOf(s: SessionConfig, id: string, title: string): SessionConfig {
  return {
    ...s,
    id,
    label: title,
    adb: { ...(s.adb ?? { serial: "", connect: "usb", view: "shell" }), view: "logcat", logcat: s.adb?.logcat ?? { ...DEFAULT_LOGCAT } },
  };
}

/** The serial the adb server knows a session's device by ("" = the only device). */
export function adbSerialOf(s: Pick<SessionConfig, "host" | "port" | "adb">): string {
  if (s.adb?.connect === "wlan") {
    const host = s.host.trim();
    if (!host) return "";
    const port = s.port && s.port !== 22 ? s.port : 5555;
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
  return s.adb?.serial?.trim() ?? "";
}

/** Sidebar / summary text: "ADB Pixel 7" style target. */
export function adbTargetSummary(s: Pick<SessionConfig, "host" | "port" | "adb">): string {
  const serial = adbSerialOf(s);
  const view = s.adb?.view === "logcat" ? " logcat" : "";
  return `ADB${view} ${serial || "auto"}`;
}
