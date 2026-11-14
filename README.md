# Nexterm

English | [简体中文](README.zh-CN.md)

<img src="src-tauri/icons/128x128.png" alt="" width="64" align="right" />

**Nexterm** is a fast, modern Windows terminal client supporting SSH, local shells (PowerShell / CMD / WSL), Telnet, raw TCP, and serial ports—built with Rust, Tauri v2, React, and [xterm.js](https://xtermjs.org).

It keeps WindTerm's familiar workflow (session tree, nested split panes, quick commands, one-click WindTerm import) and adds several built-in capabilities:

- **Remote File Workflow**: Side-by-side SFTP browser (with automatic SCP fallback), parallel transfer queue, instant previews, and **local edit with auto-upload on save**.
- **AI Agent Awareness & Control**: Live tab badges for **Claude Code / Codex**; desktop notifications when an agent **finishes, needs permission approval, or errors out** (click to jump straight to the pane); plus a built-in MCP server for human-approved terminal delegation.
- **E2EE Phone Access**: Scan a QR code to view and control desktop terminals from your mobile browser, adapt terminal dimensions to your phone screen, manage sessions, and transfer files with zero-knowledge encryption.

Windows 10 / 11 only. Current version: `0.1.0`.

## Features

### Connections

- **SSH** (`russh`): Password, `keyboard-interactive`, and private-key auth (OpenSSH / PEM, Ed25519 / RSA, passphrase support), ProxyJump, keep-alive, post-login scripts, and first-connect host key verification.
- **Local & Hardware Protocols**: Native ConPTY local shells (PowerShell / CMD / WSL / custom commands), Telnet, raw TCP, and Serial ports.
- **Shell Integration**: Automatically tracks prompts, commands, and working directories (OSC 133 / 633 / 7) in SSH `bash` / `zsh` / `fish` and local `PowerShell`. The context menu's **Load shell integration** installs scripts and startup configuration for the current `bash` / `zsh` / `fish` user, taking effect immediately and in future sessions, including WSL, SSH, nested shells, and serial consoles. Existing startup files are backed up as `.nexterm-si.bak` before changes.
- **Forwarding & In-Band Transfers**: Port forwarding, one-click X11 forwarding via bundled VcXsrv, **ZMODEM / XMODEM / YMODEM** transfers, and session logging.

### File Browser

- **SFTP with SCP Fallback**: Open via `Ctrl+Shift+O` or context menu; automatically falls back to SCP + shell commands when SFTP is unavailable.
- **Two-Way Directory Sync**: Filter folders, jump by path, **auto-follow terminal `cd`**, or `cd` the terminal to the current folder.
- **Edit Locally, Auto-Upload**: Open remote files in your local editor—every save automatically uploads back to the server.
- **Zero-Download Previews**: Preview code/text, JSON, Markdown, CSV/TSV tables, images (zoom/rotate), and PDFs directly.
- **Transfer Queue**: Drag-and-drop folders/files, edit permissions (checkboxes or octal), pause / resume / retry parallel transfers with conflict rules, and track ZMODEM transfers in one place.

### Windows & Input

- **Splits & Multi-Window**: Searchable nested session tree; arbitrary nested split panes, drag-to-rearrange, and tear-off tabs into separate windows.
- **Fast Input**: **Broadcast input** (to current tab panes or all tabs), timed multi-session Sender, Command Palette, grouped Quick Commands, and **history/dictionary auto-completion**.
- **Quick-Connect Bar**: Connect instantly with `ssh user@host:22`, `ssh -p 2222 -i key user@host`, `powershell`, or `wsl`.
- **Command Alerts & Readability**: One-shot **"Notify When Command Finishes"** alerts (with duration and exit code), output folding, highlight rules, timestamp gutter, Focus Mode (`F11`), and workspace lock.

### AI Agents

- **Live Tab Status**: Tabs display whether Claude Code or Codex is **Working**, **Waiting for Approval / Input**, **Finished (Unread)**, or in **Error**.
- **Instant Notifications**: When a background agent **completes a task**, **pauses for permission approval**, or **fails**, Nexterm flashes the taskbar and sends a system notification—click it to focus that exact pane.
- **One-Click Hooks + Screen Fallback**: Install Claude Code / Codex hooks in one click on local Windows, remote SSH, or WSL (or copy a one-liner for other Linux / serial shells); falls back to screen detection when hooks aren't installed.
- **Human-in-the-Loop MCP Server**: Register Nexterm as an MCP server so agents can read screens, run commands, or drive TUI apps (`vim`, `top`). Every takeover or new session requires **dialog approval**, locks pane keyboard input against stray keystrokes, and lets you **Pause** or **Take Back Control** anytime.

### Phone Access

- **Self-Hosted Zero-Knowledge E2EE**: Uses a lightweight self-hosted relay (see [relay/README.md](relay/README.md); Docker included) with a one-click toolbar toggle. Pair via QR code—keys stay in the URL `#` fragment and never reach the relay, which sees only AES-256-GCM ciphertext.
- **Mobile PWA & Adaptive Sizing**: Add to your home screen, use the touch bar (`Esc`, `Tab`, `Ctrl`, `Alt`, arrows), and connect one phone to multiple PCs at once; **"Take over size"** resizes the terminal to fit your phone screen and restores desktop dimensions when you leave.
- **Direct Mobile Login & Reconnect**: Enter **SSH usernames / passwords** and confirm **host keys** directly from your phone when opening sessions (dismissing the desktop prompt automatically), plus reconnect or re-enter passwords on failed/closed tabs.
- **Sessions, Files & Read-Only Mode**: Browse, create, edit, or launch saved PC sessions (saved passwords never leave your PC), upload/download remote files up to **1 GB**, or enable **"View only"** mode (up to 8 phones connected at once).

### Other

- **Easy Migration**: Import sessions, quick commands, and color schemes from **WindTerm**, or hosts from `~/.ssh/config`.
- **Customization**: 4 built-in themes + custom themes, configurable shortcuts and toolbar, in English and Simplified Chinese.

## Building

Prerequisites: [Node.js](https://nodejs.org) >= 20, [Rust](https://rustup.rs) stable (MSVC), and [Tauri v2 Windows prerequisites](https://tauri.app/start/prerequisites/).

```powershell
git clone https://github.com/rty813/nexterm.git
cd nexterm
npm install

npm run tauri:dev      # development mode
npm run tauri:build    # release build -> src-tauri/target/release/nexterm.exe (quit running nexterm.exe first)
```

Tests:

```powershell
npm test                                                 # front-end tests (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust unit tests
cd relay; npm test                                       # relay & E2EE protocol tests
```

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Front end (React + TypeScript); `utils/` holds UI-independent logic and core unit tests |
| `src-tauri/` | Rust backend: connections, protocols, SFTP / SCP, shell integration, MCP, phone access |
| `relay/` | Self-hosted relay server and mobile PWA (Node.js) |
| `bench/` | Throughput and memory benchmark scripts |

## Contributing

Issues and PRs are welcome. Please run front-end and Rust tests before submitting, and provide both English and Chinese strings for new UI text.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE). The bundled [VcXsrv](https://sourceforge.net/projects/vcxsrv/) (`src-tauri/resources/vcxsrv/`) is a separate program under GPL-2.0; other dependencies keep their own licenses.
