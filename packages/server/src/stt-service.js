// STT 语音识别域（按住说话）：把"前端录音 → 阿里 DashScope 流式 asr"做成一条
// 前端无感知管道，根治老 chamber 的"白说"（老版前端要等 task-started 才敢发音频）。
//
// 核心思想（见 AGENTS.md 讨论结论）：
//   - 前端只管推：按下即采即发（stt.audio 每 ~250ms 一块 base64 PCM16 16k mono），
//     放开发 stt.end。**不感知**后端-STT 连接状态，零等待。
//   - 后端兜底：音频先进缓冲，阿里 task-started 后按序倒灌 → 就绪延迟被管道吸收。
//     阿里空闲会自动断线 → 连接惰性重建（收首块才建，断了下轮首块再建，从不断线等待）。
//   - 结果翻译：阿里私有协议(header.event)收敛成 stt.partial/stt.final/stt.error 三个事件，
//     前端不碰厂商壳；final = 整轮终止确认(task-finished)后才发，一次注入输入框。
//
// 线协议（挂 bus，全事件、无回执）：
//   前端→后端：stt.audio {chunk:base64} ｜ stt.end {}
//   后端→前端：stt.partial {text} ｜ stt.final {text} ｜ stt.error {message}
//
// DashScope duplex 消息（发送）：
//   run-task   {header:{action:"run-task", task_id, streaming:"duplex"}, payload:{...}}
//   finish-task{header:{action:"finish-task", task_id, streaming:"duplex"}, payload:{input:{}}}
//   （音频 = ws binary，与命令同 socket）
// 接收（data.header.event）：task-started / result-generated / task-finished / task-failed

import WebSocket from "ws";
import crypto from "node:crypto";
import { get as getSetting } from "./setting.js";

const DASHSCOPE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

/** 识别设置现读 —— 不缓存。设置只在“前端推着走”时才被读（见 setting.js 纪律②），
 *  所以 key 改了 / 开关改了，下一块音频自然生效，无需任何同步机制。 */
const sttCfg = () => getSetting().stt;

// —— 模块级状态（单例服务，进程与 bus 同寿）——
let dashWs = null; // 与阿里的 ws（Node 侧客户端，无 CORS）
let dashConnecting = false;
let connBuf = []; // 连接 open 前要发的命令（最多一条 run-task）
let curTaskId = null; // 在途任务 id（null = 无在途）
let taskReady = false; // 已收阿里 task-started（此后音频可直发）
let audioBuf = []; // task-started 前积压的音频 Buffer[]（保险箱）
let ended = false; // 本轮已收 stt.end（started 到达后补发 finish-task）
let finalBuf = ""; // 本轮所有 sentence_end 句子拼接的最终文本
let noKeyWarned = false; // 未配置 key 只提示一次，别每块音频都刷

function sttJson() {
  return {
    header: { action: "run-task", task_id: curTaskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: "fun-asr-realtime",
      parameters: { format: "pcm", sample_rate: 16000 },
      input: {},
    },
  };
}

function resetTask() {
  curTaskId = null;
  taskReady = false;
  audioBuf = [];
  ended = false;
  finalBuf = "";
  connBuf = [];
}

function emitError(bus, message) {
  bus.emit("stt.error", { message }, { net: true });
}

// —— 阿里连接管理：惰性建连，open 后 flush connBuf；close/error 置空，下轮首块重建 ——
function connectDash(bus) {
  if (dashWs && dashWs.readyState === WebSocket.OPEN) return true;
  if (dashWs && dashWs.readyState === WebSocket.CONNECTING) return false; // 已在建，命令挂 connBuf
  if (dashConnecting) return false;

  dashConnecting = true;
  const ws = new WebSocket(DASHSCOPE_URL, {
    headers: { Authorization: `Bearer ${sttCfg().dashscopeApiKey || ""}`, "user-agent": "pi-chamber-server" },
  });
  dashWs = ws;

  ws.on("open", () => {
    dashConnecting = false;
    console.log("[stt] DashScope 连接建立");
    for (const m of connBuf) ws.send(m);
    connBuf = [];
  });
  ws.on("message", (data) => onDashMessage(bus, data));
  ws.on("error", (err) => {
    console.error("[stt] DashScope 连接错误:", err.message);
    dashConnecting = false;
    if (dashWs === ws) dashWs = null;
    if (curTaskId) {
      emitError(bus, "语音识别连接中断");
      resetTask();
    }
  });
  ws.on("close", () => {
    dashConnecting = false;
    if (dashWs === ws) dashWs = null;
    console.log("[stt] DashScope 连接关闭");
    // 在途任务随连接黄了 → 清态；录音中前端后续音频块会以新任务自动重启（自愈）
    if (curTaskId) {
      emitError(bus, "语音识别连接中断");
      resetTask();
    }
  });
  return false;
}

function sendRunTask(bus) {
  const msg = JSON.stringify(sttJson());
  if (dashWs?.readyState === WebSocket.OPEN) {
    dashWs.send(msg);
    return;
  }
  connBuf.push(msg); // 等 open flush
  connectDash(bus);
}

function sendFinishTask() {
  const msg = JSON.stringify({
    header: { action: "finish-task", task_id: curTaskId, streaming: "duplex" },
    payload: { input: {} },
  });
  if (dashWs?.readyState === WebSocket.OPEN) dashWs.send(msg);
}

// —— 阿里消息翻译层（前端只见 stt.partial / stt.final / stt.error）——
function onDashMessage(bus, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  const event = msg?.header?.event;
  if (msg?.header?.task_id && msg.header.task_id !== curTaskId) return; // 迟到旧任务，丢弃

  switch (event) {
    case "task-started": {
      taskReady = true;
      console.log(`[stt] task ${curTaskId} started，倒灌 ${audioBuf.length} 块积压音频`);
      for (const b of audioBuf) dashWs?.send(b);
      audioBuf = [];
      if (ended) sendFinishTask(); // 录音结束得比阿里快：started 一到就补 finish
      break;
    }
    case "result-generated": {
      const s = msg?.payload?.output?.sentence;
      if (!s || s.heartbeat) return;
      const text = s.text || "";
      if (!text) return;
      // partial 永远带"定稿前缀 + 当前句"，前端展示区所见即最终注入内容（老 chamber 同款拼法）
      if (s.sentence_end) {
        finalBuf += text;
        bus.emit("stt.partial", { text: finalBuf }, { net: true });
      } else {
        bus.emit("stt.partial", { text: finalBuf + text }, { net: true });
      }
      break;
    }
    case "task-finished": {
      console.log(`[stt] task ${curTaskId} finished`);
      bus.emit("stt.final", { text: finalBuf }, { net: true }); // 空文本也发，前端据此清 UI 不注入
      resetTask();
      break;
    }
    case "task-failed": {
      const err = msg?.header?.error_message || "语音识别任务失败";
      console.error(`[stt] task ${curTaskId} failed:`, err);
      emitError(bus, err);
      resetTask();
      break;
    }
    default:
      break; // 心跳等杂讯忽略
  }
}

// —— bus 注册（唯一出口）——
export function installSttService(bus) {
  if (!sttCfg().dashscopeApiKey) console.log("[stt] 未配置百炼 key（可在「设置 → 识别」里填）");

  // 前端录音音频块：首块隐式开任务，其余入保险箱/直发
  bus.on("stt.audio", (payload) => {
    const chunk = payload?.chunk;
    if (!chunk) return;
    const cfg = sttCfg();
    if (!cfg.enabled) return; // 开关关着 → 静默丢（前端不该发；发了也不报错，免得刷屏）
    if (!cfg.dashscopeApiKey) {
      if (!noKeyWarned) {
        noKeyWarned = true;
        emitError(bus, "语音识别未配置（请在「设置 → 识别」里填百炼 key）");
      }
      return;
    }
    const audio = Buffer.from(chunk, "base64");
    if (!audio.length) return;

    if (!curTaskId) {
      // 新一轮：发 run-task（等连接的话挂 connBuf），音频全部等 started
      curTaskId = crypto.randomUUID();
      taskReady = false;
      ended = false;
      finalBuf = "";
      audioBuf = [];
      sendRunTask(bus);
      audioBuf.push(audio);
      return;
    }
    if (taskReady && dashWs?.readyState === WebSocket.OPEN) {
      dashWs.send(audio); // started 后直通
    } else {
      audioBuf.push(audio); // 保险箱：连接/任务没就绪也不丢
    }
  });

  // 放开按钮：残余块已发完，显式说"我说完了"
  bus.on("stt.end", () => {
    if (!curTaskId) return; // 无在途（如上一轮已收尾/被错误清掉）→ 无视
    ended = true;
    if (taskReady) sendFinishTask();
    // 没 started：等 task-started 补发（onDashMessage 里处理）
  });

  // 浏览器断线 → 在途任务没人要了：断阿里连接 + 清态（前端 $conn.open 会重推现场）
  bus.on("$conn.close", () => {
    if (curTaskId || dashWs) {
      resetTask();
      if (dashWs) {
        try {
          dashWs.removeAllListeners();
          dashWs.close();
        } catch {}
        dashWs = null;
      }
      dashConnecting = false;
      console.log("[stt] 浏览器断线，清理在途语音任务");
    }
  });

  // 设置变了：只需处理“关掉”这一件 —— 其余（key / enabled）下一块音频现读即生效。
  // （这是全仓唯一“后端跟着设置变”的地方：前端关开关时，后端得把在途任务丢掉）
  bus.on("setting.sync", (s) => {
    if (s?.stt?.enabled) return;
    if (!curTaskId) return;
    console.log("[stt] 识别被关闭 → 丢弃在途任务");
    resetTask();
  });
}
