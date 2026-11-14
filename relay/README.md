# Nexterm 手机远程中继

在手机上查看、操作电脑上 Nexterm 已打开的标签页：画面实时同步，可以输入，也可以临时让终端改用手机的尺寸。

```
手机浏览器 (PWA)  ──wss──▶  中继服务器（本目录）  ◀──wss──  Nexterm（电脑）
            └──────────── AES-256-GCM 端到端加密 ────────────┘
```

- **中继看不到内容**：配对密钥放在二维码链接的 `#` 后面，浏览器不会把它发给服务器。中继只知道由密钥算出的房间号，转发的都是密文。
- 每次连接时双方各出一个随机数派生新会话密钥；帧带递增序号，中继无法重放、丢弃或调换帧。
- 电脑主动连出去，不需要公网 IP，也不用开放端口。

## 部署（Docker + 自备 HTTPS 反向代理）

中继容器只监听本机 `127.0.0.1:7085`，需要你自己的反向代理（Nginx 等）提供 HTTPS 并转发到它（含 WebSocket）。手机浏览器只在 HTTPS 下提供加密 API，所以必须走 HTTPS。

```bash
cp .env.example .env
#   HOST_TOKEN=$(openssl rand -hex 24)
docker compose up -d --build --remove-orphans
```

也可以只跑中继（`docker build -t wtn-relay . && docker run -d -p 127.0.0.1:8080:8080 -e HOST_TOKEN=... wtn-relay`），再反向代理过去，记得转发 WebSocket：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

不用 Docker：`npm ci --omit=dev && PORT=8080 HOST_TOKEN=... node server.js`（Node ≥ 20）。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `HOST_TOKEN` | 空 | 设置后，只有带这个令牌的电脑才能注册为主机。建议设置，防止别人借用你的中继。 |

## 使用

1. Nexterm → 设置 → **手机远程**：勾选开启，填写中继地址（如 `https://relay.example.com:8443`）和主机令牌，保存。
2. 状态变成"已连接中继服务器"后，用手机相机扫描设置页里的二维码。
3. 在手机浏览器里选择"添加到主屏幕"，以后可以像 App 一样直接打开。

手机端：

- 标签列表包含电脑上所有窗口的标签页，点开即可实时查看。
- 底部工具栏：Esc / Tab / Ctrl / Alt（粘滞键）/ 方向键 / ^C 等，⌨ 打开系统键盘。
- **接管尺寸**：把电脑上这个标签的终端改成手机屏幕的行列数（vim、htop 等全屏程序在手机上更好用）。点"还给电脑"、返回列表或断开连接都会恢复；电脑上标签右下角会显示蓝色徽章，点它也能收回。
- A- / A+ 调整字号。电脑尺寸比手机大时可以左右、上下滑动查看，有新输出时会自动跟随光标。

安全相关：

- 二维码就是钥匙，只让自己的手机扫。如果泄露了，在设置页点**重新生成**，所有已配对的手机都会失效。
- 设置页列出当前连接的手机，可以单独断开。
- 勾选"手机只能查看"后，手机端不能输入，也不能接管尺寸。
- 最多同时连接 8 台手机。

## 开发

```bash
npm install
npm start            # http://localhost:8080
npm test             # 中继 + 加密协议测试（node:test）
```

局域网测试可以填 `http://<电脑IP>:8080`，但手机浏览器在非 HTTPS 页面上通常不提供 WebCrypto（`localhost` 除外），所以手机实际使用必须走 HTTPS。

协议说明见 `server.js` 和 `public/crypto.js` 开头的注释；电脑端实现在 `src-tauri/src/remote.rs`、`remote_crypto.rs`，两边的加密实现由 `remote_crypto.rs` 里的跨语言测试向量保证一致。
