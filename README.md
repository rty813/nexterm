# Nexterm

基于 **Tauri v2 (Rust) + React + TypeScript + xterm.js** 从零构建的现代 SSH 与本地终端客户端，参考并复刻 WindTerm 2.7.0 的核心工作流与 `dige-black` 视觉风格，从架构根源解决旧版停止维护后的专注模式自动退出及现代 ANSI/VT（`OSC 133`、`OSC 8`、私有 `CSI`、`XTVERSION`）兼容问题。

## 已实现功能

- **多协议连接引擎（纯 Rust 异步后端）**
  - **SSH2 (`russh`)**：支持密码认证、Keyboard-Interactive 回退、私钥文件认证（OpenSSH / PEM / Ed25519 / RSA + 口令）、**ProxyJump 跳板机隧道**、KeepAlive 心跳保活、动态窗口尺寸同步（PTY Resize）及连接后自动执行脚本。
  - **本地终端 (`portable-pty` / Windows ConPTY)**：原生支持 PowerShell、CMD、WSL 及自定义本地命令。
  - **TCP 直连**：支持原生 TCP Socket 调试会话。
- **WindTerm 经典布局与体验**
  - **会话管理器侧边栏**：兼容 WindTerm `>` 多级分组树、实时搜索过滤、双击连接、一键分屏打开、复制/编辑/删除。
  - **多标签与任意递归分屏**：支持水平/垂直无限分屏、拖拽调整比例、标签序号 `1..9`（`Alt+1..9` 切换）、中键重命名、双击关闭标签页。
  - **多窗格同步广播输入 (Sync Input)**：支持向当前标签所有分屏或全部打开标签同步广播输入。
  - **顶部快速连接栏 & 底部 QuickBar**：支持 `ssh user@host:port` / `ssh -p 2222 -i key user@host` / `powershell` / `wsl` 快速连接（`Alt+Enter` 直接分屏打开），以及分组快捷命令一键发送。
  - **稳定的专注模式 (`F11`) & 锁屏 (`Lock Screen`)**：纯显式状态管理，无后台定时器异常退出问题。
- **原版配置与主题一键导入**
  - 自动扫描并导入本机 `~/.wind/profiles/*/terminal/user.sessions`、`~/.ssh/config` 以及原版 `scheme.theme` 配色。
  - 内置精准还原的 `Dige Black`、`Dige Black & White`、`Dige White` 与 `Wind Abyss` 主题。

## 快速运行与构建

### 1. 直接运行已编译的独立桌面版程序
```powershell
./src-tauri/target/release/nexterm.exe
```

### 2. 开发调试模式（支持热重载）
```powershell
cd nexterm
npm run tauri:dev
```

### 3. 运行前后端测试与生产构建
```powershell
cd nexterm
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri:build
```
