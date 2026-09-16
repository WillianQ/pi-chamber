// Agent 域冒烟（新协议）：名册 sync/patch + 生命周期 open/close/create/delete + 翻页回执 + 失败路径。
// 用法: node scripts/agent-smoke.mjs [cwd]        （默认 cwd = 本脚本所在包目录）
//
// 读表约定（PROTOCOL.new.md）：上行一律 emit 无回执，所以这里全是"发帧 → 等帧"。
import { getToken } from "./lib/creds.mjs";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { resolve } from "node:path";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const CWD = resolve(process.argv[2] || ".");
let pass = 0;
let fail = 0;
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── 连接（凭据从设置文件读：先试密码登录，失败就 jwtSecret 自签）──
const token = await getToken(BASE, jwt);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${token}`);
const bus = createBus({ requestTimeout: 30000 });
ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
ws.on("message", (raw) => bus.feed(raw.toString()));
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
console.log(`✔ 已连接 @ ${BASE}  cwd=${CWD}\n`);

// ── 帧记录 + 等待器 ──
const log = [];
const waiters = [];
const seen = (ev) => log.filter((x) => x.ev === ev).length;
function watch(ev) {
  bus.on(ev, (p) => {
    log.push({ ev, p });
    for (const w of [...waiters]) {
      if (w.ev === ev && w.pred(p)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(p);
      }
    }
  });
}
["agent.sessions.sync", "agent.sessions.patch", "agent.chat.sync", "agent.chat.notice"].forEach(watch);
function wait(ev, pred = () => true, ms = 10000, label = ev) {
  return new Promise((res, rej) => {
    const w = { ev, pred, res };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        rej(new Error(`等 ${label} 超时`));
      }
    }, ms);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. 连接即推名册全量
  const conn = await wait("agent.sessions.sync", () => true, 8000, "连接名册");
  step("连接推 agent.sessions.sync（agents + selectedCwd + sessions）",
    Array.isArray(conn.agents) && "selectedCwd" in conn && Array.isArray(conn.sessions),
    `agents=${conn.agents.length} sessions=${conn.sessions.length}`);

  // 2. 换目录 = emit agent.sessions.list{cwd} → 收名册全量
  const listP = wait("agent.sessions.sync", (p) => p.selectedCwd === CWD, 10000, "换目录名册");
  bus.emit("agent.sessions.list", { cwd: CWD }, { net: true });
  const mine = await listP;
  step("agent.sessions.list 换目录（selectedCwd 落位）", mine.selectedCwd === CWD, `共 ${mine.sessions.length} 场`);
  const row = mine.sessions[0];

  // 3. 打开真实档案：patch 行灯 + chat.sync 全量
  if (row) {
    const rowP = wait("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === row.id), 20000, "open 行灯");
    const chatP = wait("agent.chat.sync", (p) => p.activeId === row.id, 20000, "open 对话全量");
    bus.emit("agent.session.open", { sessionId: row.id }, { net: true });
    const [rowPatch, chat] = await Promise.all([rowP, chatP]);
    step("open → sessions.patch（行 status 一律走 patch）", rowPatch.rows[0].status === row.status || !!rowPatch.rows[0].status,
      `status=${rowPatch.rows[0].status}`);
    step("open → chat.sync 全量（含 messages / before / commands / status）",
      Array.isArray(chat.messages) && "before" in chat && Array.isArray(chat.commands) && "status" in chat,
      `messages=${chat.messages.length} before=${chat.before ? "有" : "null"}`);

    // 4. 翻页回执（有更早才真的要）
    if (chat.before) {
      const page = await bus.request("agent.chat.more_messages", { sessionId: row.id, before: chat.before }, { net: true });
      step("agent.chat.more_messages 回执", Array.isArray(page?.messages) && "before" in page,
        `+${page.messages.length} 条，下一站 ${page.before ? "有" : "到头"}`);
      // 5. toolResult 补全（找得到就试，找不到就算了）
      const tr = page.messages.concat(chat.messages).find((m) => m.role === "toolResult" && m.toolCallId);
      if (tr) {
        const full = await bus.request("agent.chat.toolResult", { sessionId: row.id, toolCallId: tr.toolCallId }, { net: true });
        step("agent.chat.toolResult 回执", "text" in full, `text=${full.text ? full.text.length + " 字符" : "null"}`);
      } else {
        step("agent.chat.toolResult（本场没有 toolResult，跳过）", true);
      }
    } else {
      step("agent.chat.more_messages（本场无更早，跳过）", true);
    }

    // 6. 收工：行 offline + 焦点清空
    const offP = wait("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === row.id && r.status === "offline"), 10000, "close 行灯");
    const clearP = wait("agent.chat.sync", (p) => p.activeId === null, 10000, "close 清空对话");
    bus.emit("agent.session.close", { sessionId: row.id }, { net: true });
    await Promise.all([offP, clearP]);
    step("close → patch(offline) + chat.sync(activeId:null)", true);
  } else {
    step("本目录没有档案可开（跳过 open/翻页/close）", true);
  }

  // 7. 新建幽灵 → 行 + 焦点；销毁 → 删行
  const newChatP = wait("agent.chat.sync", (p) => !!p.activeId, 30000, "create 对话");
  bus.emit("agent.session.create", { cwd: CWD }, { net: true });
  const created = await newChatP;
  const newId = created.activeId;
  step("create → chat.sync(activeId=新场) + 空 messages", newId && created.messages.length === 0, `id=${newId?.slice(0, 8)}`);
  step("create → sessions.patch 插行", log.some((x) => x.ev === "agent.sessions.patch" && x.p.rows?.some((r) => r.id === newId)),
    `patch 行 status=${log.find((x) => x.ev === "agent.sessions.patch" && x.p.rows?.some((r) => r.id === newId))?.p.rows[0].status}`);

  const delP = wait("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === newId && r.deleted), 15000, "delete 删行");
  bus.emit("agent.session.delete", { sessionId: newId }, { net: true });
  await delP;
  step("delete → patch(deleted:true) + agents 计数", true);

  // 8. 失败路径：open 不存在的档案 → patch 真值帧（清 pending）+ notice
  const badP = wait("agent.chat.notice", (p) => p.type === "error", 8000, "open 失败 notice");
  const badRowP = wait("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === "no-such-session" && r.status === "offline"), 8000, "open 失败真值帧");
  bus.emit("agent.session.open", { sessionId: "no-such-session" }, { net: true });
  const [badNotice] = await Promise.all([badP, badRowP]);
  step("open 不存在 → notice{error,sessionId} + patch(offline)（pending 有出口）",
    !!badNotice.sessionId, `${badNotice.message}`);

  await sleep(300);
  console.log(`\n帧统计：${["agent.sessions.sync", "agent.sessions.patch", "agent.chat.sync", "agent.chat.notice"].map((e) => `${e}=${seen(e)}`).join("  ")}`);
} catch (err) {
  step(`流程中断：${err?.message ?? err}`, false);
} finally {
  console.log(`\n${fail ? "✘" : "✔"} agent-smoke: ${pass} 过 / ${fail} 败`);
  ws.close();
  process.exit(fail ? 1 : 0);
}
