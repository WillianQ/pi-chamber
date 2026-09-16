// 对话工作台（chat）：焦点 Session 的消息流 + 状态。**全部由服务端帧驱动，前端零推导**。
//
// 数据组（chat.sync，字段级替换：出现的字段就是该字段的完整真值，不出现 = 不动）：
//   activeId · cwd · messages · before · commands · model · thinkingLevel · steers · info
// 状态组（本地）：
//   status（idle | pending | running | compacting）· error · retry · notice · loadingMore
//
// 关键约定（PROTOCOL.new.md）：
//   · 带 activeId 的 sync = 整组帧（连接 / open / 焦点被清），一定带全量 messages；局部帧不带 activeId。
//   · 内容流是**裸帧**（不带 sessionId）：message / delta 只发焦点，靠服务端焦点闸 + 单连接有序保证。
//   · 草稿不变式：同一时刻最多一条草稿，且草稿永远是最后一条。
//       message{open:true} → 建/更新尾部草稿；message（无 open）→ 有草稿就整条替换（终稿），否则追加。
//       delta → 只往尾部草稿的 blocks[ci] 里追加；**没有草稿就丢**（重连后 sync 给的全是终稿，
//               乱塞会把已完成的消息改脏）。
//   · 自愈不靠对账：断线重连那次的全量 sync 就是唯一对账；在途的半条草稿丢了就丢了。
import { create } from "zustand";
import { bus, useConnStore } from "../bus.js";
import { markPendingRow } from "./sessions-store.js";

const online = () => useConnStore.getState().state === "online";

// 消息身份：本地自增。★ 绝不能用下标派生 —— 翻页是从头部插入，下标一变所有 key 位移，
// React 全量重挂（卡片展开态、滚动锚、tts activeKey 全乱）。
let seq = 0;
const nextKey = () => `m${++seq}`;
const withKey = (m) => ({ ...m, key: nextKey() });

// chat.sync 里出现的键 = 该字段的完整真值（其余键不动）
const SYNC_KEYS = [
  "activeId",
  "cwd",
  "messages",
  "before",
  "commands",
  "model",
  "modelInput",
  "thinkingLevel",
  "steers",
  "info",
  "status",
];

function newBlock(ci, k, name) {
  if (k === "h") return { ci, type: "thinking", text: "", redacted: false };
  if (k === "c") return { ci, type: "toolCall", id: "", name: name ?? "", args: "" };
  return { ci, type: "text", text: "" };
}

export const useChatStore = create(() => ({
  // ── 数据组（帧驱动）──
  activeId: null,
  cwd: null,
  messages: [],
  before: null, // 翻页游标（对前端不透明：服务端生成、存着、下次原样回抄）
  commands: [], // / 命令清单（随焦点走）
  model: null,
  modelInput: null, // 当前模型吃的输入类型（"text" | "image"）—— 图片入口的开关，服务端预判后随 sync 推
  thinkingLevel: null,
  steers: [], // 未投递的插队队列
  info: null, // { input, output, cacheRead, cacheWrite, cost, contextTokens, contextPercent, contextWindow }
  // ── 状态组（本地）──
  status: "idle",
  error: null,
  retry: null, // { attempt, maxAttempts, message } 自动重试提示（notice{type:"retry"} 驱动）
  notice: null, // 一次性提示文案（notice{type:"reload"} 驱动：/reload 回执，服务端拼好的整句）
  loadingMore: false, // 向前翻页在途（挡重发）
}));

// ───────────────────────── 帧 → store ─────────────────────────

/** 对话帧：只覆盖帧里出现的字段 */
bus.on("agent.chat.sync", (p) => {
  if (!p) return;
  const cur = useChatStore.getState();
  const patch = {};
  for (const k of SYNC_KEYS) if (k in p) patch[k] = p[k];
  if (!Object.keys(patch).length) return;
  // 换会话（整组帧）：本地暂态一起归位，别把上一条会话的错/重试带过来
  if ("activeId" in patch && patch.activeId !== cur.activeId) {
    patch.error = null;
    patch.retry = null;
    patch.notice = null;
    patch.loadingMore = false;
  }
  useChatStore.setState(patch);
});

/** 整条消息：open 草稿 → 建/更新尾部草稿；终稿 → 整条替换尾部草稿（或追加） */
bus.on("agent.chat.message", (p) => {
  const m = p?.m;
  if (!m?.role) return;
  const { messages } = useChatStore.getState();
  const last = messages[messages.length - 1];
  if (last?.open) {
    // 草稿位置：更新 / 被终稿终结（沿用旧草稿的 key，免重挂丢组件态）
    useChatStore.setState({
      messages: [...messages.slice(0, -1), { ...m, key: last.key, ...(p.open ? { open: true } : {}) }],
    });
    return;
  }
  useChatStore.setState({ messages: [...messages, withKey(p.open ? { ...m, open: true } : m)] });
});

/** 内容增量：只作用在最后一条草稿上（没有草稿就丢，等下一次 message{终稿} 整条到位） */
bus.on("agent.chat.delta", (p) => {
  const { ci, k, x, name } = p ?? {};
  if (!k) return;
  const { messages } = useChatStore.getState();
  const d = messages[messages.length - 1];
  if (!d?.open) return;
  const blocks = d.blocks ? [...d.blocks] : [];
  const at = blocks.findIndex((b) => b.ci === ci);
  const block = at >= 0 ? { ...blocks[at] } : newBlock(ci, k, name);
  if (k === "c") block.args = (block.args ?? "") + (x ?? ""); // toolCall 参数 = 原始 JSON 片段
  else block.text = (block.text ?? "") + (x ?? ""); // text / thinking
  if (name && !block.name) block.name = name; // 声明帧没带名字时后续补上（OpenAI 系可能空串）
  if (at >= 0) blocks[at] = block;
  else {
    blocks.push(block);
    blocks.sort((a, b) => a.ci - b.ci); // 按块号插位
  }
  const patch = { messages: [...messages.slice(0, -1), { ...d, blocks }] };
  if (k === "t") patch.messages[patch.messages.length - 1].text = (d.text ?? "") + (x ?? ""); // 摊平文本
  useChatStore.setState(patch);
});

/** 提示帧：error 写 error；retry 只作顶栏提示（不写 messages） */
bus.on("agent.chat.notice", (p) => {
  if (!p) return;
  if (p.type === "retry") {
    if (p.phase === "start")
      useChatStore.setState({
        retry: { attempt: p.attempt, maxAttempts: p.maxAttempts, message: p.message ?? "" },
      });
    else
      useChatStore.setState({
        retry: null,
        ...(p.success ? {} : { error: p.message || "重试仍失败" }),
      });
    return;
  }
  if (p.type === "error") useChatStore.setState({ error: p.message || "出错了" });
  // reload：/reload 回执（重载了什么 + 诊断），纯展示、服务端已拼成一句话，前端不做解析
  else if (p.type === "reload") useChatStore.setState({ notice: p.message || "已重载" });
});

// ───────────────────────── Actions ─────────────────────────

export const chatActions = {
  clearError() {
    useChatStore.setState({ error: null });
  },

  clearNotice() {
    useChatStore.setState({ notice: null });
  },

  /** 发消息（emit，无回执）：受理即清输入框（调用方据返回值决定清不清）。
   *  空闲 = 起一轮；running/compacting = 服务端自动走插队（steer）。pending 在途时先挡住。
   *  ★ images 可选（线帧形状 { type:"image", data, mimeType }，前端已压过）：
   *    文本与图**至少一个非空**（纯图也放行）；不带图时字段省略（帧形状与老版一字不差）。 */
  send(text, images) {
    const { activeId, status } = useChatStore.getState();
    const t = String(text ?? "").trim();
    const imgs = Array.isArray(images) && images.length ? images : null;
    if (!activeId || (!t && !imgs)) return false;
    if (status === "pending") return false; // 上一条还没落定，别叠
    if (!online()) {
      useChatStore.setState({ error: "未连接服务器" });
      return false;
    }
    useChatStore.setState({ status: "pending", error: null });
    markPendingRow(activeId);
    bus.emit(
      "agent.session.prompt",
      { sessionId: activeId, text: t, ...(imgs ? { images: imgs } : null) },
      { net: true }
    );
    return true;
  },

  /** 停止当前轮：running / pending / compacting 都放行（只有 idle 无事可做）。
   *  ★ 不卡在 running：发送后前端先自置 pending（真值帧还没回来）与压缩中，用户此刻想停就得能停。
   *  幂等：重复调（如输入框与页面级 ESC 各一发）只会多发一条 abort，服务端 clearQueue+abort 本身幂等。 */
  abort() {
    const { activeId, status } = useChatStore.getState();
    if (!activeId || status === "idle" || !online()) return;
    useChatStore.setState({ status: "pending" });
    markPendingRow(activeId);
    bus.emit("agent.session.abort", { sessionId: activeId }, { net: true });
  },

  /** 向前翻一页（滚到顶触发）：老消息只增不删，切会话随 sync 一起丢弃 */
  async loadMore() {
    const { activeId, before, loadingMore } = useChatStore.getState();
    if (!activeId || before == null || loadingMore) return;
    useChatStore.setState({ loadingMore: true });
    try {
      const r = await bus.request(
        "agent.chat.more_messages",
        { sessionId: activeId, before },
        { net: true, timeout: 20000 }
      );
      if (useChatStore.getState().activeId !== activeId) return; // 期间切走了
      const older = (r?.messages ?? []).map(withKey);
      useChatStore.setState({
        messages: [...older, ...useChatStore.getState().messages],
        before: r?.before ?? null,
      });
    } catch (e) {
      useChatStore.setState({ error: e?.message || "加载更早的消息失败" });
    } finally {
      useChatStore.setState({ loadingMore: false });
    }
  },

  /** 展开一条被裁的 toolResult：翻档案取全文（+ 图，懒加载），换掉 text 并清 truncated。
   *  ★ 图只在这一刻拿：agent 读的图可能又多又大，首屏/翻页故意不带（见服务端 messages.js）。 */
  async expandToolResult(toolCallId) {
    const { activeId } = useChatStore.getState();
    if (!activeId || !toolCallId) return;
    try {
      const r = await bus.request(
        "agent.chat.toolResult",
        { sessionId: activeId, toolCallId },
        { net: true, timeout: 20000 }
      );
      if (r?.text == null || useChatStore.getState().activeId !== activeId) return;
      useChatStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.role === "toolResult" && m.toolCallId === toolCallId
            ? { ...m, text: r.text, truncated: false, ...(r.images?.length ? { images: r.images } : null) }
            : m
        ),
      }));
    } catch (e) {
      useChatStore.setState({ error: e?.message || "读取完整结果失败" });
    }
  },
};
