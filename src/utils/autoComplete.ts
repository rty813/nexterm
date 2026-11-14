import { backend } from "../services/backend";
import type { AutoCompleteSettings, HistoryEntry, QuickCommand } from "../types/domain";

/**
 * WindTerm-style auto completion (terminal.autoComplete.*): while typing a command line,
 * suggest history commands, quick commands, command names and command options.
 *
 * Every candidate is a plain continuation of what was typed, so accepting it only sends
 * the missing characters to the shell (nothing is erased or retyped).
 */
export interface Candidate {
  kind: "history" | "quick" | "command" | "option";
  /** Full text shown in the list. */
  label: string;
  /** Characters to send to complete the input. */
  insert: string;
  detail?: string;
}

export interface CatalogEntry {
  name: string;
  description: string;
}

export interface CommandOption {
  flags: string[];
  label: string;
  description: string;
}

/** Used when the bundled catalog has no commands for the shell (PowerShell ...). */
const BUILTIN: Record<string, string[]> = {
  linux: [
    "apt", "awk", "base64", "bash", "cat", "cd", "chmod", "chown", "clear", "cp", "crontab", "curl", "cut", "date",
    "df", "diff", "dig", "dmesg", "docker", "du", "echo", "env", "exit", "export", "find", "free", "git", "grep",
    "gunzip", "gzip", "head", "history", "hostname", "htop", "ifconfig", "ip", "journalctl", "kill", "killall",
    "less", "ln", "ls", "lsblk", "lsof", "make", "man", "mkdir", "more", "mount", "mv", "nano", "netstat", "nohup",
    "nslookup", "ping", "pip", "ps", "pwd", "python3", "reboot", "rm", "rmdir", "rsync", "scp", "sed", "service",
    "sort", "ss", "ssh", "sudo", "su", "systemctl", "tail", "tar", "tee", "tmux", "top", "touch", "tr", "umount",
    "uname", "uniq", "unzip", "uptime", "useradd", "vi", "vim", "watch", "wc", "wget", "which", "whoami", "xargs",
    "yum", "zip",
  ],
  powershell: [
    "Get-ChildItem", "Get-Content", "Set-Content", "Get-Process", "Stop-Process", "Get-Service", "Start-Service",
    "Stop-Service", "Restart-Service", "Get-Item", "Remove-Item", "Copy-Item", "Move-Item", "New-Item",
    "Set-Location", "Get-Location", "Select-String", "Where-Object", "ForEach-Object", "Sort-Object",
    "Measure-Object", "Test-Connection", "Test-NetConnection", "Invoke-WebRequest", "Get-Help", "Get-Command",
    "Write-Output", "Write-Host", "Clear-Host", "Get-Date", "Start-Process",
  ],
  cmd: ["cd", "cls", "copy", "del", "dir", "echo", "exit", "find", "findstr", "ipconfig", "md", "mkdir", "move",
    "netstat", "ping", "rd", "ren", "set", "start", "tasklist", "taskkill", "tracert", "type", "where", "xcopy"],
};

const catalogs = new Map<string, Promise<CatalogEntry[]>>();
const optionCache = new Map<string, Promise<CommandOption[]>>();

export function loadCatalog(scheme: string): Promise<CatalogEntry[]> {
  const key = scheme === "powershell" || scheme === "cmd" ? scheme : "linux";
  let p = catalogs.get(key);
  if (!p) {
    p = backend.commandCatalog(key).then((list) =>
      list.length ? list : (BUILTIN[key] ?? []).map((name) => ({ name, description: "" }))
    );
    catalogs.set(key, p);
  }
  return p;
}

export function loadOptions(scheme: string, name: string): Promise<CommandOption[]> {
  const key = `${scheme}\u0000${name}`;
  let p = optionCache.get(key);
  if (!p) {
    p = backend.commandOptions(scheme === "powershell" || scheme === "cmd" ? scheme : "linux", name);
    optionCache.set(key, p);
  }
  return p;
}

/** The command an option belongs to: "git commit" when the catalog knows it, else "git". */
export function commandOfInput(input: string, catalog: CatalogEntry[]): string | null {
  const words = input.trimStart().split(/\s+/);
  if (words.length < 2) return null;
  const sub = `${words[0]} ${words[1]}`;
  if (words.length > 2 && catalog.some((c) => c.name === sub)) return sub;
  return words[0];
}

export interface CandidateSources {
  history: HistoryEntry[];
  quickCommands: QuickCommand[];
  catalog: CatalogEntry[];
  /** Options of the command being typed (when its options were loaded). */
  options: CommandOption[];
}

export function computeCandidates(input: string, src: CandidateSources, cfg: AutoCompleteSettings, limit = 60): Candidate[] {
  if (!cfg.enabled || input.trim().length < Math.max(1, cfg.threshold) || input.includes("\n")) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>([input]);
  const push = (c: Candidate) => {
    const full = input + c.insert;
    if (!c.insert || seen.has(full)) return;
    seen.add(full);
    out.push(c);
  };

  if (cfg.history) {
    for (const e of src.history) {
      if (e.command.startsWith(input)) push({ kind: "history", label: e.command, insert: e.command.slice(input.length) });
    }
  }
  if (cfg.quickCommands) {
    for (const q of src.quickCommands) {
      const cmd = q.command.replace(/\r$/, "");
      if (!cmd.includes("\r") && !cmd.includes("\n") && cmd.startsWith(input)) {
        push({ kind: "quick", label: cmd, insert: cmd.slice(input.length), detail: q.label });
      }
    }
  }

  const words = input.trimStart().split(/\s+/);
  const token = /\s$/.test(input) ? "" : words[words.length - 1];
  const firstWord = words.length === 1 && !/\s$/.test(input);
  if (cfg.commandNames && firstWord && token) {
    for (const c of src.catalog) {
      if (c.name.startsWith(token) && !c.name.includes(" ")) {
        push({ kind: "command", label: c.name, insert: `${c.name.slice(token.length)} `, detail: c.description });
      }
    }
    // Subcommands typed as one word are not useful; "git " shows them below.
  } else if (cfg.commandNames && words.length === 2) {
    // "git ad" -> "git add"
    const prefix = `${words[0]} ${token}`;
    for (const c of src.catalog) {
      if (c.name.startsWith(prefix) && c.name.includes(" ")) {
        push({ kind: "command", label: c.name, insert: `${c.name.slice(prefix.length)} `, detail: c.description });
      }
    }
  }
  if (cfg.commandOptions && !firstWord && (token.startsWith("-") || token.startsWith("/"))) {
    for (const o of src.options) {
      for (const f of o.flags) {
        if (f.startsWith(token) && f !== token) {
          push({ kind: "option", label: f, insert: f.slice(token.length) + (f.endsWith("=") ? "" : " "), detail: o.description || o.label });
          break;
        }
      }
    }
  }
  return out.slice(0, limit);
}
