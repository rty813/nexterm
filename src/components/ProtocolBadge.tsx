import React from "react";
import {
  Cpu,
  Monitor,
  MonitorPlay,
  Network,
  Server,
  SquareTerminal,
  Terminal,
  TerminalSquare,
  Usb,
} from "lucide-react";
import type { ProtocolType } from "../types/domain";

interface ProtocolBadgeProps {
  protocol: ProtocolType;
  size?: number;
}

export const ProtocolBadge: React.FC<ProtocolBadgeProps> = ({
  protocol,
  size = 14,
}) => {
  switch (protocol) {
    case "rdp":
      return (
        <span className="proto-badge proto-rdp" title="RDP">
          <Monitor size={size} />
        </span>
      );
    case "vnc":
      return (
        <span className="proto-badge proto-vnc" title="VNC">
          <MonitorPlay size={size} />
        </span>
      );
    case "ssh":
      return (
        <span className="proto-badge proto-ssh" title="SSH2">
          <Server size={size} />
        </span>
      );
    case "powershell":
      return (
        <span className="proto-badge proto-ps" title="PowerShell">
          <Terminal size={size} />
        </span>
      );
    case "cmd":
      return (
        <span className="proto-badge proto-cmd" title="Command Prompt">
          <SquareTerminal size={size} />
        </span>
      );
    case "wsl":
      return (
        <span className="proto-badge proto-wsl" title="WSL Linux">
          <Cpu size={size} />
        </span>
      );
    case "tcp":
      return (
        <span className="proto-badge proto-tcp" title="Raw TCP">
          <Network size={size} />
        </span>
      );
    case "telnet":
      return (
        <span className="proto-badge proto-telnet" title="Telnet">
          <TerminalSquare size={size} />
        </span>
      );
    case "serial":
      return (
        <span className="proto-badge proto-serial" title="Serial">
          <Usb size={size} />
        </span>
      );
    default:
      return (
        <span className="proto-badge proto-custom" title="Custom Shell">
          <Terminal size={size} />
        </span>
      );
  }
};
