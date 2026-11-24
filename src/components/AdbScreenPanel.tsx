import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Camera,
  CircleStop,
  ChevronLeft,
  Circle,
  ClipboardPaste,
  Menu,
  MonitorOff,
  Power,
  RotateCw,
  Smartphone,
  Square,
  Video,
  Volume1,
  Volume2,
  X,
} from "lucide-react";
import { adb, mirrorOptions, type MirrorQuality } from "../services/adb";
import { backend } from "../services/backend";
import type { MirrorInput, MirrorRecordResult } from "../types/domain";
import { KEYCODE, avcCodecString, fitBox, joinBytes, keycodeFor, metaState, parseMirrorPacket, textFor, toDevice } from "../utils/adbScreen";

interface Target {
  /** A device by serial (sidebar), not through an open pane. */
  serial?: string;
  paneId: string;
  title: string;
  summary: string;
  /** Reached through an SSH pane (a remote host): starts at low quality. */
  remote?: boolean;
}

type Phase = { kind: "starting" } | { kind: "running" } | { kind: "error"; message: string } | { kind: "unsupported" };

/**
 * Screen mirror of an ADB pane's device, in a side panel: scrcpy's server streams H.264
 * (`adb/scrcpy.rs`), decoded here with WebCodecs onto a canvas; pointer, wheel and keys go
 * back as control messages.
 */
export const AdbScreenPanel: React.FC<{
  targets: Target[];
  paneId: string;
  onPane: (paneId: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}> = ({ targets, paneId, onPane, onToast, onClose }) => {
  const { t } = useTranslation();
  const current = targets.find((x) => x.paneId === paneId) ?? null;
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [video, setVideo] = useState({ w: 0, h: 0 });
  const videoRef = useRef(video);
  videoRef.current = video;
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [deviceName, setDeviceName] = useState("");
  const [screenOff, setScreenOff] = useState(false);
  const [width, setWidth] = useState(360);
  /** Recording since (ms), null when not recording. */
  const [recording, setRecording] = useState<number | null>(null);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const [, setTick] = useState(0);
  // Quality per target (paneId), remembered for this panel; remote devices start low.
  const [qualities, setQualities] = useState<Record<string, MirrorQuality>>({});
  const quality: MirrorQuality = current ? (qualities[current.paneId] ?? (current.remote ? "low" : "high")) : "high";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const mirrorId = useRef(`mirror-${Math.random().toString(36).slice(2, 10)}`);
  const pointerDown = useRef(false);

  const send = useCallback((events: MirrorInput[]) => adb.mirrorInput(mirrorId.current, events), []);

  // ---- stream: (re)start when the pane changes
  useEffect(() => {
    if (!current) return;
    if (typeof VideoDecoder === "undefined") {
      setPhase({ kind: "unsupported" });
      return;
    }
    const id = `mirror-${Math.random().toString(36).slice(2, 10)}`;
    mirrorId.current = id;
    setPhase({ kind: "starting" });
    let config: Uint8Array | null = null;
    let configured = false;
    let decoded = 0;
    let received = 0;
    let disposed = false;

    const decoder = new VideoDecoder({
      output: (frame) => {
        const canvas = canvasRef.current;
        if (canvas) {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          canvas.getContext("2d")?.drawImage(frame, 0, 0);
        }
        frame.close();
        decoded++;
        adb.mirrorAck(id, decoded);
      },
      error: (e) => {
        if (!disposed) setPhase({ kind: "error", message: String(e) });
      },
    });

    const onPacket = (buf: ArrayBuffer) => {
      if (disposed) return;
      received++;
      const p = parseMirrorPacket(buf);
      if (!p) return;
      if (p.kind === "session") {
        setVideo({ w: p.width, h: p.height });
        // A new size: the encoder restarts with a new config; ack what did not decode.
        configured = false;
        decoded = received;
        adb.mirrorAck(id, decoded);
        return;
      }
      if (p.kind === "config") {
        config = p.data.slice();
        if (decoder.state !== "closed") {
          decoder.configure({ codec: avcCodecString(config), optimizeForLatency: true });
          configured = true;
        }
        decoded = received;
        adb.mirrorAck(id, decoded);
        return;
      }
      if (!configured || decoder.state !== "configured") {
        decoded = received;
        adb.mirrorAck(id, decoded);
        return;
      }
      const data = p.key ? joinBytes(config, p.data) : p.data.slice();
      decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.pts, data }));
    };

    void adb
      .mirrorStart(id, targetOf(current), mirrorOptions(quality), onPacket)
      .then((info) => {
        if (disposed) return;
        setDeviceName(info.deviceName);
        setVideo({ w: info.width, h: info.height });
        setPhase({ kind: "running" });
      })
      .catch((e) => !disposed && setPhase({ kind: "error", message: String(e) }));

    const ended = adb.onMirrorEnded((p) => {
      if (p.mirrorId === id && !disposed) setPhase(p.message ? { kind: "error", message: p.message } : { kind: "error", message: t("mirror.ended") });
    });
    const recorded = adb.onMirrorRecorded((p) => {
      if (p.mirrorId !== id) return;
      setRecording(null);
      reportRecording(p.result, p.message);
    });
    const clip = adb.onMirrorClipboard((p) => {
      if (p.mirrorId === id) void backend.writeClipboard(p.text);
    });

    return () => {
      disposed = true;
      // Finish the file first (and say where it went), then stop.
      if (recordingRef.current !== null) {
        setRecording(null);
        void adb
          .mirrorRecordStop(id)
          .then((r) => reportRecording(r, null))
          .catch(() => undefined)
          .finally(() => adb.mirrorStop(id));
      } else {
        adb.mirrorStop(id);
      }
      void recorded.then((f) => f());
      void ended.then((f) => f());
      void clip.then((f) => f());
      if (decoder.state !== "closed") decoder.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.paneId, quality]);

  // ---- layout
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const box = fitBox(area.w, area.h, video.w, video.h);

  // ---- pointer -> touch
  const devicePoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return toDevice(e.clientX - r.left, e.clientY - r.top, { w: r.width, h: r.height }, videoRef.current);
  };
  const touch = (action: 0 | 1 | 2, e: React.PointerEvent) => {
    const { x, y } = devicePoint(e);
    const v = videoRef.current;
    send([{ type: "touch", action, x, y, w: v.w, h: v.h }]);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    areaRef.current?.focus();
    if (e.button === 2) {
      // Right click: back (or wake the screen), like scrcpy.
      send([{ type: "backOrScreenOn" }]);
      return;
    }
    if (e.button !== 0) return;
    pointerDown.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    touch(0, e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointerDown.current) touch(2, e);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    touch(1, e);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = devicePoint(e);
      const v = videoRef.current;
      const notches = (d: number) => Math.max(-16, Math.min(16, -d / (e.deltaMode === 1 ? 3 : 100)));
      send([{ type: "scroll", x, y, w: v.w, h: v.h, hscroll: notches(e.deltaX), vscroll: notches(e.deltaY) }]);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  // ---- keyboard: navigation / shortcuts as keycodes, characters as text
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !e.shiftKey) {
      e.preventDefault();
      void backend.readClipboard().then((text) => text && send([{ type: "setClipboard", text, paste: true }]));
      return;
    }
    const code = keycodeFor(e);
    if (code !== null) {
      e.preventDefault();
      send([{ type: "key", keycode: code, down: true, meta: metaState(e), repeat: e.repeat ? 1 : 0 }]);
      return;
    }
    const text = textFor(e);
    if (text) {
      e.preventDefault();
      send([{ type: "text", text }]);
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const code = keycodeFor(e);
    if (code !== null) send([{ type: "key", keycode: code, down: false, meta: metaState(e) }]);
  };
  // Text from an input method (Chinese etc.) arrives once composed.
  const onCompositionEnd = (e: React.CompositionEvent) => {
    if (e.data) send([{ type: "text", text: e.data }]);
  };

  const press = (keycode: number) => send([{ type: "key", keycode, down: true }, { type: "key", keycode, down: false }]);

  const screenshot = async () => {
    const name = `screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    const path = await backend.pickSavePath(t("mirror.screenshot"), name, [{ name: "PNG", extensions: ["png"] }]);
    if (!path || !current) return;
    try {
      await adb.screenshot(targetOf(current), path);
      onToast(t("mirror.saved", { path }));
    } catch (e) {
      onToast(String(e));
    }
  };

  const reportRecording = (r: MirrorRecordResult | null, message: string | null) => {
    if (!r) {
      if (message) onToast(t("mirror.recordFailed", { message }));
      return;
    }
    onToast(
      r.files.length > 1
        ? t("mirror.recordParts", { count: r.files.length, path: r.files[0] })
        : t("mirror.recordSaved", { path: r.files[0], duration: clock(r.durationMs) })
    );
  };

  // Elapsed time on the button.
  useEffect(() => {
    if (recording === null) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const toggleRecord = async () => {
    const id = mirrorId.current;
    if (recording !== null) {
      setRecording(null);
      try {
        reportRecording(await adb.mirrorRecordStop(id), null);
      } catch (e) {
        onToast(t("mirror.recordFailed", { message: String(e) }));
      }
      return;
    }
    const name = `screenrecord-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`;
    const path = await backend.pickSavePath(t("mirror.record"), name, [{ name: "MP4", extensions: ["mp4"] }]);
    // The mirror may have restarted while the dialog was open.
    if (!path || id !== mirrorId.current) return;
    try {
      await adb.mirrorRecordStart(id, path);
      setRecording(Date.now());
    } catch (e) {
      onToast(t("mirror.recordFailed", { message: String(e) }));
    }
  };

  // Drag the left edge to resize the panel.
  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setWidth(Math.max(240, Math.min(900, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className="side-panel mirror-panel" style={{ width }}>
      <div className="mirror-resize" onPointerDown={startResize} />
      <div className="side-panel-header">
        <Smartphone size={14} />
        <span title={deviceName}>{deviceName || t("mirror.title")}</span>
        <button type="button" className="icon-btn-xs" onClick={onClose} title={t("mirror.close")}>
          <X size={13} />
        </button>
      </div>
      <div className="mirror-target">
        {targets.length > 1 && (
          <select className="text-input input-sm" value={paneId} onChange={(e) => onPane(e.target.value)}>
            {targets.map((x) => (
              <option key={x.paneId} value={x.paneId}>
                {x.title} — {x.summary}
              </option>
            ))}
          </select>
        )}
        <select
          className="text-input input-sm mirror-quality"
          value={quality}
          title={t("mirror.quality")}
          disabled={!current}
          onChange={(e) => current && setQualities((q) => ({ ...q, [current.paneId]: e.target.value as MirrorQuality }))}
        >
          {(["high", "medium", "low"] as const).map((q) => (
            <option key={q} value={q}>
              {t(`mirror.qualities.${q}`)}
            </option>
          ))}
        </select>
      </div>
      <div
        ref={areaRef}
        className="mirror-area"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCompositionEnd={onCompositionEnd}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!current ? (
          <div className="side-panel-empty">{t("mirror.noDevice")}</div>
        ) : phase.kind === "unsupported" ? (
          <div className="side-panel-empty">{t("mirror.noWebCodecs")}</div>
        ) : phase.kind === "error" ? (
          <div className="side-panel-empty mirror-error">{phase.message}</div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="mirror-canvas"
          style={{ width: box.w || undefined, height: box.h || undefined, visibility: phase.kind === "running" ? "visible" : "hidden" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {phase.kind === "starting" && current && <div className="side-panel-empty mirror-starting">{t("mirror.starting")}</div>}
      </div>
      <div className="mirror-buttons">
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.back")} onClick={() => press(KEYCODE.BACK)}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.home")} onClick={() => press(KEYCODE.HOME)}>
          <Circle size={13} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.recents")} onClick={() => press(KEYCODE.APP_SWITCH)}>
          <Square size={12} />
        </button>
        <span className="mirror-sep" />
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.volumeDown")} onClick={() => press(KEYCODE.VOLUME_DOWN)}>
          <Volume1 size={14} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.volumeUp")} onClick={() => press(KEYCODE.VOLUME_UP)}>
          <Volume2 size={14} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.power")} onClick={() => press(KEYCODE.POWER)}>
          <Power size={14} />
        </button>
        <span className="mirror-sep" />
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.notifications")} onClick={() => send([{ type: "expandNotifications" }])}>
          <Menu size={14} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.rotate")} onClick={() => send([{ type: "rotate" }])}>
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          className={`btn-ghost btn-xs ${screenOff ? "active" : ""}`}
          title={t(screenOff ? "mirror.screenOn" : "mirror.screenOff")}
          onClick={() => {
            send([{ type: "displayPower", on: screenOff }]);
            setScreenOff(!screenOff);
          }}
        >
          <MonitorOff size={14} />
        </button>
        <button
          type="button"
          className="btn-ghost btn-xs"
          title={t("mirror.pasteClipboard")}
          onClick={() => void backend.readClipboard().then((text) => text && send([{ type: "setClipboard", text, paste: true }]))}
        >
          <ClipboardPaste size={14} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("mirror.screenshot")} onClick={() => void screenshot()}>
          <Camera size={14} />
        </button>
        <button
          type="button"
          className={`btn-ghost btn-xs mirror-record ${recording !== null ? "recording" : ""}`}
          title={t(recording !== null ? "mirror.stopRecord" : "mirror.record")}
          disabled={phase.kind !== "running" && recording === null}
          onClick={() => void toggleRecord()}
        >
          {recording !== null ? <CircleStop size={14} /> : <Video size={14} />}
          {recording !== null && <span className="mirror-record-time">{clock(Date.now() - recording)}</span>}
        </button>
      </div>
    </aside>
  );
};

/** 75000 -> "1:15". */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function targetOf(t: Target): { instanceId?: string; serial?: string } {
  return t.serial ? { serial: t.serial } : { instanceId: t.paneId };
}
