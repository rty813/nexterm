# Nexterm 插件 SDK v1（实验版）

插件不需要和 Nexterm 一起编译或提交。以下用[公开的 Hello 计数器](../plugins/hello/)走一遍开发流程；它不依赖外部服务，也不需要任何真实账号。原生接口的签名见 [SDK 类型定义](../plugins/sdk/nexterm.d.ts)。

## 从零开始：做一个计数器

准备 Node.js 20 或更高版本，以及能在「设置」中看到「插件」入口的 Nexterm 桌面版。以下 PowerShell 命令从 Nexterm 仓库根目录执行，复制到一个**尚不存在**的相邻目录；你也可以在自己的独立仓库中维护插件。

```powershell
Copy-Item -Recurse ./plugins/hello ../my-counter
```

| 文件 | 先改什么 |
| --- | --- |
| `manifest.json` | 将插件 `id` 改为自己的唯一标识（例如 `example.my-counter`），`name` 改为 `My Counter`。保留示例中的命令 ID 和视图 ID，它们与脚本中的名称相对应。 |
| `main.js` | 后台通过 `onCommand("show", ...)` 打开视图；`handle("increment", ...)` 处理点击，更新标题栏并返回计数。关掉视图不停止后台，重载会重置这个内存计数。 |
| `view.html` | 页面调用 `nexterm.request("increment")`，并监听 `count` 事件更新按钮。样式和脚本写在 HTML 内；页面不直接访问宿主 DOM。 |

```powershell
node scripts/pack-plugin.mjs ../my-counter
```

这会在源码目录旁生成 `../my-counter.nexterm-plugin`。在 Nexterm 选择「设置 → 插件 → 安装本地插件」，确认名称为 **My Counter** 且没有网络权限，再授权安装。若同时装有原版 Hello，可先停用原版，以免两个标题栏入口同名。

**验证与第一次修改：** 点击标题栏的 **Hello**，再点击页面中的 `0`；按钮应变成 `1`，标题栏应显示 **Hello 1**。要试试内容弹窗，把清单中 `hello` 视图的 `location` 从 `tab` 改为 `dialog`，保留原有 ID，重新打包并选择同一个包，点「授权并替换」。再次点击 **Hello** 应弹出窗口，而不是新开标签页；不用修改宿主或页面代码。

## 安装、调试与分发

- **改动没有生效？** 「重载」重启已安装副本，不读取开发目录。修改脚本、清单或页面后都需要重新打包并替换安装。升级沿用相同的插件 ID，发布时更新 `version`；改 ID 会安装成另一个插件。
- **包被拒绝？** 核对清单的 `main`、视图的 `file`、命令引用和大小限制（见下节）。打包工具只收集清单引用的入口脚本和视图，不会自动打包 npm 依赖或子目录。
- **分发什么？** 分享生成的 `.nexterm-plugin` 即可，不需要把插件提交给 Nexterm。包是可读的 JSON，请勿在源码中嵌入密码或令牌。普通设置用 `config`，敏感信息使用下文的凭据 API。

在 Nexterm「设置 → 插件」选择 `.nexterm-plugin`，审核身份、网络地址和会话权限，再授权安装。同 ID 的包会替换旧版本，每次替换均重新确认权限。可启停、重新加载、调整插件顺序、隐藏单个入口和卸载。开发时修改源文件、重新打包并替换安装；当前没有目录监视。要分发给团队，可以发布到[插件商店](plugin-store.zh-CN.md)。关闭设置窗口不撤销已安装插件；插件操作即时生效，不依赖设置页的保存按钮。

每个插件的设置入口位于该插件所在行，点击齿轮按钮打开独立弹窗，不再把各插件配置集中列在单独一排。`views.open()` 打开 `settings` 视图时也使用同一弹窗，不必先打开宿主偏好设置。插件有多个设置页面时，可在弹窗中切换；配置保存由插件自己的界面负责。禁用、卸载或重新加载插件会关闭其设置弹窗。

设置弹窗支持关闭按钮、点击遮罩和 Esc，关闭后返回原入口，不影响宿主偏好设置草稿。设置页中的控件可通过 `preventDefault()` 自行处理 Esc，否则由宿主关闭弹窗。关闭或切换设置页会销毁该页面实例，插件应自行管理尚未保存的配置。

插件可声明 `location: "dialog"`，从状态项或命令用 `views.open(id)` 打开独立的内容弹窗。它不占用底部面板，不出现在活动栏或设置页列表中，与设置弹窗共用关闭方式；打开另一弹窗会替换当前弹窗。

弹窗大小：内容弹窗默认 760×560，设置弹窗默认 760×620，都不会超出窗口（四周各留 20px）。插件可以用两种方式调整：

- 清单里给 `dialog` / `settings` 视图加 `size: {width?, height?}`（CSS 像素整数，宽 320–2400、高 200–1600），作为打开时的初始大小；其他位置的视图带 `size` 会拒绝安装。
- 页面运行时调用 `await nexterm.views.resize({width?, height?})`，范围相同，例如根据内容多少调整高度。只能在弹窗页面中调用。

用户也可以点标题栏的最大化按钮铺满窗口，或拖动右下角调整大小；拖出来的大小按插件 + 视图记在本机，下次打开沿用（优先于清单里的 `size`），双击右下角恢复默认。页面应按 iframe 的实际大小自适应布局，不要假定固定尺寸。

选择本地包时，插件管理显示文件选择、读取和校验状态；通过校验才出现授权确认。读取期间可取消，关闭插件管理不会安装尚未确认的包。

`contributes.statusBar` 的可见状态项显示在主窗口标题栏右侧，专注模式也保留。窄窗口下，若状态文字与清单使用同一个 `标签：` 或 `Label: ` 前缀，则只显示后面的值，悬停及无障碍名称保留全文；其他文字原样显示。已有插件无需更改清单。用户可在插件管理中隐藏单项、停用或卸载插件。

包是 UTF-8 JSON：`{"manifest": {...}, "files": {"main.js": "...", "view.html": "..."}}`。上限 2 MiB、64 个平铺文件；HTML 的脚本、样式和图片须打包内联（图片可用 data URL），不支持直接引用外部脚本或相对文件。第三方可使用任意前端框架编译成单 HTML 文件。安装内容保存在当前主窗口 WebView 的本地存储中，不进入配置同步或会话导出。

## 清单

`manifest.json` 必需字段：`apiVersion: 1`、`id`、`name`、`version`、`main`、`permissions`、`contributes`。ID 和文件名由英文字母、数字、点、横线、下划线组成，以字母或数字开头，最长 96 字符。

| 字段 | 约定 |
| --- | --- |
| `permissions.network` | 精确 HTTPS origin 数组，例如 `https://example.com:8443`；不可带路径、尾斜线、用户名或密码，不支持通配符。 |
| `permissions.networkRequest` | 可选 `true`；允许通过 `network.request(origin)` 按需请求任意 HTTPS 目标，每个新目标由宿主单独向用户确认。 |
| `permissions.sessions` | 可选 `"open"`；仅请求新建临时 SSH 会话。插件主动打开时每次需用户确认；用户在会话栏点击插件提供的会话、且 SSH 主机与插件已授权的某个 HTTPS origin 主机名相同时不再确认（连接不会把插件的秘密带到新的地方），其他主机仍需确认。 |
| `permissions.credentials` | 可选 `"store"`；允许后台使用 Windows 凭据管理器，按插件 ID、HTTPS origin 和键名隔离。安装或替换时需确认。 |
| `contributes.commands` | `{id, title, shortcut?}`；快捷键使用 `Ctrl+Shift+J` 形式，内置快捷键与快捷命令优先。 |
| `contributes.views` | `{id, title, location, file, size?}`；位置为 `sidebar`、`panel`、`tab`、`dialog`、`settings`，页面内容由作者完全控制。`size` 仅用于 `dialog` / `settings`，见上文弹窗大小。 |
| `contributes.statusBar` / `toolbar` | `{id, text, tooltip?, command}`；点击执行已声明命令。 |
| `contributes.menus` | `{title, command, selectionOnly?}`；注册终端右键菜单；只有 `selectionOnly: true` 才在用户执行此命令时交付当前选区（最多 16 KiB）。 |
| `contributes.sessionSources` | `{id, title, refreshCommand?, settingsView?}`；向原有会话栏提供动态会话，需要 `sessions: "open"`。刷新命令必须已声明，设置视图必须位于 `settings`。 |

同一插件内的贡献 ID 必须唯一。每种贡献最多 32 个，每次运行的固定及按需授权 origin 合计最多 16 个。未知权限和未知扩展位置会拒绝安装。用户可隐藏视图入口，但仍可从命令打开它。主标签页可切回原生终端，切换不会断开终端。

网络授权表示用户允许插件通过宿主访问某个 HTTPS 目标，不代表已登录该服务。协议、域名和端口都参与匹配；例如 `https://example.com:8443` 与 `https://example.com` 是两个不同的目标。固定地址写入 `permissions.network`；地址由用户输入时声明 `networkRequest: true`，运行时先请求授权。SSH 连接使用独立的会话权限。

## 后台与页面通信

宿主注入只读全局对象 `nexterm`；不要手动加载桥接代码。后台运行于 Worker，没有 DOM；页面位于独立的 opaque-origin iframe。后台先等待 SDK 初始化再执行入口；页面可 `await nexterm.ready`。后台脚本可直接使用顶层 `await`。

```js
nexterm.onCommand("show", () => nexterm.views.open("my-view"));
nexterm.handle("query", async value => ({answer: value}));
// 页面：
const result = await nexterm.request("query", {input: 1});
```

- `handle(name, handler)`：后台处理自定义页面请求，返回值可为 Promise。
- `request(name, value?)`：页面向后台发请求。一次调用 30 秒超时，单通道最多 32 个待处理请求。
- `publish(name, value)`：后台向本插件页面广播；保留最近 32 种事件的最新值，新打开页面自动接收。消息最大 256 KiB。不要广播凭据。
- `on(name, listener)` / `onCommand(id, handler)`：订阅事件或命令，返回取消函数。右键选区命令的参数为 `{selection}`。
- `config.get()` / `config.set(object)`：单插件非敏感配置，整体替换，上限 32 KiB；变更广播 `configChanged`。不得存放密码或令牌。
- `views.open(id)`：打开本插件声明的视图。`views.resize({width?, height?})`：弹窗页面调整自己所在弹窗的大小。`status.update(id, text, tooltip?)` 更新本插件状态项（文字 100 字符、提示 500 字符）。

后台失去心跳或出现未处理错误时停止该插件，可在管理页查看错误并重载。禁用、替换、卸载会销毁 Worker、页面、消息通道、缓存事件并撤销原生网络能力；已交给宿主管理的终端不会被强制断开。锁屏时 SDK 的敏感操作不可用。仅主窗口激活插件；弹出的终端窗口不启动第二份后台。

## HTTPS 与凭据

支持自定义服务器的插件可使用以下清单权限：

```json
{"network": [], "networkRequest": true}
```

`await nexterm.network.request(origin)` 对已获授权的目标直接返回 `true`；新目标会显示宿主确认框，列出插件名称、ID 和精确 origin，用户拒绝则返回 `false`。参数必须是规范化的精确 HTTPS origin，不接受路径、尾斜线、通配符或嵌入凭据，可由 `new URL(userInput).origin` 取得，但插件应先验证输入协议及是否含凭据。未声明 `networkRequest: true` 的插件只能使用固定清单中已批准的目标。

按需授权保存在本机，重启、重载或重新启用插件后保留；替换或卸载插件时清除，可在插件管理条目中主动撤销。更换域名或端口需要重新确认。禁用仍立即撤销运行实例和内存秘密，但不删除已记住的地址。`await nexterm.network.isGranted(origin)` 只查询当前实例是否已获授权，不弹窗，便于决定能否自动登录。相同目标的并发申请合并，不同目标同时申请会拒绝，插件应依次请求。停用或锁屏期间未完成的授权不会交付给插件。插件须等授权成功后再存入凭据或发送请求。

```js
const server = new URL(userInput);
if (server.protocol !== "https:" || server.username || server.password) {
  throw new Error("Invalid HTTPS server");
}
if (!await nexterm.network.request(server.origin)) {
  throw new Error("Network permission declined");
}
await nexterm.secrets.set("api-token", token, server.origin);
const result = await nexterm.http({
  url: server.origin + "/api/data", method: "GET", bearer: "api-token",
  headers: {"X-User": "1"}
});
```

`bearer` 为凭据键名，不是原始令牌。`secrets` 只保存在 Rust 进程内存中，绑定插件实例和 HTTPS origin，没有读取 API；停用或重载后清除。`secrets.delete(key, origin)` 清除内存秘密。

需要记住密码的插件声明 `credentials: "store"`，并仅在后台调用以下 API。origin 必须已获授权，键名最长 100 字符，单值最多 2560 UTF-8 字节：

```js
await nexterm.credentials.set("login", JSON.stringify({username, password}), origin);
const saved = await nexterm.credentials.get("login", origin); // string | null
await nexterm.credentials.delete("login", origin);
```

持久凭据存入当前 Windows 用户的凭据管理器，不进入 WebView 配置、同步或导出。插件重启后可重新读取自己的凭据；页面不能直接读取，后台也不应广播秘密或回填密码框。替换插件会保留凭据，但重置网络授权，新版本须重新取得对应 origin 的授权后才能读取。卸载会删除该插件的全部持久凭据；清理失败会显示错误。当前其他操作系统明确报不支持，不降级为明文保存。该权限只应授予信任的插件。

`http` 支持 JSON GET/POST/PUT/PATCH/DELETE，返回解析后的 JSON；POST 等可传 `body` 对象。同一运行实例复用 HTTP 客户端及连接池。20 秒超时，最多 4 个并发请求，请求体最大 64 KiB、响应最大 2 MiB；不跟随重定向。Authorization、Cookie、Host 等保留头不能直接覆盖。HTTPS 证书验证不可关闭。错误返回状态码或通用描述，不回显响应正文、密码或令牌。分页地址仍须由插件验证，不能向另一个 origin 发送凭据。浏览器预览不提供原生网络和凭据功能。

如果 API 返回分页链接，先校验其 origin 和路径；不要把凭据转发到其他主机。处理重复页或失效登录时应退出循环，并向用户说明目录是否完整。

## 动态会话来源

插件负责获取目录、检查当前用户的权限并解析连接参数；宿主负责搜索、展示、账号选择、已有标签页聚焦、连接确认及原生 SSH。不需要为了接入会话列表而另写一套侧栏。

```json
{
  "sessionSources": [
    {"id": "servers", "title": "Team Servers", "refreshCommand": "refresh", "settingsView": "settings"}
  ]
}
```

把以上字段放入 `contributes`，同时声明对应命令、设置视图及 `permissions.sessions: "open"`。后台使用同一份公开 SDK：

```js
nexterm.sessions.onConnect("servers", async ({itemId, choiceId}) => {
  const accounts = await loadAuthorizedAccounts(itemId);
  if (!choiceId && accounts.length > 1) {
    return {choices: accounts.map(account => ({id: account.username, label: account.username}))};
  }
  const account = accounts.find(account => account.username === choiceId) ?? (!choiceId ? accounts[0] : undefined);
  if (!account) throw new Error("Account permission revoked");
  return {connection: {
    host: "gateway.example.com", port: 2222,
    username: account.username, label: "Team Server", passwordKey: "ssh-password"
  }};
});
await nexterm.sessions.updateSource("servers", {
  state: "ready",
  items: [{id: "server-1", label: "Team Server", description: "10.0.0.1", group: "Production"}]
});
```

- `updateSource` 仅后台可调用，来源须预先声明，整体替换当前目录。`items` 只含展示数据，不接受密码或连接选项。状态为 `ready`、`loading`、`signedOut`、`error`，仅 `signedOut` 必须为空；可附 `message`。退出或认证失效时应清空目录。
- `appendSource(id, catalog)` 仅后台可调用，在 `loading` 或 `ready` 目录后追加一批展示项，保留既有项身份，不取消已打开的账号选择。批次状态也只能是 `loading` 或 `ready`，同批和跨批均不允许重复 ID。先以 `updateSource(id, {state:"loading",items:[]})` 开始，再逐批追加，最后一批改成 `ready`。单批最多 1000 项、JSON 最多 240000 字符，聚合目录最多 100000 项；单次 RPC 仍受 256 KiB 字符数约束。
- 项 ID、名称、分组最长 200 字符，描述与状态消息最长 500 字符，禁止控制字符。项 ID 是稳定的业务标识，不是宿主保存会话的 ID。宿主每页最多渲染 100 行，共用搜索匹配整个已加载目录而非仅当前页；`loading` 时已加载的主机也可连接。
- 双击、Enter 或连接按钮调用 `onConnect`，参数仅有 `itemId` 和可选 `choiceId`。返回 `{connection: NextermSshRequest}`，或 `{choices: [{id, label}]}`。不要在此处理器中再调用 `openSsh`，由宿主统一建立连接和追踪标签页。
- 选择项最多 64 个且 ID 唯一。宿主弹窗显示账号，取消或 60 秒未选择均不连接；选定后再次调用处理器，插件必须重新检查该账号授权，返回连接或抛错，不能重复返回选择列表。密码交接和每次目标确认与 `openSsh` 相同，目前仅支持 SSH。
- 会话栏共用搜索，匹配名称、描述、分组和来源标题；动态项不能当作本地保存会话编辑、删除或导出。默认双击聚焦已打开标签页，Ctrl/Command 双击或右键「另开一个连接」重新检查授权后创建新连接。
- 目录只保存在当前运行实例内，不写入会话库或配置同步。停用、重载、替换、卸载移除来源，已有终端不被关闭。来源整体替换、隐藏或插件锁定会取消尚未完成的选择或连接，单纯追加不会；宿主在异步解析、确认及凭据交接后检查实例与原始项是否仍有效。已打开终端的公开参数仍沿用原生工作区恢复策略，密码和一次性交接标记不持久化。

## 原生 SSH

```js
await nexterm.secrets.set("ssh-password", password, "https://example.com");
const {paneId} = await nexterm.sessions.openSsh({
  host: "gateway.example.com", port: 2222,
  username: "demo", label: "My Device", passwordKey: "ssh-password"
});
```

需要 `sessions: "open"`，用户确认目标后才创建临时会话。`passwordKey` 可省略，此时使用原生密码输入页；提供时经后端一次性交接，绑定当前窗口、会话 ID、主机、端口和用户名，30 秒过期，原始密码不进入前端会话配置或工作区快照。交接后重连可在原生终端重新输入凭据。使用原生主机密钥校验；插件不能关闭校验、执行本地 shell、添加启动命令、访问任意文件或读取/控制其他终端。返回 `paneId` 仅表示连接请求已移交，不代表远端登录成功。

当前 SDK 不提供终端输出读取、任意输入发送、动态扩展点注册或 SSH 多轮 keyboard-interactive/MFA。不能将 API 登录令牌当作 SSH 密码。

## 信任边界与验证范围

**这是可信插件的实验平台，不是已完成审计的恶意代码沙箱。** iframe 不与宿主同源，不开放 Tauri IPC、父页面 DOM、弹窗或顶层导航。页面可接收表单事件，实际表单导航由 CSP `form-action 'none'` 阻止；CSP 也禁止页面直接 fetch 和外部资源，网络经宿主代理。后台 Worker 配有心跳，但尚未提供进程级内存限制，且通用浏览器 iframe 的自导航等通道不能据此宣称已完全防止外传。只安装信任的来源，不应把网络授权列表理解为面对恶意脚本的完整隔离保证。

发布前请在桌面端确认首次安装与升级、拒绝权限、禁用和卸载。若使用原生 HTTPS、Windows 凭据管理器或 SSH，请另用获授权的测试环境验证成功与失败路径；浏览器预览或收到 `paneId` 都不能证明远端连接成功。
