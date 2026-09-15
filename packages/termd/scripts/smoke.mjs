// termd 冒烟（直连守护进程，不经 chamber）：起终端 / 回放 / IO / 每连接 attach / owner / 鉴权 / 关。
// 用法：pnpm termd-smoke   （需要 termd 在跑；没跑会自动拉起）
import assert from "node:assert/strict";
import WebSocket from "ws";
import { DEFAULT_PORT, ensureTermdRunning, readToken } from "../src/spawn.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    console.log(`  ✘ ${name} ${extra}`);
    process.exitCode = 1;
  }
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

/** 极简客户端：request / emit / 收事件 */
function connect(token = readToken()) {
  const ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/ws?token=${token}`);
  const c = { ws, seq: 0, pending: new Map(), events: [] };
  c.ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === "s") {
      const w = c.pending.get(f.id);
      if (!w) return;
      c.pending.delete(f.id);
      f.ok ? w.resolve(f.data) : w.reject(new Error(f.error));
      return;
    }
    if (f.t === "e") c.events.push(f);
  });
  c.req = (e, p) =>
    new Promise((resolve, reject) => {
      const id = `r${++c.seq}`;
      const t = setTimeout(() => {
        if (c.pending.delete(id)) reject(new Error(`${e} 超时`));
      }, 8000);
      c.pending.set(id, {
        resolve: (d) => {
          clearTimeout(t);
          resolve(d);
        },
        reject: (err) => {
          clearTimeout(t);
          reject(err);
        },
      });
      ws.send(JSON.stringify({ t: "q", e, p, id }));
    });
  c.emit = (e, p) => ws.send(JSON.stringify({ t: "e", e, p }));
  c.output = (termId) => c.events.filter((f) => f.e === "term.output" && f.p.termId === termId).map((f) => unb64(f.p.data)).join("");
  c.clear = () => (c.events.length = 0);
  c.close = () => ws.close();
  return c;
}

/** 等某个条件成立（轮询），超时返回 false */
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

console.log("── termd 冒烟 ──────────────────────────────");

// ── 0. 就绪 ────────────────────────────────────────────────────────────────
const up = await ensureTermdRunning({ spawnIfNeeded: true });
ok("termd 就绪（端口 " + DEFAULT_PORT + "）", up);
if (!up) process.exit(1);

// ── 1. 鉴权 ────────────────────────────────────────────────────────────────
{
  const bad = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health?token=wrong`).catch(() => null);
  ok("错 token → 401", bad?.status === 401);
  const good = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health?token=${readToken()}`);
  const body = await good.json();
  ok("对 token → health 通", good.ok && body.ok === true && typeof body.pid === "number");
  // 带 Origin（模拟浏览器）→ 401
  const wsBad = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/ws?token=${readToken()}`, { headers: { origin: "http://evil.com" } });
  const rejected = await new Promise((res) => {
    wsBad.on("error", () => res(true));
    wsBad.on("open", () => res(false));
    setTimeout(() => res(false), 3000);
  });
  ok("带 Origin 头（浏览器）→ 拒", rejected);
  wsBad.terminate();
}

// ── 2. 名册 + 新建 ─────────────────────────────────────────────────────────
const A = connect();
await A.ready;
const list0 = await A.req("term.list");
ok("term.list：有 shells 清单", Array.isArray(list0.shells) && list0.shells.length > 0, JSON.stringify(list0.shells));
ok("term.list：默认 shell 已定", !!list0.defaultShell, String(list0.defaultShell));

const before = list0.terms.length;
const created = await A.req("term.create", { cwd: process.cwd(), cols: 80, rows: 24 });
ok("term.create：返回 termId", /^t\d+$/.test(created.termId ?? ""), JSON.stringify(created));
ok("term.create：shell/cwd 回执齐全", !!created.shell && !!created.cwd);
await sleep(800); // 等 bash 起来吐提示符（attach 的回放拿的是环形缓冲的当前内容）

// ── 3. attach 回放 + 流式 ──────────────────────────────────────────────────
// 轮询 attach（bash 启动快慢不定，首次可能还没吐提示符）
let ra;
ok(
  "term.attach：拿到回放（bash 已吐提示符）",
  await until(async () => {
    ra = await A.req("term.attach", { termId: created.termId });
    return typeof ra.data === "string" && ra.data.length > 0;
  })
);
ok("term.attach：第一个 attach 的是 owner", ra.owner === true);
A.clear();
A.emit("term.input", { termId: created.termId, data: b64("echo SMOKE_MARK_1\r") });
ok("term.input → 收到 output（含回显标记）", await until(() => A.output(created.termId).includes("SMOKE_MARK_1")));

// ── 4. 第二个连接：自己的 attach + owner 语义 ──────────────────────────────
const B = connect();
await B.ready;
const rb = await B.req("term.attach", { termId: created.termId });
ok("第二个连接 attach：也有回放", typeof rb.data === "string" && rb.data.length > 0);
ok("第二个连接：不是 owner（resize 权归第一个）", rb.owner === false);

B.clear();
B.emit("term.input", { termId: created.termId, data: b64("echo SMOKE_MARK_2\r") });
ok("两个连接都能收到输出", await until(() => A.output(created.termId).includes("SMOKE_MARK_2") && B.output(created.termId).includes("SMOKE_MARK_2")));

// 非 owner 的 resize 不生效，owner 的生效
const cols0 = (await B.req("term.list")).terms.find((t) => t.termId === created.termId).cols;
B.emit("term.resize", { termId: created.termId, cols: 111, rows: 33 });
await sleep(200);
const colsAfterB = (await B.req("term.list")).terms.find((t) => t.termId === created.termId).cols;
ok("非 owner 的 term.resize 被忽略", colsAfterB === cols0, `${cols0} → ${colsAfterB}`);
A.emit("term.resize", { termId: created.termId, cols: 120, rows: 30 });
await sleep(200);
const colsAfterA = (await B.req("term.list")).terms.find((t) => t.termId === created.termId).cols;
ok("owner 的 term.resize 生效", colsAfterA === 120, String(colsAfterA));

// ── 5. detach：不再收输出 ──────────────────────────────────────────────────
B.clear();
B.emit("term.detach", { termId: created.termId });
await sleep(200);
B.clear();
A.emit("term.input", { termId: created.termId, data: b64("echo SMOKE_MARK_3\r") });
await until(() => A.output(created.termId).includes("SMOKE_MARK_3"));
ok("detach 后不再收到输出", !B.output(created.termId).includes("SMOKE_MARK_3"));

// ── 6. 断开连接不杀终端；owner 断开后移交 ─────────────────────────────────
B.close();
await sleep(300);
const afterB = (await A.req("term.list")).terms.find((t) => t.termId === created.termId);
ok("连接断开后终端照跑", afterB?.status === "running");
const C = connect();
await C.ready;
const rc = await C.req("term.attach", { termId: created.termId });
ok("新连接重连：回放里能看到断线期间的内容", unb64(rc.data).includes("SMOKE_MARK_3"));
ok("A 还连着，新连接不抢 resize 权", rc.owner === false);
C.close();

A.close();
await sleep(300);
const D = connect();
await D.ready;
const rd = await D.req("term.attach", { termId: created.termId });
ok("老 owner 断开后，新连接接管 resize 权", rd.owner === true);

// ── 7. 关闭：出列 ──────────────────────────────────────────────────────────
D.emit("term.close", { termId: created.termId });
await sleep(300);
ok("term.close：名册少一行", (await D.req("term.list")).terms.length === before);

// ── 8. 回归：关一个**已退出**的终端，守护进程不能崩 ────────────────────────────
// node-pty 的 Windows kill() 对已退出的 PTY 会异步抛（_getConsoleProcessList 拿到 undefined），
// 以前能一次带走整个守护进程（所有终端陪葬）。
const e2 = await D.req("term.create", { cwd: process.cwd() });
await D.req("term.attach", { termId: e2.termId });
D.emit("term.input", { termId: e2.termId, data: b64("exit\r") });
await until(() => D.events.some((f) => f.e === "term.exit" && f.p.termId === e2.termId));
D.emit("term.close", { termId: e2.termId });
await sleep(500);
const alive = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health?token=${readToken()}`)
  .then((r) => r.ok)
  .catch(() => false);
ok("关一个已退出的终端：守护进程不崩", alive);
D.close();
console.log(`── ${passed} 项通过${process.exitCode ? "（有失败）" : ""} ──`);
process.exit(process.exitCode ?? 0);
