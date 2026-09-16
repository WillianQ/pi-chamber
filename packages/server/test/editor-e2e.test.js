// Editor 域端到端：真实起服务（3997 独立实例）→ 登录 → 真 WS 上跑 editor 全流程。
// 覆盖：连接即推空全量、open 资格闸口（不存在/二进制）、open→new 推送、外部改动→modify 推送、
//       保存（update）→ 写盘 + 无回声、重复 open 幂等、close_file 事件解监听、
//       外部删除→delete 推送、换终端重连→editor.files 全量快照恢复现场。
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, appendFile, unlink, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";
import { writeSettingFile } from "./lib/setting-fixture.mjs";

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
// nav 状态隔离：不碰 data/nav-state.json（测试之间会互相污染，见 nav-service.js 注释）
const NAV_STATE_FILE = path.join(await mkdtemp(path.join(os.tmpdir(), "pc-editor-e2e-")), "nav-state.json");
// 设置隔离：密码/密钥走临时文件（PI_CHAMBER_SETTING），不碰用户真实的 ~/.pi/...
const SETTING_FILE = await writeSettingFile(path.dirname(NAV_STATE_FILE), PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, desc, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(80);
  }
  throw new Error(`超时等待: ${desc}`);
}

function startServer() {
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), PI_CHAMBER_SETTING: SETTING_FILE, NAV_STATE_FILE },
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

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

// 客户端 bus：subscription 先于 socket 打开注册（首帧不会漏）；awaitEvent = 首帧该事件即返回
async function connectBus(token, awaitEvent = null) {
  const bus = createBus({ requestTimeout: 3000 });
  const first = awaitEvent
    ? new Promise((res) => bus.on(awaitEvent, (s) => res(s)))
    : null;
  const opened = new Promise((res) => bus.on("$conn.open", res));
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
  ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
  ws.on("message", (raw) => bus.feed(raw.toString()));
  ws.on("close", (code, reason) => bus.detachTransport(`ws:${code}:${reason}`));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  await opened;
  return { ws, bus, first };
}

test("Editor 域全链路", async () => {
  const proc = startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-editor-"));
  const txt = path.join(dir, "t.txt");
  const bin = path.join(dir, "b.bin");
  const qmd = path.join(dir, "q.md");
  const rtxt = path.join(dir, "r.txt");
  let c1 = null;
  let c2 = null;
  try {
    await waitReady();
    const token = await login();
    c1 = await connectBus(token, "editor.files"); // 首帧快照（初始空）

    // 1. 连接即推全量 = []（无持久化，重启后清场）
    const snap0 = await c1.first;
    assert.ok(Array.isArray(snap0.files) && snap0.files.length === 0);

    // 2. 事件收集
    const changes = [];
    c1.bus.on("editor.file_changed", (p) => changes.push(p));

    // 3. 资格闸口：不存在 / 二进制 → 回执 error
    await assert.rejects(c1.bus.request("nav.open_file", { path: path.join(dir, "ghost.txt") }, { net: true }));
    await writeFile(bin, Buffer.from([0x41, 0x00, 0x42, 0x43]));
    await assert.rejects(c1.bus.request("nav.open_file", { path: bin }, { net: true }), /二进制/);

    // 4. 打开 → 回执 + 先到 new 事件（带全量内容）
    await writeFile(txt, "hello\n", "utf-8");
    const r1 = await c1.bus.request("nav.open_file", { path: txt }, { net: true });
    assert.deepEqual(r1, { ok: true, alreadyOpen: false, name: "t.txt" });
    await until(() => changes.some((c) => c.type === "new" && c.path === txt), "new 事件");
    assert.equal(changes.find((c) => c.type === "new" && c.path === txt).content, "hello\n");

    // 5. 重复 open → 幂等 alreadyOpen:true，不重推 new
    const r2 = await c1.bus.request("nav.open_file", { path: txt }, { net: true });
    assert.equal(r2.alreadyOpen, true);
    assert.equal(changes.filter((c) => c.type === "new" && c.path === txt).length, 1);

    // 6. 外部改动（agent/其他进程写盘）→ modify 推送，内容以后端/磁盘为准
    await appendFile(txt, "world\n", "utf-8");
    await until(() => changes.some((c) => c.type === "modify" && c.path === txt), "外部 modify 推送");
    const mod = changes.filter((c) => c.type === "modify" && c.path === txt).pop();
    assert.equal(mod.content, "hello\nworld\n");
    assert.equal(mod.name, "t.txt");

    // 7. 保存 editor.update → 写盘成功 + 无回声（内容比对抑制自己保存的 change）
    const before = changes.length;
    const rep = await c1.bus.request("editor.update", { path: txt, content: "saved-by-chamber\n" }, { net: true });
    assert.deepEqual(rep, { ok: true });
    assert.equal(await readFile(txt, "utf-8"), "saved-by-chamber\n");
    await sleep(900); // 等 awaitWriteFinish(300ms)+读盘窗口过去
    assert.equal(changes.length, before, "保存不应触发自己的 modify 回声");

    // 8. 保存未打开的文件 → error
    await assert.rejects(c1.bus.request("editor.update", { path: bin, content: "x" }, { net: true }), /未打开/);

    // 9. close_file 事件（单向）→ 后端解监听：之后外部写它不再推
    await writeFile(qmd, "# q\n", "utf-8");
    await c1.bus.request("nav.open_file", { path: qmd }, { net: true });
    await until(() => changes.some((c) => c.type === "new" && c.path === qmd), "open q.md");
    c1.bus.emit("editor.close_file", { path: qmd }, { net: true });
    await sleep(200);
    await writeFile(qmd, "# changed-after-close\n", "utf-8");
    await sleep(900);
    assert.ok(!changes.some((c) => c.path === qmd && c.type === "modify"), "close 后不应再有推送");

    // 10. 外部删除 → delete 推送（无 content）
    await unlink(txt);
    await until(() => changes.some((c) => c.type === "delete" && c.path === txt), "delete 推送");
    assert.equal(changes.find((c) => c.type === "delete" && c.path === txt).content, undefined);

    // 11. 换终端重连 → editor.files 全量快照恢复现场（此时 r.txt 仍开）
    await writeFile(rtxt, "keep\n", "utf-8");
    await c1.bus.request("nav.open_file", { path: rtxt }, { net: true });
    await until(() => changes.some((c) => c.type === "new" && c.path === rtxt), "open r.txt");
    c2 = await connectBus(token, "editor.files"); // 新连接踢旧
    const snap1 = await c2.first;
    assert.deepEqual(snap1.files.map((f) => f.name), ["r.txt"]);
    assert.equal(snap1.files[0].content, "keep\n");
  } finally {
    if (c1) c1.ws.close();
    if (c2) c2.ws.close();
    proc.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
