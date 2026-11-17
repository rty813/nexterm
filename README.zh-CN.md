# Nexterm

[English](README.md) | 简体中文

<img src="src-tauri/icons/128x128.png" alt="" width="64" align="right" />

**Nexterm** 是一款高性能 Windows 终端客户端，支持 SSH、本地 Shell（PowerShell / CMD / WSL）、Telnet、TCP 与串口，基于 Rust + Tauri v2 + React + [xterm.js](https://xtermjs.org) 构建。

延续 WindTerm 的交互习惯（会话树、嵌套分屏、快捷命令、一键导入 WindTerm 配置），并内置了几项特色能力：

- **远程文件管理**：SFTP 侧边栏（无 SFTP 自动降级 SCP），支持并发队列、免下载预览与**本地编辑保存自动回传**。
- **AI Agent 协同**：标签页实时显示 **Claude Code / Codex / Gemini CLI** 状态；**任务完成、等待权限审批或出错**时即时弹窗通知，点击直达对应窗格；内置 MCP 服务可将窗格受控授权给 AI 操作。
- **手机端到端远程**：扫码在手机浏览器查看与操控电脑终端、自适应手机屏幕尺寸、管理会话与收发文件，全程零知识加密。
- **完整回滚历史**：窗格输出过的每一行都在后台压缩保存，可以一直往上滚到会话开始，全部可搜索、可导出。

仅支持 Windows 10 / 11，当前版本 `0.1.2`。

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
- **完成提醒与阅读辅助**：长耗时编译/脚本可开启**「命令完成时通知我」**（弹窗显示耗时与退出码）；支持输出折叠、关键字高亮、专注模式（`F11`）与锁屏。

### 回滚与搜索

- **全部行，无缝回滚**：可以一直往上滚到会话开始。更早的输出在接近时自动加载进同一个终端，不需要另开查看器。滚动条代表全部历史，拖到最上面就是第一行。从菜单清除回滚或在远端执行 `clear`，都会一并清除完整历史，行号从 1 重新开始，与 WindTerm 一致。原理见[完整回滚历史的实现](#完整回滚历史的实现)。
- **在全部历史中搜索**：`Ctrl+Shift+F` 的计数、上一个/下一个和结果列表都覆盖全部历史，支持大小写、全词和正则。命中的行不在终端里时，跳转时自动加载。
- **滚动条标记覆盖全部历史**：搜索命中、关键字高亮规则和选中文字的其他出现位置，都按全部历史标在滚动条上。
- **时间与行号栏**（`Ctrl+Shift+S`）：显示每行的输出时间和从窗格打开起的行号，当前行用不同颜色显示。终端里光标所在行和鼠标点击的行各有一条背景色带。
- **导出与 AI 读取**：「保存到文件」导出完整历史，而不只是当前缓冲区。MCP 的 `read_history`、`search_history` 也能读取和搜索全部历史。
- **可调上限**：在设置里可以关闭完整历史，或设置每个窗格的内存和临时文件上限。

### AI Agent

- **实时状态标签**：自动显示 Claude Code / Codex / Gemini CLI 当前处于**工作中**、**等待审批 / 提问**、**已完成（未读）**或**出错**，多开 Agent 一目了然。
- **关键节点系统通知**：后台 Agent **完成任务**、**停下请求权限审批**或**报错**时自动闪烁任务栏并弹出系统通知，点击通知直接唤醒并定位到该窗格。
- **一键 Hooks + 读屏兜底**：本机、SSH 与 WSL 支持一键安装状态 Hooks（其他 Linux / 串口可复制单行命令安装）；未装 Hooks 时自动回退为屏幕内容识别。
- **MCP 终端受控托管**：可将 Nexterm 注册为 MCP 服务器，让 AI 读屏、执行命令或操作 `vim` / `top` 等交互程序。在 SSH 窗格上，AI 还可以浏览服务器目录、**上传 / 下载文件和文件夹**（SFTP，不支持时自动改用 SCP），传输进入传输面板，可随时暂停或取消。每次接管或新建会话均需**弹窗审批**，托管期间自动锁键盘防误触，随时可**暂停**或**一键收回控制**。

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

与 WindTerm 2.7.0 对比，使用 WindTerm 官方的[吞吐测试方法](https://github.com/kingToolbox/WindTerm#terminal-performance)（耗时越短越好）。Nexterm 开启完整回滚历史（默认设置）：

| 测试 | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| `cat` 100 MB 随机 base64 文本 | 5.53 s | **4.98 s** |
| `seq 1 1000000` | **1.43 s** | 2.04 s |
| `seq 1 2000000` | **2.23 s** | 2.97 s |
| `seq 1 5000000` | 5.38 s | **4.73 s** |
| `seq 1 10000000` | 10.15 s | **7.54 s** |

内存（整个进程树的专用工作集，含 WebView2）：

| 状态 | Nexterm | WindTerm 2.7.0 |
| --- | --- | --- |
| 空闲，打开一个会话 | 218 MB | **43 MB** |
| 输出 `seq 1 1000000` 后 | 峰值 350 MB，稳定后 248 MB | **75 MB** |

- **内存去向**：约 170 MB 是 WebView2 的固定开销。xterm.js 只保留最近 1 万行，按字符格固定大小存储；更早的内容压缩后放在后端，输出 `seq 1 1000000` 后 `nexterm.exe` 本身约占 20 MB。峰值大部分是 JavaScript 尚未回收的垃圾，输出停止后几秒内释放。和 WindTerm 一样，Nexterm 现在也保留全部行。
- **完整历史的开销**：后端在独立线程里解析并压缩全部输出，大量输出时约多占一个 CPU 核心。吞吐基本不受影响：连续单次测试中，`seq 1 10000000` 开启完整历史时 8.9 s，关闭时 8.7 s。
- **测试环境**：AMD Ryzen 7 5700G、32 GB 内存、Windows。两个终端都通过 Telnet 连接本机 WSL 中的服务端，窗口大小相同。计时从命令开始，到终端处理完全部输出为止：以光标位置查询（DSR）的回复为准；WindTerm 在 Telnet 下不回复 DSR，改为以程序 CPU 回落到空闲为准。每项先预热一次，再取 3 次的中位数。WindTerm 的数据来自同一台机器、同样设置下较早的一次测试。
- **复现**：在被测终端里运行 [`bench/bench.sh`](bench/bench.sh)，并在 Windows 上运行 [`bench/mem.ps1`](bench/mem.ps1) 采样终端进程树的内存。

### 完整回滚历史的实现

WebView 里的终端没法直接保留几百万行：xterm.js 每行按整个窗口宽度存储，每个字符格 12 字节，125 列时 1000 万行约要 15 GB。Nexterm 改为在 Rust 后端保存全部历史，需要时再交给 xterm.js 显示（[`src-tauri/src/history/`](src-tauri/src/history/)、[`src/services/historyScroll.ts`](src/services/historyScroll.ts)）：

1. **后端第二个终端**：每个窗格的输出照常交给 xterm.js，同时复制一份给后台线程里一个无界面的 [`alacritty_terminal`](https://crates.io/crates/alacritty_terminal)，尺寸与窗格一致。它和屏幕一样处理光标移动、`\r` 进度条、清屏和全屏程序，所以历史里存的就是当时屏幕上显示的内容。每一行滚出它的屏幕后，归入一条逻辑行：自动折行的几行合成一行，窗口宽度变了也能正确重新折行。
2. **存文本，不存字符格**：每行存文本、颜色区段（比如「第 3～10 个字符是红色」）和输出时间。每 2000 行打成一块，用 zstd 压缩。`seq 1 10000000`（78 MB 文本）压缩后约 6 MB。
3. **内存有上限**：超过内存上限（默认每个窗格 32 MB）后，最旧的块用 AES-256-GCM 加密写入临时文件，密钥只在本次运行的内存里。关闭窗格或退出程序时删除；超过磁盘上限（默认 2 GB）后丢弃最旧的行。两个上限都可以在设置里改。
4. **无缝滚动**：xterm.js 只保留最近的行。视图接近缓冲区顶部时，前端从后端取更早的行，按窗格宽度渲染好，插到 xterm.js 缓冲区的最上面。之后选择、复制、链接和高亮对这些行都照常生效。离视图远的行会再丢掉，同时最多额外加载约 3 万行；回到底部后全部释放。
5. **滚动条覆盖全部历史**：滚动条的大小和位置按完整历史的行数计算，而不是 xterm.js 缓冲区的行数。拖到最上面就是会话的第一行，途中按需加载。
6. **全量搜索也很快**：后端在多个线程上搜索压缩块。每块先整体匹配一次，命中了才逐行查找，过程中不为每行创建对象。1000 万行全部扫一遍约 0.1 秒。每个关键字的分块计数会缓存，之后的计数和滚动条标记只需扫新输出。

## 构建
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
| `src-tauri/` | Rust 后端：连接管理、各协议、SFTP / SCP、Shell 集成、完整回滚历史、MCP、手机远程 |
| `relay/` | 手机远程自建中继与移动端 PWA（Node.js） |
| `bench/` | 吞吐与内存基准测试脚本 |

## 参与

欢迎提 Issue 和 PR。提交前请运行前端和 Rust 测试；新增界面文案需同时提供中英文。

## 许可证

[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE) 双许可证任选其一。Windows 构建内置的 [VcXsrv](https://sourceforge.net/projects/vcxsrv/)（`src-tauri/resources/vcxsrv/`）为独立 GPL-2.0 程序，其余依赖遵循各自许可证。
