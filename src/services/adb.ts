// ADB commands (src-tauri/src/adb/commands.rs).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./backend";
import type {
  AdbAppAction,
  AdbAppInfo,
  AdbDeviceInfo,
  AdbDeviceProps,
  AdbProcessInfo,
  AdbStatus,
  LogEntry,
  MirrorInfo,
  MirrorInput,
  SessionConfig,
} from "../types/domain";

export interface MirrorOptions {
  maxSize: number;
  bitRate: number;
  maxFps: number;
  stayAwake: boolean;
  screenOff: boolean;
}

export const DEFAULT_MIRROR: MirrorOptions = { maxSize: 1280, bitRate: 8_000_000, maxFps: 60, stayAwake: true, screenOff: false };

/** Where a command acts: a connected ADB pane, or a device by serial. */
export interface AdbTarget {
  instanceId?: string | null;
  serial?: string | null;
}

function need() {
  if (!isTauriRuntime()) throw new Error("Browser preview mode");
}

export const adb = {
  async status(): Promise<AdbStatus> {
    if (!isTauriRuntime()) return { path: null, serverVersion: null };
    return invoke<AdbStatus>("adb_status");
  },
  async download(): Promise<string> {
    need();
    return invoke<string>("adb_download");
  },
  onDownloadProgress(handler: (p: { received: number; total: number }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return Promise.resolve(() => {});
    return listen<{ received: number; total: number }>("adb-download-progress", (e) => handler(e.payload));
  },
  async startServer(): Promise<number> {
    need();
    return invoke<number>("adb_start_server");
  },
  async devices(): Promise<AdbDeviceInfo[]> {
    if (!isTauriRuntime()) return [];
    return invoke<AdbDeviceInfo[]>("adb_devices");
  },
  /** Device list pushes (`adb-devices`); starts the app-wide watcher. */
  async watchDevices(handler: (list: AdbDeviceInfo[]) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    const un = await listen<AdbDeviceInfo[]>("adb-devices", (e) => handler(e.payload));
    void invoke("adb_watch_devices").catch(() => undefined);
    return un;
  },
  async connect(addr: string): Promise<string> {
    need();
    return invoke<string>("adb_connect", { addr });
  },
  async disconnect(addr: string): Promise<string> {
    need();
    return invoke<string>("adb_disconnect", { addr });
  },
  async pair(addr: string, code: string): Promise<string> {
    need();
    return invoke<string>("adb_pair", { addr, code });
  },
  async enableWlan(serial: string, port?: number): Promise<string> {
    need();
    return invoke<string>("adb_enable_wlan", { serial, port: port ?? null });
  },
  async props(target: AdbTarget): Promise<AdbDeviceProps> {
    need();
    return invoke<AdbDeviceProps>("adb_props", { instanceId: target.instanceId ?? null, serial: target.serial ?? null });
  },

  async apps(target: AdbTarget, versions: boolean): Promise<AdbAppInfo[]> {
    need();
    return invoke<AdbAppInfo[]>("adb_apps", { instanceId: target.instanceId ?? null, serial: target.serial ?? null, versions });
  },
  async appAction(instanceId: string, pkg: string, action: AdbAppAction): Promise<string> {
    need();
    return invoke<string>("adb_app_action", { instanceId, package: pkg, action });
  },
  async install(instanceId: string, path: string): Promise<string> {
    need();
    return invoke<string>("adb_install", { instanceId, path });
  },
  async exportApk(instanceId: string, pkg: string, dir: string): Promise<string[]> {
    need();
    return invoke<string[]>("adb_export_apk", { instanceId, package: pkg, dir });
  },
  async processes(instanceId: string): Promise<AdbProcessInfo[]> {
    need();
    return invoke<AdbProcessInfo[]>("adb_processes", { instanceId });
  },
  async kill(instanceId: string, pids: number[], signal = 15): Promise<void> {
    need();
    await invoke("adb_kill", { instanceId, pids, signal });
  },

  /** Stream a logcat tab; batches of entries arrive on `onBatch`. State changes come as `terminal-state`. */
  async logcatStart(
    instanceId: string,
    session: SessionConfig,
    options: { buffers: string[]; tail: number },
    onBatch: (entries: LogEntry[]) => void
  ): Promise<void> {
    if (!isTauriRuntime()) return;
    const channel = new Channel<LogEntry[]>(onBatch);
    await invoke("adb_logcat_start", { instanceId, session, options, channel });
  },
  logcatStop(instanceId: string): void {
    if (!isTauriRuntime()) return;
    void invoke("adb_logcat_stop", { instanceId }).catch(() => undefined);
  },
  async logcatClear(session: SessionConfig, buffers: string[]): Promise<void> {
    need();
    await invoke("adb_logcat_clear", { session, buffers });
  },

  /** Start mirroring: H.264 packets (12-byte header + data) arrive on `onPacket`. */
  async mirrorStart(mirrorId: string, target: AdbTarget, options: MirrorOptions, onPacket: (buf: ArrayBuffer) => void): Promise<MirrorInfo> {
    need();
    const channel = new Channel<ArrayBuffer>(onPacket);
    return invoke<MirrorInfo>("adb_mirror_start", {
      mirrorId,
      instanceId: target.instanceId ?? null,
      serial: target.serial ?? null,
      options,
      channel,
    });
  },
  mirrorInput(mirrorId: string, events: MirrorInput[]): void {
    if (!isTauriRuntime() || events.length === 0) return;
    void invoke("adb_mirror_input", { mirrorId, events }).catch(() => undefined);
  },
  mirrorAck(mirrorId: string, count: number): void {
    if (!isTauriRuntime()) return;
    void invoke("adb_mirror_ack", { mirrorId, count }).catch(() => undefined);
  },
  mirrorStop(mirrorId: string): void {
    if (!isTauriRuntime()) return;
    void invoke("adb_mirror_stop", { mirrorId }).catch(() => undefined);
  },
  onMirrorEnded(handler: (p: { mirrorId: string; message: string | null }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return Promise.resolve(() => {});
    return listen<{ mirrorId: string; message: string | null }>("adb-mirror-ended", (e) => handler(e.payload));
  },
  onMirrorClipboard(handler: (p: { mirrorId: string; text: string }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return Promise.resolve(() => {});
    return listen<{ mirrorId: string; text: string }>("adb-mirror-clipboard", (e) => handler(e.payload));
  },
  async screenshot(target: AdbTarget, path: string): Promise<void> {
    need();
    await invoke("adb_screenshot", { instanceId: target.instanceId ?? null, serial: target.serial ?? null, path });
  },
};
