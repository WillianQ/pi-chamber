import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { bus } from "./bus.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

// —— WS 帧日志（收发同一条摘要规则）——
// 音频块（base64 PCM，每块几 KB）整帧直打会刷爆日志：只打一行摘要——
//   stt.audio（w→s）只打块长；tts.audio（s→w）只打 base64 前 5 字符 "xxxxx…"，不打印内容。
// 图片块（base64，单张 ~150KB）同理：把 data 换成字符数，否则一张图就顶掉几屏日志
//   （三处会出现图片块：prompt 上行、chat.sync 首屏的 messages[].images、chat.toolResult 回执）。
// 其余超长帧截断保可读；普通小帧维持全量（日志是主要观测手段）。
const LOG_MAX = 10; // 非音频帧序列化超此长度截断

/** 图片 base64 → 摘要。
 *  图片块在线协议里只有一个形状：{ type:"image", mimeType, data }（上行 prompt、下行 Message.images 同构）。
 *  兼容判据（type 或 mimeType 任一命中即可）—— 万一以后哪个环节只带了 mimeType，也不至于把 base64 灌进日志。 */
function looksLikeImage(v) {
  return typeof v.data === "string" && (v.type === "image" || String(v.mimeType ?? "").startsWith("image/"));
}

function redactImages(v, depth = 0) {
  if (depth > 16 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactImages(x, depth + 1));
  if (looksLikeImage(v)) return { ...v, data: `…(${v.data.length} 字符 base64)` };
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactImages(x, depth + 1);
  return out;
}

function logWsFrame(dir, raw) {
  const s = raw.toString();
  let f = null;
  try {
    f = JSON.parse(s);
  } catch {}
  const chunk = f?.p?.chunk;
  if (f?.e === "stt.audio" && typeof chunk === "string") {
    console.log(`[WS] ${dir}帧: ${f.e} 音频块 base64 ${chunk.length} 字符`);
    return;
  }
  if (f?.e === "tts.audio" && typeof chunk === "string") {
    console.log(`[WS] ${dir}帧: ${f.e} 音频块 base64 ${chunk.slice(0, 5)}…`);
    return;
  }
  // 图片脱敏：只在帧里真出现图片块时才重走一遍序列化（无图帧零开销）。
  // 判据用 '"image'（不带尾引号）：要同时命中 '"type":"image"' 与 '"mimeType":"image/png"' 两种形状
  const safe = f && s.includes('"image') ? JSON.stringify(redactImages(f)) : s;
  if (safe.length <= LOG_MAX) {
    console.log(`[WS] ${dir}帧: ${safe}`);
    return;
  }
  console.log(`[WS] ${dir}帧: ${safe.slice(0, LOG_MAX)} …(共 ${safe.length} 字符)`);
}

// —— 单连接独占：新连接总是赢（踢旧迎新），bus 本身不受连接生死影响 ——
let current = null; // { ws }
const allConns = new Set(); // 心跳用

export function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    // 踢旧迎新（浏览器刷新场景：旧连接可能还假死挂着）
    if (current) {
      try {
        current.ws.close(4001, "replaced");
      } catch {}
    }
    current = { ws };
    allConns.add(ws);
    ws.isAlive = true;

    // 插线：bus 感知到对端上线（$conn.open）；包一层 send 打发送帧日志（readyState 检查仍在 nodeTransport 内）
    const wire = nodeTransport(ws);
    bus.attachTransport({
      send: (s) => {
        logWsFrame("发送", s);
        wire.send(s);
      },
    });

    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", (raw) => {
      logWsFrame("收到", raw);
      bus.feed(raw.toString()); // 坏帧由 bus 内部丢弃
    });
    ws.on("close", () => {
      allConns.delete(ws);
      if (current?.ws === ws) {
        current = null;
        bus.detachTransport("peer closed"); // 拔线：在途 request 全部 reject
      }
    });
    console.log("[WS] 新连接已接管");
  });

  // 心跳：60s 一次，清理僵尸连接（WS 层自己的事，与 bus 无关）
  const timer = setInterval(() => {
    for (const ws of allConns) {
      if (ws.isAlive === false) {
        ws.terminate();
        allConns.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 60_000);
  wss.on("close", () => clearInterval(timer));

  return wss;
}

// 在 HTTP upgrade 阶段做 JWT 鉴权，失败直接断开 socket
export function installUpgradeAuth(httpServer, wss, path = "/ws") {
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    try {
      req.user = verifyToken(token);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });
}
