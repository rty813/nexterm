import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStore, compareVersions, fingerprint, generateKey, publicKeyFromRaw, verifyStore } from "./plugin-store.mjs";

let root;
let key;
const store = () => join(root, "store");

async function plugin(name, { id = "test.demo", version = "1.0.0", body = "export {};", meta } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: `Demo ${version}`, version, main: "main.js", permissions: { network: [] }, contributes: {} }));
  await writeFile(join(dir, "main.js"), body);
  if (meta) await writeFile(join(dir, "store.json"), JSON.stringify(meta));
  return dir;
}
const build = (pluginDirs, options = {}) => buildStore({ storeDir: store(), privateKey: key.privateKey, pluginDirs, ...options });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nexterm-store-test-"));
  key = generateKey();
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("plugin store build", () => {
  it("publishes a signed index that verifies with the pinned public key", async () => {
    const meta = { description: { zh: "演示", en: "Demo" }, tags: ["x"] };
    const result = await build([await plugin("a", { meta })], { name: "Team store" });
    expect(result.changed).toBe(true);
    const bytes = await readFile(join(store(), "index.json"));
    const signature = Buffer.from(await readFile(join(store(), "index.json.sig"), "utf8"), "base64");
    expect(crypto.verify(null, bytes, publicKeyFromRaw(key.publicKey), signature)).toBe(true);
    const index = JSON.parse(bytes.toString("utf8"));
    expect(index).toMatchObject({ schema: 1, seq: 1, store: { name: "Team store", publicKey: key.publicKey }, revoked: [] });
    expect(index.plugins).toEqual([expect.objectContaining({ id: "test.demo", name: "Demo 1.0.0", description: meta.description, tags: ["x"] })]);
    const [version] = index.plugins[0].versions;
    const pkg = await readFile(join(store(), version.file));
    expect(version).toMatchObject({ version: "1.0.0", file: "packages/test.demo/1.0.0.nexterm-plugin", size: pkg.length, sha256: crypto.createHash("sha256").update(pkg).digest("hex") });
    await expect(verifyStore(store(), key.publicKey)).resolves.toMatchObject({ seq: 1 });
    expect(fingerprint(key.publicKey)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("leaves the index untouched when nothing changed", async () => {
    const dir = await plugin("a");
    await build([dir]);
    const before = await readFile(join(store(), "index.json"));
    const again = await build([dir]);
    expect(again.changed).toBe(false);
    expect(again.report).toEqual(["test.demo 1.0.0: already published"]);
    expect(await readFile(join(store(), "index.json"))).toEqual(before);
  });

  it("keeps older versions and bumps seq on a new version", async () => {
    await build([await plugin("a")]);
    const old = await readFile(join(store(), "packages/test.demo/1.0.0.nexterm-plugin"));
    const result = await build([await plugin("b", { version: "1.1.0" })]);
    expect(result.index.seq).toBe(2);
    expect(result.index.plugins[0].name).toBe("Demo 1.1.0");
    expect(result.index.plugins[0].versions.map((item) => item.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(await readFile(join(store(), "packages/test.demo/1.0.0.nexterm-plugin"))).toEqual(old);
  });

  it("refuses to change a published version or go backwards", async () => {
    await build([await plugin("a", { version: "1.1.0" })]);
    await expect(build([await plugin("b", { version: "1.1.0", body: "export const changed = 1;" })])).rejects.toThrow(/already published with different content/);
    await expect(build([await plugin("c", { version: "1.0.9" })])).rejects.toThrow(/older than the published 1.1.0/);
    await expect(build([await plugin("d", { version: "2" })])).rejects.toThrow(/not semver/);
    expect(JSON.parse(await readFile(join(store(), "index.json"), "utf8")).seq).toBe(1);
  });

  it("refuses a store signed by another key or a tampered folder", async () => {
    await build([await plugin("a")]);
    const other = generateKey();
    await expect(buildStore({ storeDir: store(), privateKey: other.privateKey, pluginDirs: [] })).rejects.toThrow(/another store key/);
    await expect(verifyStore(store(), other.publicKey)).rejects.toThrow(/another store key/);
    const file = join(store(), "packages/test.demo/1.0.0.nexterm-plugin");
    await writeFile(file, (await readFile(file, "utf8")).replace("export {};", "export {} ;"));
    await expect(verifyStore(store(), key.publicKey)).rejects.toThrow(/does not match the index/);
    const indexPath = join(store(), "index.json");
    await writeFile(indexPath, (await readFile(indexPath, "utf8")).replace('"seq": 1', '"seq": 9'));
    await expect(verifyStore(store(), key.publicKey)).rejects.toThrow(/signature does not verify/);
  });

  it("requires both Chinese and English descriptions", async () => {
    await expect(build([await plugin("a", { meta: { description: { zh: "只有中文" } } })])).rejects.toThrow(/both zh and en/);
  });
});

describe("compareVersions", () => {
  it("orders semantic versions", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(/semantic/);
  });
});
