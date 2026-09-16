// 终端域冒烟（走 chamber 全链路）：前端 term-store 的**真代码**在 Node 里消费活体帧。
// 用法: node scripts/term-smoke.mjs        （需要 3000 上跑着后端 + termd 就绪）
//
// 覆盖：名册帧落库 → create（问答）→ attach（回放写进 xterm sink）→ input/output 直通
//      → resize（owner 语义）→ detach（退订）→ close（出列）。
// 为什么要它：term-store 的逻辑错了要在浏览器里肉眼找；这里直接把活体帧喂进真 store 断言。
//
// Node 缺浏览器 API → 进门前打好桩（localStorage / location）。
import { selfSign } from "./lib/creds.mjs";

// ── 浏览器 API 桩（必须在 import 前端代码之前）──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = { protocol: "http:", host: process.env.HOST || "localhost:3000" };

import jwt from "jsonwebtoken";
const { connect, useConnStore } = await import("../../web/src/bus.js");
const { useTermStore, termActions, registerSink, unregisterSink } = await import("../../web/src/stores/term-store.js");

let pass = 0;
let fail = 0;
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, every = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(every);
  }
}
const T = () => useTermStore.getState();
const row = (id) => T().terms.find((t) => t.termId === id);

console.log("── 终端域冒烟（chamber 全链路）──────────────");

// ── 0. 连上 ────────────────────────────────────────────────────────────────
connect(selfSign(jwt));
await until(() => useConnStore.getState().state === "online", 8000);
step("WS 连上（bus 在线）", useConnStore.getState().state === "online");
if (useConnStore.getState().state !== "online") process.exit(1);

// ── 1. 名册帧：$conn.open 时 chamber 喂缓存名册 ─────────────────────────────
await until(() => T().shells.length > 0, 10000);
step("term.list → shells / defaultShell 落库", T().shells.length > 0 && !!T().defaultShell,
  `shells=${T().shells.map((s) => s.id).join(",")}`);
if (!T().shells.length) {
  console.log("  （termd 没就绪？先 pnpm termd start）");
  process.exit(1);
}

// ── 2. 新建（问答）：creating 起落 + 名册由帧回填 ───────────────────────────
const termId = await termActions.create();
step("term.create → 回执有 termId", /^t\d+$/.test(termId ?? ""), `${termId} err=${T().error ?? "-"}`);
step("term.create → 名册插行（term.list 帧写真值）", await until(() => !!row(termId)));
step("creating 已复位", T().creating === false);

// ── 3. attach（问答）：回放直写 xterm sink ─────────────────────────────────
let received = "";
const fake = {
  reset: () => (received = ""),
  write: (bytes) => (received += new TextDecoder().decode(bytes)),
};
registerSink(termId, fake);
// 轮询 attach：bash 启动快慢不定，首次回放可能还是空的
let ra;
await until(async () => {
  ra = await termActions.attach(termId);
  return typeof ra?.data === "string" && ra.data.length > 0;
}, 10000);
step("term.attach → 回放非空（bash 已吐提示符）", typeof ra?.data === "string" && ra.data.length > 0);
step("term.attach → owner=true（第一个 attach 的）", ra?.owner === true);
step("回放已写进 sink（先 reset 再整份写）", received.length > 0, `${received.length} 字节`);

// ── 4. input → output：直通 sink，不进 store ───────────────────────────────
received = "";
termActions.sendInput(termId, "echo TERM_SMOKE_MARK\r");
step("term.input → term.output 直通 xterm sink", await until(() => received.includes("TERM_SMOKE_MARK")));
step("输出不进 store（terms 里没有 data 字段）", !JSON.stringify(T().terms).includes("TERM_SMOKE_MARK"));

// ── 5. resize：owner 才发得出去 ────────────────────────────────────────────
const cols0 = row(termId).cols;
termActions.sendResize(termId, 132, 40);
step("term.resize（owner）→ 名册 cols/rows 跟随", await until(() => row(termId).cols === 132 && row(termId).rows === 40),
  `${cols0} → ${row(termId).cols}`);

// ── 6. detach：退订后不再收输出 ────────────────────────────────────────────
termActions.detach(termId);
await sleep(200);
received = "";
termActions.sendInput(termId, "echo AFTER_DETACH\r");
await sleep(800);
step("detach 后不再收输出", !received.includes("AFTER_DETACH"));

// 重新 attach 回来：回放里能看到 detach 期间的内容
registerSink(termId, fake);
const r2 = await termActions.attach(termId);
step("重新 attach → 回放含 detach 期间的内容", new TextDecoder().decode(
  Uint8Array.from(atob(r2?.data ?? ""), (c) => c.charCodeAt(0))
).includes("AFTER_DETACH"));

// ── 7. 失败路径：不存在的 termId → 回执 throw（不是永久 pending） ──────────
let threw = false;
try {
  const { bus: b } = await import("../../web/src/bus.js");
  await b.request("term.attach", { termId: "t99999" }, { net: true, timeout: 5000 });
} catch {
  threw = true;
}
step("term.attach 不存在的 termId → reject（前端不卡 pending）", threw);

// ── 8. close：出列 ─────────────────────────────────────────────────────────
unregisterSink(termId);
termActions.close(termId);
step("term.close → 名册少一行", await until(() => !row(termId)));

console.log(`── ${pass} 通过 / ${fail} 失败 ──`);
process.exit(fail ? 1 : 0);
