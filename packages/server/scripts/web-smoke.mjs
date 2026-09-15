// 前端 store 冒烟（Node 里跑真前端代码，连活体后端）：sessions-store + chat-store 的帧消费与 Actions。
// 用法: node scripts/web-smoke.mjs [cwd]     （需要 3001 上跑着新协议后端）
//
// 为什么要它：前端两个 store 全是"收帧 → 写状态"，逻辑错了要在浏览器里肉眼找；这里直接把活体帧喂进去断言。
// Node 缺浏览器 API → 进门前打好桩（localStorage / location）。
import "dotenv/config";

// ── 浏览器 API 桩（必须在 import 前端代码之前）──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = { protocol: "http:", host: process.env.HOST || "localhost:3001" };

import jwt from "jsonwebtoken";
import { resolve } from "node:path";
const { bus, connect, useConnStore } = await import("../../web/src/bus.js");
const { useSessionsStore, sessionsActions } = await import("../../web/src/stores/sessions-store.js");
const { useChatStore, chatActions } = await import("../../web/src/stores/chat-store.js");

const CWD = resolve(process.argv[2] || "../../");
let pass = 0;
let fail = 0;
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, every = 100) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(every);
  }
}

const token = jwt.sign({ sub: "owner" }, process.env.JWT_SECRET, { expiresIn: "10m" });
connect(token);
await until(() => useConnStore.getState().state === "online", 8000);
step("WS 连上（bus 在线）", useConnStore.getState().state === "online");

// 1. 连接即收到名册全量
await until(() => useSessionsStore.getState().agents.length > 0, 10000);
const s0 = useSessionsStore.getState();
step("agent.sessions.sync → agents / selectedCwd / sessions 落库",
  s0.agents.length > 0 && !!s0.selectedCwd && Array.isArray(s0.sessions),
  `agents=${s0.agents.length} selectedCwd=${s0.selectedCwd} sessions=${s0.sessions.length}`);

// 2. 换目录（Agent 下拉）
sessionsActions.selectAgent(CWD);
await until(() => useSessionsStore.getState().selectedCwd === CWD, 10000);
step("换目录 → selectedCwd 跟随 + 列表重推", useSessionsStore.getState().selectedCwd === CWD,
  `${useSessionsStore.getState().sessions.length} 场`);

let id = null;
try {
  // 3. 新建：creating 起落 + 插行 + chat 整组
  sessionsActions.createSession(CWD);
  step("create 发出 → creating=true（按钮转圈）", useSessionsStore.getState().creating === true);
  await until(() => !!useChatStore.getState().activeId, 30000);
  id = useChatStore.getState().activeId;
  const c1 = useChatStore.getState();
  step("create → chat 整组就位（activeId/messages/commands/cwd/status）",
    !!id && Array.isArray(c1.messages) && c1.messages.length === 0 && c1.commands.length > 0 && c1.status === "idle",
    `id=${id?.slice(0, 8)} commands=${c1.commands.length}`);
  await until(() => useSessionsStore.getState().sessions.some((r) => r.id === id), 5000);
  const row = useSessionsStore.getState().sessions.find((r) => r.id === id);
  step("create → 名册插行（status=idle）", !!row && row.status === "idle", `rows=${useSessionsStore.getState().creating}`);
  step("create → creating 归零", useSessionsStore.getState().creating === false);

  // 4. 发消息：本端 pending → 服务端 running → 终稿 → idle
  const okSend = chatActions.send("回答两个字：收到");
  step("send 受理（清输入框的依据）→ status=pending", okSend === true && useChatStore.getState().status === "pending");
  step("send → 名册行也置 pending（本端在途标记）",
    useSessionsStore.getState().sessions.find((r) => r.id === id)?.status === "pending");
  step("pending 期间再发被挡（不叠）", chatActions.send("再来一条") === false);

  await until(() => useChatStore.getState().status === "running" || useChatStore.getState().messages.some((m) => m.open), 45000);
  step("服务端真值帧接管 → status=running / 草稿出生",
    ["running", "compacting"].includes(useChatStore.getState().status) || useChatStore.getState().messages.some((m) => m.open),
    `status=${useChatStore.getState().status}`);

  let sawDraft = false;
  await until(() => {
    if (useChatStore.getState().messages.some((m) => m.open)) sawDraft = true;
    return useChatStore.getState().status === "idle" && !useChatStore.getState().messages.some((m) => m.open);
  }, 180000, 60);
  const c2 = useChatStore.getState();
  step("跑动期见过 open 草稿（delta 有落脚处）", sawDraft);
  step("settled → status 回 idle 且无残留草稿", c2.status === "idle" && !c2.messages.some((m) => m.open));
  step("messages 落地 user + assistant 两条终稿",
    c2.messages.filter((m) => m.role === "user").length === 1 &&
      c2.messages.filter((m) => m.role === "assistant").length === 1,
    `共 ${c2.messages.length} 条：${c2.messages.map((m) => m.role).join(",")}`);
  const last = c2.messages.at(-1);
  step("assistant 终稿带 blocks + usage 汇总进 info", Array.isArray(last?.blocks) && !!c2.info,
    `info.cost=${c2.info?.cost} ctx=${c2.info?.contextTokens ?? "null"}/${c2.info?.contextWindow}`);
  await until(() => useSessionsStore.getState().sessions.find((r) => r.id === id)?.status === "idle", 8000);
  const row2 = useSessionsStore.getState().sessions.find((r) => r.id === id);
  step("名册行回 idle（messageCount 由 patch 刷新）", row2?.status === "idle", `count=${row2?.messageCount}`);

  // 5. 收工 → 行 offline + chat 清空
  sessionsActions.closeSession(id);
  await until(() => useChatStore.getState().activeId === null, 15000);
  step("close → chat 整组清空（activeId=null / messages=[]）",
    useChatStore.getState().activeId === null && useChatStore.getState().messages.length === 0);
  step("close → 行 status=offline",
    useSessionsStore.getState().sessions.find((r) => r.id === id)?.status === "offline");

  // 6. 销毁（清场）
  sessionsActions.deleteSession(id);
  await until(() => !useSessionsStore.getState().sessions.some((r) => r.id === id), 15000);
  step("delete → 行从名册消失", !useSessionsStore.getState().sessions.some((r) => r.id === id));
  id = null;
} catch (err) {
  step(`流程中断：${err?.message ?? err}`, false);
} finally {
  if (id) sessionsActions.deleteSession(id);
  await sleep(400);
  console.log(`\n${fail ? "✘" : "✔"} web-smoke: ${pass} 过 / ${fail} 败`);
  process.exit(fail ? 1 : 0);
}
