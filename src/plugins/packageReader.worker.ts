import { parsePackage, type PluginPackage } from "./model";

/** `code`: a message the host translates (plugin.<code>); `error` is the untranslated detail. */
export type PackageReadResult = {bundle: PluginPackage} | {error: string; code?: "tooLarge" | "invalidJson"};

class ReadError extends Error {
  constructor(readonly code: "tooLarge" | "invalidJson", message: string) { super(message); }
}

self.onmessage = async ({data: file}: MessageEvent<File>) => {
  let result: PackageReadResult;
  try {
    if (file.size > 2 * 1024 * 1024) throw new ReadError("tooLarge", "Plugin packages must not exceed 2 MiB");
    result = {bundle: parsePackage(JSON.parse(await file.text()))};
  } catch (reason) {
    result = reason instanceof ReadError ? {error: reason.message, code: reason.code}
      : reason instanceof SyntaxError ? {error: "The file is not a valid JSON plugin package", code: "invalidJson"}
      : {error: reason instanceof Error ? reason.message : String(reason)};
  }
  self.postMessage(result);
};
