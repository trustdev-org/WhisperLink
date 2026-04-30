/**
 * WhisperLink 私有加密即时通讯应用
 * ============================================
 *
 * 【宝塔面板部署步骤】
 * 1. 在宝塔【软件商店】安装 Node.js 版本管理器，安装 Node.js 18+ 并设为默认。
 * 2. 在宝塔【软件商店】安装 PM2 管理器。
 * 3. 上传本项目到 /www/wwwroot/whisperlink （或任意目录）。
 * 4. 进入项目目录，执行: npm install --production
 * 5. 在宝塔【安全】放行端口 3000 (HTTP) 和 3478 (TURN, TCP+UDP)。
 *    - 如果在云服务器（阿里云/腾讯云）还需在云控制台安全组放行同样端口。
 * 6. 在宝塔【PM2 管理器】添加项目：
 *      启动文件: index.js
 *      项目目录: /www/wwwroot/whisperlink
 *      项目名称: whisperlink
 * 7. (可选) 在宝塔【网站】新建反向代理，把域名 80/443 反代到 127.0.0.1:3000，
 *    并开启 SSL；WebSocket 也会自动走同一域名。
 * 8. 设置环境变量 (PM2 管理器 -> 项目 -> 配置)：
 *      PORT=3000
 *      TURN_USERNAME=your_user
 *      TURN_PASSWORD=your_password
 *      TURN_REALM=whisperlink
 *      PUBLIC_IP=你的服务器公网IP   (TURN 必须设为公网IP，否则中转失败)
 *
 * 【Railway 部署步骤】
 * 1. push 到 GitHub，Railway 一键导入仓库。
 * 2. 在 Railway 控制台 Variables 设置 TURN_USERNAME / TURN_PASSWORD。
 * 3. Railway 会自动注入 PORT；TURN 3478 端口在 Railway 上无法暴露 UDP，
 *    建议宝塔/自有服务器部署以使用语音功能。
 * ============================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const Turn = require('node-turn');

// ---------- 环境变量 ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const TURN_PORT = parseInt(process.env.TURN_PORT || '3478', 10);
const TURN_USERNAME = process.env.TURN_USERNAME || 'user';
const TURN_PASSWORD = process.env.TURN_PASSWORD || 'password';
const TURN_REALM = process.env.TURN_REALM || 'whisperlink';
// PUBLIC_IP 用于 TURN 中转地址通告，没设置时 node-turn 会用本机网卡 IP
const PUBLIC_IP = process.env.PUBLIC_IP || '';

// ---------- 启动 TURN ----------
// 用于 WebRTC NAT 穿透中转，国内网络强烈建议优先走 TURN
let turnServer = null;
try {
  turnServer = new Turn({
    listeningPort: TURN_PORT,
    listeningIps: ['0.0.0.0'],
    relayIps: PUBLIC_IP ? [PUBLIC_IP] : undefined,
    externalIps: PUBLIC_IP || undefined,
    authMech: 'long-term',
    credentials: { [TURN_USERNAME]: TURN_PASSWORD },
    realm: TURN_REALM,
    debugLevel: 'WARN',
  });
  turnServer.start();
  console.log(`[TURN] 已启动 端口=${TURN_PORT} 用户=${TURN_USERNAME} realm=${TURN_REALM}`);
} catch (err) {
  console.error('[TURN] 启动失败（语音通话可能不可用）：', err.message);
}

// ---------- 启动 HTTP ----------
const app = express();
const indexHtmlPath = path.join(__dirname, 'index.html');

// 根路径直接 serve index.html（前端单文件）
app.get('/', (req, res) => {
  res.sendFile(indexHtmlPath);
});

// 把 TURN 配置暴露给前端，方便前端按需切换公网/内网
app.get('/turn-config', (req, res) => {
  // 协议：客户端通过这个 host 推断 TURN 服务器地址
  const host = req.hostname;
  res.json({
    urls: [
      `turn:${host}:${TURN_PORT}?transport=udp`,
      `turn:${host}:${TURN_PORT}?transport=tcp`,
    ],
    username: TURN_USERNAME,
    credential: TURN_PASSWORD,
  });
});

// 健康检查
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);

// ---------- WebSocket 信令 + 消息转发 ----------
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * 内存数据结构（重启即清空，符合"不存储任何消息"的安全要求）
 *   rooms: Map<roomId, Map<userId, { ws, nickname }>>
 */
const rooms = new Map();

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('[WS] 发送失败:', e.message);
  }
}

// 广播房间在线用户列表（不含敏感数据）
function broadcastUserList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const users = Array.from(room.entries()).map(([userId, info]) => ({
    userId,
    nickname: info.nickname,
  }));
  for (const { ws } of room.values()) {
    safeSend(ws, { type: 'user_list', users });
  }
}

wss.on('connection', (ws) => {
  // 当前连接附带的状态
  ws.meta = { roomId: null, userId: null, nickname: null };

  // 心跳防止代理断连
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // 非法消息直接丢弃
    }

    switch (msg.type) {
      // 加入房间
      case 'join': {
        const { roomId, userId, nickname } = msg;
        if (!roomId || !userId || !nickname) return;
        ws.meta = { roomId, userId, nickname };
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        rooms.get(roomId).set(userId, { ws, nickname });
        broadcastUserList(roomId);
        // 通知其他人有新人加入（仅广播事件，不含明文）
        for (const [uid, info] of rooms.get(roomId)) {
          if (uid !== userId) {
            safeSend(info.ws, { type: 'user_joined', userId, nickname });
          }
        }
        break;
      }

      // 群消息：服务端只看到密文，原样转发给除发送者之外的所有人
      case 'message': {
        const { roomId, userId } = ws.meta;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        for (const [uid, info] of room) {
          if (uid !== userId) {
            safeSend(info.ws, {
              type: 'message',
              from: userId,
              fromNickname: ws.meta.nickname,
              ciphertext: msg.ciphertext, // 加密后的内容
              iv: msg.iv,
              msgType: msg.msgType,        // text / image
              ts: Date.now(),
            });
          }
        }
        break;
      }

      // 私聊消息：只发给目标用户，端到端加密
      case 'private_message': {
        const { roomId, userId } = ws.meta;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.get(msg.to);
        if (!target) return;
        safeSend(target.ws, {
          type: 'private_message',
          from: userId,
          fromNickname: ws.meta.nickname,
          ciphertext: msg.ciphertext,
          iv: msg.iv,
          msgType: msg.msgType,
          ts: Date.now(),
        });
        break;
      }

      // WebRTC 信令转发：offer/answer/candidate 以及 ECDH 公钥交换
      case 'webrtc_signal': {
        const { roomId, userId } = ws.meta;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        if (msg.to) {
          // 定向信令
          const target = room.get(msg.to);
          if (target) {
            safeSend(target.ws, {
              type: 'webrtc_signal',
              from: userId,
              fromNickname: ws.meta.nickname,
              signal: msg.signal,
              channel: msg.channel || 'group', // group / private
            });
          }
        } else {
          // 广播信令（用于群通话发起）
          for (const [uid, info] of room) {
            if (uid !== userId) {
              safeSend(info.ws, {
                type: 'webrtc_signal',
                from: userId,
                fromNickname: ws.meta.nickname,
                signal: msg.signal,
                channel: msg.channel || 'group',
              });
            }
          }
        }
        break;
      }

      // 通话控制：邀请、接听、拒绝、挂断
      case 'call_control': {
        const { roomId, userId } = ws.meta;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const payload = {
          type: 'call_control',
          from: userId,
          fromNickname: ws.meta.nickname,
          action: msg.action, // invite / accept / reject / hangup
          channel: msg.channel || 'group',
        };
        if (msg.to) {
          const target = room.get(msg.to);
          if (target) safeSend(target.ws, payload);
        } else {
          for (const [uid, info] of room) {
            if (uid !== userId) safeSend(info.ws, payload);
          }
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const { roomId, userId } = ws.meta || {};
    if (roomId && userId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(userId);
      if (room.size === 0) {
        rooms.delete(roomId);
      } else {
        // 通知其他人离开
        for (const info of room.values()) {
          safeSend(info.ws, { type: 'user_left', userId });
        }
        broadcastUserList(roomId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] 连接错误:', err.message);
  });
});

// 心跳：每 30s ping 一次，未响应则断开
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  });
}, 30000);

// 启动 HTTP
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] WhisperLink 已启动: http://0.0.0.0:${PORT}`);
  if (!fs.existsSync(indexHtmlPath)) {
    console.warn('[警告] index.html 不存在，请确认前端文件与 index.js 同目录。');
  }
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] 正在关闭...');
  if (turnServer) try { turnServer.stop(); } catch (_) {}
  server.close(() => process.exit(0));
});
