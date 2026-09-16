// Setting 域端到端：真实起服务（3999 独立实例）→ 登录 → 真 WS 上跑 setting 全流程。
//
// 覆盖：
//   ① 连接即推 setting.sync，且**不含 password / jwtSecret**（服务端私有，永不下发）
//   ② setting.update 部分字段 → 合并落盘 + 推新真值
//   ③ 非法值 → setting.notice{type:"error"} + sync 回滚成旧真值（前端据此自动回滚 UI）
//   ④ 改密码 → 新密码能登录、旧密码被拒
//   ⑤ 改密码不动 jwtSecret → 老 token 继续有效（不被踢下线）
//   ⑥ PORT 环境变量只影响 get()，**不落盘**（否则 dev 的 3001 会写进生产配置）
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";
import { writeSettingFile, TEST_PASSWORD } from "./lib/setting-fixture.mjs";

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const TMP = await mkdtemp(path.join(os.tmpdir(), "pc-setting-e2e-"));
const SETTING_FILE = await writeSettingFile(TMP, 3000); // ★ 故意写 3000：用来验 PORT 覆盖不落盘
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const proc = spawn(process.execPath, ["src/server.js"], {
    // PORT 传 3999（文件里是 3000）：用来验"环境变量覆盖不落盘"
    env: { ...process.env, PORT: String(PORT), PI_CHAMBER_SETTING: SETTING_FILE },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.allOutput = "";
  proc.stdout.on("data", (d) => (proc.allOutput += d));
  proc.stderr.on("data", (d) => (proc.allOutput += d));
  return proc;
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("服务器启动超时");
}

async function login(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 连一条 WS 到被测服务，返回 { bus, close } */
async function connect(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
  const bus = createBus({ requestTimeout: 15000 });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  bus.attachTransport(nodeTransport(ws));
  ws.on("message", (raw) => bus.feed(raw.toString()));
  return { bus, close: () => ws.close() };
}

const readSetting = async () => JSON.parse(await readFile(SETTING_FILE, "utf8"));

test("Setting 域：sync 不下发密钥 / update 合并落盘 / 非法值回滚 / 改密码不动 jwtSecret", async () => {
  const proc = startServer();
  try {
    await waitReady();

    // ── ① 连接即推全量，且不含 password / jwtSecret ──
    const { body: loginBody } = await login(TEST_PASSWORD);
    const token = loginBody.token;
    assert.ok(token, "登录应拿到 token");
    const { bus, close } = await connect(token);
    try {
      const syncs = [];
      bus.on("setting.sync", (p) => syncs.push(p));
      await sleep(400);
      assert.equal(syncs.length >= 1, true, "连接后应收到 setting.sync");
      const first = syncs.at(-1);
      assert.equal("password" in first, false, "sync 不得下发 password");
      assert.equal("jwtSecret" in first, false, "sync 不得下发 jwtSecret");
      assert.equal(typeof first.tts.enabled, "boolean", "tts.enabled 应为布尔");
      assert.equal(typeof first.port, "number", "port 应为数字");

      // ── ② update 部分字段 → 合并落盘 + 推真值 ──
      const before = await readSetting();
      bus.emit("setting.update", { tts: { enabled: true, voice: "longanlingxi" } }, { net: true });
      await sleep(400);
      const after = await readSetting();
      assert.equal(after.tts.enabled, true, "tts.enabled 应已落盘");
      assert.equal(after.tts.voice, "longanlingxi", "tts.voice 应已落盘");
      assert.equal(after.stt.enabled, before.stt.enabled, "未提到的 stt 不应被动");
      assert.equal(after.password, before.password, "未提到的 password 不应被动");
      const s2 = syncs.at(-1);
      assert.equal(s2.tts.enabled, true, "sync 应推新真值");
      assert.equal(s2.tts.voice, "longanlingxi");

      // ── ③ 非法值 → notice + sync 回滚（用 tts.rate 验，避开 PORT 环境变量覆盖的干扰）──
      const notices = [];
      bus.on("setting.notice", (p) => notices.push(p));
      bus.emit("setting.update", { tts: { rate: 99 } }, { net: true });
      await sleep(400);
      assert.equal(notices.length, 1, "应收到一条 setting.notice");
      assert.equal(notices[0].type, "error");
      assert.equal((await readSetting()).tts.rate, before.tts.rate, "非法 rate 不得落盘");
      assert.equal(syncs.at(-1).tts.rate, before.tts.rate, "sync 应回滚成旧真值");

      // 脏字段（不在白名单）应被丢弃而不是写进文件
      bus.emit("setting.update", { evil: "x", tts: { nope: 1 } }, { net: true });
      await sleep(300);
      const dirty = await readSetting();
      assert.equal("evil" in dirty, false, "白名单外的顶层字段不得落盘");
      assert.equal("nope" in dirty.tts, false, "白名单外的嵌套字段不得落盘");

      // ── ⑤ 改密码不动 jwtSecret → 老 token 仍有效 ──
      const jwtBefore = before.jwtSecret;
      bus.emit("setting.update", { password: "new-password-1" }, { net: true });
      await sleep(400);
      assert.equal((await readSetting()).jwtSecret, jwtBefore, "改密码不得重置 jwtSecret");
      const me = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(me.status, 200, "改密码后老 token 应仍有效（不被踢下线）");

      // ── ④ 新密码能登录、旧密码被拒 ──
      assert.equal((await login(TEST_PASSWORD)).status, 401, "旧密码应被拒");
      assert.equal((await login("new-password-1")).status, 200, "新密码应能登录");

      // ── ⑥ PORT 环境变量只覆盖 get()，不落盘 ──
      assert.equal((await readSetting()).port, 3000, "文件里的 port 不应被 PORT 环境变量改写");
      assert.equal(syncs.at(-1).port, PORT, "下发的 port 应是生效值（环境变量覆盖）");
    } finally {
      close();
    }
  } finally {
    proc.kill();
  }
});
