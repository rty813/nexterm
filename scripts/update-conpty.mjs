// Refresh the bundled ConPTY (src-tauri/resources/conpty) from Microsoft's NuGet package
// Microsoft.Windows.Console.ConPTY, the conpty.dll + OpenConsole.exe Windows Terminal ships.
//
//   node scripts/update-conpty.mjs            latest stable release
//   node scripts/update-conpty.mjs 1.25.261109001
//
// Layout (local_pty.rs loads conpty.dll; conpty.dll starts <arch>\OpenConsole.exe from
// its own folder): conpty.dll (x64, the app is built for x64), x64/OpenConsole.exe and
// arm64/OpenConsole.exe (x64 apps on ARM64 Windows get the native console host).
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ID = "microsoft.windows.console.conpty";
const FEED = `https://api.nuget.org/v3-flatcontainer/${ID}`;
const DEST = resolve(import.meta.dirname, "../src-tauri/resources/conpty");

async function latestStable() {
  const res = await fetch(`${FEED}/index.json`);
  if (!res.ok) throw new Error(`NuGet index: HTTP ${res.status}`);
  const { versions } = await res.json();
  const stable = versions.filter((v) => !v.includes("-"));
  if (!stable.length) throw new Error("no stable release on NuGet");
  return stable[stable.length - 1];
}

/** Fails unless the file carries a valid Authenticode signature from Microsoft. */
function checkSignature(file) {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
    { encoding: "utf8" },
  ).trim();
  const [status, subject = ""] = out.split("|");
  if (status !== "Valid" || !subject.startsWith("CN=Microsoft Corporation,")) {
    throw new Error(`${file}: signature ${status} ${subject}`);
  }
}

const version = process.argv[2] || (await latestStable());
const work = await mkdtemp(join(tmpdir(), "nexterm-conpty-"));
try {
  const pkg = join(work, "pkg.zip");
  const res = await fetch(`${FEED}/${version}/${ID}.${version}.nupkg`);
  if (!res.ok) throw new Error(`download ${version}: HTTP ${res.status}`);
  await writeFile(pkg, Buffer.from(await res.arrayBuffer()));
  const x = join(work, "x");
  await mkdir(x);
  // Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not.
  execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", pkg, "-C", x]);

  const files = [
    [join(x, "runtimes/win-x64/native/conpty.dll"), "conpty.dll"],
    [join(x, "build/native/runtimes/x64/OpenConsole.exe"), "x64/OpenConsole.exe"],
    [join(x, "build/native/runtimes/arm64/OpenConsole.exe"), "arm64/OpenConsole.exe"],
  ];
  for (const [src] of files) checkSignature(src);

  await rm(DEST, { recursive: true, force: true });
  for (const dir of ["x64", "arm64"]) await mkdir(join(DEST, dir), { recursive: true });
  for (const [src, rel] of files) await copyFile(src, join(DEST, rel));
  await writeFile(
    join(DEST, "LICENSE.txt"),
    `Microsoft.Windows.Console.ConPTY ${version}
Copyright (c) Microsoft Corporation

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  );
  console.log(`ConPTY ${version} -> ${DEST}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
