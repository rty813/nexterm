# Nexterm

English | [简体中文](README.zh-CN.md)

<img src="src-tauri/icons/128x128.png" alt="" width="64" align="right" />

**Nexterm** is a fast, modern Windows terminal client supporting SSH, local shells (PowerShell / CMD / WSL), Telnet, raw TCP, and serial ports—built with Rust, Tauri v2, React, and [xterm.js](https://xtermjs.org).

It keeps WindTerm's familiar workflow (session tree, nested split panes, quick commands, one-click WindTerm import) and adds several built-in capabilities:

- **Remote File Workflow**: Side-by-side SFTP browser (with automatic SCP fallback), parallel transfer queue, instant previews, and **local edit with auto-upload on save**.
- **AI Agent Awareness & Control**: Live tab badges for **Claude Code / Codex / Gemini CLI**; desktop notifications when an agent **finishes, needs permission approval, or errors out** (click to jump straight to the pane); plus a built-in MCP server for human-approved terminal delegation.
- **E2EE Phone Access**: Scan a QR code to view and control desktop terminals from your mobile browser, adapt terminal dimensions to your phone screen, manage sessions, and transfer files with zero-knowledge encryption.
- **Full Scrollback History**: Every line a pane ever printed stays available, compressed in the background. Scroll, search and export all of it, back to the start of the session.

Windows 10 / 11 only. Current version: `0.1.1`.

![Nexterm main window: session tree, split panes running htop and Claude Code, SFTP file browser, quick-command bar](docs/media/screenshot.jpg)

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
- **Command Alerts & Readability**: One-shot **"Notify When Command Finishes"** alerts (with duration and exit code), output folding, highlight rules, Focus Mode (`F11`), and workspace lock.

### Scrollback & Search

- **Every Line, Seamlessly**: Scroll up as far as the session goes. Older output loads into the same terminal as you approach it, so there is no separate viewer. The scrollbar spans the whole history: drag it to the top for the first line. Clearing the scrollback from the menu clears it too, while a remote `clear` keeps it and marks the spot. See [How the full scrollback works](#how-the-full-scrollback-works).
- **Search the Whole History**: `Ctrl+Shift+F` counts, steps through and lists matches across the entire history, with case, whole-word and regex options. Matches outside the loaded lines are loaded when you jump to them.
- **Whole-History Scrollbar Marks**: Search hits, keyword-highlight rules and other occurrences of the selected text are marked on the scrollbar for the entire history.
- **Timestamp & Line-Number Gutter** (`Ctrl+Shift+S`): The time each line was written and its line number since the pane opened. The current line is shown in its own color. In the terminal, the cursor's line and the clicked line get background bands.
- **Export & AI Access**: **Save to file** writes the whole history, not just the visible buffer. MCP agents can read and search it too (`read_history`, `search_history`).
- **Configurable Limits**: Turn the full history off, or set its memory and temporary-file limits per pane, in Settings.

### AI Agents

- **Live Tab Status**: Tabs display whether Claude Code, Codex or Gemini CLI is **Working**, **Waiting for Approval / Input**, **Finished (Unread)**, or in **Error**.
- **Instant Notifications**: When a background agent **completes a task**, **pauses for permission approval**, or **fails**, Nexterm flashes the taskbar and sends a system notification—click it to focus that exact pane.
- **One-Click Hooks + Screen Fallback**: Install Claude Code / Codex / Gemini CLI hooks in one click on local Windows, remote SSH, or WSL (or copy a one-liner for other Linux / serial shells); falls back to screen detection when hooks aren't installed.
- **Human-in-the-Loop MCP Server**: Register Nexterm as an MCP server so agents can read screens, run commands, or drive TUI apps (`vim`, `top`). Every takeover or new session requires **dialog approval**, locks pane keyboard input against stray keystrokes, and lets you **Pause** or **Take Back Control** anytime.

<p align="center">
  <a href="docs/media/mcp-demo.mp4"><img src="docs/media/mcp-demo.gif" alt="MCP demo: Claude Code asks Nexterm to open WSL and check disk usage" width="860" /></a>
  <br />
  <sub>Claude Code opens a WSL pane through Nexterm's MCP server, checks disk usage, and closes it again (2.5× speed; click for the full video).</sub>
</p>

### Phone Access

- **Self-Hosted Zero-Knowledge E2EE**: Uses a lightweight self-hosted relay (see [relay/README.md](relay/README.md); Docker included) with a one-click toolbar toggle. Pair via QR code—keys stay in the URL `#` fragment and never reach the relay, which sees only AES-256-GCM ciphertext.
- **Mobile PWA & Adaptive Sizing**: Add to your home screen, use the touch bar (`Esc`, `Tab`, `Ctrl`, `Alt`, arrows), and connect one phone to multiple PCs at once; **"Take over size"** resizes the terminal to fit your phone screen and restores desktop dimensions when you leave.
- **Direct Mobile Login & Reconnect**: Enter **SSH usernames / passwords** and confirm **host keys** directly from your phone when opening sessions (dismissing the desktop prompt automatically), plus reconnect or re-enter passwords on failed/closed tabs.
- **Sessions, Files & Read-Only Mode**: Browse, create, edit, or launch saved PC sessions (saved passwords never leave your PC), upload/download remote files up to **1 GB**, or enable **"View only"** mode (up to 8 phones connected at once).

<p align="center">
  <a href="docs/media/phone-remote.mp4"><img src="docs/media/phone-remote.gif" alt="Phone access demo: controlling a desktop SSH session from a phone" width="860" /></a>
  <br />
  <sub>Typing into a desktop SSH session from the phone, with "Take over size" fitting the terminal to the phone screen (1.5× speed; click for the full video).</sub>
</p>

### Config Sync & Backup

- **Cloud Sync Across PCs**: Under **Settings → Sync & Backup**, sync sessions, quick commands, custom themes, settings, senders, and command history to **S3-compatible storage** (AWS S3, Cloudflare R2, MinIO, Aliyun OSS, Tencent COS, ...), **WebDAV** (Nextcloud, Synology, Jianguoyun, ...), a **GitHub Gist** (secret, with revision history), or a **local / network folder** (OneDrive, Dropbox, SMB shares, ...). Optional auto sync at startup and on an interval.
- **Conflict Handling & Machine-Local Settings**: Detects whether to upload or download; when both sides changed, choose to merge (by ID), keep local, or keep remote. Each PC keeps its own sync target, log folder, X server, and phone remote settings.
- **Encrypted Export / Import**: Export selected categories to a single JSON file, optionally password-protected (PBKDF2 + AES-256-GCM), and import by merging or replacing. The current config is backed up to `backups/` in the data folder before every import or download (last 10 kept).

### Other

- **Easy Migration**: Import sessions, quick commands, and color schemes from **WindTerm**, or hosts from `~/.ssh/config`.
- **Customization**: 4 built-in themes + custom themes, configurable shortcuts and toolbar, in English and Simplified Chinese.

## Performance

Compared with WindTerm 2.7.0 using WindTerm's own [throughput test](https://github.com/kingToolbox/WindTerm#terminal-performance) (lower is better). Nexterm runs with full scrollback history on, its default:

| Test | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| `cat` 100 MB random base64 text | 5.53 s | **4.98 s** |
| `seq 1 1000000` | **1.43 s** | 2.04 s |
| `seq 1 2000000` | **2.23 s** | 2.97 s |
| `seq 1 5000000` | 5.38 s | **4.73 s** |
| `seq 1 10000000` | 10.15 s | **7.54 s** |

Memory (private working set of the whole process tree, WebView2 included):

| State | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| Idle, one session open | 218 MB | **43 MB** |
| After `seq 1 1000000` | 350 MB peak, 248 MB once settled | **75 MB** |

- **Where the memory goes:** about 170 MB is the fixed cost of WebView2. xterm.js keeps the last 10,000 lines, at a fixed size per character cell. Everything older lives in the backend, compressed: after `seq 1 1000000`, `nexterm.exe` itself uses about 20 MB. Most of the peak is JavaScript garbage, freed within seconds of the output stopping. Like WindTerm, Nexterm now keeps every line.
- **Cost of the full history:** the backend parses and compresses all output on its own thread, about one more CPU core while output streams. Throughput barely changes: in back-to-back single runs, `seq 1 10000000` took 8.9 s with the full history and 8.7 s without.
- **Setup:** AMD Ryzen 7 5700G, 32 GB RAM, Windows. Both terminals connect over Telnet to a server in WSL on the same machine, with the same window size. Each time runs from starting the command until the terminal has processed all output. That moment is the reply to a cursor-position query (DSR), or the point where the app's CPU goes idle, since WindTerm does not answer DSR over Telnet. Each test is one warm-up run followed by the median of 3 runs. The WindTerm figures come from an earlier run on the same machine and setup.
- **Reproduce:** run [`bench/bench.sh`](bench/bench.sh) inside the terminal under test, and [`bench/mem.ps1`](bench/mem.ps1) on Windows to sample the memory of the terminal's process tree.

### How the full scrollback works

A WebView terminal cannot simply keep millions of lines: xterm.js stores every line at its full width, 12 bytes per cell, so 10 million lines at 125 columns would take about 15 GB. Nexterm keeps the whole history in the Rust backend instead and shows it through xterm.js on demand ([`src-tauri/src/history/`](src-tauri/src/history/), [`src/services/historyScroll.ts`](src/services/historyScroll.ts)):

1. **A second terminal in the backend.** Each pane's output goes to xterm.js as usual, and a copy goes to a worker thread running a headless [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal) of the same size. It handles cursor movement, `\r` progress bars, clears and full-screen programs the way the screen does, so the history holds what was actually shown. Every row that scrolls off its screen becomes part of a logical line: rows joined across automatic wraps, so the line re-wraps correctly at any window width.
2. **Text, not cells.** A line is stored as its text, color runs ("characters 3 to 10 are red") and the time it was written. Lines are packed into blocks of 2,000 and compressed with zstd. `seq 1 10000000` (78 MB of text) takes about 6 MB.
3. **Bounded memory.** Past the memory limit (32 MB per pane by default), the oldest blocks are encrypted with AES-256-GCM, using a key that exists only in memory for this run, and moved to temporary files. They are deleted when the pane closes or the app exits. Past the disk limit (2 GB by default), the oldest lines are dropped. Both limits are in Settings.
4. **Seamless scrolling.** xterm.js holds only the recent lines. As the view nears the top of its buffer, the front end fetches older lines, renders them at the pane's width, and splices them into xterm.js's buffer above what it holds. Selection, copy, links and highlighting then work on them like on any other line. Lines far from the view are dropped again, so at most about 30,000 extra rows are loaded at a time, and all of them go once the view is back at the bottom.
5. **A scrollbar for the whole history.** The scrollbar is sized and placed by the number of lines in the whole history, not in xterm.js's buffer. Dragging it to the top reaches the first line of the session, loading that part of the history on the way.
6. **Fast search over everything.** The backend searches the compressed blocks on several threads. It matches each block's text in one pass before looking at single lines, and builds no per-line objects. A full pass over 10 million lines takes about 0.1 s. Per-block match counts are cached for each query, so match counts and scrollbar marks only scan new output afterwards.

## Building
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
| `src-tauri/` | Rust backend: connections, protocols, SFTP / SCP, shell integration, full scrollback history, MCP, phone access |
| `relay/` | Self-hosted relay server and mobile PWA (Node.js) |
| `bench/` | Throughput and memory benchmark scripts |

## Contributing

Issues and PRs are welcome. Please run front-end and Rust tests before submitting, and provide both English and Chinese strings for new UI text.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE). The bundled [VcXsrv](https://sourceforge.net/projects/vcxsrv/) (`src-tauri/resources/vcxsrv/`) is a separate program under GPL-2.0; other dependencies keep their own licenses.
