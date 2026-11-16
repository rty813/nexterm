# Nexterm

[English](README.md) | 简体中文

<img src="src-tauri/icons/128x128.png" alt="" width="64" align="right" />

**Nexterm** 是一款高性能 Windows 终端客户端，支持 SSH、本地 Shell（PowerShell / CMD / WSL）、Telnet、TCP 与串口，基于 Rust + Tauri v2 + React + [xterm.js](https://xtermjs.org) 构建。

延续 WindTerm 的交互习惯（会话树、嵌套分屏、快捷命令、一键导入 WindTerm 配置），并内置了几项特色能力：

- **远程文件管理**：SFTP 侧边栏（无 SFTP 自动降级 SCP），支持并发队列、免下载预览与**本地编辑保存自动回传**。
- **AI Agent 协同**：标签页实时显示 **Claude Code / Codex / Gemini CLI** 状态；**任务完成、等待权限审批或出错**时即时弹窗通知，点击直达对应窗格；内置 MCP 服务可将窗格受控授权给 AI 操作。
- **手机端到端远程**：扫码在手机浏览器查看与操控电脑终端、自适应手机屏幕尺寸、管理会话与收发文件，全程零知识加密。

仅支持 Windows 10 / 11，当前版本 `0.1.0`。

![Nexterm 主界面：会话树、分屏运行 htop 与 Claude Code、SFTP 文件浏览器、快捷命令栏](docs/media/screenshot.jpg)

## 功能

### 连接

- **SSH**（`russh`）：密码、交互式、私钥认证（OpenSSH / PEM，Ed25519 / RSA，支持口令），支持跳板机（ProxyJump）、保活、登录后脚本与首次连接主机密钥确认。
- **本地与硬件协议**：ConPTY 本地终端（PowerShell / CMD / WSL / 自定义命令），以及 Telnet、Raw TCP、串口。
- **Shell 集成**：SSH 的 `bash` / `zsh` / `fish` 和本地 `PowerShell` 支持自动注入目录与命令追踪（OSC 133 / 633 / 7）。右键“加载 Shell 集成”会为当前 `bash` / `zsh` / `fish` 用户安装脚本并写入启动配置，立即生效，重开会话后自动加载；适用于 WSL、SSH、嵌套 Shell 和串口，修改已有启动文件前会保留 `.nexterm-si.bak` 备份。
- **转发与终端传输**：支持端口转发、一键开启内置 VcXsrv 的 X11 转发、终端内 **ZMODEM / XMODEM / YMODEM** 收发文件及会话日志。

### 文件浏览器

- **SFTP / SCP 自动兜底**：`Ctrl+Shift+O` 或右键打开；服务器无 SFTP 子系统时自动切换为 SCP + Shell 命令。
- **目录双向联动**：支持路径输入与过滤，可**自动跟随终端 `cd`**，或一键让终端跳转到当前浏览目录。
- **本地编辑自动上传**：用本地编辑器打开远端文件，每次保存自动回传服务器。
- **免下载预览**：直接预览代码/文本、JSON、Markdown、CSV/TSV 表格、图片（缩放/旋转）与 PDF。
- **并发传输队列**：支持拖拽上传文件/文件夹、软链接、权限修改（勾选或八进制），支持暂停 / 续传 / 重试与冲突策略，统一显示 ZMODEM 进度。

### 窗口与输入

- **分屏与多窗口**：多级会话树与搜索；标签内任意嵌套分屏、拖拽调整布局，或将标签拖出为独立窗口。
- **高效输入**：**广播输入**（当前标签分屏或全部标签）、定时多会话发送器、命令面板、分组快捷命令栏与**历史/词库自动补全**。
- **快速连接栏**：直接输入 `ssh user@host:22`、`ssh -p 2222 -i key user@host`、`powershell` 或 `wsl` 回车即连。
- **完成提醒与阅读辅助**：长耗时编译/脚本可开启**「命令完成时通知我」**（弹窗显示耗时与退出码）；支持输出折叠、关键字高亮、时间戳栏、专注模式（`F11`）与锁屏。

### AI Agent

- **实时状态标签**：自动显示 Claude Code / Codex / Gemini CLI 当前处于**工作中**、**等待审批 / 提问**、**已完成（未读）**或**出错**，多开 Agent 一目了然。
- **关键节点系统通知**：后台 Agent **完成任务**、**停下请求权限审批**或**报错**时自动闪烁任务栏并弹出系统通知，点击通知直接唤醒并定位到该窗格。
- **一键 Hooks + 读屏兜底**：本机、SSH 与 WSL 支持一键安装状态 Hooks（其他 Linux / 串口可复制单行命令安装）；未装 Hooks 时自动回退为屏幕内容识别。
- **MCP 终端受控托管**：可将 Nexterm 注册为 MCP 服务器，让 AI 读屏、执行命令或操作 `vim` / `top` 等交互程序。每次接管或新建会话均需**弹窗审批**，托管期间自动锁键盘防误触，随时可**暂停**或**一键收回控制**。

<p align="center">
  <a href="docs/media/mcp-demo.mp4"><img src="docs/media/mcp-demo.gif" alt="MCP 演示：Claude Code 通过 Nexterm 打开 WSL 查看磁盘占用" width="860" /></a>
  <br />
  <sub>Claude Code 通过 Nexterm 的 MCP 服务打开 WSL 窗格、查看磁盘占用后自动关闭（2.5 倍速，点击查看完整视频）。</sub>
</p>

### 手机远程

- **自建中继 + 端到端加密**：配套轻量自建中继（见 [relay/README.md](relay/README.md)，含 Docker 配置），工具栏可一键开关。扫码配对，密钥仅保存在 URL `#` 后，中继只转发 AES-256-GCM 密文。
- **移动端 PWA 与自适应尺寸**：免安装添加到主屏幕，带 `Esc` / `Tab` / `Ctrl` / `Alt` / 方向键触控栏，一部手机可同时连多台电脑；支持「接管尺寸」将终端行列数临时适配手机屏幕，离开自动恢复。
- **手机端直接登录与重连**：连接等待输入**用户名 / 密码**或首次确认 **SSH 主机密钥**时，可直接在手机弹窗中填写确认（电脑端弹窗同步关闭）；断线或失败后支持手机端直接重连或重输密码。
- **会话、文件与只读模式**：手机端可浏览、新建、编辑并打开电脑会话（已存密码不下发手机），上传或下载最大 **1 GB** 远端文件；支持开启「手机只能查看」只读模式（最多 8 台设备同时在线）。

<p align="center">
  <a href="docs/media/phone-remote.mp4"><img src="docs/media/phone-remote.gif" alt="手机远程演示：在手机上操控电脑的 SSH 会话" width="860" /></a>
  <br />
  <sub>在手机上直接输入操控电脑端 SSH 会话，「接管尺寸」让终端适配手机屏幕（1.5 倍速，点击查看完整视频）。</sub>
</p>

### 配置同步与备份

- **多端云同步**：在「设置 → 同步与备份」中把会话、快捷命令、自定义主题、设置、发送器与命令历史同步到 **S3 兼容存储**（AWS S3、Cloudflare R2、MinIO、阿里云 OSS、腾讯云 COS 等）、**WebDAV**（坚果云、Nextcloud、群晖等）、**GitHub Gist**（私密 Gist，自带历史版本）或**本地 / 网络文件夹**（OneDrive、Dropbox、SMB 共享等）。支持启动时与定时自动同步。
- **冲突处理与本机隔离**：自动判断只需上传还是下载；两端都有改动时提示冲突，可选择合并（按 ID）、保留本机或保留远程。同步目标、日志目录、X 服务器、手机远程等本机设置不会被同步或覆盖。
- **加密导出 / 导入**：可按类别导出为单个 JSON 文件并设置密码（PBKDF2 + AES-256-GCM 加密），导入时可选择合并或替换。导入或下载前自动备份当前配置到数据目录的 `backups/`（保留最近 10 份）。

### 其他

- **无缝迁移**：支持从 **WindTerm** 导入会话、快捷命令与配色，从 `~/.ssh/config` 导入主机。
- **个性化**：内置 4 套主题并支持自定义配色、快捷键与工具栏；支持简体中文与英文界面。

## 性能

与 WindTerm 2.7.0 对比，使用 WindTerm 官方的[吞吐测试方法](https://github.com/kingToolbox/WindTerm#terminal-performance)（耗时越短越好）：

| 测试 | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| `cat` 100 MB 随机 base64 文本 | **4.43 s** | 4.98 s |
| `seq 1 1000000` | **1.39 s** | 2.04 s |
| `seq 1 2000000` | **2.29 s** | 2.97 s |
| `seq 1 5000000` | 4.92 s | **4.73 s** |
| `seq 1 10000000` | 9.26 s | **7.54 s** |

内存（整个进程树的专用工作集，含 WebView2）：

| 状态 | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| 空闲，打开一个会话 | 186 MB | **43 MB** |
| 输出 `seq 1 1000000` 后 | 峰值 434 MB，稳定后 284 MB | **75 MB** |

- **内存去向**：约 170 MB 是 WebView2 的固定开销。Nexterm 保留 5 万行回滚，xterm.js 按字符格固定大小存储；WindTerm 压缩回滚区并保留全部行。峰值大部分是 JavaScript 尚未回收的垃圾，输出停止后一分钟内释放。
- **测试环境**：AMD Ryzen 7 5700G、32 GB 内存、Windows。两个终端都通过 Telnet 连接本机 WSL 中的服务端，窗口大小相同。计时从命令开始，到终端处理完全部输出为止：以光标位置查询（DSR）的回复为准；WindTerm 在 Telnet 下不回复 DSR，改为以程序 CPU 回落到空闲为准。每项先预热一次，再取 3 次平均。
- **复现**：在被测终端里运行 [`bench/bench.sh`](bench/bench.sh)，并在 Windows 上运行 [`bench/mem.ps1`](bench/mem.ps1) 采样终端进程树的内存。

## 构建

环境要求：[Node.js](https://nodejs.org) >= 20、[Rust](https://rustup.rs) stable（MSVC）、[Tauri v2 Windows 依赖](https://tauri.app/start/prerequisites/)。

```powershell
git clone https://github.com/rty813/nexterm.git
cd nexterm
npm install

npm run tauri:dev      # 开发模式
npm run tauri:build    # 生产构建（输出 src-tauri/target/release/nexterm.exe，构建前请先退出正在运行的 nexterm.exe）
```

测试：

```powershell
npm test                                                 # 前端测试（Vitest）
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust 单元测试
cd relay; npm test                                       # 中继与加密协议测试
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 前端（React + TypeScript），`utils/` 存放与 UI 解耦的纯逻辑与主要测试 |
| `src-tauri/` | Rust 后端：连接管理、各协议、SFTP / SCP、Shell 集成、MCP、手机远程 |
| `relay/` | 手机远程自建中继与移动端 PWA（Node.js） |
| `bench/` | 吞吐与内存基准测试脚本 |

## 参与

欢迎提 Issue 和 PR。提交前请运行前端和 Rust 测试；新增界面文案需同时提供中英文。

## 许可证

[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE) 双许可证任选其一。Windows 构建内置的 [VcXsrv](https://sourceforge.net/projects/vcxsrv/)（`src-tauri/resources/vcxsrv/`）为独立 GPL-2.0 程序，其余依赖遵循各自许可证。
