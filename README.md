# WhisperLink

> 私有部署的端到端加密即时通讯应用 · 群聊 + 私聊 + 实时语音

零注册、零存储、纯密文转发。打开页面输入昵称和 4–32 位频道码即可进入加密房间，所有消息在浏览器侧用 Web Crypto API 加密后再发出，服务端只看到密文。

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/trustdev-org/WhisperLink)

---

## ✨ 功能特性

| 模块 | 说明 |
| --- | --- |
| 身份 | 无需注册，昵称 + 4–32 位频道码即可登录；频道码即房间 ID 也是密钥派生源 |
| 群聊 | 同一频道码的用户进入同一群组，AES-GCM 加密广播 |
| 私聊 | 点击群成员头像发起一对一私聊，ECDH 协商独立密钥，群内其他人不可见 |
| 消息类型 | 文字、图片（前端压缩到 ≤1MB） |
| 语音通话 | WebRTC Mesh，支持群语音和私聊语音；通过 node-turn 中转，国内 NAT 友好 |
| 登录体验 | Tab 切换「新建/加入」与「历史频道」，历史频道记录上次访问时间，🎲 一键随机昵称/频道码，URL `?c=xxx` 直接预填 |
| 提示音 | 页面失焦或当前未聚焦该会话时收到消息，播放短促提示音；可在侧栏 🔔/🔕 一键静音 |
| 分享 | 一键复制/系统分享带频道码的链接 |
| UI | 微信移动端风格 + 现代化渐变与圆角，移动 / 桌面双布局自适应 |
| 安全 | 服务端不存储任何消息，进程重启即清空；端到端加密，TURN 仅中转 ICE |
| 可靠性 | WebSocket 自动重连、心跳保活、断线状态条 |

---

## 🏗️ 技术栈

- **服务端**：Node.js + Express + ws + node-turn（仅 3 个依赖）
- **前端**：原生 HTML/CSS/JS（单文件 `index.html`，无构建）
- **加密**：Web Crypto API（PBKDF2 / AES-GCM-256 / ECDH P-256）
- **实时通讯**：WebSocket 信令 + WebRTC 音频
- **NAT 穿透**：node-turn 自建 TURN 服务（默认端口 3478）

---

## 📦 项目结构

```
WhisperLink/
├── index.js          # 服务端单文件（HTTP + WebSocket + TURN）
├── index.html        # 前端单文件（所有 JS/CSS 内联）
├── package.json
├── railway.json      # Railway 一键部署配置
├── Procfile          # PaaS 启动配置
└── README.md
```

---

## 🚀 快速开始

### 本地运行

```bash
git clone <repo>
cd WhisperLink
npm install
node index.js
```

打开 `http://localhost:3000`，在两个浏览器标签里输入相同频道码即可对话。

也可以直接通过链接进入：`http://localhost:3000/?c=频道码`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket 端口 |
| `TURN_PORT` | `3478` | TURN 服务端口（TCP + UDP） |
| `TURN_USERNAME` | `user` | TURN 用户名 |
| `TURN_PASSWORD` | `password` | TURN 密码 |
| `TURN_REALM` | `whisperlink` | TURN realm |
| `PUBLIC_IP` | 自动 | **生产环境必须设置为服务器公网 IP**，否则 TURN 中转地址会下发内网 IP 导致语音失败 |

---

## 🛠️ 宝塔面板部署（推荐）

1. 在 **软件商店** 安装：`Node.js 版本管理器`（选 Node 18+）、`PM2 管理器`。
2. 上传项目到 `/www/wwwroot/whisperlink`。
3. 进入目录执行：
   ```bash
   npm install --production
   ```
4. 在 **安全** → 防火墙放行端口：
   - `3000`（TCP，HTTP）
   - `3478`（TCP + UDP，TURN）
   - 云服务器还需在云控制台安全组同步放行
5. 在 **PM2 管理器** → 添加项目：
   - 启动文件：`index.js`
   - 项目目录：`/www/wwwroot/whisperlink`
   - 项目名称：`whisperlink`
6. 在 PM2 项目配置中添加环境变量：
   ```
   PORT=3000
   TURN_USERNAME=your_user
   TURN_PASSWORD=your_password
   PUBLIC_IP=你的公网IP
   ```
7. （可选）在 **网站** 新建反向代理：
   - 代理目标：`http://127.0.0.1:3000`
   - 开启 SSL（Let's Encrypt）
   - WebSocket 会自动随域名走 `wss://`

> ⚠️ TURN 端口 **不能** 被反代，必须直接暴露 `3478`，且必须设置 `PUBLIC_IP`。

---

## ☁️ Railway 部署

1. push 仓库到 GitHub。
2. Railway → New Project → Deploy from GitHub Repo。
3. 在 **Variables** 设置：
   ```
   TURN_USERNAME=xxx
   TURN_PASSWORD=xxx
   ```
4. Railway 会自动注入 `PORT`，HTTP 部分立即可用。

> ⚠️ Railway 不支持暴露任意 UDP 端口，**语音通话功能在 Railway 上不可用**，请使用支持 UDP 的 VPS / 宝塔。

---

## 🔐 加密设计

### 群聊密钥派生

```
roomKey = PBKDF2(
  password = 频道码,
  salt     = "WhisperLink-Salt-v1:" + 频道码,
  iter     = 100000,
  hash     = SHA-256
) → AES-GCM-256
```

群消息：`AES-GCM(roomKey, plaintext, randomIV)` → 服务端转发密文。

### 私聊密钥协商

```
A.priv, A.pub = ECDH(P-256)
B.priv, B.pub = ECDH(P-256)
sharedKey = ECDH(A.priv, B.pub) = ECDH(B.priv, A.pub) → AES-GCM-256
```

每对用户拥有独立密钥，服务端拿到的依旧只是密文。

### 威胁模型

| 威胁 | 处理 |
| --- | --- |
| 服务端被入侵 | 不存历史；内存只有密文与 ECDH 公钥 |
| 中间人被动监听 | 全程密文；TLS（反代时）+ AES-GCM 双层 |
| 频道码泄露 | 仅泄露该房间的群聊解密能力，私聊仍安全（ECDH 在客户端协商） |
| 重放攻击 | AES-GCM 含 96-bit 随机 IV + 服务端时间戳 |
| 浏览器本地痕迹 | 仅存昵称、频道码列表、静音偏好（localStorage），可随时在历史频道列表删除 |

---

## 📡 WebSocket 协议

所有消息为 JSON，路径 `/ws`。

### 客户端 → 服务端

```jsonc
// 加入房间
{ "type": "join", "roomId": "abc123", "userId": "uuid", "nickname": "Alice" }

// 群消息（已加密）
{ "type": "message", "msgType": "text", "iv": "<b64>", "ciphertext": "<b64>" }

// 私聊消息（已加密）
{ "type": "private_message", "to": "userId", "msgType": "image",
  "iv": "<b64>", "ciphertext": "<b64>" }

// WebRTC 信令 / ECDH 公钥
{ "type": "webrtc_signal", "to": "userId", "channel": "group|private",
  "signal": { "kind": "offer|answer|candidate|ecdh_pub|ecdh_request", ... } }

// 通话控制
{ "type": "call_control", "to": "userId?", "channel": "group|private",
  "action": "invite|accept|reject|hangup" }
```

### 服务端 → 客户端

```jsonc
{ "type": "user_list", "users": [ { "userId", "nickname" } ] }
{ "type": "user_joined", "userId", "nickname" }
{ "type": "user_left",   "userId" }
{ "type": "message",         "from", "fromNickname", "iv", "ciphertext", "msgType", "ts" }
{ "type": "private_message", "from", "fromNickname", "iv", "ciphertext", "msgType", "ts" }
{ "type": "webrtc_signal",   "from", "fromNickname", "signal", "channel" }
{ "type": "call_control",    "from", "fromNickname", "action", "channel" }
```

---

## 🎙️ 语音通话流程

```
A 点击 📞              → call_control(invite)
B 收到来电弹窗 → 接听   → call_control(accept)
A 收到 accept           → 创建 RTCPeerConnection → createOffer → webrtc_signal(offer)
B 收到 offer            → setRemoteDescription → createAnswer → webrtc_signal(answer)
A/B ICE 候选互换         → webrtc_signal(candidate)
通话建立                → ontrack 播放 PCM
任意一方挂断            → call_control(hangup) → 双方关闭 PeerConnection
```

ICE 服务器优先级：

```js
[
  { urls: ["turn:host:3478?transport=udp", "turn:host:3478?transport=tcp"], ... },
  { urls: "stun:stun.l.google.com:19302" }
]
```

---

## 🧪 浏览器兼容性

| 浏览器 | 文字/图片 | 语音 |
| --- | --- | --- |
| iOS Safari 14+ | ✅ | ✅（必须 HTTPS） |
| Android Chrome | ✅ | ✅（必须 HTTPS） |
| 桌面 Chrome / Edge / Firefox | ✅ | ✅ |

> ⚠️ `getUserMedia` 和 Web Crypto 在非 `localhost` 下要求 HTTPS。生产环境务必通过反向代理开启 SSL。

---

## ❓ 常见问题

**Q：消息发不出去 / 一直显示"重连中"？**
A：检查反向代理是否开启 WebSocket 透传（Nginx 需要 `proxy_set_header Upgrade` / `Connection`）。宝塔默认模板已包含。

**Q：语音通话连不通？**
A：90% 是 TURN 配置问题。
1. 确认服务器放行 `3478` 的 **UDP** 端口（不仅是 TCP）。
2. 确认 `PUBLIC_IP` 设置为服务器真实公网 IP。
3. 在 Chrome `chrome://webrtc-internals` 中查看 ICE 候选是否包含 `relay` 类型。

**Q：可以在内网部署吗？**
A：可以。把 `PUBLIC_IP` 设为内网 IP 即可，所有客户端必须能访问该 IP 的 3000 / 3478 端口。

**Q：频道码有多安全？**
A：建议使用 12 位以上随机字母数字（点击 🎲 自动生成）。12 位字母数字 ≈ 36¹² ≈ 4.7×10¹⁸ 组合，配合 PBKDF2 100000 轮迭代，离线爆破成本极高。但 **不要把频道码当作长期密码使用**，建议每次重要会话都换一个新频道码。

**Q：历史频道存在哪？会泄露吗？**
A：仅存在浏览器本地 `localStorage`（key：`wl_channels`），服务端完全不知情。可以在登录页「历史频道」Tab 里点 × 删除单条，或清浏览器数据全部清掉。

**Q：消息提示音不响？**
A：浏览器要求音频在用户手势内首次播放，所以提示音在首次点击「进入聊天室」后才解锁。如果之后仍不响：1) 检查侧栏铃铛是否为 🔔（非 🔕）；2) 提示音只在「页面失焦」或「不在当前会话」时才会响（避免打扰当前对话）。

**Q：能加视频通话 / 文件传输吗？**
A：架构已支持，前端把 `getUserMedia({ video: true })` 打开并加 `RTCDataChannel` 即可。本项目主线保持精简。

---

## 📜 License

MIT
