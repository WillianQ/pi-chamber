// Subagent 域冒烟：让模型真的调一次 subagent 工具，验证「子 agent = 名册里的一行真 Session」全链路。
// 用法: node scripts/subagent-smoke.mjs
//
// ⚠️ 这个冒烟**会真调模型**（两场各 2~4 轮，约 $0.003）—— 同 prompt-smoke 的定位，
//    不是每次 CI 都跑的那种。断言的是「帧语义 + 归属关系 + 配置闸」，不是"模型说了什么"。
//
// ⚠️ 断言陷阱：`agent_settled` 推的是**局部帧** `{status, info}`（**没有 activeId**）——
//    “等父场跑完”必须用 `status==="idle" && info.cost>0` 这个口径（cost 只在真跑过之后才 >0），
//    不能要求 `p.activeId === id`，否则永远不匹配。
//
// 两个场景（都在临时目录里，跑完即删）：
//   A 不写 <cwd>/.pi/pi-chamber.json  → **默认禁用**：模型调不到 subagent（没有 isSubAgent 行）
//   B 写 {"subagent":{"enabled":true}} → 全链路：
//       ① 名册里多出一行 isSubAgent=true，parentId 指向父场，cwd 与父场相同
//       ② 父场 toolResult 的 subagent 指针（childSessionId / status / usage）被投影出来
//       ③ 返回给模型的 content 是「成本头 + 结论」，且够瘦（不含 transcript）
//       ④ 子场成本计入父场（getSessionStats 累加 toolResult.usage）
//       ⑤ 子场用完即自动收工（行转 offline），且**收工≠销毁** —— 档案还在，点开还能回看
//       ⑥ 子场有独立档案 jsonl（可回看）
//   C 把配置改成 enabled:false → /reload → **热更生效**：模型立刻调不到 subagent（不用重开会话）
import "dotenv/config";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const TASK = process.argv[2] || "`echo hi-from-subagent`";
const askForSubagent = () =>
  "必须使用 subagent 工具（不要自己动手）：派一个子任务，让它在同一目录用 bash 执行 " +
  `${TASK}，然后把 subagent 的结论原样复述给我。`;

let pass = 0;
let fail = 0;
const step = (name, ok, extra = "") => {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── 连接（明文密码优先；没有就 JWT_SECRET 自签）──
let token = null;
if (process.env.PASSWORD) {
  try {
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.PASSWORD }),
    });
    token = (await r.json())?.token ?? null;
  } catch {}
}
if (!token) {
  if (!process.env.JWT_SECRET) {
    console.error("拿不到登录凭据（.env 无 PASSWORD 也无 JWT_SECRET）");
    process.exit(1);
  }
  token = jwt.sign({ sub: "owner" }, process.env.JWT_SECRET, { expiresIn: "10m" });
  console.log("（用 JWT_SECRET 自签 token）");
}

const bus = createBus({ requestTimeout: 30000 });
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${token}`);
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
ws.on("message", (d) => bus.feed(d.toString()));
bus.attachTransport(nodeTransport(ws));

const log = [];
for (const ev of ["agent.sessions.sync", "agent.sessions.patch", "agent.chat.sync", "agent.chat.message", "agent.chat.notice"]) {
  bus.on(ev, (p) => log.push({ ev, p }));
}

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

/** 等一帧**新**帧（不扫历史）—— /reload 这类“同一事件会重复发生”的场景必须用它，
 *  否则 waitFor 会立刻匹配到早先那一条，断言就形同虚设。 */
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
  const cwd = await mkdtemp(join(tmpdir(), `pc-subagent-smoke-${tag}-`));
  if (withConfig) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-chamber.json"), JSON.stringify({ subagent: { enabled: true } }, null, 2), "utf8");
  }
  return cwd;
}

async function createAndAsk(cwd) {
  const chatP = waitFor("agent.chat.sync", (p) => p.activeId && p.cwd && resolve(p.cwd) === resolve(cwd), 30000, "create chat.sync");
  bus.emit("agent.session.create", { cwd }, { net: true });
  const id = (await chatP).activeId;
  // 局部帧口径：cost > 0 才说明真跑过一轮（create 时那帧 info.cost = 0）
  const settledP = waitFor("agent.chat.sync", (p) => p.status === "idle" && (p.info?.cost ?? 0) > 0, 240000, "父场 settled");
  bus.emit("agent.session.prompt", { sessionId: id, text: askForSubagent() }, { net: true });
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
    ws.close();
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
  const spawnedInA = log.some((x) => x.ev === "agent.sessions.patch" && x.p.rows?.some((r) => r.isSubAgent === true));
  step("默认禁用：模型调不到 subagent（名册里没有 isSubAgent 行）", !spawnedInA);
  console.log("");

  // ─────────── 场景 B：写配置启用 → 全链路 ───────────
  console.log("── 场景 B：.pi/pi-chamber.json 里 enabled:true ──");
  const cwdB = await makeSpace("on", true);
  spaces.push(cwdB);

  const chatP = waitFor("agent.chat.sync", (p) => p.activeId && p.cwd && resolve(p.cwd) === resolve(cwdB), 30000, "create chat.sync");
  bus.emit("agent.session.create", { cwd: cwdB }, { net: true });
  const parentId = (await chatP).activeId;
  created.push(parentId);
  step("父场已建", !!parentId, `id=${parentId?.slice(0, 8)}`);

  const childPatchP = waitFor("agent.sessions.patch", (p) => p.rows?.some((r) => r.isSubAgent === true), 180000, "子 Session 行");
  const toolResultP = waitFor("agent.chat.message", (p) => p.m?.role === "toolResult" && p.m?.toolName === "subagent", 240000, "subagent toolResult");
  bus.emit("agent.session.prompt", { sessionId: parentId, text: askForSubagent() }, { net: true });
  console.log("   已派单，等模型动作…\n");

  const childRow = (await childPatchP).rows.find((r) => r.isSubAgent === true);
  const childId = childRow.id;
  created.push(childId);
  step("名册里出现 isSubAgent=true 的新行", true, `id=${childId?.slice(0, 8)} status=${childRow.status}`);
  step("该行 parentId 指向父场", childRow.parentId === parentId, `got=${childRow.parentId}`);
  step("该行 cwd = 父场 cwd（v1 强制同 Agent Space）", childRow.cwd === resolve(cwdB), `got=${childRow.cwd}`);

  const tr = await toolResultP;
  const sub = tr.m.subagent;
  step("toolResult.subagent.childSessionId 已投影", sub?.childSessionId === childId, `got=${sub?.childSessionId}`);
  step("toolResult.subagent.status = ok", sub?.status === "ok", `got=${sub?.status}`);
  step("给模型的 content = 成本头 + 结论", /\[subagent\]/.test(tr.m.text ?? ""), JSON.stringify((tr.m.text ?? "").slice(0, 90)));
  step("content 够瘦（不含 transcript）", (tr.m.text ?? "").length < 1500, `len=${(tr.m.text ?? "").length}`);

  const childCost = sub?.usage?.cost ?? 0;
  const st = await waitFor("agent.chat.sync", (p) => p.status === "idle" && (p.info?.cost ?? 0) > 0, 240000, "父场 settled");
  step("父场回到 idle", st.status === "idle");
  step("子场成本已计入父场（父 ≥ 子 > 0）", childCost > 0 && (st.info?.cost ?? 0) >= childCost, `父=${st.info?.cost} 子=${childCost}`);

  await waitFor("agent.sessions.patch", (p) => p.rows?.some((r) => r.id === childId && r.status === "offline"), 30000, "子场自动收工");
  step("子场用完即自动收工（行转 offline）", true);

  const reopenP = waitFor("agent.chat.sync", (p) => p.activeId === childId, 30000, "重新打开子场");
  bus.emit("agent.session.open", { sessionId: childId }, { net: true });
  const re = await reopenP;
  step("收工后仍可点开回看（档案保留）", (re.messages?.length ?? 0) > 0, `messages=${re.messages?.length}`);

  // 删 Session 只 unlink 文件、不删目录 → 逐目录搜，别只取第一个匹配
  const sessDir = join(process.env.USERPROFILE ?? process.env.HOME, ".pi", "agent", "sessions");
  const dirs = (await readdir(sessDir)).filter((d) => d.includes("pc-subagent-smoke"));
  let hitChild = false;
  let hitParent = false;
  for (const d of dirs) {
    const files = await readdir(join(sessDir, d)).catch(() => []);
    if (files.some((f) => f.includes(childId))) hitChild = true;
    if (files.some((f) => f.includes(parentId))) hitParent = true;
  }
  step("子场有独立档案（jsonl，可回看）", hitChild, `扫了 ${dirs.length} 个目录`);
  step("父场也有自己的档案", hitParent);

  // ─────────── 场景 C：改配置 → /reload 热更开关（不用重开会话）───────────
  console.log("\n── 场景 C：enabled:true → false，/reload 热更 ──");
  // 前面为了验“能回看”把焦点给了子场，先切回父场
  const backP = waitNew("agent.chat.sync", (p) => p.activeId === parentId, 30000, "切回父场");
  bus.emit("agent.session.open", { sessionId: parentId }, { net: true });
  await backP;

  const spawnRows = () => log.filter((x) => x.ev === "agent.sessions.patch" && x.p.rows?.some((r) => r.isSubAgent === true)).length;
  const before = spawnRows();

  await writeFile(join(cwdB, ".pi", "pi-chamber.json"), JSON.stringify({ subagent: { enabled: false } }, null, 2), "utf8");
  const noticeP = waitNew("agent.chat.notice", (p) => p.type === "reload", 30000, "/reload 回执");
  bus.emit("agent.session.prompt", { sessionId: parentId, text: "/reload" }, { net: true });
  const notice = await noticeP;
  step("/reload 回执报告插件已关", /插件已开：（无）/.test(notice.message ?? ""), JSON.stringify((notice.message ?? "").slice(-30)));

  const costNow = () => Math.max(0, ...log.filter((x) => x.ev === "agent.chat.sync").map((x) => x.p?.info?.cost ?? 0));
  const costBefore = costNow(); // /reload 不调模型 → 它的收尾 sync 不会抬 cost，能当分界
  const settle2P = waitNew("agent.chat.sync", (p) => p.status === "idle" && (p.info?.cost ?? 0) > costBefore, 240000, "父场 settled(2)");
  bus.emit("agent.session.prompt", { sessionId: parentId, text: askForSubagent() }, { net: true });
  await settle2P;
  step("关掉 + /reload 后模型调不到（无新 isSubAgent 行）", spawnRows() === before, `before=${before} after=${spawnRows()}`);
} catch (err) {
  step(`异常：${err?.message ?? err}`, false);
} finally {
  await cleanup();
  console.log(`\n${fail === 0 ? "✔" : "✘"} subagent-smoke: ${pass} 过 / ${fail} 败`);
  process.exit(fail === 0 ? 0 : 1);
}
