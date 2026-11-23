import type { SessionConfig } from "../types/domain";

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse WindTerm-style Quick Connect input:
 * - `powershell` | `pwsh` | `cmd` | `wsl`
 * - `tcp://127.0.0.1:47331` | `tcp 127.0.0.1:47331` | `telnet://10.0.0.1` | `telnet 10.0.0.1 2323`
 * - `ssh -p 2222 user@host` | `ssh user@host:2222` | `user@host:port` | `192.168.1.10`
 */
export function parseQuickConnectInput(raw: string): SessionConfig | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "powershell" || lower === "pwsh") {
    return {
      id: makeId(),
      label: "PowerShell",
      group: "Quick Connect",
      protocol: "powershell",
      host: "",
      port: 0,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    };
  }

  if (lower === "cmd" || lower === "cmd.exe") {
    return {
      id: makeId(),
      label: "CMD",
      group: "Quick Connect",
      protocol: "cmd",
      host: "",
      port: 0,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    };
  }

  if (lower === "wsl" || lower === "wsl.exe") {
    return {
      id: makeId(),
      label: "WSL",
      group: "Quick Connect",
      protocol: "wsl",
      host: "",
      port: 0,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    };
  }

  // rdp://[user@]host[:port], vnc://host[:port] (also "rdp host", "vnc host").
  const desktopKind = /^(rdp|vnc)(?::\/\/|\s+)/.exec(lower)?.[1] as "rdp" | "vnc" | undefined;
  if (desktopKind) {
    const rest = trimmed.replace(/^(?:rdp|vnc)(?::\/\/|\s+)/i, "").trim().replace(/\/+$/, "");
    const at = rest.lastIndexOf("@");
    const user = at >= 0 ? safeUser(rest.slice(0, at)) : "";
    const { host, port } = splitHostPort(at >= 0 ? rest.slice(at + 1) : rest, desktopKind === "rdp" ? 3389 : 5900);
    if (!host) return null;
    return {
      id: makeId(),
      label: `${desktopKind.toUpperCase()} ${host}`,
      group: "Quick Connect",
      protocol: desktopKind,
      host,
      port,
      username: user,
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    };
  }

  const rawKind =
    lower.startsWith("telnet://") || lower.startsWith("telnet ")
      ? "telnet"
      : lower.startsWith("tcp://") || lower.startsWith("tcp ")
      ? "tcp"
      : null;
  if (rawKind) {
    const rest = trimmed.replace(/^(?:tcp|telnet):\/\/|^(?:tcp|telnet)\s+/i, "").trim().replace(/\s+(\d+)$/, ":$1");
    const { host, port } = splitHostPort(rest, 23);
    if (!host) return null;
    return {
      id: makeId(),
      label: `${rawKind === "tcp" ? "TCP" : "Telnet"} ${host}:${port}`,
      group: "Quick Connect",
      protocol: rawKind,
      host,
      port,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    };
  }

  // SSH parsing: support `ssh://user@host:port`, `ssh -p 2222 -i ~/.ssh/key user@host`, or `user@host:port`
  let body = trimmed.replace(/^ssh:\/\//i, "");
  const tokens = body.split(" ").filter((t) => t.length > 0);
  if (tokens[0]?.toLowerCase() === "ssh") {
    tokens.shift();
  }

  let explicitPort: number | undefined;
  let explicitUser: string | undefined;
  let keyPath: string | undefined;
  let targetToken = "";

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-p" && tokens[i + 1]) {
      const parsed = Number(tokens[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        explicitPort = parsed;
      }
      i++;
    } else if (tok === "-l" && tokens[i + 1]) {
      explicitUser = tokens[i + 1];
      i++;
    } else if (tok === "-i" && tokens[i + 1]) {
      keyPath = tokens[i + 1];
      i++;
    } else if (!tok.startsWith("-")) {
      targetToken = tok;
    }
  }

  if (!targetToken) {
    return null;
  }

  let username = explicitUser ?? "";
  let hostPart = targetToken;
  const atIndex = targetToken.lastIndexOf("@");
  if (atIndex > 0) {
    username = explicitUser ?? targetToken.slice(0, atIndex);
    hostPart = targetToken.slice(atIndex + 1);
  }

  const { host, port } = splitHostPort(hostPart, explicitPort ?? 22);
  if (!host) {
    return null;
  }

  return {
    id: makeId(),
    label: username ? `${username}@${host}` : host,
    group: "Quick Connect",
    protocol: "ssh",
    host,
    port: explicitPort ?? port,
    username,
    authType: keyPath ? "privatekey" : "password",
    privateKeyPath: keyPath,
    term: "xterm-256color",
    keepAliveSecs: 60,
  };
}

function splitHostPort(
  input: string,
  defaultPort: number
): { host: string; port: number } {
  const colonIdx = input.lastIndexOf(":");
  if (colonIdx > 0 && input.indexOf(":") === colonIdx) {
    const maybePort = Number(input.slice(colonIdx + 1));
    if (!Number.isNaN(maybePort) && maybePort > 0 && maybePort <= 65535) {
      return { host: input.slice(0, colonIdx), port: maybePort };
    }
  }
  return { host: input, port: defaultPort };
}

/**
 * Input that is clearly an address (for the command palette, where a plain word is a
 * search): user@host, a scheme, an `ssh` / `tcp` / `telnet` command, a dotted host or IP.
 */
export function looksLikeAddress(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s{2,}/.test(s)) return false;
  return (
    /@|:\/\//.test(s) ||
    /^(ssh|tcp|telnet|rdp|vnc)\s+\S/i.test(s) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(s) ||
    /^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(s)
  );
}

/** A user name from an address, percent-decoded when it is valid. */
function safeUser(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}
