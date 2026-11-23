import type { SessionConfig } from "../types/domain";
import { adbTargetSummary } from "./adbSession";

/** One-line target description shown in the sidebar, pane header and status bar. */
export function sessionTargetSummary(s: SessionConfig): string {
  switch (s.protocol) {
    case "ssh":
      return s.username ? `${s.username}@${s.host}:${s.port}` : `${s.host}:${s.port}`;
    case "tcp":
    case "telnet":
      return `${s.host}:${s.port}`;
    case "rdp":
    case "vnc":
      return `${s.protocol.toUpperCase()} ${s.username ? `${s.username}@` : ""}${s.host}:${s.port}`;
    case "serial":
      return `${s.host} @ ${s.serial?.baudRate ?? 115200}`;
    case "adb":
      return adbTargetSummary(s);
    default:
      return s.protocol.toUpperCase();
  }
}
