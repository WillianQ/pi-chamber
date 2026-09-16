// TTS Store — 文本朗读（前端半边）：管道式接口（start/inject/finish）+ 内部"轮询拉取式"调度。
//
// 外部统一为"注入管道"（manual 与 live 同一套）：
//   start(kind, key?)   起点：start("manual") 无条件抢权（清场+建任务）；start("live") 仅空闲接管
//   inject(text)        注入：textBuf += text（纯追加，零判断）→ 首次注入自动开任务
//   finish()            注入完成：eof=true → flush 残段 → 播完回 idle
//
// 任务归属 mode（二态，无 null；空闲 = "manual"，安全不注入）：
//   mode==="live"   自动跟读会话中 → agent.chat.delta 注入
//   mode==="manual" 手动朗读中 / 空闲 / 已停止 → delta 一律屏蔽
//   mode 只在 start() 变化；任何收尾（播完 idle / stop / 断线）归位 "manual"。
//   autoLive 开关只在一个点被查：message_start 到达时决定要不要 start("live")；
//   之后 delta 能不能注入只看 mode，不再碰 autoLive。
//
//   手动优先：start("live") 只在真空闲时接管；手动朗读进行中来了 message_start → no-op 不抢。
//   live 被手动/停止夺权后 mode→"manual" → 后续 delta 注入自动死（不回魂）；
//   下一条 message_start（新 run/工具循环新段）且 autoLive 开 → 重新接管。
//
// 内部（喂送节奏，沿用已验证的"2s 轮询拉取式"——内容由事件送进来，节奏由这里拍）：
//     textBuf        未喂文本缓存（inject 只管往这倒，一个字符都不发阿里）
//     tick()         每 2s 轮询一次（+ 每次注入后立即补一次）：唯一"拍表"点
//                      → 文本缓存空?  在途块没解锁?  播放剩余≥3s? → 都不挡 → 切一块 speak
//     player         时间线预调度播放器（audio-player.js）
//     inFlight       在途块锁：speak 受理后等首帧 audio 才解锁 → 杜绝疯狂推送
//
//   协议/事件（见后端 tts-service.js 头注）：
//     request tts.speak {text} → {ok, sampleRate}   会话内可多次 continue；受理即回
//     emit(w→s) tts.finish / tts.stop
//     emit(s→w) tts.audio {chunk(base64)} / tts.end {reason:done|cancelled|error}
//
//   断线/会话重建：前端一律不管——后端自动重连/重放/重开会话，前端当"永不掉线"
//   用（收到 end(error) 只记状态继续推进；已收 audio 照播）。
//
//   切块规则（防阿里缓存对赌——不完整句会被缓存不吐，旧版卡死的总根源）：
//     ~100 字后找第一个【句末】收尾（。！？!? / 换行 / 英文句号后面跟空白或到头）；不足 100 字全量发。
//     块尾保证是句末标点 → 每块 continue 都被阿里即时合成，无缓存错位。
//     只"文本全部喂完"后才发一次 finish，flush 可能残留的无标点尾段。
//   切块规则 + markdown 清洗 + 补尾标点，全在 lib/tts-text.js 的 cutBlock 里一步做完；
//   这里只管“什么时候切、一块一块往外喂”。
import { create } from "zustand";
import { bus } from "../bus.js";
import { audioPlayer } from "../lib/audio-player.js";
import { cutBlock } from "../lib/tts-text.js";

const TICK_MS = 2000; // 轮询拍表间隔
const THRESHOLD_SEC = 3; // 播放剩余 < 3s 才补喂

// —— 自动朗读开关持久化（localStorage；关页不丢）——
// ★ 语速 / 音色**不在这里**：它们是服务端设置（setting.tts.rate / voice），见 setting-store.js。
//   会话参数由后端在开新会话时现读 —— 前端只管把改动 emit 上去。
const PARAMS_KEY = "tts.params";
function loadParams() {
  try {
    const p = JSON.parse(localStorage.getItem(PARAMS_KEY));
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function persistParams(patch) {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ ...loadParams(), ...patch }));
  } catch {}
}

// —— 模块态（非响应式；zustand 只管 phase/error/activeKey/autoLive 薄壳）——
let mode = "manual"; // 任务归属：manual（含空闲/手动/已停）| live（自动跟读会话中）
let textBuf = ""; // 未喂文本缓存
let eof = false; // finish() 已调：不会再有 inject
let inFlight = null; // 在途块 {text}：speak 受理 → 等首帧 audio 解锁（防疯狂推送）
let sessionLive = false; // 后端有活会话（speak 受理置真 / end 置假）
let finishSent = false; // 本会话已发 tts.finish（幂等）
let stopped = true; // 无激活任务（空闲/清场后为真；首次 inject 才开任务）
let sr = 22050; // 首个 speak 回执带回
let lastFailAt = 0;
let inFlightAt = 0; // 在途块发起时刻（超时放行兜底）
let injectCount = 0; // inject计数器

const st = (s) => useTTSStore.setState(s);

// —— 工具 ——
function toFloat32(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // int16 小端。JS 位运算是无符号 Number，0xFFFF 会成 65535（int16 里是 -1）→ 手动转有符号
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v / 32768;
  }
  return out;
}

function settleIfDone() {
  if (stopped) return;
  const s = useTTSStore.getState();
  if (s.phase === "paused") return;
  if (!eof || textBuf || inFlight || sessionLive) return; // 还有文本/在途/会话未收尾
  if (audioPlayer.hasActive() || audioPlayer.buffered() > 0.01) return; // 还在播
  stopped = true;
  mode = "manual"; // 任务播完归位：live/manual 都回安全态（下个 message_start 才可能再 start("live")）
  st({ phase: "idle", activeKey: null });
}

/** 唯一"拍表"点：收尾 flush → 无标点残段超时放行 → 水位不足且无在途 → 切块喂 */
function tick() {
  const s = useTTSStore.getState();
  if (stopped || s.phase !== "speaking") return;
  // 0) 无标点残段兜底：在途块 4s 无 audio（阿里在缓存等拼接/无句号）→ 放行，靠后续块拼句或 finish flush
  if (inFlight && Date.now() - inFlightAt > 4000) {
    inFlight = null;
    inFlightAt = 0;
  }
  // 1) 文本全喂完（含在途块都发出去了）+ 会话还开着 → 发 finish flush 残段（幂等，end 后复位）
  if (eof && !textBuf && sessionLive && !finishSent) {
    finishSent = true;
    bus.emit("tts.finish", null, { net: true });
  }
  // 2) 补喂
  if (!textBuf || inFlight) return;
  if (audioPlayer.buffered() >= THRESHOLD_SEC) return;
  const { text, raw, rest } = cutBlock(textBuf);
  textBuf = rest;
  if (!text) return; // 整块被洗空（纯标记/纯围栏）：不占在途，下个 tick 接着切
  inFlight = { text };
  inFlightAt = Date.now();
  bus
    .request(
      "tts.speak",
      { text }, // 语速/音色不带：后端开新会话时从设置现读（setting.tts.rate / voice）
      { net: true, timeout: 10000 },
    )
    .then((r) => {
      if (r?.sampleRate) sr = r.sampleRate;
      sessionLive = true;
      finishSent = false; // 受理成功 = 会话(可能重建过)活着，收尾逻辑重新武装
      // 不在此解锁：等首帧 audio（onAudio 里），保证在途≈一块
    })
    .catch(() => {
      textBuf = raw + textBuf; // 没喂出去：退回缓存头（退**原文片段** raw，不是洗过带补句号的 text）
      inFlight = null;
      inFlightAt = 0;
      // cancelling 过渡期的拒接是正常握手，别闪错；持续失败才提示
      const now = Date.now();
      if (now - lastFailAt > 8000) st({ error: "语音合成暂不可用，将自动重试" });
      lastFailAt = now;
    });
}

// —— 对外 Action ——
export const useTTSStore = create(() => ({
  phase: "idle", // idle | speaking | paused
  error: null,
  activeKey: null, // 手动朗读的源标识（消息 key），UI 据此点亮喇叭；live 不设（无喇叭可亮）
  autoLive: loadParams().autoLive ?? false, // 自动跟读总开关：只在 message_start 时决定是否 start("live")；默认关

  /** 朗读起点。kind="manual"：无条件抢权（清场，正在读的 live/手动全停）→ 手动任务；
   *  kind="live"：仅空闲接管（不抢正在读的手动任务；已在 live 幂等）。须在用户手势内调 manual */
  start(kind, key) {
    injectCount = 0
    if (kind === "live") {
      if (mode === "live" || !stopped) return; // 已在 live / 有任务在跑（手动优先，不抢）
      mode = "live";
      return;
    }
    // manual：无条件清场抢权
    stopped = true;
    stopPlayback(true);
    mode = "manual";
    if (key != null) st({ activeKey: key }); // 纯展示标注：高亮正在念的喇叭
  },

  /** 注入文本：纯追加。首次注入（空闲）自动开任务（ensure 音频 + 置 speaking）；须在 start 之后调 */
  inject(text) {
    const t = String(text ?? "");
    if (!t.trim()) return;
    if (stopped) {
      audioPlayer.ensure(); // manual 在手势栈内；live 由 autoLive 钮开时预热过（非手势也能响）
      stopped = false;
      eof = false;
      st({ phase: "speaking", error: null });
    }
    textBuf += t;
    injectCount += t.length
    tick(); // 立即拍一次（首块不用等 2s）
  },

  /** 声明"没有更多文本了"：缓存喂完 + 播完才回 idle。manual 由用户收尾；live 由 settled 收尾 */
  finish() {
    eof = true;
    tick();
    settleIfDone();
  },

  /** 暂停：音频时钟挂起（已排队的全冻结）+ 停止喂送（省钱）。后端会话不掐 */
  pause() {
    const cur = useTTSStore.getState();
    if (cur.phase !== "speaking" || stopped) return;
    audioPlayer.pause();
    st({ phase: "paused" });
  },

  /** 恢复：原地续播（suspend 语义）+ 立即拍表 */
  resume() {
    const cur = useTTSStore.getState();
    if (cur.phase !== "paused" || stopped) return;
    audioPlayer.ensure();
    audioPlayer.resume();
    st({ phase: "speaking" });
    tick();
  },

  /** 自动跟读总开关：开 = 预热音频（live 注入在 bus 回调里，非手势，靠这次预热出声）；关 = 若在跟读先停 */
  setAutoLive(v) {
    const on = Boolean(v);
    const cur = useTTSStore.getState();
    if (cur.autoLive === on) return;
    if (!on && mode === "live") {
      stopped = true;
      stopPlayback(true); // 正在跟读 → 停掉归位 manual（本 run 不再自动，等下个 message_start + 开关打开）
    }
    if (on) audioPlayer.ensure(); // 手势内建/唤醒 AudioContext
    persistParams({ autoLive: on });
    st({ autoLive: on });
  },

  /** 用户主动停：丢文本缓存 + 停播 + cancel 后端会话；归位 manual（live 不回魂） */
  stop() {
    stopped = true;
    stopPlayback(true);
  },
}));

/** 清场（抢权/停止共用）：cancel 后端会话、清播放器与缓存；归属归位 manual */
function stopPlayback(clearText) {
  mode = "manual";
  eof = false;
  inFlight = null;
  inFlightAt = 0;
  finishSent = false;
  if (clearText) textBuf = "";
  audioPlayer.stop();
  if (sessionLive) {
    sessionLive = false;
    bus.emit("tts.stop", null, { net: true }); // 会话死了不用 cancel；cancel 的 end 会来
  }
  st({ phase: "idle", activeKey: null, error: null });
}

// —— 结果事件（bus 订阅终身有效，不随连接生死）——
bus.on("tts.audio", (p) => {
  if (stopped || !p?.chunk) return;
  const f32 = toFloat32(p.chunk);
  if (!f32.length) return;
  audioPlayer.enqueue(f32, sr);
  inFlight = null; // 首帧 audio 到 = 后端在吐 → 解锁，允许下一块（防疯狂推送的关键）
  inFlightAt = 0;
});
bus.on("tts.end", (p) => {
  sessionLive = false;
  finishSent = false;
  inFlight = null;
  inFlightAt = 0;
  if (p?.reason === "error") st({ error: p.error || "语音合成中断" });
  else st({ error: null }); // done/cancelled 都清历史错误
  // 后端保证会话续命：取消/出错后仍可 speak → 有缓存就继续喂（轮询自愈）
  tick();
});
bus.on("$conn.close", () => {
  // WS 断了：后端已清在途会话，前端一并复位（重连后用户重新读/autoLive 重新武装）
  stopPlayback(false);
  stopped = true;
  st({ phase: "idle", activeKey: null, error: null });
});

// —— 自动跟读（live）：autoLive 只在“新草稿出生”那一刻被查一次，之后全凭 mode ——
// 内容帧（chat.message / chat.delta）是**裸帧、只发焦点**（服务端焦点闸）；
// 收尾锞 = chat.sync 里 status 回到非 running（settled / 压缩收尾，两者都必到）——
// 不用 settled 也不会串会话：live 只在主动 start("live") 后才可能注入，而 start 只发生在焦点内容流上。
bus.on("agent.chat.message", (p) => {
  if (!p?.open || p.m?.role !== "assistant") return; // 只认 assistant 草稿出生（终稿/其他角色不接管）
  if (useTTSStore.getState().autoLive) useTTSStore.getState().start("live");
});
bus.on("agent.chat.delta", (p) => {
  // ★ delta 能不能注入只看 mode（manual 在读/空闲/已停 → 屏蔽；autoLive 不参与）
  if (mode !== "live" || p?.k !== "t" || !p?.x) return;
  useTTSStore.getState().inject(p.x);
});
bus.on("agent.chat.message", (p) => {
  // 权威终稿旁挂的零头兜底（SDK 协议异常时 *_end 没发干净才非空；常态无操作）
  if (mode !== "live" || p?.open) return;
  if (p?.m?.role !== "assistant") return;
  useTTSStore.getState().inject(String(p.m.text ?? "").slice(injectCount));
});
bus.on("agent.chat.sync", (p) => {
  // 整轮真落定（settled → status 非 running）或压缩收尾：live 任务收尾。
  // 工具循环中间不 settle（status 一直 running），不会提前 flush 拆段。
  if (!p || !("status" in p)) return;
  if (p.status !== "idle") return; // compacting = run 中间压缩（后面还有正文），不能当收尾
  if (mode === "live") useTTSStore.getState().finish();
});

bus.on("setting.sync", (s) => {
  // 朗读被关掉 → 立刻停（后端也会拾掉在途会话；这边停本地播放与文本缓存）
  if (s?.tts?.enabled) return;
  const cur = useTTSStore.getState();
  if (mode === "live" || cur.phase !== "idle") cur.stop();
});

// 每块（含最后一块）播完 → 评估收尾
audioPlayer.onDrained = () => settleIfDone();

// 轮询拍表：常驻（空转极轻；无任务/暂停时 tick 早退）
setInterval(tick, TICK_MS);
