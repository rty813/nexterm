import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  FileText,
  Maximize,
  Minimize2,
  PencilLine,
  RotateCw,
  Server,
  WrapText,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { backend } from "../services/backend";
import type { PreviewJob, PreviewResult } from "../services/previewWorker";
import { fmtSize, PREVIEW_LIMIT, previewKind, TABLE_ROW_LIMIT, type PreviewKind } from "../utils/sftpPaths";

export interface PreviewRequest {
  instanceId: string;
  /** Session name shown on the tab (several sessions may be previewed at once). */
  sessionLabel: string;
  path: string;
  name: string;
  size: number;
}

type Content =
  | { state: "loading" }
  | { state: "tooLarge"; size: number; limit: number }
  | { state: "unsupported" }
  | { state: "binary" }
  | { state: "error"; message: string }
  | { state: "ready"; text?: string; html?: string; rows?: string[][]; truncated?: boolean; encoding?: string; jsonError?: string; url?: string };

interface Tab extends PreviewRequest {
  key: string;
  kind: PreviewKind | null;
  content: Content;
}

// One decoder for all previews, created on first use.
let worker: Worker | null = null;
let nextJob = 1;
const pending = new Map<number, (r: PreviewResult) => void>();

function decodeOffThread(kind: PreviewKind, bytes: ArrayBuffer): Promise<PreviewResult> {
  if (!worker) {
    worker = new Worker(new URL("../services/previewWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<PreviewResult>) => {
      pending.get(ev.data.id)?.(ev.data);
      pending.delete(ev.data.id);
    };
  }
  const id = nextJob++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, kind, bytes } satisfies PreviewJob, [bytes]);
  });
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

async function load(tab: Tab): Promise<Content> {
  const kind = tab.kind;
  if (!kind) return { state: "unsupported" };
  const limit = PREVIEW_LIMIT[kind];
  if (tab.size > limit) return { state: "tooLarge", size: tab.size, limit };
  let bytes: ArrayBuffer;
  try {
    bytes = await backend.sftpRead(tab.instanceId, tab.path, limit);
  } catch (e) {
    const msg = String(e);
    const big = /TOO_LARGE:(\d+)/.exec(msg);
    if (big) return { state: "tooLarge", size: Number(big[1]), limit };
    return { state: "error", message: msg };
  }
  if (kind === "image" || kind === "pdf") {
    const ext = tab.name.toLowerCase().split(".").pop() ?? "";
    // SVG shown through <img>: scripts inside never run.
    const type = kind === "pdf" ? "application/pdf" : MIME[ext] ?? "application/octet-stream";
    return { state: "ready", url: URL.createObjectURL(new Blob([bytes], { type })) };
  }
  const r = await decodeOffThread(kind, bytes);
  if (!r.ok) return r.error === "binary" ? { state: "binary" } : { state: "error", message: r.detail ?? r.error };
  const { id: _id, ok: _ok, ...rest } = r;
  return { state: "ready", ...rest };
}

/**
 * Read-only previews of remote files, one tab per file (from any session). Loading and
 * decoding happen off the UI thread; each format has a size limit.
 */
export const FilePreview: React.FC<{
  requests: PreviewRequest[];
  onClose: () => void;
  onCloseOne: (path: string, instanceId: string) => void;
  onDownload: (req: PreviewRequest) => void;
  onEdit: (req: PreviewRequest) => void;
}> = ({ requests, onClose, onCloseOne, onDownload, onEdit }) => {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Record<string, number>>({});
  const [rotate, setRotate] = useState<Record<string, number>>({});
  const [fit, setFit] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const urls = useRef<string[]>([]);

  // New requests open a tab (or focus an open one) and start loading.
  const started = useRef(new Set<string>());
  useEffect(() => {
    const keyOf = (r: PreviewRequest) => `${r.instanceId}:${r.path}`;
    const wanted = new Set(requests.map(keyOf));
    started.current.forEach((k) => !wanted.has(k) && started.current.delete(k));
    const fresh: Tab[] = requests
      .filter((r) => !started.current.has(keyOf(r)))
      .map((r) => ({ ...r, key: keyOf(r), kind: previewKind(r.name), content: { state: "loading" } }));
    fresh.forEach((tab) => {
      started.current.add(tab.key);
      void load(tab).then((content) => {
        if (content.state === "ready" && content.url) urls.current.push(content.url);
        setTabs((cur) => cur.map((x) => (x.key === tab.key ? { ...x, content } : x)));
      });
    });
    setTabs((prev) => [...prev.filter((tab) => wanted.has(tab.key)), ...fresh]);
    const last = requests[requests.length - 1];
    if (last) setActive(`${last.instanceId}:${last.path}`);
  }, [requests]);

  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    []
  );

  const tab = tabs.find((x) => x.key === active) ?? tabs[tabs.length - 1];
  const z = tab ? zoom[tab.key] ?? 1 : 1;
  const setZ = (v: number) => tab && setZoom((m) => ({ ...m, [tab.key]: Math.min(8, Math.max(0.1, v)) }));
  const isImage = tab?.kind === "image" && tab.content.state === "ready";
  const isText = tab?.content.state === "ready" && !isImage && tab.kind !== "pdf";
  const fitOn = tab ? fit[tab.key] ?? true : true;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!tab || !(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") (e.preventDefault(), setZ(z * 1.2));
      if (e.key === "-") (e.preventDefault(), setZ(z / 1.2));
      if (e.key === "0") (e.preventDefault(), setZ(1));
      if (e.key.toLowerCase() === "w") (e.preventDefault(), onCloseOne(tab.path, tab.instanceId));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const body = useMemo(() => {
    if (!tab) return null;
    const c = tab.content;
    switch (c.state) {
      case "loading":
        return <div className="preview-msg">{t("sftp.preview.loading")}</div>;
      case "tooLarge":
        return (
          <div className="preview-msg">
            <p>{t("sftp.preview.tooLarge", { size: fmtSize(c.size), limit: fmtSize(c.limit) })}</p>
            <PreviewActions tab={tab} />
          </div>
        );
      case "unsupported":
      case "binary":
        return (
          <div className="preview-msg">
            <p>{c.state === "binary" ? t("sftp.preview.binary") : t("sftp.preview.unsupported")}</p>
            <PreviewActions tab={tab} />
          </div>
        );
      case "error":
        return <div className="preview-msg warn">{c.message}</div>;
    }
    if (tab.kind === "image") {
      const r = rotate[tab.key] ?? 0;
      return (
        <div className={`preview-image ${fitOn ? "fit" : ""}`}>
          <img
            src={c.url}
            alt={tab.name}
            decoding="async"
            style={{ transform: `rotate(${r}deg) scale(${fitOn ? 1 : z})` }}
            draggable={false}
          />
        </div>
      );
    }
    // WebView2's PDF viewer: pages, zoom and search of its own.
    if (tab.kind === "pdf") return <iframe className="preview-pdf" src={c.url} title={tab.name} />;
    const font = { fontSize: `${Math.round(12.5 * z)}px` };
    if (c.rows) {
      const [head, ...rest] = c.rows;
      return (
        <div className="preview-table-wrap" style={font}>
          <table className="preview-table">
            {head && (
              <thead>
                <tr>
                  <th className="row-no">#</th>
                  {head.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rest.map((row, i) => (
                <tr key={i}>
                  <td className="row-no">{i + 1}</td>
                  {row.map((cell, k) => (
                    <td key={k}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {c.truncated && <div className="preview-note">{t("sftp.preview.truncated", { rows: TABLE_ROW_LIMIT })}</div>}
        </div>
      );
    }
    if (c.html !== undefined) {
      // renderMarkdown escapes everything first: only its own tags remain.
      return <article className="preview-markdown" style={font} dangerouslySetInnerHTML={{ __html: c.html }} />;
    }
    return (
      <>
        {c.jsonError && <div className="preview-note warn">{t("sftp.preview.jsonError", { error: c.jsonError })}</div>}
        <pre className={`preview-text ${wrap ? "wrap" : ""}`} style={font}>
          {c.text}
        </pre>
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, z, rotate, fitOn, wrap, t]);

  if (tabs.length === 0) return null;

  function PreviewActions({ tab }: { tab: Tab }) {
    return (
      <div className="preview-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={() => onDownload(tab)}>
          <Download size={12} /> {t("sftp.download")}
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => onEdit(tab)}>
          <PencilLine size={12} /> {t("sftp.editLocal")}
        </button>
      </div>
    );
  }

  return (
    <div className="modal-backdrop preview-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal-panel preview-panel ${maximized ? "maximized" : ""}`}>
        <div className="preview-tabs">
          {tabs.map((x) => (
            <div
              key={x.key}
              className={`preview-tab ${x.key === tab?.key ? "active" : ""}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseOne(x.path, x.instanceId);
                } else setActive(x.key);
              }}
              title={`${x.sessionLabel}: ${x.path}`}
            >
              <FileText size={12} />
              <span className="preview-tab-name">{x.name}</span>
              <span className="preview-tab-session">
                <Server size={10} /> {x.sessionLabel}
              </span>
              <button
                type="button"
                className="icon-btn-xs"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onCloseOne(x.path, x.instanceId)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <span className="preview-tabs-spacer" />
          <button type="button" className="icon-btn-xs" title={maximized ? t("sftp.preview.restore") : t("sftp.preview.maximize")} onClick={() => setMaximized((v) => !v)}>
            {maximized ? <Minimize2 size={13} /> : <Maximize size={13} />}
          </button>
          <button type="button" className="icon-btn-xs" title={t("forward.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {tab && (
          <div className="preview-toolbar">
            <span className="mono preview-path" title={tab.path}>
              {tab.path}
            </span>
            <span className="muted">{fmtSize(tab.size)}</span>
            {tab.content.state === "ready" && tab.content.encoding && <span className="muted">{tab.content.encoding}</span>}
            <span className="preview-tools">
              {(isText || isImage) && (
                <>
                  <button type="button" className="icon-btn-xs" title={t("sftp.preview.zoomOut")} onClick={() => (isImage && setFit((m) => ({ ...m, [tab.key]: false })), setZ(z / 1.2))}>
                    <ZoomOut size={13} />
                  </button>
                  <span className="preview-zoom" onDoubleClick={() => setZ(1)}>
                    {isImage && fitOn ? t("sftp.preview.fit") : `${Math.round(z * 100)}%`}
                  </span>
                  <button type="button" className="icon-btn-xs" title={t("sftp.preview.zoomIn")} onClick={() => (isImage && setFit((m) => ({ ...m, [tab.key]: false })), setZ(z * 1.2))}>
                    <ZoomIn size={13} />
                  </button>
                </>
              )}
              {isImage && (
                <>
                  <button
                    type="button"
                    className={`icon-btn-xs ${fitOn ? "active" : ""}`}
                    title={t("sftp.preview.fit")}
                    onClick={() => setFit((m) => ({ ...m, [tab.key]: !fitOn }))}
                  >
                    <Maximize size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn-xs"
                    title={t("sftp.preview.rotate")}
                    onClick={() => setRotate((m) => ({ ...m, [tab.key]: ((m[tab.key] ?? 0) + 90) % 360 }))}
                  >
                    <RotateCw size={13} />
                  </button>
                </>
              )}
              {tab.content.state === "ready" && isText && !tab.content.rows && tab.content.html === undefined && (
                <button type="button" className={`icon-btn-xs ${wrap ? "active" : ""}`} title={t("sftp.preview.wrap")} onClick={() => setWrap((v) => !v)}>
                  <WrapText size={13} />
                </button>
              )}
              <button type="button" className="icon-btn-xs" title={t("sftp.download")} onClick={() => onDownload(tab)}>
                <Download size={13} />
              </button>
              <button type="button" className="icon-btn-xs" title={t("sftp.editLocal")} onClick={() => onEdit(tab)}>
                <PencilLine size={13} />
              </button>
            </span>
          </div>
        )}
        <div className="preview-body">{body}</div>
      </div>
    </div>
  );
};
