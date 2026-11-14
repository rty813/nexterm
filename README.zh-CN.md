<div align="center">

<img src="src-tauri/icons/128x128.png" alt="Nexterm" width="96" height="96" />

# Nexterm

**基于 Tauri、Rust 与 React 构建的现代 Windows SSH 与本地终端客户端。**

[English](README.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#许可证)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#环境要求)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-async-DEA584.svg)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-TypeScript-61DAFB.svg)](https://react.dev)
[![Stars](https://img.shields.io/github/stars/rty813/nexterm?style=social)](https://github.com/rty813/nexterm/stargazers)

</div>

---

Nexterm 是一个从零开始构建的终端客户端：后端是纯 Rust 异步实现，前端基于 [xterm.js](https://xtermjs.org)。它保留了经典多标签 SSH 客户端里好用的工作流——会话树、任意递归分屏、快捷命令、命令历史——并补上了它们缺少的能力：AI Agent 状态指示、MCP 服务，以及端到端加密的手机访问。

## 亮点

- **多协议合一**：SSH、本地终端（ConPTY）、Telnet、TCP 直连与串口。
- **轻快**：用 Tauri 而不是 Electron；终端输出走带流控的二进制通道，并把反压传到远端。
- **为 AI 编程助手而做**：一眼看出哪个标签里的 Claude Code / Codex 正在工作、等待确认或已完成；Agent 还能通过 MCP 操作终端。
- **手机上看你的终端**：自建中继 + PWA，AES-256-GCM 端到端加密，中继只能看到密文。
- **熟悉且可导入**：一键导入 WindTerm 会话与 OpenSSH 配置。

## 功能

### 连接
- **SSH**（`russh`）：密码、Keyboard-Interactive、私钥认证（OpenSSH / PEM / Ed25519 / RSA，支持口令）、**ProxyJump 跳板机**、KeepAlive 保活、PTY 尺寸实时同步、登录后自动执行脚本、主机密钥确认。
- **本地终端**（`portable-pty`）：通过 Windows ConPTY 运行 PowerShell、CMD、WSL 与自定义命令。
- **Telnet、TCP、串口**会话。
- **端口转发 / 隧道**，以及可选的内置 **X Server**（X11 转发）。
- 终端内 **ZMODEM / XMODEM / YMODEM** 文件传输，以及会话**日志**记录。

### 工作区
- 会话管理器侧边栏：多级分组、搜索、复制 / 编辑 / 删除、双击连接。
- 标签页支持**无限递归分屏**，可拖拽调整比例与位置，标签页可在窗口间移动。
- **广播输入**到当前标签的所有窗格或全部标签。
- 快速连接栏（`ssh user@host:22`、`ssh -p 2222 -i key user@host`、`powershell`、`wsl`）、命令面板，以及分组的 **QuickBar** 快捷命令。
- 命令**历史**、**自动补全**、**发送器**（带延时向多个会话发送文本）、输出折叠与高亮规则、时间戳栏与标尺标记。
- 稳定的**专注模式**（`F11`）与**锁屏**：纯显式状态管理，没有后台定时器。

### AI Agent
- **Claude Code** 与 **Codex** 的实时状态徽标：工作中、等待授权、已完成、出错。状态来自 Agent hooks（本机或 SSH 主机上一键安装），并以屏幕识别兜底。
- 内置 **MCP 服务**，Agent 可以读取并操作你交给它的终端标签。

### 手机远程
- 扫描二维码配对，添加到主屏幕即可当 PWA 使用。
- 实时查看所有标签，底部有 Esc / Tab / Ctrl / Alt / 方向键等移动端按键栏。
- **端到端加密**：配对密钥放在二维码链接的 `#` 之后，不会发给中继。自建方法见 [`relay/`](relay/README.md)（Docker）。

### 外观与体验
- 内置主题（`Dige Black`、`Dige Black & White`、`Dige White`、`Wind Abyss`），并支持自定义主题。
- 界面支持简体中文与英文。
- 可从 **WindTerm** 配置与 `~/.ssh/config` 导入会话、快捷命令和配色。

## 环境要求

Nexterm 目前面向 **Windows 10/11**（依赖 ConPTY 与 WebView2）。

从源码构建需要：

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs)（stable，MSVC 工具链）
- Windows 下的 [Tauri v2 前置依赖](https://tauri.app/start/prerequisites/)

## 快速开始

```powershell
git clone https://github.com/rty813/nexterm.git
cd nexterm
npm install

npm run tauri:dev      # 开发模式（热重载）
npm run tauri:build    # 生产构建 -> src-tauri/target/release/nexterm.exe
```

运行测试：

```powershell
npm test                                                 # 前端（vitest）
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust 单元测试
cd relay; npm test                                       # 中继与加密协议
```

> 若 `nexterm.exe` 仍在运行，请先结束它再编译 release，否则 Windows 会因文件占用而失败。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/` | React + TypeScript 前端（组件、hooks、纯逻辑 `utils/`、i18n、主题） |
| `src-tauri/` | Rust 后端：连接管理，SSH / PTY / 串口 / Telnet / TCP，ZMODEM，MCP，手机远程桥接 |
| `relay/` | 自建中继与手机 PWA（Node.js） |
| `bench/` | 终端吞吐与内存基准测试 |

## 第三方组件

- Windows 构建在 `src-tauri/resources/vcxsrv/` 下附带 **[VcXsrv](https://sourceforge.net/projects/vcxsrv/)**（GPL-2.0），作为独立程序用于可选的 X11 转发。其许可证与源码请见上游项目。
- [xterm.js](https://xtermjs.org)、[Tauri](https://tauri.app)、[russh](https://github.com/Eugeny/russh)、[portable-pty](https://github.com/wez/wezterm/tree/main/pty) 等依赖各自遵循其许可证。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行前端与 Rust 测试，新增界面文案请同时提供中英文。

## 许可证

以下两种许可证任选其一：

- [Apache License, Version 2.0](LICENSE-APACHE)
- [MIT license](LICENSE-MIT)

除非你另有明确说明，你有意提交到 Nexterm 的任何贡献都将按上述双许可证授权，不附加任何其他条款。

## Star History

<a href="https://star-history.com/#rty813/nexterm&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=rty813/nexterm&type=Date" />
  </picture>
</a>
