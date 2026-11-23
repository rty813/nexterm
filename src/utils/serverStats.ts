/**
 * Server resource monitor: parse the raw output of the sampling script
 * (src-tauri/src/server_stats.rs: /proc/stat, /proc/meminfo, /proc/loadavg, /proc/net/dev,
 * /proc/uptime, `df -P -k`) and turn two consecutive samples into rates.
 */

export interface CpuTimes {
  /** All jiffies (user .. steal; guest time is already part of user / nice). */
  total: number;
  /** idle + iowait. */
  idle: number;
}

export interface NicCounters {
  rx: number;
  tx: number;
}

export interface DiskUsage {
  filesystem: string;
  mount: string;
  /** Bytes. */
  size: number;
  used: number;
  avail: number;
  /** 0-100. */
  percent: number;
}

/** One parsed sample, before any rate is known. */
export interface RawSample {
  /** Client clock (ms), the fallback time base. */
  at: number;
  cpu: CpuTimes | null;
  cores: number;
  /** Bytes. */
  memTotal: number;
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
  load: [number, number, number] | null;
  /** Server uptime in seconds (also the preferred time base for rates). */
  uptime: number | null;
  nics: Record<string, NicCounters>;
  disks: DiskUsage[];
  /** Android (`dumpsys battery`), else null. */
  battery?: BatteryInfo | null;
}

export interface BatteryInfo {
  /** 0-100. */
  level: number;
  /** "charging" | "discharging" | "full" | "not charging" | "unknown" */
  status: string;
  /** AC / USB / wireless, or "" on battery. */
  plugged: string;
  /** Celsius. */
  temperature: number | null;
  health: string;
}

export type ParseResult = { supported: true; sample: RawSample } | { supported: false; os: string };

export interface NicStats {
  name: string;
  /** Bytes per second; null on the first sample or after a counter reset. */
  rxRate: number | null;
  txRate: number | null;
  rxTotal: number;
  txTotal: number;
  virtual: boolean;
}

export interface ServerStats {
  /** 0-100, null until two samples exist. */
  cpuPercent: number | null;
  cores: number;
  memTotal: number;
  memUsed: number;
  memPercent: number;
  swapTotal: number;
  swapUsed: number;
  swapPercent: number;
  load: [number, number, number] | null;
  uptime: number | null;
  nics: NicStats[];
  /** Sum over physical interfaces (no loopback, bridges, veth ...). */
  rxRate: number | null;
  txRate: number | null;
  disks: DiskUsage[];
  battery: BatteryInfo | null;
}

/** Split the script output into `@@name` sections. */
export function splitSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const m = /^@@(\w+)(.*)$/.exec(line);
    if (m) {
      current = [];
      out.set(m[1], current);
      if (m[2].trim()) current.push(m[2].trim());
      continue;
    }
    if (current && line) current.push(line);
  }
  return out;
}

/** The aggregate `cpu` line of /proc/stat plus the number of `cpuN` lines. */
export function parseProcStat(lines: string[]): { cpu: CpuTimes | null; cores: number } {
  let cpu: CpuTimes | null = null;
  let cores = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "cpu") {
      // user nice system idle iowait irq softirq steal [guest guest_nice]
      const v = parts.slice(1, 9).map((x) => Number(x) || 0);
      if (v.length >= 4) {
        const total = v.reduce((a, b) => a + b, 0);
        cpu = { total, idle: v[3] + (v[4] ?? 0) };
      }
    } else if (/^cpu\d+$/.test(parts[0])) {
      cores++;
    }
  }
  return { cpu, cores };
}

/** /proc/meminfo in bytes. MemAvailable when the kernel has it (3.14+), else estimated. */
export function parseMeminfo(lines: string[]): { memTotal: number; memAvailable: number; swapTotal: number; swapFree: number } {
  const kb = new Map<string, number>();
  for (const line of lines) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line.trim());
    if (m) kb.set(m[1], Number(m[2]));
  }
  const get = (k: string) => (kb.get(k) ?? 0) * 1024;
  const memTotal = get("MemTotal");
  const available = kb.has("MemAvailable")
    ? get("MemAvailable")
    : get("MemFree") + get("Buffers") + get("Cached") + get("SReclaimable") - get("Shmem");
  return {
    memTotal,
    memAvailable: Math.min(memTotal, Math.max(0, available)),
    swapTotal: get("SwapTotal"),
    swapFree: Math.min(get("SwapTotal"), get("SwapFree")),
  };
}

export function parseLoadavg(lines: string[]): [number, number, number] | null {
  const parts = (lines[0] ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1], parts[2]] : null;
}

export function parseUptime(lines: string[]): number | null {
  const n = Number((lines[0] ?? "").trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** /proc/net/dev: `iface: rx_bytes rx_packets ... (8 rx fields) tx_bytes ...`. */
export function parseNetDev(lines: string[]): Record<string, NicCounters> {
  const out: Record<string, NicCounters> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const fields = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (!name || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    out[name] = { rx: fields[0], tx: fields[8] };
  }
  return out;
}

const PSEUDO_FS = /^(rootfs|tmpfs|devtmpfs|udev|overlay|shm|none|proc|sysfs|cgroup2?|devfs|efivarfs)$/;
const PSEUDO_MOUNT = /^\/(dev|proc|sys|run|snap)(\/|$)|^\/var\/lib\/docker\/|^\/boot\/efi$/;

/**
 * `df -P -k` (1024-byte blocks). Pseudo / container file systems and squashfs snaps are
 * dropped; a long file system name may wrap onto its own line (handled).
 */
export function parseDf(lines: string[]): DiskUsage[] {
  const out: DiskUsage[] = [];
  const seen = new Set<string>();
  let pending = "";
  for (const raw of lines) {
    const line = pending ? `${pending} ${raw.trim()}` : raw.trim();
    if (/^Filesystem\s/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 6) {
      pending = parts.length === 1 ? line : "";
      continue;
    }
    pending = "";
    // Mount points may contain spaces: the first five fields are fixed.
    const [filesystem, size, used, avail, pct] = parts;
    const mount = parts.slice(5).join(" ");
    const sizeKb = Number(size);
    if (!Number.isFinite(sizeKb) || sizeKb <= 0) continue;
    if (PSEUDO_FS.test(filesystem) || PSEUDO_MOUNT.test(mount) || filesystem.startsWith("/dev/loop")) continue;
    // Bind mounts of the same device show up more than once.
    if (seen.has(filesystem) && filesystem.startsWith("/dev/")) continue;
    seen.add(filesystem);
    const usedB = (Number(used) || 0) * 1024;
    const availB = (Number(avail) || 0) * 1024;
    const pctN = Number(pct.replace("%", ""));
    out.push({
      filesystem,
      mount,
      size: sizeKb * 1024,
      used: usedB,
      avail: availB,
      percent: Number.isFinite(pctN) ? pctN : usedB + availB > 0 ? Math.round((usedB / (usedB + availB)) * 100) : 0,
    });
  }
  return out;
}

/** `dumpsys battery`: "  level: 87", "  status: 2", "  AC powered: true", "  temperature: 312". */
export function parseBattery(lines: string[]): BatteryInfo | null {
  const kv = new Map<string, string>();
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) kv.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const level = Number(kv.get("level"));
  const scale = Number(kv.get("scale")) || 100;
  if (!Number.isFinite(level) || !kv.has("level")) return null;
  const statuses: Record<string, string> = { "1": "unknown", "2": "charging", "3": "discharging", "4": "not charging", "5": "full" };
  const healths: Record<string, string> = { "1": "unknown", "2": "good", "3": "overheat", "4": "dead", "5": "over voltage", "6": "failure", "7": "cold" };
  const plugged = ["AC", "USB", "Wireless", "Dock"].filter((k) => kv.get(`${k.toLowerCase()} powered`) === "true").join(" / ");
  const temp = Number(kv.get("temperature"));
  return {
    level: Math.round((level / scale) * 100),
    status: statuses[kv.get("status") ?? ""] ?? "unknown",
    plugged,
    temperature: Number.isFinite(temp) && kv.has("temperature") ? temp / 10 : null,
    health: healths[kv.get("health") ?? ""] ?? "unknown",
  };
}

/** Parse one sampling script output. Non-Linux hosts (no /proc) report `supported: false`. */
export function parseServerSample(text: string, at: number): ParseResult {
  const sec = splitSections(text);
  if (sec.has("unsupported")) return { supported: false, os: (sec.get("unsupported") ?? [])[0] ?? "" };
  // Android 8+ hides /proc/stat from the shell user: CPU then stays unknown.
  const cpuLines = sec.get("cpu") ?? [];
  const memLines = sec.get("mem");
  if (!memLines) return { supported: false, os: "" };
  const { cpu, cores } = parseProcStat(cpuLines);
  const mem = parseMeminfo(memLines);
  if (!cpu && mem.memTotal === 0) return { supported: false, os: "" };
  return {
    supported: true,
    sample: {
      at,
      cpu,
      cores,
      ...mem,
      load: parseLoadavg(sec.get("load") ?? []),
      uptime: parseUptime(sec.get("uptime") ?? []),
      nics: parseNetDev(sec.get("net") ?? []),
      disks: parseDf(sec.get("df") ?? []),
      battery: sec.has("battery") ? parseBattery(sec.get("battery") ?? []) : null,
    },
  };
}

/** Interfaces that mirror traffic already counted elsewhere (loopback, bridges, veth ...). */
export function isVirtualNic(name: string): boolean {
  return /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan|kube-|tunl|dummy|ifb|lxcbr|vnet)/.test(name);
}

/** Seconds between two samples: server uptime when both have it, else the client clock. */
export function sampleInterval(prev: RawSample, cur: RawSample): number {
  if (prev.uptime != null && cur.uptime != null && cur.uptime > prev.uptime) return cur.uptime - prev.uptime;
  return Math.max(0, (cur.at - prev.at) / 1000);
}

function rate(prevV: number | undefined, curV: number, secs: number): number | null {
  if (prevV === undefined || secs <= 0 || curV < prevV) return null; // first sample / counter reset
  return (curV - prevV) / secs;
}

/** Stats from the latest sample and the one before it (null for the first sample). */
export function computeServerStats(prev: RawSample | null, cur: RawSample): ServerStats {
  // A reboot between samples resets every counter: treat it as a first sample.
  const usable = prev && !(prev.uptime != null && cur.uptime != null && cur.uptime < prev.uptime) ? prev : null;
  let cpuPercent: number | null = null;
  if (usable?.cpu && cur.cpu) {
    const dTotal = cur.cpu.total - usable.cpu.total;
    const dIdle = cur.cpu.idle - usable.cpu.idle;
    if (dTotal > 0 && dIdle >= 0) cpuPercent = Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
  }
  const secs = usable ? sampleInterval(usable, cur) : 0;
  const nics: NicStats[] = Object.entries(cur.nics).map(([name, c]) => ({
    name,
    rxRate: usable ? rate(usable.nics[name]?.rx, c.rx, secs) : null,
    txRate: usable ? rate(usable.nics[name]?.tx, c.tx, secs) : null,
    rxTotal: c.rx,
    txTotal: c.tx,
    virtual: isVirtualNic(name),
  }));
  nics.sort((a, b) => Number(a.virtual) - Number(b.virtual) || b.rxTotal + b.txTotal - (a.rxTotal + a.txTotal));
  const physical = nics.filter((n) => !n.virtual);
  const sum = (key: "rxRate" | "txRate") =>
    physical.length && physical.every((n) => n[key] != null) ? physical.reduce((a, n) => a + (n[key] ?? 0), 0) : null;
  const memUsed = Math.max(0, cur.memTotal - cur.memAvailable);
  const swapUsed = Math.max(0, cur.swapTotal - cur.swapFree);
  const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
  return {
    cpuPercent,
    cores: cur.cores,
    memTotal: cur.memTotal,
    memUsed,
    memPercent: pct(memUsed, cur.memTotal),
    swapTotal: cur.swapTotal,
    swapUsed,
    swapPercent: pct(swapUsed, cur.swapTotal),
    load: cur.load,
    uptime: cur.uptime,
    nics,
    rxRate: sum("rxRate"),
    txRate: sum("txRate"),
    disks: cur.disks,
    battery: cur.battery ?? null,
  };
}

/** 1023 B, 1.5 KB, 12 MB, 3.2 GB (binary units). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatRate(n: number | null): string {
  return n == null ? "-" : `${formatBytes(n)}/s`;
}

/** Uptime as "3d 4h", "5h 12m" or "7m". */
export function formatServerUptime(secs: number | null): string {
  if (secs == null) return "-";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
