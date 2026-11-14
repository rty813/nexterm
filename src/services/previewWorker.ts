/// <reference lib="webworker" />
/**
 * Decodes file previews off the UI thread: character set, binary check, JSON pretty
 * printing, CSV / TSV parsing and Markdown rendering.
 */
import { renderMarkdown } from "../utils/markdownLite";
import { looksBinary, parseDelimited, type PreviewKind } from "../utils/sftpPaths";

export interface PreviewJob {
  id: number;
  kind: PreviewKind;
  bytes: ArrayBuffer;
}

export type PreviewResult =
  | { id: number; ok: true; text?: string; html?: string; rows?: string[][]; truncated?: boolean; encoding?: string; jsonError?: string }
  | { id: number; ok: false; error: "binary" | "decode"; detail?: string };

function decode(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    // Chinese servers often write GBK / GB18030 logs and configs.
    return { text: new TextDecoder("gb18030").decode(bytes), encoding: "GB18030" };
  }
}

self.onmessage = (ev: MessageEvent<PreviewJob>) => {
  const { id, kind, bytes } = ev.data;
  const post = (r: PreviewResult) => (self as unknown as Worker).postMessage(r);
  try {
    const data = new Uint8Array(bytes);
    if (looksBinary(data)) return post({ id, ok: false, error: "binary" });
    const { text, encoding } = decode(data);
    switch (kind) {
      case "json": {
        try {
          return post({ id, ok: true, text: JSON.stringify(JSON.parse(text), null, 2), encoding });
        } catch (e) {
          // Shown as plain text with the parse error (JSONC, NDJSON, broken files).
          return post({ id, ok: true, text, encoding, jsonError: String((e as Error).message) });
        }
      }
      case "markdown":
        return post({ id, ok: true, html: renderMarkdown(text), text, encoding });
      case "csv":
      case "tsv": {
        const { rows, truncated } = parseDelimited(text, kind === "csv" ? "," : "\t");
        return post({ id, ok: true, rows, truncated, encoding });
      }
      default:
        return post({ id, ok: true, text, encoding });
    }
  } catch (e) {
    post({ id, ok: false, error: "decode", detail: String(e) });
  }
};
