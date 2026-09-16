// todos 域冒烟：让模型真调一次 todos 工具，验证「清单 = 一条工具调用 + 一条状态帧」全链路。
// 用法: node scripts/todos-smoke.mjs
//
// ⚠️ 这个冒烟**会真调模型**（一场 1~2 轮，约 $0.001）—— 同 prompt-smoke / subagent-smoke 的定位，
//    断言的是「帧语义 + 配置闸 + 恢复现场」，不是"模型说了什么"。
//
// 三个场景（都在临时目录里，跑完即删）：
//   A 不写 <cwd>/.pi/pi-chamber.json  → **默认禁用**：模型调不到 todos（没有任何状态帧）
//   B 写 {"todos":{"enabled":true}} → 全链路：
//       ① 模型真调 todos → agent.plugin.state 帧到（sessionId = 本场，todos 形状对）
//       ② 给模型的 content = 可读清单（不是 JSON）
//       ③ toolResult 里 toolName === "todos"（details 随消息落盘 = 零手动持久化）
//       ④ **恢复现场**：close → open 后立刻收到状态帧，且内容与关前一致（数据来自档案）
//       ⑤ **重连补推**：断开 WS 重连（= $conn.open）后同样收到该场状态
import { getToken } from "./lib/creds.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const STATUSES = ["waiting", "doing", "done"];

const ASK =
  "必须调用 todos 工具（别用别的工具、别写别的废话）：把这三件事记进清单 —— " +
  "① 读代码（已经做完了）② 写插件（正在做）③ 写前端（还没开始）。然后直接结束。";

let pass = 0;
let fail = 0;
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── 连接（凭据从设置文件读：先试密码登录，失败就 jwtSecret 自签）──
const token = await getToken(BASE, jwt);

const bus = createBus({ requestTimeout: 30000 });
const log = [];
for (const ev of ["agent.sessions.sync", "agent.sessions.patch", "agent.chat.sync", "agent.chat.message", "agent.chat.notice", "agent.plugin.state"]) {
  bus.on(ev, (p) => log.push({ ev, p }));
}

let ws = null;
async function connect() {
  const sock = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${token}`);
  await new Promise((res, rej) => {
    sock.on("open", res);
    sock.on("error", rej);
  });
  sock.on("message", (d) => bus.feed(d.toString()));
  bus.attachTransport(nodeTransport(sock));
  ws = sock;
  return sock;
}
await connect();

/** 等一帧（先扫历史再挂监听；超时抛错，绝不静默挂死） */
function waitFor(ev, pred, ms, what) {
  return new Promise((res, rej) => {
    const hit = log.find((x) => x.ev === ev && pred(x.p));
    if (hit) return res(hit.p);
    const off = bus.on(ev, (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      off();
      res(p);
    });
    const t = setTimeout(() => {
      off();
      rej(new Error(`超时等待: ${what}`));
    }, ms);
  });
}

/** 等一帧**新**帧（不扫历史）：close/open 这类"同一事件会重复发生"的场景必须用它 */
function waitNew(ev, pred, ms, what) {
  return new Promise((res, rej) => {
    const off = bus.on(ev, (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      off();
      res(p);
    });
    const t = setTimeout(() => {
      off();
      rej(new Error(`超时等待(新帧): ${what}`));
    }, ms);
  });
}

/** 建一个干净的临时 agent space；withConfig=true 时写入启用配置 */
async function makeSpace(tag, withConfig) {
  const cwd = await mkdtemp(join(tmpdir(), `pc-todos-smoke-${tag}-`));
  if (withConfig) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-chamber.json"), JSON.stringify({ todos: { enabled: true } }, null, 2), "utf8");
  }
  return cwd;
}

/** 建场 + 发问；返回 { id, settledP } */
async function createAndAsk(cwd) {
  const chatP = waitFor("agent.chat.sync", (p) => p.activeId && p.cwd && resolve(p.cwd) === resolve(cwd), 30000, "create chat.sync");
  bus.emit("agent.session.create", { cwd }, { net: true });
  const id = (await chatP).activeId;
  const settledP = waitFor("agent.chat.sync", (p) => p.status === "idle" && (p.info?.cost ?? 0) > 0, 240000, "本场 settled");
  bus.emit("agent.session.prompt", { sessionId: id, text: ASK }, { net: true });
  return { id, settledP };
}

const spaces = [];
const created = [];
const cleanup = async () => {
  try {
    for (const id of created) bus.emit("agent.session.delete", { sessionId: id }, { net: true });
    await new Promise((r) => setTimeout(r, 800));
  } catch {}
  try {
    ws?.close();
  } catch {}
  for (const d of spaces) await rm(d, { recursive: true, force: true }).catch(() => {});
};

try {
  console.log(`✔ 已连接 @ ${BASE}\n`);

  // ─────────── 场景 A：不写配置 → 默认禁用 ───────────
  console.log("── 场景 A：不写 .pi/pi-chamber.json（默认禁用）──");
  const cwdA = await makeSpace("off", false);
  spaces.push(cwdA);
  const a = await createAndAsk(cwdA);
  created.push(a.id);
  await a.settledP;
  // ★ 必须按 sessionId 过滤：agent.plugin.state 是**广播不分焦点**的 —— 机器上任何一个别的场
  //   （本仓自己的对话、上一轮没删干净的场）写一次 todos，本连接的 log 里就会出现它的帧，
  //   不过滤就会把别人的进度算成"本场模型调到了工具"（踩过：本仓 cwd 开着 todos 时必假失败）。
  step(
    "默认禁用：模型调不到 todos（本场没有状态帧）",
    !log.some((x) => x.ev === "agent.plugin.state" && x.p?.sessionId === a.id && x.p?.state?.todos?.length),
  );
  console.log("");

  // ─────────── 场景 B：写配置启用 → 全链路 ───────────
  console.log("── 场景 B：.pi/pi-chamber.json 里 enabled:true ──");
  const cwdB = await makeSpace("on", true);
  spaces.push(cwdB);

  const chatP = waitFor("agent.chat.sync", (p) => p.activeId && p.cwd && resolve(p.cwd) === resolve(cwdB), 30000, "create chat.sync");
  bus.emit("agent.session.create", { cwd: cwdB }, { net: true });
  const id = (await chatP).activeId;
  created.push(id);
  step("Session 已建", !!id, `id=${id?.slice(0, 8)}`);

  const stateP = waitFor("agent.plugin.state", (p) => p.sessionId === id && p.state?.todos?.length, 240000, "todos 状态帧");
  const trP = waitFor("agent.chat.message", (p) => p.m?.role === "toolResult" && p.m?.toolName === "todos", 240000, "todos toolResult");
  bus.emit("agent.session.prompt", { sessionId: id, text: ASK }, { net: true });
  console.log("   已下发，等模型调工具…\n");

  const st = await stateP;
  const todos = st.state.todos;
  step("agent.plugin.state 帧到（带 sessionId + todos）", Array.isArray(todos), `n=${todos?.length}`);
  step("每条形状 = {description, status}", todos.every((t) => typeof t.description === "string" && t.description && STATUSES.includes(t.status)));
  step("清单条数 ≥ 2（模型真列了计划）", todos.length >= 2, `n=${todos.length}`);
  step("有且最多一条 doing", todos.filter((t) => t.status === "doing").length <= 1);
  step("状态帧按场存（sessionId = 本场）", st.sessionId === id);

  const tr = await trP;
  step("toolResult.toolName === \"todos\"（details 随消息落盘）", tr.m.toolName === "todos");
  step("给模型的 content = 可读清单（不是 JSON）", /清单 \d+\/\d+/.test(tr.m.text ?? ""), JSON.stringify((tr.m.text ?? "").slice(0, 60)));

  await waitFor("agent.chat.sync", (p) => p.status === "idle" && (p.info?.cost ?? 0) > 0, 240000, "本场 settled");

  // ─────────── 恢复现场：close → open（数据来自档案，不是内存）───────────
  console.log("\n── 恢复现场：close → open ──");
  const closeP = waitNew("agent.plugin.state", (p) => p.sessionId === id && p.state == null, 30000, "close 清状态");
  bus.emit("agent.session.close", { sessionId: id }, { net: true });
  await closeP;
  step("收工推 state:null（前端删条目）", true);

  const reopenStateP = waitNew("agent.plugin.state", (p) => p.sessionId === id && p.state?.todos?.length, 30000, "open 恢复状态");
  bus.emit("agent.session.open", { sessionId: id }, { net: true });
  const restored = await reopenStateP;
  step("重开会话后状态从档案恢复（条数一致）", restored.state.todos.length === todos.length, `${restored.state.todos.length} vs ${todos.length}`);
  step("恢复的内容与关前一致", JSON.stringify(restored.state.todos) === JSON.stringify(todos));

  // ─────────── 重连补推：$conn.open ───────────
  console.log("\n── 重连（$conn.open）补推 ──");
  const reconnP = waitNew("agent.plugin.state", (p) => p.sessionId === id && p.state?.todos?.length, 30000, "重连补推状态");
  ws.close();
  bus.detachTransport("test reconnect");
  await new Promise((r) => setTimeout(r, 500));
  await connect();
  const again = await reconnP;
  step("换设备/刷新接入后状态自动补推", again.state.todos.length === todos.length);
} catch (err) {
  step(`异常：${err?.message ?? err}`, false);
} finally {
  await cleanup();
  console.log(`\n${fail === 0 ? "✔" : "✘"} todos-smoke: ${pass} 过 / ${fail} 败`);
  process.exit(fail === 0 ? 0 : 1);
}
