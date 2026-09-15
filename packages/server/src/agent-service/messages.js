// ───────────────────── agent-service / messages.js ─────────────────────
// 消息投影：SDK message / 档案 entry → 前端 Message（**纯函数孤岛**：零 import、零状态、不碰 bus）。
//
// 三个消费者共用同一套投影（口径一致是硬要求，首屏与实时帧不允许长得不一样）：
//   · index.js 的 chatFull()      —— chat.sync 首屏（agentSession.messages 全量 + 在途草稿）
//   · index.js 的 translate()     —— chat.message 实时帧（message_end 权威终稿）
//   · index.js 的 moreMessages()  —— chat.more_messages 翻页（档案 entry）
//
// 归一与裁剪（只动投影副本，内存与磁盘都不动）：
//   · 时间戳统一 ISO（内存消息是 number ms，档案 entry 是 ISO 字符串）
//   · toolResult.text 裁到前 50 字 + truncated:true（前端展开时再走 chat.toolResult 要全文）
//   · assistant.blocks 带 ci（= content[] 下标），实时 delta 按 ci 入格；终稿整条替换，不做逐块合并
//
// 不发的两样：
//   · key —— 前端本地自增分配（翻页从头部插入不能靠下标派生身份）
//   · 档案 entry id —— 只作 before 游标用一次，对前端不透明（前端存着、原样回抄）

const TOOL_RESULT_KEEP = 50; // toolResult 首屏/实时帧只给前 N 字

/** 时间戳归一：内存消息给 number(ms)，档案 entry 给 ISO 字符串 */
function isoOf(v) {
  if (typeof v === "string") return v;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function safeJson(x) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return "[unserializable]";
  }
}

/** toolCall 参数 → 字符串。终稿给对象（pretty JSON）；流式在途块可能是半截 JSON 字符串
 *  （provider 边解析边吐，或 pi-ai 的内部 partialJson/partialArgs）→ 原样透传，
 *  这样"在途草稿 + 后续 delta 片段"能接得上；反正终稿会整条替换。 */
function argsText(x) {
  if (typeof x === "string") return x;
  if (typeof x?.partialJson === "string") return x.partialJson;
  if (typeof x?.partialArgs === "string") return x.partialArgs;
  return safeJson(x ?? {});
}

/** 一条消息的内容摊成纯文本（只留文本/图片占位；thinking/toolCall 走 blocks） */
function flattenText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const x of c) {
    if (!x || typeof x !== "object") continue;
    if (x.type === "text") parts.push(x.text ?? "");
    else if (x.type === "image") parts.push("[图片]");
  }
  return parts.join("\n");
}

/** 全角色 → 可渲染文本。多数角色有 content 数组（摊平）；
 *  bashExecution / *Summary 是扁平消息（无 content，字段即内容）。 */
function textOf(m) {
  switch (m?.role) {
    case "bashExecution":
      return m.output ?? "";
    case "branchSummary":
    case "compactionSummary":
      return m.summary ?? "";
    default:
      return flattenText(m);
  }
}

/** assistant content[] → 渲染块列表（ci = 下标，实时 delta 按 ci 入格） */
function blocksOf(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return null;
  const blocks = [];
  for (let ci = 0; ci < c.length; ci++) {
    const x = c[ci];
    if (!x || typeof x !== "object") continue;
    if (x.type === "text") blocks.push({ ci, type: "text", text: x.text ?? "" });
    else if (x.type === "thinking")
      blocks.push({ ci, type: "thinking", text: x.thinking ?? "", redacted: !!x.redacted });
    else if (x.type === "toolCall")
      blocks.push({ ci, type: "toolCall", id: x.id ?? "", name: x.name ?? "", args: argsText(x.arguments ?? x) });
    else blocks.push({ ci, type: x.type ?? "unknown", raw: safeJson(x) });
  }
  return blocks.length ? blocks : null;
}

/** assistant 用量元数据（档案自带）：挑最小集，剥 api/provider/diagnostics/responseId */
function usageOf(m) {
  const u = m?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    total: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
    cost: u.cost?.total ?? 0,
  };
}

/**
 * 一条消息 → 前端 Message（**不含 key**）。
 * 结构：{ role, ts, text } + 按角色的附加字段（与协议 Message 类型一字不差）。
 */
function rowOfMessage(m) {
  const role = m?.role ?? "unknown";
  const row = { role, ts: isoOf(m?.timestamp), text: textOf(m) };
  switch (role) {
    case "toolResult": {
      const full = row.text ?? "";
      if (full.length > TOOL_RESULT_KEEP) {
        row.text = full.slice(0, TOOL_RESULT_KEEP) + "…";
        row.truncated = true;
      }
      row.toolCallId = m.toolCallId ?? "";
      row.toolName = m.toolName;
      row.isError = m.isError;
      // subagent 的指针（白名单：只认 chamber 自己的 subagent 工具）。
      // 为什么不透传整个 details：details 是各工具的自留地（read/edit 塞文件清单、edit 塞 diff），
      // 全透传会把线帧撑大；这里只挑前端真用得上的三个字段。
      // 存在意义：① 工具卡片能渲染「打开 →」；② 档案里带着它 → 重连/翻页后卡片不丢。
      const sc = m.toolName === "subagent" ? m.details : null;
      if (sc?.childSessionId) {
        row.subagent = {
          childSessionId: sc.childSessionId,
          status: sc.status ?? null,
          usage: sc.usage ?? null,
        };
      }
      break;
    }
    case "bashExecution":
      row.command = m.command;
      row.exitCode = m.exitCode ?? null;
      row.cancelled = !!m.cancelled;
      row.truncated = !!m.truncated;
      break;
    case "custom":
      row.customType = m.customType;
      row.display = m.display;
      break;
    case "assistant": {
      const blocks = blocksOf(m);
      if (blocks) row.blocks = blocks;
      row.stopReason = m.stopReason;
      row.model = m.model ?? null;
      if (m.errorMessage) row.errorMessage = m.errorMessage; // 模型侧失败的红消息原因
      const usage = usageOf(m);
      if (usage) row.usage = usage;
      break;
    }
    default:
      break;
  }
  return row;
}

/** 在途草稿：agent.state.streamingMessage（**不在 state.messages 里**，SDK 只在 message_end 才入列）。
 *  首屏若发现有在途 assistant，就把它挂成 open 草稿 —— 否则切回正在跑的会话会一片空白，
 *  要干等 message_end 整条到（delta 有"只进草稿"守卫，不会替它兜底）。
 *  非 assistant 的在途消息忽略（user 消息出生即满，等 message_end 一步到位）。 */
function draftOf(message) {
  if (!message || message.role !== "assistant") return null;
  const row = rowOfMessage(message);
  if (!row.blocks) row.blocks = [];
  row.open = true;
  return row;
}

/** 档案 entry → 前端 Message（翻页用）。非消息行（header/session_info/model_change/custom/…）返回 null。
 *  compaction / branch_summary 是独立 entry（summary 在顶层）→ 投影成 *Summary 角色。 */
function rowOfEntry(entry) {
  if (!entry) return null;
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return {
      role: entry.type === "compaction" ? "compactionSummary" : "branchSummary",
      ts: isoOf(entry.timestamp),
      text: entry.summary ?? "",
    };
  }
  if (entry.type !== "message") return null;
  const row = rowOfMessage(entry.message);
  if (row.ts == null) row.ts = isoOf(entry.timestamp); // 老档案里消息可能没 timestamp，回退用 entry 的
  return row;
}

export { rowOfMessage, rowOfEntry, draftOf, isoOf, textOf };
export { TOOL_RESULT_KEEP };
