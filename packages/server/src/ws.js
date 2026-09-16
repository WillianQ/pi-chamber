import { log } from "./log.js";
import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { bus } from "./bus.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

// —— WS 帧日志 ——
// 帧就是一行 JSON，原样丢给 log() 就行：脱敏（base64 只留前 10 字符）与长度上限都由 log.js 统一做，
// 这里不再自带一套（曾经的 redactImages / 音频分支 / LOG_MAX 已删）。
function logWsFrame(dir, raw) {
  log(`[WS] ${dir}帧: ${raw.toString()}`);
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
    log("[WS] 新连接已接管");
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
