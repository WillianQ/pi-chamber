// bus 端到端测试：真实起服务（3998 独立实例）→ HTTP 登录 → 真 WS 上跑 bus
// 覆盖：握手鉴权、conn.welcome、net request（ping/whoami/no handler）、emit echo 往返、
//       帧落日志、单连接踢旧迎新
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";
import { writeSettingFile } from "./lib/setting-fixture.mjs";

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
// 日志落临时目录：测试进程带 LOG=1（logger 启动会清空文件），不能指向 dev 那份 logs/server.log
const TMP = await mkdtemp(path.join(os.tmpdir(), "pc-bus-e2e-"));
const LOG_FILE = path.join(TMP, "server.log");
// nav 状态也隔离：否则测试之间通过 data/nav-state.json 互相污染
const NAV_STATE_FILE = path.join(TMP, "nav-state.json");
// 设置也隔离：密码/密钥走临时文件（PI_CHAMBER_SETTING），不碰用户真实的 ~/.pi/...
const SETTING_FILE = await writeSettingFile(TMP, PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_CHAMBER_SETTING: SETTING_FILE, // 密码 / 密钥（不再走 JWT_SECRET / PASSWORD 环境变量）
      LOG: "1", // 让 logger 写文件（默认只有 dev 写）
      LOG_FILE, // 且写到临时目录
      NAV_STATE_FILE, // nav 状态也落临时目录（不碰 data/nav-state.json）
    },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.allOutput = "";
  proc.stdout.on("data", (d) => (proc.allOutput += d));
  proc.stderr.on("data", (d) => (proc.allOutput += d));
  return proc;
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("服务器启动超时");
}

async function login(password = "test-password") {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

// 客户端 bus：open 插线 / message 喂帧 / close 拔线（前端将来照抄这段）
async function connectBus(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
  const bus = createBus({ requestTimeout: 3000 });
  const welcome = new Promise((res) => bus.on("conn.welcome", res));
  bus.on("$conn.open", () => {}); // 系统事件存在性冒烟
  ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
  ws.on("message", (raw) => bus.feed(raw.toString()));
  ws.on("close", (code, reason) => {
    bus.detachTransport(`ws:${code}:${reason}`);
    bus.__closed = { code, reason: reason.toString() };
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  return { ws, bus, welcome };
}

test("bus 全链路：登录→welcome→request(ping)→错误透传→emit 往返→no handler→日志断言", async () => {
  const proc = startServer();
  try {
    await waitReady();

    // 鉴权链路回归：坏密码 / 坏 token
    await assert.rejects(login("wrong"), /401/);
    const badWs = new WebSocket(`ws://localhost:${PORT}/ws?token=***`);
    await new Promise((res, rej) => {
      badWs.on("error", () => res()); // 预期 401 拒连
      badWs.on("open", () => rej(new Error("假 token 不应连上")));
    });

    const token = await login();
    const { ws, bus, welcome } = await connectBus(token);
    assert.strictEqual((await welcome).from, "server", "应收到上网的 conn.welcome");
    assert.strictEqual(bus.connected, true);

    // request {net:true}：ping → 服务端 handler 返回值即 data
    const pong = await bus.request("ping", { n: 1 }, { net: true });
    assert.ok(typeof pong.pong === "number");
    assert.deepStrictEqual(pong.you, { n: 1 });

    // 服务端 handler 抛错 → 错误信息透传
    await assert.rejects(bus.request("whoami", null, { net: true }), /not implemented yet/);

    // 对面无人应答 → 快速失败
    await assert.rejects(bus.request("nobody-exists", null, { net: true }), /no handler/);

    // emit {net:true}：服务端 echo → 回推 echo.reply（本地也会投一份，验证 meta.net）
    const got = new Promise((res) => bus.on("echo.reply", (p, meta) => res({ p, meta })));
    bus.emit("echo", { hello: "bus" }, { net: true });
    const { p, meta } = await got;
    assert.deepStrictEqual(p.echo, { hello: "bus" });
    assert.strictEqual(meta.net, true, "从线上回来的事件 meta.net 应为 true");

    // 日志断言：服务端确实收到并打印了 echo 帧
    // ★ 轮询等一下 —— appendFile 是异步的，echo.reply 回来时那行可能还没落盘（原来"立刻读"是赌运气）
    let log = "";
    for (let i = 0; i < 20; i++) {
      log = (await readFile(LOG_FILE)).toString();
      if (/\[WS\] 收到帧:.*"e".*echo/.test(log)) break;
      await sleep(50);
    }
    assert.match(log, /\[WS\] 收到帧:.*"e".*echo.*"hello":"bus"/);

    ws.close();
    await sleep(100);
  } finally {
    proc.kill();
  }
});

test("单连接独占：新连接踢旧（4001 replaced），旧 bus 拔线、在途作废", async () => {
  const proc = startServer();
  try {
    await waitReady();
    const token = await login();

    const first = await connectBus(token);
    const closed = new Promise((res) =>
      first.ws.on("close", (code, reason) => res({ code, reason: reason.toString() }))
    );

    const second = await connectBus(token); // 第二条接管
    const info = await closed;
    assert.strictEqual(info.code, 4001, "旧连接应收到 4001");
    assert.strictEqual(info.reason, "replaced");
    assert.strictEqual(first.bus.connected, false, "旧 bus 已拔线");

    // 新 bus 一切正常
    assert.strictEqual((await second.welcome).from, "server");
    const pong = await second.bus.request("ping", null, { net: true });
    assert.ok(pong.pong);

    second.ws.close();
  } finally {
    proc.kill();
  }
});
