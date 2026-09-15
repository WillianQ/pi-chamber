// 冒烟测试：直接打正在运行的服务（不自启进程），走完整 bus 协议
// 用法: npm run smoke   |  换地址: BASE=http://localhost:3001 npm run smoke（dev 活体；生产 3000 可 BASE 指定）
import "dotenv/config";
import WebSocket from "ws";
import { stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const PASSWORD = process.env.SMOKE_PASSWORD || process.env.PASSWORD;
// 日志统一在仓库根 logs/（见 logger.js）；从脚本位置算，不依赖 cwd
const LOG_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "logs", "server.log");

if (!PASSWORD) {
  console.error("拿不到明文密码（.env 缺 PASSWORD？）；可用 SMOKE_PASSWORD=xxx npm run smoke");
  process.exit(1);
}
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name} ${extra}`);
  if (!ok) process.exit(1);
};

// —— 1. HTTP：登录 + 受保护接口 ——
const bad = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "definitely-wrong" }),
});
step("POST /api/login 错误密码被拒", bad.status === 401);

const loginRes = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!loginRes.ok) {
  step("POST /api/login", false, String(loginRes.status));
  process.exit(1);
}
const { token } = await loginRes.json();
step("POST /api/login", true, `→ token ${token.slice(0, 20)}...`);

const me = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
step("GET /api/me (Bearer)", me.ok, await me.text());

// —— 2. WS + bus：插线 → welcome → request ping → emit echo → 日志断言 ——
const marker = `smoke-${Date.now()}`;
const logSizeBefore = await stat(LOG_FILE).then((s) => s.size).catch(() => 0);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${token}`);
const bus = createBus({ requestTimeout: 3000 });
const welcome = new Promise((res) => bus.on("conn.welcome", res));
ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
ws.on("message", (raw) => bus.feed(raw.toString()));
ws.on("close", () => {
  bus.detachTransport("ws closed");
  clearTimeout(watchdog);
  process.exit(0);
});
ws.on("error", (e) => step("WS 连接", false, e.message));
const watchdog = setTimeout(() => step("整体超时", false, "8s"), 8000);

try {
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const w = await welcome;
  step("WS 握手鉴权 + conn.welcome 上网帧", w?.from === "server");

  const pong = await bus.request("ping", { marker }, { net: true });
  step("bus.request(ping,{net:true}) 回执", pong?.you?.marker === marker, JSON.stringify(pong));

  const gotEcho = new Promise((res) => bus.on("echo.reply", res));
  bus.emit("echo", { marker, note: "日志断言测试" }, { net: true });
  const echoed = await gotEcho;
  step("emit(echo,{net:true}) → echo.reply 往返", echoed?.echo?.marker === marker);

  // 读日志新增部分，断言服务端确实收到并打印了这一帧
  // （打生产实例时它不写日志 → 文件不存在，这一步降级为「跳过」而不是失败）
  let logged = false;
  const logExists = await stat(LOG_FILE).then(() => true).catch(() => false);
  if (!logExists) {
    console.log("· 跳过日志断言（服务端没开 LOG=1，不写文件）");
  } else {
    for (let i = 0; i < 10 && !logged; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const buf = await readFile(LOG_FILE).catch(() => null);
      logged = !!buf && buf.subarray(logSizeBefore).toString().includes(`[WS] 收到帧:`) && buf.toString().includes(marker);
    }
    step("后端日志出现该帧 (logs/server.log)", logged);
  }

  console.log("\n完毕 —— bus 单例协议全链路 OK");
  ws.close();
} catch (err) {
  step("流程异常", false, err.message);
}
