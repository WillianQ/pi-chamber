// TTS 域（语音输出）：前端 tts.speak 喂文本 → 后端与阿里 DashScope 语音合成跑一轮"会话"，
// 音频块（PCM16 base64）边收边推 tts.audio；会话终结必回一次 tts.end。
//
// 协议（详情待并入 AGENTS.md "TTS 域"，此处记全）：
//   request  tts.speak {text, opts?} → {ok, sampleRate}   受理即回，流走事件
//   emit(s→w) tts.audio {chunk}                            一块 = 阿里一帧 binary（base64 PCM16）
//   emit(w→s) tts.finish                                   正常收尾：finish-task flush 尾句，audio 照推完
//   emit(w→s) tts.stop                                     打断：立即停推 + finish-task(cancel)
//   emit(s→w) tts.end {reason:"done"|"cancelled"|"error", error?}   会话终结（必到一次）
//   request  tts.break → {ok}                              测试口：仅断开阿里 WS（走真实断网同款 close 路径）
//
// 实现决策/坑（本文件是唯一真相，改协议先改这里）：
//   - 会话模型 = duplex 追加：一次"会话"自首个 speak 受理起，到 tts.end 止。
//     speak 在会话中 = continue-task 续文本；phase!=="running"（finishing/cancelling）时 speak 拒绝。
//     finish/stop 若早于阿里 task-started 到达 → 挂起，task-started 到了补发。
//   - 连接：进程内单例一条"阿里面向"WS（与 STT 各持一条：同 socket 只能跑一个在途任务，不能共享）。
//     惰性建连 + 空闲被阿里掐了静默置空，下个 speak 重建（自愈，照 STT 同款哲学）。
//   - 断线分层（handleDashGone）：
//       空闲断            → 静默，下轮 speak 重建
//       会话中·cancelling → tts.end{cancelled}
//       会话中·finishing  → tts.end{error}（尾句没念完，不重放）
//       会话中·已出过 audio → tts.end{error}（不重放，会重念前半截）
//       会话中·未出过 audio → 自动换新 task_id 重连 + 整段重放缓存 texts（前端无感，只重试一次）
//   - 厂商约束后端兜：continue-task 单次 ≤20000 字符，超长自动切段逐段发。
//     阿里 task_id 是会话内唯一锚：迟到旧任务帧按 task_id 不符丢弃。
//   - 音频格式：PCM16 单声道，sample_rate 硬编码 22050，speak 回执携带供前端建 AudioContext。
//   - stop 兜底：发 cancel 后 3s 阿里未回 task-finished → 强收束 end{cancelled}（用户要求 stop 必回 end）。
//     缺口/待办：finish（正常 flush）没有兜底计时器，极罕见阿里不回 task-finished 时会悬挂到连接断开。
import { log, logErr } from "./log.js";
import WebSocket from "ws";
import crypto from "node:crypto";
import { get as getSetting } from "./setting.js";

const URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const CHUNK_LIMIT = 20000; // continue-task 单次文本上限（字符）
const STOP_TIMEOUT = 3000; // stop 后等阿里 task-finished 的兜底

// —— 配置 ——
// model / sampleRate 硬编码（设置项里没有它们，见 setting.js 字段表）；apiKey / voice / rate 走设置。
const MODEL = "qwen-audio-3.0-tts-flash";
const SAMPLE_RATE = 22050;

// 当前会话的语音参数：run-task 一发出就定死，中途改不了 ——
// 所以开新会话时从设置**现读一次**（设置页改了 → 下个会话生效）
let voice = "";
let rate = 1.0;

// —— 与阿里的连接（进程级单例，TTS 专用）——
let dashWs = null;
let dashConnecting = false;
let connBuf = []; // open 前要发的命令（run-task 挂在里面，open 后 flush）

// —— 当前会话（taskId=null 即无会话）——
let taskId = null; // 阿里任务 id（uuid）
let taskStarted = false; // 已收阿里 task-started（之后才能发 continue/finish）
let phase = "running"; // running | finishing（已发 finish 等尾句）| cancelling（stop 已发）
let dropping = false; // stop 后：阿里的 audio 帧一律丢弃（立即停推，不等阿里）
let pendingContinue = []; // 尚未发到阿里的文本段（task-started 前 / 重连后 flush）
let texts = []; // 本会话已收录全部文本段（未出声断线时整段重放用）
let audioEmitted = false; // 是否已向前端推过 audio（断线走"重放"还是"error"的分界）
let retried = false; // 本会话是否已自动重放过
let stopTimer = null; // stop 兜底计时器

function ttsJson() {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      model: MODEL,
      parameters: {
        text_type: "PlainText",
        voice,
        format: "pcm",
        sample_rate: SAMPLE_RATE,
        rate,
      },
      input: {},
    },
  };
}
const continueJson = (text) => ({
  header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
  payload: { input: { text } },
});
const finishJson = (cancel) => ({
  header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
  payload: { input: cancel ? { directive: "cancel" } : {} },
});

/** 超长文本切段：continue-task 单次 ≤20000 字符，逐段发（阿里自动分句，切在哪都安全） */
function chunkText(text) {
  const segs = [];
  for (let i = 0; i < text.length; i += CHUNK_LIMIT) segs.push(text.slice(i, i + CHUNK_LIMIT));
  return segs;
}

function sendOrQueue(msg, bus) {
  if (dashWs?.readyState === WebSocket.OPEN) {
    dashWs.send(msg);
    return;
  }
  connBuf.push(msg); // 连接没就绪：挂队列，open 后 flush
  connectDash(bus);
}

function sendRunTask(bus) {
  sendOrQueue(JSON.stringify(ttsJson()), bus);
}

function sendFinishCmd(cancel) {
  // finish/cancel 须在 task-started 之后才有意义；没 started 就由 task-started 分支补发
  if (!taskStarted) return;
  if (dashWs?.readyState === WebSocket.OPEN) dashWs.send(JSON.stringify(finishJson(cancel)));
}

function flushPendingContinue() {
  if (dashWs?.readyState !== WebSocket.OPEN) return;
  for (const s of pendingContinue) dashWs.send(JSON.stringify(continueJson(s)));
  pendingContinue = [];
}

/** 收束当前会话并回 tts.end（end 之前不保留任何会话残留） */
function endSession(bus, reason, error) {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  taskId = null;
  taskStarted = false;
  phase = "running";
  dropping = false;
  pendingContinue = [];
  texts = [];
  audioEmitted = false;
  retried = false;
  const p = reason === "error" ? { reason, error: error ?? "语音合成失败" } : { reason };
  log(`[tts] 会话终结 reason=${reason}${error ? `（${error}）` : ""}`);
  bus.emit("tts.end", p, { net: true });
}

// —— 阿里连接管理：惰性建连，open 后 flush connBuf；close/error 走 handleDashGone ——
function connectDash(bus) {
  if (dashWs?.readyState === WebSocket.OPEN) return;
  if (dashWs?.readyState === WebSocket.CONNECTING) return; // 已在建，命令已挂 connBuf
  if (dashConnecting) return;

  dashConnecting = true;
  const ws = new WebSocket(URL, {
    headers: { Authorization: `Bearer ${getSetting().tts.dashscopeApiKey || ""}`, "user-agent": "pi-chamber-server" },
  });
  dashWs = ws;

  ws.on("open", () => {
    dashConnecting = false;
    log(`[tts] DashScope 连接建立（flush ${connBuf.length} 条排队命令）`);
    for (const m of connBuf) ws.send(m);
    connBuf = [];
  });
  ws.on("message", (data, isBinary) => onDashMessage(data, isBinary, bus));
  ws.on("error", (err) => {
    logErr("[tts] DashScope 连接错误:", err.message);
    dashConnecting = false;
    handleDashGone(ws, bus);
  });
  ws.on("close", () => {
    dashConnecting = false;
    handleDashGone(ws, bus);
  });
}

/** 连接没了（阿里断 / 错误 / tts.break）——统一收束。幂等：只认当前连接的 ws */
function handleDashGone(ws, bus) {
  if (dashWs !== ws) return; // 旧连接 / 已被处理（如手动 close 后又被重连覆盖）
  dashWs = null;
  connBuf = [];
  log("[tts] 与阿里连接断开");

  if (!taskId) return; // 空闲断线：静默，下轮 speak 惰性重建

  // —— 会话在途 ——
  if (phase === "cancelling") {
    endSession(bus, "cancelled");
    return;
  }
  if (phase === "finishing") {
    endSession(bus, "error", "合成收尾时连接中断");
    return;
  }
  if (audioEmitted) {
    endSession(bus, "error", "语音合成连接中断");
    return;
  }
  if (retried) {
    endSession(bus, "error", "语音合成连接中断（重试后仍未出声）");
    return;
  }
  // 未出过 audio → 自动重连 + 换新 task_id 整段重放（前端一个字节都没收到，无感）
  retried = true;
  taskStarted = false;
  taskId = crypto.randomUUID();
  pendingContinue = texts.slice();
  log(`[tts] 未出声断线，自动重连重放 ${pendingContinue.length} 段文本（task ${taskId}）`);
  sendRunTask(bus);
}
// —— 阿里消息翻译层（前端只见 tts.audio / tts.end；厂商壳全咽在这）——
function onDashMessage(raw, isBinary, bus) {
  // binary 帧 = 阿里吐的 PCM 音频。注意：Node ws 客户端 text 帧的 data 也是 Buffer，
  // 分帧只能看 isBinary 标志，不能靠 Buffer.isBuffer（stt-service 靠 parse 失败推断是歪打正着，这里别学）
  if (isBinary) {
    if (taskId && taskStarted && !dropping && raw.length) {
      audioEmitted = true;
      bus.emit("tts.audio", { chunk: raw.toString("base64") }, { net: true });
    }
    return;
  }
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const event = msg?.header?.event;
  if (msg?.header?.task_id && msg.header.task_id !== taskId) return; // 迟到旧任务帧，丢弃

  switch (event) {
    case "task-started": {
      taskStarted = true;
      log(`[tts] task ${taskId} started`);
      if (phase === "cancelling") {
        sendFinishCmd(true); // stop 早于 started 到：不发文本，直接 cancel
        break;
      }
      flushPendingContinue(); // 把 started 前积压的文本补发
      if (phase === "finishing") sendFinishCmd(false);
      break;
    }
    case "result-generated": {
      const out = msg?.payload?.output;
      if (out?.type === "sentence-end") {
        const chars = msg?.payload?.usage?.characters ?? "";
        log(`[tts] 句 ${out.sentence?.index} 完成（累计 ${chars} 字符）`);
      }
      break;
    }
    case "task-finished": {
      log(`[tts] task ${taskId} finished`);
      endSession(bus, dropping || phase === "cancelling" ? "cancelled" : "done");
      break;
    }
    case "task-failed": {
      const err = msg?.header?.error_message || "合成任务失败";
      logErr(`[tts] task ${taskId} failed:`, err);
      endSession(bus, "error", err);
      break;
    }
    default:
      break; // 心跳等杂讯忽略
  }
}

// —— bus 注册（唯一出口）——
export function installTtsService(bus) {
  if (!getSetting().tts.dashscopeApiKey) log("[tts] 未配置百炼 key（可在「设置 → 朗读」里填）");

  // speak（request）：文本进当前会话；无会话 → 开新 run-task；会话中 → continue-task 追加。受理即回
  bus.on("tts.speak", async (payload) => {
    const cfg = getSetting().tts; // ★ 现读：开关 / key / 音色 / 语速都在这里
    if (!cfg.enabled) throw new Error("朗读未开启（在「设置 → 朗读」里打开）");
    if (!cfg.dashscopeApiKey) throw new Error("语音合成未配置（在「设置 → 朗读」里填百炼 key）");
    const text = String(payload?.text ?? "").trim();
    if (!text) throw new Error("空文本：没东西可念");
    if (taskId && phase !== "running") throw new Error("上一段正在收尾，请稍候再试");

    const segs = chunkText(text);
    if (!taskId) {
      // 开新会话：语音参数在此刻定死（run-task 之后改不了）——现读设置
      voice = cfg.voice;
      rate = cfg.rate;
      taskId = crypto.randomUUID();
      taskStarted = false;
      phase = "running";
      dropping = false;
      texts = [...segs];
      pendingContinue = [...segs];
      audioEmitted = false;
      retried = false;
      log(`[tts] 新会话 task ${taskId}，${texts.length} 段文本（${text.length} 字符）`);
      sendRunTask(bus); // 连接没就绪则惰性建连，open 后 flush
    } else {
      // 追加续文本
      texts.push(...segs);
      for (const s of segs) {
        if (taskStarted && dashWs?.readyState === WebSocket.OPEN) {
          dashWs.send(JSON.stringify(continueJson(s)));
        } else {
          pendingContinue.push(s); // 没 started/没连上：等 task-started flush
        }
      }
      log(`[tts] 追加 ${segs.length} 段文本（累计 ${texts.join("").length} 字符）`);
    }
    return { ok: true, sampleRate: SAMPLE_RATE };
  });

  // finish（emit）：正常收尾。flush 阿里缓存尾句，剩余 audio 照常推完 → task-finished → end done
  bus.on("tts.finish", () => {
    if (!taskId || phase !== "running") return; // 无会话 / 已收尾中 → 幂等忽略
    phase = "finishing";
    log(`[tts] finish：请求正常收尾（task ${taskId}）`);
    sendFinishCmd(false); // 早于 started 则 task-started 分支补发
  });

  // stop（emit）：打断。立即停推 audio（dropping 挡后续帧）+ 发 cancel；3s 兜底强收束
  bus.on("tts.stop", () => {
    if (!taskId || dropping) return;
    dropping = true;
    phase = "cancelling";
    log(`[tts] stop：打断会话（task ${taskId}）`);
    sendFinishCmd(true);
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      log("[tts] stop 兜底：阿里未回 task-finished，强收束");
      endSession(bus, "cancelled");
    }, STOP_TIMEOUT);
  });

  // break（request，测试口）：只断开阿里 WS，不做多余处理——close 路径即"模拟断网"
  bus.on("tts.break", async () => {
    if (!dashWs) return { ok: true, alreadyDown: true };
    log("[tts] tts.break：手动断开阿里连接（模拟断网）");
    try {
      dashWs.close();
    } catch {}
    return { ok: true };
  });

  // 浏览器断线 → 在途会话没人听了：清态 + 断阿里（前端重连后会重新 speak，无需恢复现场）
  bus.on("$conn.close", () => {
    if (taskId || dashWs || dashConnecting) {
      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      taskId = null;
      taskStarted = false;
      phase = "running";
      dropping = false;
      pendingContinue = [];
      texts = [];
      audioEmitted = false;
      retried = false;
      if (dashWs) {
        try {
          dashWs.removeAllListeners();
          dashWs.close();
        } catch {}
        dashWs = null;
      }
      dashConnecting = false;
      connBuf = [];
      log("[tts] 浏览器断线，清理在途会话与阿里连接");
    }
  });

  // 设置变了：只需处理“关掉”这一件 —— key / 音色 / 语速都是下个会话现读即生效。
  // （这是全仓唯一“后端跟着设置变”的地方：前端关开关时，正在念的得马上停）
  bus.on("setting.sync", (s) => {
    if (s?.tts?.enabled) return;
    if (!taskId) return;
    log("[tts] 朗读被关闭 → 掐掉在途会话");
    endSession(bus, "cancelled");
  });

  log(`[tts] 语音合成服务已装（model=${MODEL} pcm@${SAMPLE_RATE}Hz）`);
}
