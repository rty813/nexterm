import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

export async function packPlugin(directory, destination) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const names = new Set([manifest.main, ...(manifest.contributes?.views ?? []).map(view => view.file)]);
  const files = {};
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) throw new Error("Only flat plugin filenames are supported");
    files[name] = await readFile(resolve(root, name), "utf8");
  }
  const bundle = JSON.stringify({manifest, files});
  if (Buffer.byteLength(bundle) > 2 * 1024 * 1024) throw new Error("Plugin exceeds 2 MiB");
  const output = destination ? resolve(destination) : resolve(root, "..", `${basename(root)}.nexterm-plugin`);
  await mkdir(resolve(output, ".."), {recursive: true});
  await writeFile(output, bundle + "\n", "utf8");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/pack-plugin.mjs <plugin-directory> [output]");
  console.log(await packPlugin(process.argv[2], process.argv[3]));
}
