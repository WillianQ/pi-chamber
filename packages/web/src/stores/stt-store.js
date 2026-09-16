// STT Store — "按住说话"语音输入（前端半边）。
//
// 与后端 stt-service 的分工：前端 = 只管录音与推流，不感知"后端-STT 连接是否就绪"。
//   startRecording → 采即发（stt.audio 每 ~250ms 一块 base64 PCM16 16k mono，无脑推，不等回执）
//   stopRecording  → flush 残余 + stt.end（"我说完了"）
// 结果三事件（后端已把 DashScope 私有协议翻译好）：
//   stt.partial   → 提示条"听写中…"（所见即最终注入内容）；不碰输入框
//   stt.final     → 整轮终止确认，一次性回调 onFinal(text)，由 InputBox 注入光标处
//   stt.error     → 停录 + 提示（输入框从未被改过，无残留可回滚）
//
// 采集：ScriptProcessor（老 chamber 同款，已验证可跑；AudioWorklet 是后换项）
// Float32 → Int16 → 线性重采样到 16kHz → base64 上车。bus 是文本 JSON 帧，无二进制通道。
import { create } from "zustand";
import { bus } from "../bus.js";

const CHUNK_MS = 250; // 攒批发送间隔
const TARGET_RATE = 16000;

// —— 采集句柄（模块级，非响应式）——
let stream = null;
let audioCtx = null;
let srcNode = null;
let procNode = null;
let sendTimer = null;
let pending = []; // Int16Array[]，原生采样率
let sampleRate = 0;
let _onFinal = null; // 最终文本回调（InputBox 注入用），一轮一设

// —— 工具：Int16 合并 / 线性重采样(老 chamber 同款) / base64 ——
function mergeChunks(chunks) {
  if (!chunks.length) return null;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

function resample16(i16, fromRate) {
  const ratio = fromRate / TARGET_RATE;
  const n = Math.round(i16.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, i16.length - 1);
    const frac = idx - lo;
    out[i] = Math.round(i16[lo] * (1 - frac) + i16[hi] * frac);
  }
  return out;
}

function toBase64(u8) {
  let bin = "";
  const STEP = 8192;
  for (let i = 0; i < u8.length; i += STEP) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  }
  return btoa(bin);
}

// Int16 little-endian → base64（bus 无二进制，文本帧承载音频）
function emitAudio(i16) {
  const pcm = sampleRate === TARGET_RATE ? i16 : resample16(i16, sampleRate);
  const u8 = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    u8[i * 2] = pcm[i] & 0xff;
    u8[i * 2 + 1] = (pcm[i] >> 8) & 0xff;
  }
  if (u8.length) bus.emit("stt.audio", { chunk: toBase64(u8) }, { net: true });
}

// —— 采集启停（无 React 状态，纯工具）——
function flushPending() {
  const merged = mergeChunks(pending);
  pending = [];
  if (merged) emitAudio(merged);
}

function teardownCollect() {
  if (sendTimer) {
    clearInterval(sendTimer);
    sendTimer = null;
  }
  if (procNode) {
    try {
      procNode.disconnect();
    } catch {}
    procNode = null;
  }
  if (srcNode) {
    try {
      srcNode.disconnect();
    } catch {}
    srcNode = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  // audioCtx 是模块级单例、跨轮复用：这里不 close（只停 track + 断节点），
  // 下一轮免去 AudioContext 创建 + resume 的冷启动延迟（消除“按下即说”的丢头空窗）。
  // 真正释放留给组件卸载的 cleanup()（closeAudioCtx）。
}

// AudioContext 单例（模块级，跨轮复用）。resume 必须在用户手势栈内发起才不被浏览器拦：
// 移动端无手势创建的 ctx 停在 suspended、onaudioprocess 不触发 = 整轮静音。
function ensureAudioCtx() {
  if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// 组件卸载/登出等真收尾才关 ctx；录音轮间 teardown 只停采集、保 ctx 复用
function closeAudioCtx() {
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {}
    audioCtx = null;
  }
}

function startCapture(mediaStream) {
  stream = mediaStream;
  audioCtx = ensureAudioCtx(); // 复用单例（resume 已在手势栈内发起，连好节点等 running 即出声）
  sampleRate = audioCtx.sampleRate;

  srcNode = audioCtx.createMediaStreamSource(mediaStream);
  procNode = audioCtx.createScriptProcessor(4096, 1, 1);
  procNode.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    pending.push(i16);
    // 诚实锚点：首个 audio quantum 才置 listening（此前是“启动中”，还没在采）
    if (!useSTTStore.getState().listening) useSTTStore.setState({ listening: true });
  };
  srcNode.connect(procNode);
  procNode.connect(audioCtx.destination); // 0 输出不发声（脚本节点惯例仍要 connect）

  pending = [];
  sendTimer = setInterval(flushPending, CHUNK_MS);
}

// 停采集但保留 UI 最终画面（stop 正常收尾 / error 中断都走这里；中断不发 end）
function haltCapture() {
  flushPending();
  teardownCollect();
}

// —— Store ——
export const useSTTStore = create((set, get) => ({
  isRecording: false,
  listening: false, // 真在采样（首个 quantum 才置位）；按下到出 PCM 之间与 isRecording 分离，UI 显示“启动中”
  partialText: "", // 后端 stt.partial 累计文本（提示条展示，最终注入内容预览）
  error: null,

  /** 按下：开录 + 开推。onFinal = 整轮定稿回调（InputBox 注入输入框用） */
  async startRecording(onFinal) {
    if (get().isRecording) return;
    _onFinal = onFinal || null;
    set({ isRecording: true, listening: false, partialText: "", error: null }); // 乐观即时反馈（采集初始化是异步的）
    // 创建 + resume ctx 在 await 之前（本函数由 pointerdown 同步调用，这段仍在手势栈内）：
    // 与 getUserMedia 并行跑，流回来时 ctx 通常已 running —— 采样 gap 只剩取流本身。
    ensureAudioCtx();

    let mediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      _onFinal = null;
      set({ isRecording: false, error: `无法访问麦克风：${err?.message || err}` });
      return;
    }
    if (!get().isRecording) {
      // 等 getUserMedia 期间已被松开/出错 → 放弃这轮
      mediaStream.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      startCapture(mediaStream);
    } catch (err) {
      teardownCollect();
      _onFinal = null;
      set({ isRecording: false, error: `录音初始化失败：${err?.message || err}` });
    }
  },

  /** 放开：flush 残余 → stt.end（"我说完了"）；结果等 stt.final 回来再一次性注入 */
  stopRecording() {
    if (!get().isRecording) return;
    set({ isRecording: false });
    haltCapture(); // flush 残余 + 断采集
    bus.emit("stt.end", {}, { net: true });
  },

  /** 组件卸载/断线强制收尾：不发 end（后端在途任务由 $conn.close 清理），不注入 */
  cleanup() {
    _onFinal = null;
    if (get().isRecording) {
      set({ isRecording: false });
      teardownCollect();
      pending = [];
    }
    closeAudioCtx(); // 真收尾：关单例 ctx（轮间 teardown 不关，见 teardownCollect 注）
  },
}));

// —— 结果事件（模块级订阅一次，终身有效；bus 订阅不随连接生死）——
bus.on("stt.partial", (p) => {
  if (p?.text) useSTTStore.setState({ partialText: p.text });
});
bus.on("stt.final", (p) => {
  const text = p?.text || "";
  const cb = _onFinal;
  _onFinal = null;
  useSTTStore.setState({ isRecording: false, listening: false, partialText: "", error: null });
  cb?.(text); // 空文本也回调：InputBox 只跳过注入，仍需复位内部状态
});
bus.on("stt.error", (p) => {
  const err = p?.message || "语音识别失败";
  useSTTStore.setState((s) => {
    if (s.isRecording) {
      // 后端任务黄了：停采集（不发 end，免得给已复位后端补刀），提示条报错
      teardownCollect();
      pending = [];
    }
    return { isRecording: false, listening: false, partialText: "", error: err };
  });
});
// 录音中连接断了：音频怎么发都白搭，停录提示，等重连再按
bus.on("$conn.close", () => {
  const s = useSTTStore.getState();
  if (s.isRecording) {
    _onFinal = null;
    teardownCollect();
    pending = [];
    useSTTStore.setState({ isRecording: false, listening: false, partialText: "", error: "连接断开，语音已取消" });
  }
});
// 识别开关被关掉（设置页）→ 停录（不发 end：后端在途任务由它自己的 setting.sync 拾掉）
bus.on("setting.sync", (s) => {
  if (s?.stt?.enabled) return;
  const cur = useSTTStore.getState();
  if (!cur.isRecording) return;
  _onFinal = null;
  teardownCollect();
  pending = [];
  useSTTStore.setState({ isRecording: false, listening: false, partialText: "", error: null });
});
