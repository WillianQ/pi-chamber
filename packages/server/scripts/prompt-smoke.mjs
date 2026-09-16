// Prompt 全流程冒烟（新协议）：create 幽灵 → prompt → 内容流（message 草稿 / delta / 终稿）→ settled → 清理。
// 用法: node scripts/prompt-smoke.mjs ["想说的话"]        （真写盘，用完即删幽灵）
//
// 断言的是"帧语义"，不是"模型说了什么"：草稿出生 → 增量入格 → 终稿整条替换 → status 归 idle。
// 另带一段**图片往返**（模型不吃图就自动跳过）：带图 prompt → user 消息帧带 images →
// open 重推全量 sync 时仍带（证明投影来自 jsonl）+ 超量被拒的负例。
import { getToken } from "./lib/creds.mjs";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { resolve } from "node:path";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const CWD = resolve(".");
const TEXT = process.argv[2] || "回答四个字：收到明白";
// 1×1 红色 PNG：只求"真能当图发"，不靠它验模型看懂了什么
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

// ── 帧记录 ──
const stream = { drafts: 0, deltas: 0, deltaChars: 0, deltaKinds: new Set(), finals: [], rowStatuses: [], rowNames: [], userMsgs: [] };
const waiters = [];
function watch(ev, fn) {
  bus.on(ev, (p) => {
    fn?.(p);
    for (const w of [...waiters]) {
      if (w.ev === ev && w.pred(p)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(p);
      }
    }
  });
}
function wait(ev, pred = () => true, ms = 120000, label = ev) {
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

watch("agent.chat.sync", () => {}); // 只为唤醒 wait（下面各 wait 都等它）
watch("agent.chat.message", (p) => {
  if (p?.open && p.m?.role === "assistant") stream.drafts++;
  else if (p?.m?.role === "assistant") stream.finals.push(p.m);
  else if (p?.m?.role === "user") stream.userMsgs.push(p.m);
});
watch("agent.chat.delta", (p) => {
  stream.deltas++;
  stream.deltaChars += (p?.x ?? "").length;
  stream.deltaKinds.add(p?.k);
});
watch("agent.sessions.patch", (p) => {
  for (const r of p?.rows ?? []) {
    if (r.deleted) continue;
    stream.rowStatuses.push(r.status ?? "(未变)");
    if (r.name) stream.rowNames.push(r.name);
  }
});
watch("agent.chat.notice", (p) => {
  if (p?.type === "error") console.log(`   [notice] ${p.message}`);
});

let sessionId = null;
try {
  // 1. 建幽灵场 + 置焦
  const chatP = wait("agent.chat.sync", (p) => !!p.activeId, 30000, "create");
  bus.emit("agent.session.create", { cwd: CWD }, { net: true });
  const created = await chatP;
  sessionId = created.activeId;
  step("create → 置焦 + 空 messages", created.messages.length === 0 && created.commands.length > 0,
    `id=${sessionId.slice(0, 8)} commands=${created.commands.length}`);

  // 2. 发 prompt（emit 无回执）
  const runningP = wait("agent.chat.sync", (p) => p.status === "running", 60000, "status:running");
  const draftP = wait("agent.chat.message", (p) => p?.open && p.m?.role === "assistant", 60000, "assistant 草稿");
  const idleP = wait("agent.chat.sync", (p) => p.status === "idle", 180000, "status:idle");
  bus.emit("agent.session.prompt", { sessionId, text: TEXT }, { net: true });
  console.log(`→ prompt: “${TEXT}”\n`);

  await draftP;
  step("message{open:true, role:assistant} 草稿出生", stream.drafts > 0);
  await runningP;
  step("chat.sync{status:running}（agent_start）", true);

  // 3. 等落定
  await idleP;
  await new Promise((r) => setTimeout(r, 300)); // 让尾帧排完

  step("delta 增量到达（k ∈ t/h/c 且攒批发）", stream.deltas > 0,
    `${stream.deltas} 条 / ${stream.deltaChars} 字 / kinds=${[...stream.deltaKinds].join(",")}`);
  const final = stream.finals.at(-1);
  step("message 终稿（整条、不带 open、带 blocks）",
    !!final && Array.isArray(final.blocks) && typeof final.text === "string",
    `blocks=${final?.blocks?.length ?? 0} text=${(final?.text ?? "").length} 字 stopReason=${final?.stopReason}`);
  step("终稿文本非空（模型真回了话）", !!final?.text?.trim(), `“${(final?.text ?? "").slice(0, 40)}”`);
  // 首条用户消息 → 自动命名（走 setSessionName → session_info_changed → patch{name}）
  const wantName = TEXT.replace(/\s+/g, " ").trim().slice(0, 24);
  step("首条用户消息 → 自动命名（名册行 name = 首句截断）",
    stream.rowNames.at(-1) === wantName, `name=“${stream.rowNames.at(-1) ?? ""}”`);

  step("名册行 status 走过 running → idle",
    stream.rowStatuses.includes("running") && stream.rowStatuses.at(-1) === "idle",
    stream.rowStatuses.join(" → "));

  // 3.5 图片往返（模型不吃图就跳过）
  if (!created.modelInput?.includes("image")) {
    console.log(`⊘ 图片往返：当前模型不吃图（modelInput=${JSON.stringify(created.modelInput ?? null)}）→ 跳过`);
  } else {
    const before = stream.userMsgs.length;
    const imgIdleP = wait("agent.chat.sync", (p) => p.status === "idle", 180000, "图片轮 idle");
    bus.emit(
      "agent.session.prompt",
      { sessionId, text: "这张图什么颜色？两个字回答", images: [{ type: "image", mimeType: "image/png", data: PNG_1PX }] },
      { net: true }
    );
    await imgIdleP;
    await new Promise((r) => setTimeout(r, 300));
    const um = stream.userMsgs.slice(before).at(-1);
    step("带图 prompt → user 消息帧带 images", !!um?.images?.length, `images=${um?.images?.length ?? 0}`);

    // 首屏投影：open 幂等重推全量 sync，图应还在（来源 = jsonl，不是内存残影）
    const fullP = wait("agent.chat.sync", (p) => p.activeId === sessionId && Array.isArray(p.messages), 30000, "open 全量");
    bus.emit("agent.session.open", { sessionId }, { net: true });
    const full = await fullP;
    const withImg = full.messages.filter((m) => m.role === "user" && m.images?.length).length;
    step("首屏 chat.sync 里 user 消息仍带图（投影自 jsonl）", withImg > 0, `带图 user 消息 ${withImg} 条`);

    // 负例：超量整条拒（不落盘、不静默丢图）
    const errP = wait("agent.chat.notice", (p) => p?.type === "error", 15000, "超量被拒");
    bus.emit(
      "agent.session.prompt",
      { sessionId, text: "x", images: Array.from({ length: 6 }, () => ({ type: "image", mimeType: "image/png", data: PNG_1PX })) },
      { net: true }
    );
    const err = await errP;
    step("6 张图 → 被拒并弹 notice", /最多/.test(err.message ?? ""), `“${err.message}”`);
  }

  // 4. 收尾清场（幽灵场：不落盘就直接销毁；落盘了也删掉，保持环境干净）
  const delP = wait("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === sessionId && r.deleted), 15000, "delete");
  bus.emit("agent.session.delete", { sessionId }, { net: true });
  await delP;
  step("delete → patch{deleted:true}（清场完成）", true);
  sessionId = null;
} catch (err) {
  step(`流程中断：${err?.message ?? err}`, false);
} finally {
  if (sessionId) bus.emit("agent.session.delete", { sessionId }, { net: true });
  console.log(`\n${fail ? "✘" : "✔"} prompt-smoke: ${pass} 过 / ${fail} 败`);
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  process.exit(fail ? 1 : 0);
}
