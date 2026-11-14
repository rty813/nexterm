<div align="center">

<img src="src-tauri/icons/128x128.png" alt="Nexterm" width="96" height="96" />

# Nexterm

**A modern SSH & local terminal client for Windows, built with Tauri, Rust and React.**

English | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#requirements)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-async-DEA584.svg)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-TypeScript-61DAFB.svg)](https://react.dev)
[![Stars](https://img.shields.io/github/stars/rty813/nexterm?style=social)](https://github.com/rty813/nexterm/stargazers)

</div>

---

Nexterm is a from-scratch terminal client with a pure Rust async backend and an [xterm.js](https://xtermjs.org) front end. It keeps the workflow people like in classic tabbed SSH clients — session tree, recursive split panes, quick commands, command history — and adds things those clients lack: an AI-agent status indicator, an MCP server, and end-to-end encrypted phone access to your terminal tabs.

## Highlights

- **Many protocols, one app** — SSH, local shells (ConPTY), Telnet, raw TCP and serial ports.
- **Fast and light** — Tauri instead of Electron; terminal output goes through a flow-controlled binary channel with back-pressure to the remote end.
- **Built for AI coding agents** — see at a glance which tab has a Claude Code / Codex session that is working, waiting for approval or finished; let agents drive terminals over MCP.
- **Your terminal on your phone** — a self-hosted relay and PWA with end-to-end encryption (AES-256-GCM); the relay only ever sees ciphertext.
- **Familiar and importable** — bring over sessions from WindTerm and OpenSSH config in one click.

## Features

### Connections
- **SSH** (`russh`): password, keyboard-interactive and private-key auth (OpenSSH / PEM / Ed25519 / RSA, with passphrase), **ProxyJump**, keep-alive, live PTY resize, post-login scripts, host-key confirmation.
- **Local terminal** (`portable-pty`): PowerShell, CMD, WSL and custom commands through Windows ConPTY.
- **Telnet, TCP and serial** sessions.
- **Port forwarding / tunnels** and an optional bundled **X server** for X11 forwarding.
- **File transfer inside the terminal** with ZMODEM, XMODEM and YMODEM; per-session **logging**.

### Workspace
- Session-manager sidebar with nested groups, search, duplicate / edit / delete and double-click to connect.
- Tabs with **unlimited recursive split panes**, drag to resize or rearrange, move tabs between windows.
- **Broadcast input** to every pane of a tab or to all tabs.
- Quick-connect bar (`ssh user@host:22`, `ssh -p 2222 -i key user@host`, `powershell`, `wsl`), a command palette, and a **QuickBar** of grouped quick commands.
- Command **history**, **auto-completion**, a **sender** panel (send text to several sessions with delays), output folding and highlight rules, timestamp gutter and ruler marks.
- Stable **focus mode** (`F11`) and **lock screen** — explicit state, no background timers.

### AI agents
- Live state badges for **Claude Code** and **Codex** — working, blocked on permission, done, error — from agent hooks (installable locally or on an SSH host in one click) with screen-based detection as a fallback.
- Built-in **MCP server**, so agents can read and operate terminal tabs you hand over to them.

### Remote access from your phone
- Pair by scanning a QR code; add the page to your home screen as a PWA.
- Live view of all tabs with a mobile key bar (Esc / Tab / Ctrl / Alt / arrows).
- **End-to-end encrypted**: the pairing key lives in the QR code fragment and never reaches the relay. See [`relay/`](relay/README.md) to self-host it with Docker.

### Look and feel
- Built-in themes (`Dige Black`, `Dige Black & White`, `Dige White`, `Wind Abyss`) plus custom themes.
- English and Simplified Chinese UI.
- Import sessions, quick commands and color schemes from **WindTerm** profiles and `~/.ssh/config`.

## Requirements

Nexterm currently targets **Windows 10/11** (it relies on ConPTY and WebView2).

To build from source you need:

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable, MSVC toolchain)
- The [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for Windows

## Getting started

```powershell
git clone https://github.com/rty813/nexterm.git
cd nexterm
npm install

npm run tauri:dev      # development with hot reload
npm run tauri:build    # production build -> src-tauri/target/release/nexterm.exe
```

Run the tests:

```powershell
npm test                                                 # front end (vitest)
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust unit tests
cd relay; npm test                                       # relay + crypto protocol
```

> If `nexterm.exe` is still running, stop it before building a release — Windows locks the file.

## Project layout

| Path | What it is |
| --- | --- |
| `src/` | React + TypeScript front end (components, hooks, pure `utils/`, i18n, themes) |
| `src-tauri/` | Rust backend: connection manager, SSH / PTY / serial / Telnet / TCP, ZMODEM, MCP, remote bridge |
| `relay/` | Self-hosted relay and phone PWA for remote tabs (Node.js) |
| `bench/` | Terminal throughput and memory benchmarks |

## Third-party components

- The Windows build bundles **[VcXsrv](https://sourceforge.net/projects/vcxsrv/)** (GPL-2.0) under `src-tauri/resources/vcxsrv/` as a separate program for optional X11 forwarding. Its license and source are available from the upstream project.
- [xterm.js](https://xtermjs.org), [Tauri](https://tauri.app), [russh](https://github.com/Eugeny/russh), [portable-pty](https://github.com/wez/wezterm/tree/main/pty) and other dependencies keep their own licenses.

## Contributing

Issues and pull requests are welcome. Please run the front-end and Rust tests before submitting, and keep new UI strings in both English and Chinese.

## License

Licensed under either of

- [Apache License, Version 2.0](LICENSE-APACHE)
- [MIT license](LICENSE-MIT)

at your option. Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in Nexterm by you shall be dual licensed as above, without any additional terms or conditions.

## Star History

<a href="https://star-history.com/#rty813/nexterm&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date" />
  </picture>
</a>
