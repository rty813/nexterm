import { describe, expect, it } from "vitest";
import { autoSyncInterval, exportFileName, syncErrorKey, syncReady } from "../utils/configSync";
import { DEFAULT_SYNC, syncOf } from "../utils/settingsDefaults";
import type { AppSettings } from "../types/domain";

describe("config sync helpers", () => {
  it("maps backend codes to i18n keys", () => {
    expect(syncErrorKey("badPassword")).toBe("cfgSync.err.badPassword");
    expect(syncErrorKey("S3 GET: HTTP 403 Forbidden")).toBeNull();
    expect(syncErrorKey(undefined)).toBeNull();
  });

  it("checks required fields per provider", () => {
    expect(syncReady(DEFAULT_SYNC)).toBe(false);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "s3", s3: { ...DEFAULT_SYNC.s3, bucket: "b", accessKeyId: "k" } })).toBe(false);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "s3", s3: { ...DEFAULT_SYNC.s3, bucket: "b", accessKeyId: "k", secretAccessKey: "s" } })).toBe(true);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "webdav", webdav: { url: "dav.example.com", username: "", password: "" } })).toBe(false);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "webdav", webdav: { url: "https://dav.example.com/x", username: "", password: "" } })).toBe(true);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "folder", folder: { path: "D:\\OneDrive\\nexterm" } })).toBe(true);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "gist" })).toBe(false);
    expect(syncReady({ ...DEFAULT_SYNC, provider: "gist", gist: { token: "ghp_x", gistId: "", apiUrl: "" } })).toBe(true);
  });

  it("auto sync interval has a 5 minute floor", () => {
    const folder = { ...DEFAULT_SYNC, provider: "folder" as const, folder: { path: "D:\\x" } };
    expect(autoSyncInterval(folder)).toBeNull();
    expect(autoSyncInterval({ ...folder, autoSync: true, intervalMin: 0 })).toBeNull();
    expect(autoSyncInterval({ ...folder, autoSync: true, intervalMin: 1 })).toBe(5 * 60_000);
    expect(autoSyncInterval({ ...folder, autoSync: true, intervalMin: 30 })).toBe(30 * 60_000);
  });

  it("fills missing nested fields from defaults", () => {
    const s = syncOf({ sync: { provider: "webdav", webdav: { url: "https://x" } } } as unknown as AppSettings);
    expect(s.provider).toBe("webdav");
    expect(s.webdav).toEqual({ url: "https://x", username: "", password: "" });
    expect(s.s3.prefix).toBe("nexterm");
    expect(s.categories).toHaveLength(6);
  });

  it("names export files by time", () => {
    expect(exportFileName(new Date(2026, 10, 5, 9, 3))).toBe("nexterm-config-20261105-0903.json");
  });
});
