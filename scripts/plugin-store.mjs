// Nexterm plugin store tooling. A store is a folder of static files:
//
//   index.json                                 catalog (plugins, versions, file paths, sha256)
//   index.json.sig                             base64 Ed25519 signature of the exact index.json bytes
//   packages/<id>/<version>.nexterm-plugin     package files; never changed once published
//
// Any server can host the folder (the relay serves it at /store/). Nexterm pins the store's public key
// the first time the store is added (by its address alone) and rejects any later index whose signature does
// not verify with that key, so the host is untrusted.
//
//   node scripts/plugin-store.mjs keygen --out <private-key-file>
//   node scripts/plugin-store.mjs build  --store <dir> --key <private-key-file> [--name <store name>] <plugin-dir>...
//   node scripts/plugin-store.mjs verify --store <dir> [--public-key <base64>]
//
// A plugin directory may hold store.json next to manifest.json:
//   {"description": {"zh": "…", "en": "…"}, "author": "…", "homepage": "https://…", "tags": ["…"]}

import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundlePlugin } from "./pack-plugin.mjs";
import { parsePackage } from "../src/plugins/model.ts";

export const INDEX = "index.json";
export const SIGNATURE = "index.json.sig";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Private keys are stored as base64 PKCS#8 DER (one line, fits a CI secret). */
export const loadPrivateKey = (text) => crypto.createPrivateKey({ key: Buffer.from(text.trim(), "base64"), format: "der", type: "pkcs8" });
/** The raw 32-byte Ed25519 public key, base64: what Nexterm pins. */
export const rawPublicKey = (privateKey) => crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
export const publicKeyFromRaw = (raw) => {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("Public key must be 32 bytes (base64)");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: "der", type: "spki" });
};
/** Short form shown to users for comparing keys out of band. */
export const fingerprint = (raw) => crypto.createHash("sha256").update(Buffer.from(raw, "base64")).digest("hex").slice(0, 16);
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function generateKey() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: rawPublicKey(privateKey) };
}

export function compareVersions(a, b) {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!x || !y) throw new Error(`Not a semantic version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const [p, q] = [x[4].split("."), y[4].split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (m !== n) return m ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

const exists = (path) => access(path).then(() => true, () => false);
async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

/** Reads and checks the signed index; throws when the signature, a hash or a package is wrong. */
export async function verifyStore(storeDir, publicKey) {
  const bytes = await readFile(join(storeDir, INDEX));
  const signature = Buffer.from((await readFile(join(storeDir, SIGNATURE), "utf8")).trim(), "base64");
  const index = JSON.parse(bytes.toString("utf8"));
  const key = publicKey ?? index.store?.publicKey;
  if (publicKey && index.store?.publicKey !== publicKey) throw new Error("Index was signed for another store key");
  if (!crypto.verify(null, bytes, publicKeyFromRaw(key), signature)) throw new Error("Index signature does not verify");
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const file = await readFile(join(storeDir, version.file));
      if (file.length !== version.size || sha256(file) !== version.sha256) throw new Error(`${version.file} does not match the index`);
      const bundle = parsePackage(JSON.parse(file.toString("utf8")));
      if (bundle.manifest.id !== plugin.id || bundle.manifest.version !== version.version) throw new Error(`${version.file} is not ${plugin.id} ${version.version}`);
    }
  }
  return index;
}

async function storeMetadata(directory) {
  const path = join(directory, "store.json");
  if (!(await exists(path))) return {};
  const value = JSON.parse(await readFile(path, "utf8"));
  const text = (item, limit) => typeof item === "string" && item.trim() && item.length <= limit;
  const out = {};
  if (value.description !== undefined) {
    if (!text(value.description?.zh, 500) || !text(value.description?.en, 500)) throw new Error(`${path}: description needs both zh and en`);
    out.description = { zh: value.description.zh, en: value.description.en };
  }
  if (value.author !== undefined) { if (!text(value.author, 100)) throw new Error(`${path}: invalid author`); out.author = value.author; }
  if (value.homepage !== undefined) { if (!text(value.homepage, 500) || new URL(value.homepage).protocol !== "https:") throw new Error(`${path}: homepage must be https`); out.homepage = value.homepage; }
  if (value.tags !== undefined) { if (!Array.isArray(value.tags) || value.tags.length > 8 || !value.tags.every((tag) => text(tag, 32))) throw new Error(`${path}: invalid tags`); out.tags = value.tags; }
  return out;
}

/** Fixed key and list order, so unchanged content serializes to the same bytes. */
function normalize(index) {
  const plugins = [...index.plugins]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(({ id, name, description, author, homepage, tags, versions }) => ({
      id, name, description, author, homepage, tags,
      versions: [...versions].sort((a, b) => compareVersions(b.version, a.version)).map(({ version, apiVersion, file, sha256, size, published, permissions }) => ({ version, apiVersion, file, sha256, size, published, permissions })),
    }));
  return JSON.parse(JSON.stringify({ schema: 1, seq: index.seq, generated: index.generated, store: { name: index.store.name, publicKey: index.store.publicKey }, plugins, revoked: index.revoked ?? [] }));
}

/**
 * Adds the given plugin directories to the store folder and re-signs the index when anything changed.
 * Published files are append-only: a version already in the index must produce identical bytes, and a
 * version lower than the newest published one is refused.
 */
export async function buildStore({ storeDir, privateKey, name, pluginDirs, now = new Date() }) {
  const key = typeof privateKey === "string" ? loadPrivateKey(privateKey) : privateKey;
  const publicKey = rawPublicKey(key);
  const hasIndex = await exists(join(storeDir, INDEX));
  const previous = hasIndex
    ? await verifyStore(storeDir, publicKey)
    : { schema: 1, seq: 0, generated: "", store: { name: name ?? "Nexterm plugins", publicKey }, plugins: [], revoked: [] };
  const index = structuredClone(previous);
  if (name) index.store.name = name;
  const report = [];
  const seen = new Set();
  for (const directory of pluginDirs) {
    const text = await bundlePlugin(directory);
    const bytes = Buffer.from(text, "utf8");
    const { manifest } = parsePackage(JSON.parse(text));
    if (seen.has(manifest.id)) throw new Error(`${manifest.id} given twice`);
    seen.add(manifest.id);
    if (!SEMVER.test(manifest.version)) throw new Error(`${manifest.id}: version ${manifest.version} is not semver (x.y.z)`);
    const metadata = await storeMetadata(directory);
    let plugin = index.plugins.find((item) => item.id === manifest.id);
    if (!plugin) {
      plugin = { id: manifest.id, versions: [] };
      index.plugins.push(plugin);
    }
    const file = `packages/${manifest.id}/${manifest.version}.nexterm-plugin`;
    const entry = { version: manifest.version, apiVersion: manifest.apiVersion, file, sha256: sha256(bytes), size: bytes.length, published: now.toISOString(), permissions: manifest.permissions };
    const same = plugin.versions.find((item) => item.version === manifest.version);
    if (same) {
      if (same.sha256 !== entry.sha256) throw new Error(`${manifest.id} ${manifest.version} is already published with different content; raise the version`);
      report.push(`${manifest.id} ${manifest.version}: already published`);
    } else {
      const newest = plugin.versions[0];
      if (newest && compareVersions(manifest.version, newest.version) < 0) throw new Error(`${manifest.id} ${manifest.version} is older than the published ${newest.version}`);
      const target = join(storeDir, file);
      if (await exists(target)) {
        if (sha256(await readFile(target)) !== entry.sha256) throw new Error(`${file} exists with different content`);
      } else await writeAtomic(target, bytes);
      plugin.versions.unshift(entry);
      report.push(`${manifest.id} ${manifest.version}: published`);
    }
    // The listing shows the newest version's name.
    if (!same || !plugin.name) plugin.name = manifest.name;
    for (const field of ["description", "author", "homepage", "tags"]) {
      if (metadata[field] === undefined) delete plugin[field];
      else plugin[field] = metadata[field];
    }
  }
  const ordered = normalize(index);
  if (hasIndex && JSON.stringify(ordered) === JSON.stringify(normalize(previous))) return { index: previous, changed: false, report, publicKey };
  ordered.seq = previous.seq + 1;
  ordered.generated = now.toISOString();
  const bytes = Buffer.from(JSON.stringify(ordered, null, 2) + "\n", "utf8");
  // Signature first: a reader that sees the new index alongside the old signature fails closed and retries.
  await writeAtomic(join(storeDir, `${SIGNATURE}.next`), crypto.sign(null, bytes, key).toString("base64"));
  await writeAtomic(join(storeDir, INDEX), bytes);
  await rename(join(storeDir, `${SIGNATURE}.next`), join(storeDir, SIGNATURE));
  await verifyStore(storeDir, publicKey);
  return { index: ordered, changed: true, report, publicKey };
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) options[argv[i].slice(2)] = argv[++i];
    else options.positional.push(argv[i]);
  }
  return options;
}

async function main([command, ...rest]) {
  const options = parseArgs(rest);
  if (command === "keygen") {
    if (!options.out) throw new Error("keygen needs --out <private-key-file>");
    if (await exists(options.out)) throw new Error(`${options.out} already exists; refusing to overwrite a signing key`);
    const { privateKey, publicKey } = generateKey();
    await mkdir(dirname(resolve(options.out)), { recursive: true });
    await writeFile(options.out, privateKey + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Private key: ${resolve(options.out)} (keep it off the store server and out of git)`);
    console.log(`Public key:  ${publicKey}`);
    console.log(`Fingerprint: ${fingerprint(publicKey)}`);
  } else if (command === "build") {
    if (!options.store || !options.key || !options.positional.length) throw new Error("build needs --store <dir> --key <file> <plugin-dir>...");
    const result = await buildStore({ storeDir: resolve(options.store), privateKey: await readFile(options.key, "utf8"), name: options.name, pluginDirs: options.positional });
    for (const line of result.report) console.log(line);
    console.log(result.changed ? `Signed index seq ${result.index.seq}` : "Nothing changed; index left as is");
    console.log(`Store key fingerprint: ${fingerprint(result.publicKey)}`);
  } else if (command === "verify") {
    if (!options.store) throw new Error("verify needs --store <dir>");
    const index = await verifyStore(resolve(options.store), options["public-key"]);
    console.log(`OK: "${index.store.name}" seq ${index.seq}, ${index.plugins.length} plugins, key ${fingerprint(index.store.publicKey)}${options["public-key"] ? "" : " (key taken from the index itself)"}`);
  } else {
    throw new Error("Usage: node scripts/plugin-store.mjs keygen|build|verify … (see the header of this file)");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  });
}
