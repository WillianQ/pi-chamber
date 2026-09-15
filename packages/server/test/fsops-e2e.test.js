// FS 写侧端到端：真实起服务（3996 独立实例）→ 登录 → 真 WS 上跑 fs.create/rename/delete/move 全流程。
// 覆盖：新建文件/目录、已存在不覆盖、改名、纯换大小写放行、目标冲突拒、移入目录、
//       移进自己拒、永久（递归）删除、受保护目录拒删、盘根拒删、坏名字静默拒。
// 注意：fs.* 无回执（发后即忘），断言一律"等下一个 nav.state 全量 + 查磁盘真相"。
//       nav 状态落临时目录（NAV_STATE_FILE）—— 以前它会写 data/nav-state.json，
//       把 current 指到临时目录，留给下一个测试实例一个挂不上的 fs.watch。
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
// nav 状态隔离：不碰 data/nav-state.json（测试之间会互相污染，见 nav-service.js 注释）
const NAV_STATE_FILE = path.join(await mkdtemp(path.join(os.tmpdir(), "pc-fsops-e2e-")), "nav-state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 条件支持同步/异步 fn（异步版每次轮询 await 一次）
async function until(fn, desc, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`超时等待: ${desc}`);
}

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

function startServer() {
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: "test-secret", PASSWORD: "test-password", NAV_STATE_FILE },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.on("exit", (code) => console.log(`[fsops-e2e] server exit ${code}`));
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

test("FS 写侧全链路", async () => {
  const proc = startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-fsops-"));
  let ws = null;
  try {
    await waitReady();
    const token = await login();
    const bus = createBus({ requestTimeout: 3000 });
    ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
    ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
    ws.on("message", (raw) => bus.feed(raw.toString()));
    ws.on("close", (c, r) => bus.detachTransport(`ws:${c}:${r}`));
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });

    // 镜像服务端最新全量（fs.* 成功后的 pushState 补刀都落在这）
    let nav = { items: [] };
    bus.on("nav.state", (s) => (nav = s));
    const names = () => nav.items.map((i) => i.name);
    const inList = (n) => names().includes(n);
    const onDisk = (n) => exists(path.join(dir, n));

    await bus.request("nav.open", { current: dir }, { net: true });
    await until(() => nav.current === dir, "nav.state 落到临时目录");

    // 1. 新建文件 + 目录（列表与盘上都要出现）
    bus.emit("fs.create", { parent: dir, name: "a.txt", dir: false }, { net: true });
    await until(() => inList("a.txt") && onDisk("a.txt"), "create a.txt");
    bus.emit("fs.create", { parent: dir, name: "sub", dir: true }, { net: true });
    await until(() => inList("sub"), "create sub");

    // 2. 重复 create → 不覆盖不报错（列表不变）
    bus.emit("fs.create", { parent: dir, name: "a.txt", dir: false }, { net: true });
    await sleep(400);
    assert.equal(nav.items.filter((i) => i.name === "a.txt").length, 1);

    // 3. 坏名字静默拒（escape/含分隔符/点开头），服务不崩、盘上干净
    bus.emit("fs.create", { parent: dir, name: "..", dir: true }, { net: true });
    bus.emit("fs.create", { parent: dir, name: "x/y.txt", dir: false }, { net: true });
    bus.emit("fs.create", { parent: dir, name: ".hidden", dir: false }, { net: true });
    await sleep(400);
    assert.deepEqual((await readdir(dir)).sort(), ["a.txt", "sub"]);

    // 4. rename a.txt → b.txt
    bus.emit("fs.rename", { path: path.join(dir, "a.txt"), newName: "b.txt" }, { net: true });
    await until(() => inList("b.txt") && !inList("a.txt"), "rename → b.txt");

    // 5. 纯换大小写放行（Windows 不视为冲突）
    bus.emit("fs.rename", { path: path.join(dir, "b.txt"), newName: "B.TXT" }, { net: true });
    await until(async () => (await readdir(dir)).includes("B.TXT"), "case rename B.TXT");
    await until(() => inList("B.TXT"), "case rename 后进列表");

    // 6. rename 目标冲突拒：建 c.txt，再把 B.TXT 改成 c.txt → 不动
    bus.emit("fs.create", { parent: dir, name: "c.txt", dir: false }, { net: true });
    await until(() => inList("c.txt"), "create c.txt");
    bus.emit("fs.rename", { path: path.join(dir, "B.TXT"), newName: "c.txt" }, { net: true });
    await sleep(400);
    assert.ok(inList("B.TXT"), "冲突 rename 不应生效");

    // 7. move B.TXT → sub；再 move sub → sub（自己）拒
    bus.emit("fs.move", { path: path.join(dir, "B.TXT"), toDir: path.join(dir, "sub") }, { net: true });
    await until(() => !inList("B.TXT"), "move 出列表");
    assert.ok(await exists(path.join(dir, "sub", "B.TXT")), "B.TXT 应落在 sub 里");
    bus.emit("fs.move", { path: path.join(dir, "sub"), toDir: path.join(dir, "sub") }, { net: true });
    await sleep(400);
    assert.ok(inList("sub"), "移进自己应被拒");

    // 8. delete c.txt；递归删 sub（连 B.TXT 一起没）
    bus.emit("fs.delete", { path: path.join(dir, "c.txt") }, { net: true });
    await until(() => !inList("c.txt"), "delete c.txt");
    bus.emit("fs.delete", { path: path.join(dir, "sub") }, { net: true });
    await until(async () => !inList("sub") && !(await onDisk("sub")), "recursive delete sub");

    // 9. 守卫：cwd（Agent 目录本体）拒删/拒改名/拒移走 —— 借 chat.sync 的 cwd 字段把 cwd 设成 dir 本身
    bus.emit("agent.chat.sync", { activeId: "x", cwd: dir }, { net: true });
    await until(() => nav.cwd === dir, "chat.sync 联动 cwd");
    bus.emit("fs.delete", { path: dir }, { net: true });
    bus.emit("fs.rename", { path: dir, newName: "hijacked" }, { net: true });
    bus.emit("fs.move", { path: dir, toDir: os.tmpdir() }, { net: true });
    await sleep(500);
    assert.ok(await exists(dir), "受保护 cwd 本体必须还在");

    // 10. 守卫：盘根拒删
    const root = process.platform === "win32" ? "C:\\" : "/";
    bus.emit("fs.delete", { path: root }, { net: true });
    await sleep(400);
    assert.ok(await exists(root), "盘根必须还在");
  } finally {
    ws?.close();
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
