import { describe, expect, it } from "vitest";
import {
  computeServerStats,
  formatBytes,
  formatRate,
  formatServerUptime,
  isVirtualNic,
  parseDf,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseServerSample,
  type RawSample,
} from "../utils/serverStats";

function output(o: { cpu: string; rx: number; tx: number; uptime: number; extra?: string }): string {
  return [
    "@@cpu",
    o.cpu,
    "cpu0 1 0 1 1 0 0 0 0 0 0",
    "cpu1 1 0 1 1 0 0 0 0 0 0",
    "@@mem",
    "MemTotal:        8000000 kB",
    "MemFree:         1000000 kB",
    "MemAvailable:    6000000 kB",
    "Buffers:          100000 kB",
    "SwapTotal:       2000000 kB",
    "SwapFree:        1500000 kB",
    "@@load",
    "0.52 0.40 0.35 2/345 12345",
    "@@net",
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    `    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0`,
    `  eth0: ${o.rx} 100 0 0 0 0 0 0 ${o.tx} 90 0 0 0 0 0 0`,
    `docker0: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0`,
    "@@uptime",
    `${o.uptime} 9000.00`,
    "@@df",
    "Filesystem     1024-blocks    Used Available Capacity Mounted on",
    "/dev/sda1         41152736 20576368  18463004      53% /",
    "tmpfs               816396     1508    814888       1% /run",
    "/dev/mapper/vg-very-long-logical-volume-name",
    "                 103081248 51540624  46281000      53% /data disk",
    "/dev/loop3           56832    56832         0     100% /snap/core18/2812",
    "overlay           41152736 20576368  18463004      53% /var/lib/docker/overlay2/abc/merged",
    o.extra ?? "",
    "@@end",
  ].join("\r\n");
}

const first = output({ cpu: "cpu  1000 0 500 8000 500 0 0 0 0 0", rx: 1_000_000, tx: 500_000, uptime: 100 });
const second = output({ cpu: "cpu  1300 0 600 8500 600 0 0 0 0 0", rx: 1_300_000, tx: 530_000, uptime: 103 });

function sample(text: string, at: number): RawSample {
  const r = parseServerSample(text, at);
  if (!r.supported) throw new Error("unsupported");
  return r.sample;
}

describe("parseServerSample", () => {
  it("parses every section", () => {
    const s = sample(first, 0);
    expect(s.cpu).toEqual({ total: 10000, idle: 8500 });
    expect(s.cores).toBe(2);
    expect(s.memTotal).toBe(8_000_000 * 1024);
    expect(s.memAvailable).toBe(6_000_000 * 1024);
    expect(s.load).toEqual([0.52, 0.4, 0.35]);
    expect(s.uptime).toBe(100);
    expect(Object.keys(s.nics)).toEqual(["lo", "eth0", "docker0"]);
    expect(s.nics.eth0).toEqual({ rx: 1_000_000, tx: 500_000 });
  });

  it("reports non-Linux hosts as unsupported", () => {
    expect(parseServerSample("@@unsupported Darwin\n", 0)).toEqual({ supported: false, os: "Darwin" });
    expect(parseServerSample("@@unsupported\n", 0)).toEqual({ supported: false, os: "" });
    expect(parseServerSample("garbage", 0).supported).toBe(false);
  });
});

describe("parsers", () => {
  it("estimates available memory on old kernels", () => {
    const m = parseMeminfo(["MemTotal: 1000 kB", "MemFree: 100 kB", "Buffers: 50 kB", "Cached: 300 kB", "SReclaimable: 50 kB", "Shmem: 20 kB"]);
    expect(m.memAvailable).toBe(480 * 1024);
    expect(m.swapTotal).toBe(0);
  });

  it("reads /proc/stat with or without per-core lines", () => {
    expect(parseProcStat(["cpu 1 2 3 4"])).toEqual({ cpu: { total: 10, idle: 4 }, cores: 0 });
    expect(parseProcStat([]).cpu).toBeNull();
  });

  it("skips malformed /proc/net/dev lines", () => {
    expect(parseNetDev(["eth0: 1 2 3", "bad line", "wlan0: 10 0 0 0 0 0 0 0 20"])).toEqual({ wlan0: { rx: 10, tx: 20 } });
  });

  it("filters pseudo file systems and joins wrapped df lines", () => {
    expect(parseDf(["Filesystem 1024-blocks Used Available Capacity Mounted on", "tmpfs 100 1 99 1% /dev/shm", "/dev/sdb1 0 0 0 - /mnt"])).toEqual([]);
    const s = sample(first, 0);
    expect(s.disks.map((d) => d.mount)).toEqual(["/", "/data disk"]);
    expect(s.disks[1].filesystem).toBe("/dev/mapper/vg-very-long-logical-volume-name");
    expect(s.disks[0]).toMatchObject({ size: 41152736 * 1024, percent: 53 });
  });
});

describe("computeServerStats", () => {
  it("has no rates on the first sample", () => {
    const st = computeServerStats(null, sample(first, 0));
    expect(st.cpuPercent).toBeNull();
    expect(st.rxRate).toBeNull();
    expect(st.memPercent).toBeCloseTo(25);
    expect(st.swapUsed).toBe(500_000 * 1024);
    expect(st.swapPercent).toBeCloseTo(25);
  });

  it("computes CPU usage and NIC rates over the server's uptime", () => {
    const a = sample(first, 0);
    // The client clock says 10 s (slow round trip); the server's uptime says 3 s.
    const b = sample(second, 10_000);
    const st = computeServerStats(a, b);
    // Δtotal = 1000, Δidle = 600 → 40 %.
    expect(st.cpuPercent).toBeCloseTo(40);
    const eth0 = st.nics.find((n) => n.name === "eth0")!;
    expect(eth0.rxRate).toBeCloseTo(100_000);
    expect(eth0.txRate).toBeCloseTo(10_000);
    expect(st.rxRate).toBeCloseTo(100_000);
    expect(st.nics[0].name).toBe("eth0");
    expect(st.nics.find((n) => n.name === "lo")!.virtual).toBe(true);
  });

  it("falls back to the client clock and survives counter resets", () => {
    const a = { ...sample(first, 0), uptime: null };
    const b = { ...sample(second, 2_000), uptime: null };
    expect(computeServerStats(a, b).nics.find((n) => n.name === "eth0")!.rxRate).toBeCloseTo(150_000);

    const reset = sample(output({ cpu: "cpu  10 0 5 80 5 0 0 0", rx: 10, tx: 10, uptime: 103 }), 3_000);
    const st = computeServerStats(sample(first, 0), reset);
    expect(st.nics.find((n) => n.name === "eth0")!.rxRate).toBeNull();
    expect(st.cpuPercent).toBeNull();

    // Reboot: uptime went backwards.
    const rebooted = sample(output({ cpu: "cpu  2000 0 900 9000 600 0 0 0", rx: 2_000_000, tx: 600_000, uptime: 5 }), 3_000);
    expect(computeServerStats(sample(first, 0), rebooted).rxRate).toBeNull();
  });
});

describe("formatting", () => {
  it("formats sizes, rates and uptime", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatRate(null)).toBe("-");
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatServerUptime(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatServerUptime(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(formatServerUptime(420)).toBe("7m");
    expect(isVirtualNic("veth12ab")).toBe(true);
    expect(isVirtualNic("enp3s0")).toBe(false);
  });
});
