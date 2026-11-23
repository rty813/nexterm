// Refresh the bundled scrcpy server (src-tauri/resources/scrcpy) from Genymobile/scrcpy's
// GitHub releases. The ADB screen mirror (src-tauri/src/adb/scrcpy.rs) pushes this file to
// the device and runs it; the client must announce the same version, kept in version.txt.
//
//   node scripts/update-scrcpy.mjs          latest release
//   node scripts/update-scrcpy.mjs 3.3.3
//
// The release lists a SHA-256 for each asset (GitHub's `digest`); the download must match.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = "Genymobile/scrcpy";
const DEST = resolve(import.meta.dirname, "../src-tauri/resources/scrcpy");
const headers = { "User-Agent": "nexterm-build", Accept: "application/vnd.github+json" };

const tag = process.argv[2] ? `v${process.argv[2].replace(/^v/, "")}` : null;
const res = await fetch(`https://api.github.com/repos/${REPO}/releases/${tag ? `tags/${tag}` : "latest"}`, { headers });
if (!res.ok) throw new Error(`GitHub release: HTTP ${res.status}`);
const release = await res.json();
const version = release.tag_name.replace(/^v/, "");
const asset = release.assets.find((a) => a.name === `scrcpy-server-v${version}`);
if (!asset) throw new Error(`release ${release.tag_name} has no scrcpy-server asset`);

const bin = Buffer.from(await (await fetch(asset.browser_download_url, { headers })).arrayBuffer());
const sha = createHash("sha256").update(bin).digest("hex");
const expected = (asset.digest || "").replace(/^sha256:/, "");
if (!expected) throw new Error("GitHub did not give a digest for the asset");
if (sha !== expected) throw new Error(`SHA-256 mismatch: got ${sha}, release says ${expected}`);

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });
await writeFile(join(DEST, "scrcpy-server"), bin);
await writeFile(join(DEST, "version.txt"), `${version}\n`);
await writeFile(
  join(DEST, "LICENSE.txt"),
  `scrcpy-server ${version} (https://github.com/${REPO}), SHA-256 ${sha}
Copyright (C) 2018 Genymobile
Copyright (C) 2018-2025 Romain Vimont

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`,
);
console.log(`scrcpy-server ${version} -> ${DEST} (sha256 ${sha})`);
