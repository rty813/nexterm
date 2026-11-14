import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Minimize2, Radio } from "lucide-react";
import type { SyncInputScope, TerminalLeafNode } from "../types/domain";
import { sessionTargetSummary } from "../utils/sessionSummary";
import { ProtocolBadge } from "./ProtocolBadge";

interface StatusBarProps {
  activeLeaf: TerminalLeafNode | null;
  syncScope: SyncInputScope;
  /** The toolbar shows the sync state already (and it is not in focus mode). */
  syncOnToolbar: boolean;
  focusMode: boolean;
  onExitFocusMode: () => void;
  onLockScreen: () => void;
  syncPaused: boolean;
  /** Panes paused one by one while the others keep syncing. */
  pausedPaneCount: number;
  channelCount: number;
  onToggleSyncPause: () => void;
  loggingCount: number;
  /** The active pane writes a session log. */
  activeLogging: boolean;
}

/** 0:42, 12:05, 1:02:03 */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Ticks once a second while a connection time is shown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeLeaf,
  syncScope,
  syncOnToolbar,
  focusMode,
  onExitFocusMode,
  onLockScreen,
  syncPaused,
  pausedPaneCount,
  channelCount,
  onToggleSyncPause,
  loggingCount,
  activeLogging,
}) => {
  const { t } = useTranslation();
  const leaf = activeLeaf;
  const connected = leaf?.status === "connected" && Boolean(leaf.connectedAt);
  const now = useNow(connected);

  const statusText = !leaf
    ? ""
    : leaf.status === "connected"
    ? leaf.connectedAt
      ? t("statusbar.connectedFor", { time: formatUptime(now - leaf.connectedAt) })
      : t("statusbar.connected")
    : t(`statusbar.state.${leaf.status}`, leaf.status);

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        {leaf && (
          <>
            <span className="status-seg status-target" title={leaf.statusMessage || undefined}>
              <span className={`status-dot status-${leaf.status}`} />
              <ProtocolBadge protocol={leaf.session.protocol} size={11} />
              <span className="mono">{sessionTargetSummary(leaf.session) || leaf.session.label}</span>
            </span>
            <span className="status-seg">{statusText}</span>
            {activeLogging && <span className="status-seg log-highlight">● {t("statusbar.recording")}</span>}
          </>
        )}
        {!leaf && <span className="status-seg">{t("statusbar.noSession")}</span>}

        {syncScope !== "off" && !syncOnToolbar && (
          <button
            type="button"
            className={`status-btn status-seg ${syncPaused ? "sync-paused" : "sync-highlight"}`}
            onClick={onToggleSyncPause}
            title={syncPaused ? t("menu.resumeSync") : t("menu.pauseSync")}
          >
            <Radio size={11} />{" "}
            {t(syncPaused ? "statusbar.broadcastPaused" : "statusbar.broadcast", {
              scope:
                syncScope === "visible"
                  ? t("statusbar.scopeVisible")
                  : syncScope === "channels"
                  ? t("statusbar.scopeChannels", { count: channelCount })
                  : t("statusbar.scopeAll"),
            })}
            {!syncPaused && pausedPaneCount > 0 ? ` · ${t("sync.pausedPanes", { count: pausedPaneCount })}` : ""}
          </button>
        )}
        {loggingCount > (activeLogging ? 1 : 0) && (
          <span className="status-seg log-highlight">{t("statusbar.logging", { count: loggingCount })}</span>
        )}
      </div>

      <div className="statusbar-right">
        {leaf && (
          <>
            <span className="status-seg" title={t("statusbar.sizeTip")}>
              {leaf.cols}×{leaf.rows}
            </span>
            <span className="status-seg">{leaf.session.charset || "UTF-8"}</span>
          </>
        )}
        {focusMode && (
          <button type="button" className="status-btn accent-btn" onClick={onExitFocusMode} title={t("toolbar.focusMode")}>
            <Minimize2 size={11} /> {t("statusbar.exitFocus")}
          </button>
        )}
        <button type="button" className="status-btn" onClick={onLockScreen} title={t("statusbar.lockScreen")}>
          <Lock size={11} /> {t("statusbar.lockScreen")}
        </button>
      </div>
    </footer>
  );
};
