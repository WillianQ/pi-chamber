// TTS 冒烟：直打活体服务，验证 tts.speak/audio/finish/stop/break/end 全流程 + 断线自愈。
// 用法:
//   node scripts/tts-smoke.mjs 1           一段 speak → finish → 等 end(done)
//   node scripts/tts-smoke.mjs 2           两段 speak（同一会话 continue）→ finish
//   node scripts/tts-smoke.mjs 3 [秒]      两段 speak，间隔 N 秒（默认 25，> 阿里 23s 无 continue 超时）
//   node scripts/tts-smoke.mjs 4           发一段(等出声) → break 断阿里 → 再发一段
// 换活体: BASE=http://localhost:3000 node scripts/tts-smoke.mjs 1
import { getToken } from "./lib/creds.mjs";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { createBus } from "@pi-chamber/bus/core.js";
import { nodeTransport } from "@pi-chamber/bus/transport-node.js";

const BASE = process.env.BASE || "http://localhost:3001";
const SCENARIO = Number(process.argv[2] || 1);
const GAP_MS = (Number(process.argv[3]) || 25) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// token：凭据从设置文件读（不再有 .env）——先试密码登录，失败就 jwtSecret 自签
const token = await getToken(BASE, jwt);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${token}`);
const bus = createBus({ requestTimeout: 20000 });
ws.on("open", () => bus.attachTransport(nodeTransport(ws)));
ws.on("message", (raw) => bus.feed(raw.toString()));
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});

const t0 = Date.now();
const audio = { chunks: 0, bytes: 0, firstAt: null };
const ends = [];
bus.on("tts.audio", (p) => {
  audio.chunks++;
  audio.bytes += Math.floor((p.chunk.length / 4) * 3); // base64 → 字节
  if (!audio.firstAt) audio.firstAt = Date.now() - t0;
});
bus.on("tts.end", (p) => {
  ends.push({ at: Date.now() - t0, ...p });
  console.log(`   [end#${ends.length}] +${Date.now() - t0}ms reason=${p?.reason}${p?.error ? ` error=${p.error}` : ""}`);
});
const speak = (text) => bus.request("tts.speak", { text }, { net: true, timeout: 15000 });
const brk = () => bus.request("tts.break", {}, { net: true, timeout: 15000 });
const finish = () => bus.emit("tts.finish", null, { net: true });
async function waitFor(pred, ms, label) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (pred()) return;
    await sleep(120);
  }
  throw new Error(`${label} 超时(${ms}ms)`);
}
const waitEnd = (from, ms) => waitFor(() => ends.length > from, ms, "等 tts.end");
const waitAudio = (ms) => waitFor(() => audio.chunks > 0, ms, "等首块 tts.audio");
const line = (s) => console.log(`\n── 场景${SCENARIO}: ${s} ──`);
const report = (ok, name, extra = "") => console.log(`${ok ? "✔" : "✘"} ${name} ${extra}`);

const T_A = "春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。";
const T_B = "床前明月光，疑是地上霜。";

if (SCENARIO === 1) {
  line("一段 speak → finish");
  const r = await speak(T_A);
  report(r?.ok === true, "speak 受理", `(sampleRate=${r?.sampleRate})`);
  await waitAudio(20000);
  report(true, "收到音频", `(${audio.chunks} 块 / ${(audio.bytes / 1024).toFixed(1)}KB，首块 +${audio.firstAt}ms)`);
  const before = ends.length;
  finish();
  await waitEnd(before, 30000);
  report(ends.at(-1)?.reason === "done", "end(done)", `(${ends.length} 次 end 共)`);
} else if (SCENARIO === 2) {
  line("两段 speak（同一会话）→ finish");
  await speak(T_A);
  await waitAudio(20000);
  const audioBefore = audio.chunks;
  await speak(T_B);
  report(true, "第二段 speak 受理并追加");
  const before = ends.length;
  finish();
  await waitEnd(before, 30000);
  report(audio.chunks > audioBefore, "第二段有后续音频", `(${audioBefore} → ${audio.chunks} 块)`);
  report(ends.at(-1)?.reason === "done", "end(done)");
} else if (SCENARIO === 3) {
  line(`两段 speak，间隔 ${GAP_MS / 1000}s（超阿里 23s continue 时限）`);
  await speak(T_A);
  await waitAudio(25000);
  report(true, "第一段已出声", `(${audio.chunks} 块)`);
  console.log(`   …等 ${GAP_MS / 1000}s 期间观察断线…`);
  await sleep(GAP_MS);
  const gapEnds = ends.length;
  if (gapEnds) report(ends.at(-1)?.reason === "error", "空闲期断线被收束为 end(error)", `(共 ${gapEnds} 次)`);
  else report(true, "间隔后连接仍活（阿里未按 23s 断）");
  const before = ends.length;
  await speak(T_B);
  const b2 = audio.chunks;
  finish();
  await waitEnd(before, 40000);
  const last = ends.at(-1);
  report(last?.reason === "done", "第二段新会话 end(done)", `(本段音频 ${audio.chunks - b2} 块)`);
} else if (SCENARIO === 4) {
  line("发一段(等出声) → break 断阿里 → 再发一段");
  await speak(T_A);
  await waitAudio(25000);
  report(true, "第一段已出声", `(${audio.chunks} 块)`);
  const before = ends.length;
  await brk();
  report(true, "tts.break 已断阿里 WS");
  await waitEnd(before, 8000);
  report(ends.at(-1)?.reason === "error", "断线被收束为 end(error)", `(${ends.at(-1)?.error ?? ""})`);
  const b2 = audio.chunks;
  await speak(T_B);
  finish();
  await waitEnd(ends.length, 30000);
  const last = ends.at(-1);
  report(last?.reason === "done", "第二段自动重连后 end(done)", `(本段音频 ${audio.chunks - b2} 块)`);
} else {
  console.error("未知场景:", SCENARIO);
  process.exit(1);
}

console.log(`\n总计: 音频 ${audio.chunks} 块 / ${(audio.bytes / 1024).toFixed(1)}KB / 首块 +${audio.firstAt}ms | end 序列: ${ends.map((e) => e.reason).join(" → ") || "（无）"}`);
console.log("完毕 —— 看后端日志（[tts] 前缀）确认链路");
ws.close();
process.exit(0);
