# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Nexterm：仿 WindTerm 的 Windows 终端客户端（SSH / 本地 ConPTY / Telnet / TCP / 串口），Rust 后端 + Tauri v2 + React + TypeScript + xterm.js。仅支持 Windows 10/11（依赖 `windows-sys`、ConPTY、WebView2）。

## 命令

```powershell
npm run tauri:dev                     # 开发模式（Vite 端口 1420，strictPort）
npm run tauri:build                   # 生产构建 → src-tauri/target/release/nexterm.exe
npm run build                         # 仅前端：tsc 类型检查 + vite build
npm test                              # 前端 vitest（src/__tests__/*.test.ts）
npx vitest run src/__tests__/agent.test.ts      # 单个测试文件
npx vitest run -t "测试名"                        # 按名称过滤
cargo test --manifest-path src-tauri/Cargo.toml --lib            # Rust 单元测试（各模块内 #[cfg(test)]）
cargo test --manifest-path src-tauri/Cargo.toml --lib zmodem::   # 只跑某个模块
cd relay; npm test                    # 中继 + 加密协议（node:test；vitest 已排除 relay/）
```

- release 构建前若 `nexterm.exe` 正在运行会因文件占用失败：先 `taskkill /IM nexterm.exe /F`。
- `tsconfig.json` 开启 `strict`、`noUnusedLocals`、`noUnusedParameters`，未使用的变量会让 `npm run build` 失败。
- 纯浏览器（`npm run dev`）下没有 Tauri 后端，`invoke` 会失败，只能看界面。
- 性能基准：`bench/bench.sh`（在被测终端里经 SSH 运行，用 DSR 回包测解析吞吐）、`bench/mem.ps1`（统计进程树含 WebView2 的内存）。
- 提交前跑前端和 Rust 测试；新增界面文案必须同时有中文和英文。

## 架构

### 后端（`src-tauri/src/`）

- `lib.rs`：`AppContext`、全部 `#[tauri::command]`、托盘、单实例、窗口关闭处理。新命令要注册到 `generate_handler!`。`AppSettings` 里较新的设置放在 `extra`（`serde_json::Value` 映射）中，用 `extra_bool`/`extra_str` 读取，不给结构体加字段。
- `manager.rs`：`ConnectionManager` 按 `instance_id`（每个窗格一个连接实例）管理连接。各协议模块（`ssh_conn`、`local_pty`、`telnet_conn`、`tcp_conn`、`serial_conn`）通过 `spawn_*_session` 启动后台任务，用 `ControlMsg`/`RuntimeControl` 接收写入、resize 和关闭。输出走 `TerminalSink` trait，包装层在这里截获 ZMODEM 检测、X/YMODEM 传输（`zmodem.rs`、`xymodem.rs`、`transfer.rs`）、会话日志和 shell 集成注入。SSH 主机密钥确认是 `host-key-prompt` 事件和 `respond_host_key` 命令的往返。ZMODEM 接收先写到目标目录里的临时文件，传完才落盘；目标已存在时也是往返：`zmodem-progress` 事件（`state: "conflict"`）问用户改名 / 覆盖 / 取消，`zmodem_answer` 命令回答，文件名经 `zmodem::valid_receive_name` 校验（不能含路径或 Windows 保留名）。
- `output.rs`：终端输出不走事件/JSON，而是每个窗格一个 `tauri::ipc::Channel`，发送原始 `ArrayBuffer`，并带流控：前端确认 xterm.js 已解析的字节；未确认的超过窗口时合并到 pending，pending 满了就阻塞连接读线程（反压到远端）；1 秒没有确认视为卡死，继续发送。窗格可以在窗口之间迁移（孤儿缓冲 8 MB）。
- `shell_integration.rs` + `src-tauri/shell-integration/*`：SSH 自动注入通过 exec 通道上传脚本到 `/tmp`，不改远端 dotfiles，再键入一行加载器（输出被暂扣并重绘，用户看不到加载器），让 shell 上报 OSC 133/633/7；WSL 同样自动注入（`local_pty.rs` 另起一个 `wsl.exe` 写脚本），本地 PowerShell 启动时带集成参数。总开关是 `settings.extra.shellIntegration`（默认开）。右键“加载 Shell 集成”（嵌套 ssh、容器、串口、Telnet 等）发送 gzip+base64 安装器，为当前用户安装到 `~/.local/share/nexterm/shell-integration/`，写入 bash/zsh/fish 启动配置并立即加载，重开后继续生效；修改已有启动文件前保存 `.nexterm-si.bak` 备份。
- `mcp.rs` + `term_capture.rs`：内置 MCP 服务器。在 127.0.0.1 上提供 JSON-RPC over HTTP POST（bearer token），地址写在 `<data>/mcp-endpoint.json`。`nexterm.exe mcp` 是一个 stdio 桥：自己应答 `initialize`/`tools/list`，再把 `tools/call` 转发给正在运行的应用。agent 必须先 `request_control`，用户批准后才能读屏和输入；持有期间用户键盘被锁。命令输出在后端按 OSC 133 截取，屏幕内容经 `mcp-read-screen` 事件 / `mcp_screen_reply` 命令从前端 xterm.js 取回。
- `agent.rs`：Claude Code / Codex / Gemini CLI 的 hook 上报的 agent 状态（Gemini 的事件名和超时单位不同，见 `utils/agentHooks.ts`）。远程 shell 用 OSC 7501 写到 tty；本地 shell 因为 ConPTY 会丢掉未知 OSC，改为调用本地 HTTP 端点（环境变量 `NEXTERM_AGENT_URL`、`NEXTERM_PANE_ID`）。前端在没有 hook 时退回读屏识别（`utils/agentStatus.ts`）。
- `remote.rs` / `remote_crypto.rs` / `remote_ops.rs`：远程访问（界面上叫“远程访问”，代码里沿用 remote / phone 的命名）。电脑以 host 身份连接自建中继（`relay/`：Node + ws，同时托管 PWA 和分享页），两端之间 AES-256-GCM 端到端加密（配对密钥在二维码 URL 的 `#` 之后，存于 `remote_pairing.json`）。手机画面来自桌面 xterm.js：`services/remoteMirror.ts` 把已解析的输出和序列化快照经 `remote_feed` 转发；手机“接管尺寸”通过 `remote-size` 事件让窗格固定为手机的行列数。`remote_ops.rs` 处理会话管理和 SFTP 文件传输的请求/响应帧。**这条链路不能依赖 `setTimeout` 或渲染**（窗口最小化时 WebView2 会节流）。`remote_crypto.rs` 的测试向量由 `relay/public/crypto.js` 生成，改任一侧加密都要同步另一侧。中继连接本身（重连、心跳、帧格式）在 `relay_link.rs`。
- `share.rs`：单次会话分享。每个分享一个内存里的新密钥和独立房间（单独一条 `relay_link` 连接），只转发一个窗格的画面；访客默认只读，`in` 和接管尺寸（`take`，同样走 `remote-size`）只接受持有控制权的访客，控制权一变尺寸就还给电脑。画面同样来自 `remoteMirror`：`remote::watched()` 是远程访问和分享的并集，不含回滚的分享用 `F_SCREEN` 快照。访客页是 `relay/public/share.html` + `share.js`（路由 `/s`），前端是 `components/ShareDialog.tsx` + `services/shares.ts`。
- `storage.rs`：JSON 文件持久化（`sessions.json`、`quick_commands.json`、`settings.json`、`custom_themes.json`），位于 Tauri `app_data_dir`。`app_paths.rs` 给出数据目录和打包资源目录（`resources/vcxsrv` 是 X11 转发用的 VcXsrv；`resources/commands` 是补全目录，由 `commands.rs` 加载）。
- `sync.rs`：配置导出/导入与云同步（S3 兼容存储用自写 SigV4 签名、WebDAV、GitHub Gist、本地/网络文件夹）。打包格式 `nexterm-config` v1，可选 PBKDF2 + AES-256-GCM 加密；`hash` 明文保留用于变更判断。`sync_state.json` 记录上次同步两侧的哈希，决定上传/下载/冲突。`settings` 中的 `sync`、`logDir`、`zmodemDownloadDir`、`xserver` 属于本机，不导出也不被覆盖；`remote` 只同步 `relayUrl` + `hostToken`（有地址时成对覆盖），`enabled`、`readOnly` 和配对密钥留在本机。写入前备份到 `<data>/backups/`（保留 10 份），完成后发 `config-applied` 事件让各窗口重新加载。前端界面是 `components/SettingsSync.tsx`。
- `importer.rs`：从 `~/.wind/profiles/*/terminal/user.sessions`、`~/.ssh/config`、WindTerm 的 `scheme.theme` 导入；`importer_xshell.rs`（`.xsh` 目录 / `.xts` 包）和 `importer_mobaxterm.rs`（`MobaXterm.ini` / `.mxtsessions` 的 Bookmarks）共用其中的 `decode_text`（BOM / UTF-16LE / GBK）和 `parse_ini`。
- `net.rs`：出站连接，SOCKS5 / SOCKS4(a) / HTTP CONNECT 代理和 SSH 的 ProxyCommand（`connect_stream`）；`socks.rs`：动态转发（`-D`）的 SOCKS4/4a/5 服务端，解析是纯函数。
- `server_stats.rs`：服务器资源监控的采样脚本（`/proc` + `df`），经窗格已有 SSH 连接的 exec 通道运行；解析和速率计算在前端 `utils/serverStats.ts`，轮询在 `services/serverMonitor.ts`（只在显示且窗口可见时）。
- `sftp.rs` / `scp.rs`：SSH 窗格的文件面板（前端是 `SftpPanel.tsx`）。

### 前端（`src/`）

- 多窗口：同一个 bundle。`main.tsx` 按 URL hash 选择根组件：`#ctxmenu` 渲染 `MenuHost`（上下文菜单是独立的 webview 窗口），其余渲染 `App`；拆出去的标签页是 `term-*` 窗口。新增窗口标签要同时加入 `src-tauri/capabilities/default.json` 的 `windows` 列表。
- `services/backend.ts`：`invoke`、事件和后端命令的封装层，组件通过它调用后端（少数窗口操作直接用 `@tauri-apps/api/window`）。`types/domain.ts` 与 Rust `models.rs` 一一对应（serde `camelCase`），改一侧必须同步另一侧。
- `services/terminalBus.ts`：按 paneId 分发输出字节，窗格未挂载时先暂存。`services/mcpScreen.ts` 应答 MCP 读屏请求。
- `App.tsx` 持有标签、分屏布局（`utils/layout.ts` 是递归的分屏树）、广播输入等全局状态；`components/TerminalPane.tsx` 封装单个 xterm.js 实例及各种附加功能。
- `utils/` 是与 UI 解耦的纯逻辑（快速连接解析、会话树、输出折叠/高亮、命令历史、自动补全、agent 状态识别等），也是 vitest 的主要测试对象。新逻辑尽量放在这里，方便测试。
- i18n：`i18n.ts` 是基础资源，`i18n.extra.ts`（WindTerm 对齐功能）和 `i18n.ui.ts`（布局重做相关）在运行时依次深度合并进去。
- 主题在 `constants/themes.ts`，样式集中在 `styles/app.css`（SFTP 的样式在 `styles/sftp.css`）。
