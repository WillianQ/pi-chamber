// ───────────────────── agent-service / index.js ─────────────────────
// Agent 域：Session 名册 + 焦点对话（重写版，协议以 PROTOCOL.new.md 为准）。
//
// 模块划分（本目录）：
//   index.js     本文件：sessions 活跃表 · 焦点指针(activeId) · 名册目录(cwd) · 事件桥 translate
//                · 生命周期 open/close/create/delete · prompt/abort 受理 · chat 首屏/翻页/补全
//   commands.js  / 命令域（BUILTINS + 四源清单）：闭合孤岛，不吃表不读焦点不摸 bus
//   messages.js  消息投影纯函数：SDK message / 档案 entry → 前端 Message（三个消费者共用）
//
// 领域模型（AGENTS.md 2.1 术语；代码侧直接借用 SDK 概念名）：
//   Agent（Space）= 一个 cwd 目录；Session = 该 agent 的一次出勤
//   档案（jsonl）是出勤记录（SessionManager 持久对象，1:1 一个 jsonl），AgentSession 是出勤运行时
//
// 服务端真值（三样，全在这里；别处不许另存）：
//   sessions  Map<sessionId, entry>   进程内活跃出勤；entry = { agentSession, sm, cwd, fallbackName,
//                                     unsubscribe, commandsPromise, lastActiveAt, autoNamed }
//                                     lastActiveAt = 最后一轮落定时刻（呆滞清理 sweepIdle 的唯一依据）
//   activeId  焦点 session（chat 帧只发它那一场；裸帧不带 sessionId 的根据）
//   cwd       当前名册目录（≠ 前端 selectedCwd；前端那个只在连接时采纳一次，之后是纯前端变量）
//
// 协议一览（详见 PROTOCOL.new.md 第 4 章）：
//   名册  agent.sessions.sync { agents, selectedCwd, sessions }      连接 / 换目录 推全量
//         agent.sessions.patch { agents?, rows? }                    其余所有名册变化（全员广播，不分焦点）
//   对话  agent.chat.sync { activeId, cwd, messages, before, commands, model,
//                           thinkingLevel, steers, info, status }    连接 / open 推全量；其余推局部
//         agent.chat.message { m, open? }                            整条消息（裸帧，只发焦点）
//         agent.chat.delta   { ci, k:"t"|"h"|"c", x, name? }         内容增量（裸帧，只发焦点；攒够 30 事件打包）
//         agent.chat.notice  { sessionId?, type, message, … }        错误 / 重试提示（不写 messages）
//   上行  agent.sessions.list{cwd} · agent.session.{open,close,create,delete,prompt,abort}   一律 emit，无回执
//         agent.chat.more_messages{sessionId,before} · agent.chat.toolResult{sessionId,toolCallId}   读数据用 request
//
// 三条铁律（踩过才知道）：
//   ① **行 status 一律走 sessions.patch**（open 也发）；任何 status 都现推（读 isCompacting/isStreaming），
//      不硬编码 —— compaction_end 那刻 isCompacting 已 false 但自动压缩发生在 run 中间，isStreaming 仍 true。
//   ② **每条上行帧都要有"结束帧"**：成功靠事件桥（agent_start/settled/queue_update/compaction_*），
//      失败/被拒由 handler 自己补推真值帧 + notice。否则前端 pending 永久卡住
//      （SDK 的 abort() 在空闲时不发 settled；open 档案不存在没有 sync；prompt 压缩中被拒不上事件桥）。
//   ③ **非焦点场不碰攒批装置**：deltaBuf 只服务 activeId 那条流；焦点一变立即清空。
//
// SDK 缺口记录（沿用上一版）：SessionManager（v0.84.4 含上游 main）无档案删除公共 API →
//   自己 unlink，白名单收敛在 unlinkSessionFile（只认 <agentDir>/sessions 内的 .jsonl）。

import { basename, join, resolve, sep } from "node:path";
import { unlink } from "node:fs/promises";
import {
  SessionManager,
  DefaultResourceLoader,
  ModelRuntime,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { BUILTINS, commandsOf } from "./commands.js";
import { rowOfMessage, rowOfEntry, draftOf, isoOf, textOf } from "./messages.js";
import { buildPluginTools, applyPluginActivation } from "./plugins/index.js";

/** 出勤表：进程内所有活跃出勤（已创建/已打开） */
const sessions = new Map(); // sessionId -> entry（见文件头）

let activeId = null; // 焦点 session：chat 帧只发它那一场
let cwd = null; // 当前名册目录（服务端变量）

// ───────────────────────── delta 攒批装置（服务端唯一的攒批） ─────────────────────────
// 攒的是「事件数」不是「字符数」：中英 token 粒度差太多，按字切会把英文单词拦腰截断。
// 只设下限（30 个事件）不设上限；块 *_end 的零头照发；message_end 兜底再发一次。
// state 是全局一份 —— 只服务 activeId 那条流（非焦点场在 message_update 就被挡回，根本进不来）。
const DELTA_MIN_EVENTS = 30;
let deltaBuf = ""; // 攒着的文本
let deltaCount = 0; // 攒了几个 delta 事件
let deltaCi = -1; // 攒的是哪个块（-1 = 空）
let deltaKind = null; // 攒的是哪类（t/h/c；同 ci 不会变，纯留档）

function clearDelta() {
  deltaBuf = "";
  deltaCount = 0;
  deltaCi = -1;
  deltaKind = null;
}

/** 改焦点：攒批装置随之清空（协议：activeId 变 → 整体清空） */
function setActive(id) {
  if (activeId !== id) {
    activeId = id;
    clearDelta();
  }
}

// ───────────────────────── 推送小工具 ─────────────────────────

const emit = (bus, name, payload) => bus.emit(name, payload, { net: true });

/** 名册增量：只带变化的字段（前端按 id / cwd 合并） */
function patchRows(bus, rows, agents) {
  if (!rows?.length && !agents?.length) return;
  emit(bus, "agent.sessions.patch", {
    ...(agents ? { agents } : {}),
    ...(rows?.length ? { rows } : {}),
  });
}

/** 对话增量：字段级替换（帧里出现的字段就是该字段的完整真值；不出现 = 前端不动） */
function chatSync(bus, patch) {
  emit(bus, "agent.chat.sync", patch);
}

function chatMessage(bus, payload) {
  emit(bus, "agent.chat.message", payload);
}

function notice(bus, payload) {
  emit(bus, "agent.chat.notice", payload);
}

// ───────────────────────── 状态 / 真值读取 ─────────────────────────

/** 行灯：现推（铁律 ①）。未在册 = offline（只有档案）。 */
function statusOf(entry) {
  if (!entry) return "offline";
  const s = entry.agentSession;
  try {
    if (s.isCompacting) return "compacting";
    if (s.isStreaming) return "running";
  } catch {
    /* getter 异常按 idle 处理（极罕见） */
  }
  return "idle";
}

/** info = getSessionStats() + getContextUsage() 投影（整场累计，含被压缩掉的历史） */
function infoOf(entry) {
  const s = entry.agentSession;
  try {
    const st = s.getSessionStats();
    const ctx = s.getContextUsage?.();
    return {
      input: st?.tokens?.input ?? 0,
      output: st?.tokens?.output ?? 0,
      cacheRead: st?.tokens?.cacheRead ?? 0,
      cacheWrite: st?.tokens?.cacheWrite ?? 0,
      cost: st?.cost ?? 0,
      contextTokens: ctx?.tokens ?? null,
      contextPercent: ctx?.percent ?? null,
      contextWindow: ctx?.contextWindow ?? 0,
    };
  } catch (err) {
    console.error(`[agent] info 读取失败: ${err?.message ?? err}`);
    return null;
  }
}

/** 活跃行（现查，不读盘）：messageCount 现算、updateTime 现给 */
function rowOf(entry) {
  const s = entry.agentSession;
  const stats = s.getSessionStats?.();
  return {
    id: s.sessionId,
    cwd: entry.cwd,
    name: s.sessionName ?? entry.fallbackName ?? "",
    status: statusOf(entry),
    messageCount: stats?.totalMessages ?? 0,
    updateTime: new Date().toISOString(),
    ...subagentFields(entry.parentPath, entry.parentId),
  };
}

/** 磁盘行的显示名：sessionName → 首条用户消息 → ""（前端再兜 shortId） */
function displayNameOf(info) {
  const n = (info?.name ?? "").trim();
  if (n) return n;
  const first = (info?.firstMessage ?? "").trim();
  return first && first !== "(no messages)" ? first : "";
}

// ───────── subagent 标记（名册行的两个附加字段） ─────────
// isSubAgent 的唯一来源 = **档案头的 parentSession**（pi 的官方字段，语义 = "本场派生自哪一场"）：
//   写在建场时（SessionManager.create 的 parentSession），读在 getHeader()/SessionInfo.parentSessionPath。
//   好处：重连、换目录（sync 整组替换）、chamber 重启 —— 全都丢不了，且零额外 IO（header 本来就要读）。
// parentId = "父是谁"（前端做缩进用）：尽力而为 —— 父是幽灵/已删时为 null，但 isSubAgent 仍为 true。
//   两字段恒出现（不省字节）：false / null 也是真值，省了反而让前端要区分 undefined 与 false。
function subagentFields(parentPath, parentId) {
  const isSubAgent = !!parentPath;
  return { isSubAgent, parentId: isSubAgent ? (parentId ?? null) : null };
}

/** 路径归一（仅用于"是不是同一个文件"的比较）：win/mac 不区分大小写。
 *  与 unlinkSessionFile 的白名单闸同口径 —— 两边必须一致，否则父子的路径对不上。 */
function foldPath(p) {
  const r = resolve(String(p ?? ""));
  return process.platform === "linux" ? r : r.toLowerCase();
}

/** 磁盘行（读盘）：档案在册但运行时可能不在 → status 现查活跃表。
 *  byPath = 本目录的 档案路径→sessionId 表（父的 sessionId 前端才知道怎么缩进）。 */
function rowOfInfo(info, byPath) {
  const live = sessions.get(info.id);
  const parentId = info.parentSessionPath ? (byPath?.get(foldPath(info.parentSessionPath)) ?? null) : null;
  return {
    id: info.id,
    cwd: info.cwd,
    name: displayNameOf(info),
    status: live ? statusOf(live) : "offline",
    messageCount: info.messageCount,
    updateTime: info.modified instanceof Date ? info.modified.toISOString() : String(info.modified ?? ""),
    ...subagentFields(info.parentSessionPath, parentId),
  };
}

/** agent 列表（cwd 聚合）：磁盘归档 + 内存幽灵补偿（幽灵还没落盘，不补计数就对不上行数） */
async function agentsSnapshot() {
  const infos = await SessionManager.listAll();
  const byCwd = new Map(); // cwd -> { cwd, basename, sessionCount, lastAt }
  const onDisk = new Set();
  const bump = (dir, at) => {
    const cur = byCwd.get(dir) ?? { cwd: dir, basename: basename(dir), sessionCount: 0, lastAt: 0 };
    cur.sessionCount += 1;
    cur.lastAt = Math.max(cur.lastAt, at);
    byCwd.set(dir, cur);
  };
  for (const info of infos) {
    onDisk.add(info.id);
    if (!info.cwd) continue; // 太老的档案没有 cwd 字段，无处归类
    bump(info.cwd, info.modified?.getTime?.() ?? 0);
  }
  for (const entry of sessions.values()) {
    if (!entry.cwd || onDisk.has(entry.agentSession.sessionId)) continue;
    bump(entry.cwd, Date.now());
  }
  return [...byCwd.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(({ cwd: dir, basename: base, sessionCount }) => ({ cwd: dir, basename: base, sessionCount }));
}

/** 某目录下的出勤史行（读盘；活跃场次的状态现查） */
async function rowsOfCwd(dir) {
  const infos = await SessionManager.list(dir);
  // 父子解析表：档案头里存的是**父的档案路径**，换成 sessionId（前端拿 id 做缩进）
  const byPath = new Map(infos.map((i) => [foldPath(i.path), i.id]));
  return infos.map((info) => rowOfInfo(info, byPath));
}

/** 连接 / 换目录：推名册全量（= 前端 sessions-store 数据组，键名一字不差）
 *  fallback=true（只在连接时）：cwd 为空或已失效（目录被删/首次启动）→ 落到"最近动过的 agent"。
 *  ★ 用户显式点名目录（agent.sessions.list）时**必须照单全收** —— 哪怕该目录还没有任何场次
 *    （他就是要去那儿新建 Session）。 */
async function pushSessionsSync(bus, { fallback = false } = {}) {
  const agents = await agentsSnapshot();
  if (fallback && (!cwd || !agents.some((a) => a.cwd === cwd))) cwd = agents[0]?.cwd ?? null;
  const rows = cwd ? await rowsOfCwd(cwd) : [];
  emit(bus, "agent.sessions.sync", { agents, selectedCwd: cwd, sessions: rows });
}

/** 翻页游标：上下文那份条目的第一条 → 它的 parentId 就是"再往前的下一站"。
 *  ★ 不用"getEntries() 里找它的前一条"：getEntries() 是文件行序，分叉档案会走到别的分支；
 *    parentId 天然沿当前分支回溯，且压缩后 compaction entry 的 parentId 正好 = 最后一条被压掉的条目。 */
function cursorOf(entry) {
  try {
    return entry.sm.buildContextEntries()?.[0]?.parentId ?? null;
  } catch (err) {
    console.error(`[agent] 游标计算失败 ${entry.cwd}: ${err?.message ?? err}`);
    return null;
  }
}

async function commandsOfSafe(entry) {
  try {
    return await commandsOf(entry);
  } catch (err) {
    console.error(`[agent] 命令清单构建失败 ${entry.cwd}: ${err?.message ?? err}`);
    return [];
  }
}

/** 对话全量：= 前端 chat-store 数据组。连接 / open / 焦点被清 都推它。
 *  在途草稿也要挂上（agent.state.streamingMessage 不在 state.messages 里，SDK 只在 message_end 才入列）
 *  —— 否则切回正在跑的会话会一片空白，要干等 message_end。 */
async function pushChatFull(bus) {
  const entry = activeId ? sessions.get(activeId) : null;
  if (!entry) {
    chatSync(bus, {
      activeId: null,
      cwd: null,
      messages: [],
      before: null,
      commands: [],
      model: null,
      thinkingLevel: null,
      steers: [],
      info: null,
      status: "idle",
    });
    return;
  }
  const s = entry.agentSession;
  const messages = s.messages.map(rowOfMessage);
  const draft = draftOf(s.state?.streamingMessage);
  if (draft) messages.push(draft);
  chatSync(bus, {
    activeId,
    cwd: entry.cwd,
    messages,
    before: cursorOf(entry),
    commands: await commandsOfSafe(entry),
    model: s.model?.id ?? null,
    thinkingLevel: s.thinkingLevel ?? null,
    steers: [...s.getSteeringMessages()],
    info: infoOf(entry),
    status: statusOf(entry),
  });
}

/** 焦点真值帧：命令改状态（/model /level）不进订阅桥、abort 空闲不发 settled、
 *  prompt 被拒不上事件桥 —— 这些路都得由 handler 主动补一发真值（顺带刷命令清单）。
 *  ★ 一律不外抛（调用方多在 catch/finally 里，再抛就是未处理 rejection）。 */
async function refreshFocus(bus, entry) {
  if (!entry) return;
  try {
    if (entry.agentSession.sessionId === activeId) {
      const s = entry.agentSession;
      chatSync(bus, {
        status: statusOf(entry),
        info: infoOf(entry),
        model: s.model?.id ?? null,
        thinkingLevel: s.thinkingLevel ?? null,
        steers: [...s.getSteeringMessages()],
        commands: await commandsOfSafe(entry),
      });
    }
    patchRows(bus, [rowOf(entry)]);
  } catch (err) {
    console.error(`[agent] 焦点真值帧失败: ${err?.message ?? err}`);
  }
}

// ───────────────────────── 事件桥：SDK 事件 → 线帧 ─────────────────────────

/** 本场首条用户消息 → 自动命名（一次即封口，见 message_start 分支的 entry.autoNamed）。
 *  走 SDK 的 setSessionName（= 内置 /name 同一个入口）：追加一条 session_info entry + emit
 *  session_info_changed → 事件桥 patchRows{name}（链路现成，无新帧）。
 *  ★ 幽灵不因此提前落盘：_persist 在 hasAssistant 为 false 时只排队不写文件，等首条 assistant 一起写。
 *  名字 = 首句压平 + 截断；不引模型生成标题（成本/延迟/额外 key，pi 自己也拿首条消息兜底）。 */
const AUTO_NAME_MAX = 24;
function autoName(entry, m) {
  const s = entry.agentSession;
  try {
    if (s.sessionName) return; // 已有名（用户先 /name 过 ‖ 旧档案带名）→ 不动
    const name = textOf(m).replace(/\s+/g, " ").trim().slice(0, AUTO_NAME_MAX);
    if (!name) return; // 空白/纯图片 → 弃权（标记已封口，下条不再试：行为可预测）
    s.setSessionName(name);
  } catch (err) {
    console.error(`[agent] 自动命名失败 ${entry.agentSession.sessionId}: ${err?.message ?? err}`);
  }
}
// 二分法：名册（sessions.patch，全员广播，后台出勤的灯也要动）/ 对话（chat.*，只发 activeId 那一场）。
// 其余 SDK 事件（turn_*/agent_end/tool_execution_*/entry_appended/summarization_retry_*）就地毙。

function translate(bus, entry, type, data) {
  const id = entry.agentSession.sessionId;
  const focal = id === activeId; // 对话帧的闸门

  // ── 名册帧（不分焦点）──
  if (type === "agent_start") {
    patchRows(bus, [{ id, status: statusOf(entry) }]);
    if (focal) chatSync(bus, { status: statusOf(entry) });
    return;
  }
  if (type === "agent_settled") {
    // 一轮落定 = 这个运行时最后一次“有动静”的时刻（sweepIdle 据此计时；run 中间由 isStreaming 兜着）
    entry.lastActiveAt = Date.now();
    patchRows(bus, [rowOf(entry)]); // 整轮落定：条数 / 时间 / 灯一次给全
    if (focal) chatSync(bus, { status: statusOf(entry), info: infoOf(entry) });
    return;
  }
  if (type === "session_info_changed") {
    patchRows(bus, [{ id, name: data.name ?? entry.fallbackName ?? "" }]);
    return;
  }
  if (type === "queue_update") {
    if (focal)
      chatSync(bus, { steers: [...(data.steering ?? [])], status: statusOf(entry) }); // 顺带给 status：清 pending 用
    return;
  }
  if (type === "thinking_level_changed") {
    if (focal) chatSync(bus, { thinkingLevel: data.level ?? null });
    return;
  }
  if (type === "auto_retry_start") {
    if (focal)
      notice(bus, {
        sessionId: id,
        type: "retry",
        phase: "start",
        message: data.errorMessage ?? "",
        attempt: data.attempt,
        maxAttempts: data.maxAttempts,
      });
    return;
  }
  if (type === "auto_retry_end") {
    if (focal)
      notice(bus, {
        sessionId: id,
        type: "retry",
        phase: "end",
        success: !!data.success,
        message: data.finalError ?? "",
        attempt: data.attempt,
      });
    return;
  }

  // ── 压缩（手动 /compact ‖ 自动阈值 ‖ 分支总结）──
  // SDK 不走 message 流，只发 compaction_*：前端复用「草稿 → 终稿」——start 插占位行，end 用 summary 替换。
  // 成败都必到一次 end（失败 result 缺、errorMessage 有）。status 一律现推（见铁律 ①）。
  if (type === "compaction_start" || type === "compaction_end") {
    if (focal) clearDelta(); // 非焦点场不碰攒批装置（只服务焦点那条流）
    if (type === "compaction_start") {
      patchRows(bus, [{ id, status: statusOf(entry) }]);
      if (!focal) return;
      chatSync(bus, { status: statusOf(entry) });
      chatMessage(bus, {
        m: { role: "compactionSummary", ts: new Date().toISOString(), text: "", blocks: [] },
        open: true,
      });
      return;
    }
    patchRows(bus, [rowOf(entry)]);
    if (!focal) return;
    const ok = !!data.result?.summary;
    chatMessage(bus, {
      m: {
        role: "compactionSummary",
        ts: new Date().toISOString(),
        text: ok ? data.result.summary : data.errorMessage ?? "压缩未完成",
        ...(ok ? {} : { error: true }),
      },
    });
    chatSync(bus, { status: statusOf(entry), info: infoOf(entry) });
    return;
  }

  // ── 内容流（只发焦点；裸帧不带 sessionId）──
  if (type === "message_start") {
    // 首条用户消息 → 自动命名（不分焦点：后台出勤的灯/名也要对）；一次即封口
    if (data.message?.role === "user" && !entry.autoNamed) {
      entry.autoNamed = true;
      autoName(entry, data.message);
    }
    if (!focal) return; // 非焦点场连攒批装置都不碰（否则会冲掉焦点场的零头）
    clearDelta();
    const m = data.message;
    if (m?.role !== "assistant") return; // user/toolResult 出生即满 → 等 message_end 一步到位
    chatMessage(bus, {
      m: { role: "assistant", ts: isoOf(m.timestamp) ?? new Date().toISOString(), text: "", blocks: [] },
      open: true,
    });
    return;
  }

  if (type === "message_update") {
    if (!focal) return;
    const ev = data.assistantMessageEvent; // 外层 message / 内层 partial 两个全量快照胖子，丢在这（O(n²) 主凶）
    const t = ev?.type ?? "";
    const ci = ev?.contentIndex ?? 0;
    const k = t.startsWith("text_") ? "t" : t.startsWith("thinking_") ? "h" : t.startsWith("toolcall_") ? "c" : null;
    if (!k) return; // start/done/error 等其余形态不上线

    if (t === "toolcall_start") {
      // 块声明：名字只说一次（可能为空串 —— OpenAI 系在 name 之前就 push 了 start；前端等后续 delta 补）
      if (deltaCi !== -1 && deltaCi !== ci) clearDelta(); // 上一个块没关门（协议违背）→ 旧串丢弃
      const name = ev.partial?.content?.[ci]?.name ?? "";
      emit(bus, "agent.chat.delta", { ci, k: "c", x: "", ...(name ? { name } : {}) });
      return;
    }

    if (t.endsWith("_delta")) {
      if (deltaCi !== ci) {
        clearDelta(); // 块号变了又没见 *_end（协议违背）→ 旧串丢弃（message_end 帧带全文兜底）
        deltaCi = ci;
        deltaKind = k;
      }
      deltaBuf += ev.delta || "";
      deltaCount += 1;
      if (deltaCount >= DELTA_MIN_EVENTS) {
        emit(bus, "agent.chat.delta", { ci, k, x: deltaBuf });
        deltaBuf = "";
        deltaCount = 0;
      }
      return;
    }

    if (t.endsWith("_end")) {
      // 块关门：零头照发（不够 30 也发）
      if (deltaBuf && deltaCi === ci) emit(bus, "agent.chat.delta", { ci, k, x: deltaBuf });
      clearDelta();
      return;
    }
    return;
  }

  if (type === "message_end") {
    if (!focal) return;
    if (deltaBuf && deltaCi !== -1) emit(bus, "agent.chat.delta", { ci: deltaCi, k: deltaKind, x: deltaBuf });
    clearDelta();
    const row = rowOfMessage(data.message);
    if (!row?.role || row.role === "unknown") return;
    chatMessage(bus, { m: row }); // 权威终稿：assistant 整条替换草稿；其余角色建+敲一步到位
    return;
  }

  // 其余：白名单外，静默（turn_*/agent_end/tool_execution_* 等全是 message_end 已发过的重复品）
}

// ───────────────────────── 运行时装配 ─────────────────────────

let modelRuntimePromise = null; // ModelRuntime 进程级共享单例（懒加载，失败可重试）
function sharedModelRuntime() {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create({ agentDir: getAgentDir() }).catch((err) => {
      modelRuntimePromise = null;
      throw err;
    });
    console.log("[agent] ModelRuntime 初始化中…（读 auth.json/models.json）");
  }
  return modelRuntimePromise;
}

/** 插件 ctx 的统一构造（建场与 /reload 重算共用一套）。
 *  ★ getSession 是晚绑取值器：建场时本场的 AgentSession 还没造出来。 */
function pluginCtx(bus, { cwd, depth, modelRuntime, getSession }) {
  return {
    bus,
    cwd,
    depth,
    modelRuntime,
    getSession,
    // ★ 必须绑 bus：spawnSession 的签名是 (bus, opts)，不绑就会把 opts 当成 bus 传进去
    spawnSession: (opts) => spawnSession(bus, opts),
    closeChild: (id) => closeChild(bus, id),
  };
}

/** 给一个 SessionManager（档案对象）配齐运行时并登记进表；bus 显式传入（事件桥要把 SDK 动静推给前端） */
async function attachSession(sm, bus, { fallbackName = "", parentId = null, depth = 0, model, thinkingLevel } = {}) {
  const absCwd = sm.getCwd();
  const sessionId = sm.getSessionId();
  // subagent 标记的**唯一来源**：档案头里的 parentSession。从档案读、不从参数传 ——
  // 这样「新建」与「从档案打开」两条路天然一致，不会有一边忘了传。
  const parentPath = sm.getHeader()?.parentSession ?? null;

  const resourceLoader = new DefaultResourceLoader({ cwd: absCwd, agentDir: getAgentDir() });
  await resourceLoader.reload(); // 扫该 agent 的扩展 / skills / prompts

  const modelRuntime = await sharedModelRuntime();

  // 插件：按 <cwd>/.pi/pi-chamber.json 决定**注册什么、激活什么**（见 plugins/index.js）。
  // ★ 晚绑：插件要在 execute 时读“本场”的模型/思考等级（用来继承给子场），但那会儿 session 还没造出来
  //   → 给一个 getSession() 取值器，建好之后回填（见下面的 self）。
  let self = null;
  const ctxOf = () => pluginCtx(bus, { cwd: absCwd, depth, modelRuntime, getSession: () => self });
  const { tools: customTools, excluded, active } = await buildPluginTools(ctxOf());

  const { session } = await createAgentSession({
    cwd: absCwd,
    agentDir: getAgentDir(),
    sessionManager: sm,
    resourceLoader,
    modelRuntime,
    customTools,
    // 插件自己 decline（如 subagent 深度到顶）→ 连同名扩展工具一起挡掉，
    // 否则 agent 目录里装了个同名扩展就能绕过插件的闸
    ...(excluded.length ? { excludeTools: excluded } : {}),
    // 子场继承父场的脑子（由插件在派单时显式传入）；普通建场不传 → 走 SDK 默认 / 档案恢复
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  self = session;
  // ★ 构造时 customTools 会被**全部激活** → 立刻按配置收敛一次。
  //   “开关”是**激活**不是注册（恒注册）—— 这才使得 /reload 能热更开关，不用重开会话。
  applyPluginActivation(session, active);

  const entry = {
    agentSession: session,
    sm,
    cwd: absCwd,
    fallbackName, // 名字被清空时的兜底（= 档案首条用户消息）
    autoNamed: false, // 本场是否已跑过自动命名（首条用户消息一次即封口，见 autoName）
    unsubscribe: null,
    commandsPromise: null, // / 命令清单懒建缓存（/reload 时作废）
    lastActiveAt: Date.now(), // 呆滞判定基准（见 sweepIdle）：建场时算一次，每轮落定（agent_settled）再刷
    parentPath, // 档案头里的 parentSession（持久）：非空 = 本场是 subagent
    parentId, // 父的 sessionId（尽力而为：父是幽灵/已删时为 null）
    // /reload 之后重读 <cwd>/.pi/pi-chamber.json 并重新收敛插件开关。
    // 挂在 entry 上给命令域调（命令域保持孤岛：只调 entry 上的函数，不 import 本文件）。
    reapplyPlugins: async () => applyPluginActivation(session, (await buildPluginTools(ctxOf())).active),
  };
  entry.unsubscribe = session.subscribe((evt) => {
    const { type, ...data } = evt;
    try {
      translate(bus, entry, type, data ?? {});
    } catch (err) {
      console.error(`[agent] 事件桥异常 ${sessionId} ${type}: ${err?.message ?? err}`);
    }
  });
  await session.bindExtensions({});
  sessions.set(sessionId, entry);
  return entry;
}

/** 摘表 + 退订（焦点随主人走） */
function takeSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  sessions.delete(sessionId);
  if (activeId === sessionId) setActive(null);
  entry.unsubscribe?.(); // 先退订：dispose 的善后事件不再外推
  clearDelta();
  return entry;
}

/** 删档案文件（本项目唯一裸碰 fs 的写侧）。硬闸两道：① 必须是 <agentDir>/sessions 内的 .jsonl；
 *  ② fs.unlink 绝不递归、绝不碰目录。文件已不在（幽灵/并发删）视为成功。 */
async function unlinkSessionFile(file, key) {
  const real = resolve(String(file ?? ""));
  const root = foldPath(join(getAgentDir(), "sessions")) + sep;
  if (!real.endsWith(".jsonl") || !foldPath(real).startsWith(root)) {
    throw new Error(`拒绝删除可疑档案路径（不在 sessions 目录内）: ${file}`);
  }
  try {
    await unlink(real);
  } catch (err) {
    if (err?.code === "ENOENT") return; // 已经不在了 → 目标达成
    throw new Error(`档案删除失败 ${key}: ${err?.message ?? err}`);
  }
}

// ───────────────────────── 生命周期原语：建场 / 置焦 ─────────────────────────
// 「建」与「上工」是两个关注点，拆开才好让别的调用方各取所需：
//   createSession（用户新建） = spawnSession + focusSession
//   openSession（用户打开）   = （找/建运行时）+ focusSession
//   subagent（后台派单）      = 只 spawnSession —— **不抢焦点、不动名册目录**

/** 原语①：建一份出勤（登记名册；不置焦、不动名册目录）。
 *  失败一律 throw（调用方决定吞成 notice 还是转成工具错误），半成品不泄漏。 */
async function spawnSession(bus, { cwd: cwdArg, fallbackName = "", parentPath = null, parentId = null, depth = 0, model, thinkingLevel } = {}) {
  const absCwd = resolve(String(cwdArg ?? "").trim());
  if (!absCwd) throw new Error("cwd 必填");

  // parentPath 非空 = 本场是 subagent：写进档案头（pi 官方字段，语义 = "本场派生自哪一场"）
  // → isSubAgent 天然持久（重连 / 换目录 / 重启都不丢）
  const sm = SessionManager.create(absCwd, undefined, parentPath ? { parentSession: parentPath } : undefined);
  let entry = null;
  try {
    entry = await attachSession(sm, bus, { fallbackName, parentId, depth, model, thinkingLevel });
    // 插行 + agents 计数：新场是幽灵（还没落盘），rowsOfCwd 读不到它，必须显式补这一行
    patchRows(bus, [rowOf(entry)], await agentsSnapshot());
    return entry;
  } catch (err) {
    // attachSession 成功但推帧炸了 → 表里留一个没人管的运行时（看不见、关不掉）→ 摘表 + dispose
    if (entry) {
      takeSession(entry.agentSession.sessionId);
      entry.agentSession.dispose();
    }
    throw err;
  }
}

/** 原语②：置焦（名册目录跟着焦点走 + 发行灯 + 推对话全量）。
 *  ★ 顺序硬约束：换目录时 sync 必须在前、patch 必须在后 ——
 *    sync 是「整组替换」而 patch 是「合并」，反了的话刚建好的幽灵行会被 sync 冲掉。 */
async function focusSession(bus, entry) {
  const key = entry.agentSession.sessionId;
  setActive(key);
  if (cwd !== entry.cwd) {
    // 焦点跨了目录（今天打不到：前端名册只含 selectedCwd 的行；但一旦有别的入口，
    // 不跟着换就会出现「sessions-store 说 A、chat-store 说 B」的两 store 打架）
    cwd = entry.cwd;
    await pushSessionsSync(bus);
  }
  patchRows(bus, [rowOf(entry)]); // ★ open 也要发行灯（行 status 一律走 patch）
  await pushChatFull(bus);
}

// ───────────────────────── 生命周期：open / close / create / delete ─────────────────────────

/** 打开（或切到）一个出勤：档案 → 运行时（幂等）；置焦 → 推名册行 + chat 全量 */
async function openSession(sessionId, bus) {
  const key = String(sessionId ?? "").trim();
  if (!key) return;
  try {
    let entry = sessions.get(key);
    if (!entry) {
      const infos = await SessionManager.listAll();
      const info = infos.find((s) => s.id === key);
      if (!info) {
        // 档案不存在：补真值帧（清 pending）+ 提示（**不动当前 chat**）
        patchRows(bus, [{ id: key, status: "offline" }]);
        notice(bus, { sessionId: key, type: "error", message: `Session 不存在: ${key}` });
        console.log(`[agent] open 失败：档案不存在 ${key}`);
        return;
      }
      // 父的 sessionId 要现查（档案头里存的是父的**路径**）—— listAll 已拿全，顺手建表
      const byPath = new Map(infos.map((i) => [foldPath(i.path), i.id]));
      const sm = SessionManager.open(info.path);
      entry = await attachSession(sm, bus, {
        fallbackName: displayNameOf(info),
        parentId: info.parentSessionPath ? (byPath.get(foldPath(info.parentSessionPath)) ?? null) : null,
      });
    }
    await focusSession(bus, entry);
    console.log(`[agent] Session 已打开 ${key} @ ${entry.cwd}${entry.agentSession.isStreaming ? "（正在跑）" : ""}`);
  } catch (err) {
    // 建运行时/读档案炸了：也必须留帧，否则前端那一行永久 pending
    console.error(`[agent] open 异常 ${key}: ${err?.message ?? err}`);
    patchRows(bus, [{ id: key, status: sessions.has(key) ? statusOf(sessions.get(key)) : "offline" }]);
    notice(bus, { sessionId: key, type: "error", message: `打开失败: ${err?.message ?? err}` });
  }
}

/** 收工：释放运行时、保留档案 */
async function closeSession(sessionId, bus) {
  const key = String(sessionId ?? "").trim();
  if (!key) return;
  const entry = sessions.get(key);
  if (!entry) {
    patchRows(bus, [{ id: key, status: "offline" }]);
    notice(bus, { sessionId: key, type: "error", message: `Session 未打开: ${key}` });
    return;
  }
  const wasFocal = activeId === key;
  takeSession(key);
  entry.agentSession.dispose();
  patchRows(bus, [{ id: key, status: "offline" }]);
  if (wasFocal) await pushChatFull(bus); // 焦点被清 → 前端整组清空
  console.log(`[agent] Session ${key} 已收工（运行时释放，档案保留）`);
}

/** subagent 用完即收工（释放运行时；**档案保留** → 名册行转 offline，随时可点开回看）。
 *  ★ 焦点豁免：人正看着它就不动 —— 收了会把前端正在读的对话清空（与 sweepIdle 同款规矩）；
 *    那种情况留给呆滞清理，人一切走焦点就自然纳入。
 *  ★ 不抛：收工失败不能把工具的结果弄丢（账都算完了）。 */
async function closeChild(bus, sessionId) {
  const key = String(sessionId ?? "").trim();
  if (!key || key === activeId || !sessions.has(key)) return false;
  try {
    await closeSession(key, bus);
    return true;
  } catch (err) {
    console.error(`[agent] subagent 收工失败 ${key}: ${err?.message ?? err}`);
    return false;
  }
}

/** 新建出勤（幽灵，惰性落盘）：建场 + 置焦（= spawnSession + focusSession）。
 *  建到别的目录时，名册目录由 focusSession 跟着焦点切过去。 */
async function createSession(cwdArg, bus) {
  try {
    const entry = await spawnSession(bus, { cwd: cwdArg });
    await focusSession(bus, entry);
    console.log(`[agent] Session 已创建 ${entry.agentSession.sessionId} @ ${entry.cwd}（档案惰性落盘，等首次回复写盘）`);
  } catch (err) {
    // 此刻可能还没有 id（也就没有行）——前端清的是「新建」按钮的 loading，所以 notice 够了
    console.error(`[agent] create 异常 ${cwdArg}: ${err?.message ?? err}`);
    notice(bus, { type: "error", message: `新建 Session 失败: ${err?.message ?? err}` });
  }
}

/** 销毁：释放运行时（在册时）+ 删档案（永久） */
async function deleteSession(sessionId, bus) {
  const key = String(sessionId ?? "").trim();
  if (!key) return;
  const entry = sessions.get(key);
  const wasFocal = activeId === key;
  if (entry) {
    takeSession(key);
    entry.agentSession.dispose();
  }
  const info = (await SessionManager.listAll()).find((s) => s.id === key);
  if (info) {
    try {
      await unlinkSessionFile(info.path, key);
    } catch (err) {
      notice(bus, { sessionId: key, type: "error", message: String(err?.message ?? err) });
      patchRows(bus, [{ id: key, status: "offline" }]); // 档案还在：真值帧照推（清 pending）
      return;
    }
  }
  if (wasFocal) await pushChatFull(bus);
  patchRows(bus, [{ id: key, deleted: true }], await agentsSnapshot());
  if (!entry && !info) notice(bus, { sessionId: key, type: "error", message: `Session 不存在: ${key}` });
  console.log(`[agent] Session ${key} 已销毁（${info ? "运行时 + 档案" : "幽灵，无档案"}）`);
}

// ───────────────────────── 呆滞清理：后台定时收工 ─────────────────────────
// 只在 **agent_settled** 打点（见 translate），不在每个事件上刷：跑着的场次由 isStreaming 兜着
// （绝不打断正在干活的），要回收的就是"跑完了、人也不动了"那群。
// 焦点豁免：activeId 那一场永不回收（人正看着它，收了 = 聊天区被清空）。
// 不用 SDK 现成的 SessionInfo.modified：那是读盘算出来的（listAll 会逐个 jsonl 全量流式扫），
// 且只在消息落盘时才前进 —— 长时间跑 toolCall 中途不动，会把在跑的场次误判成呆滞。
const SWEEP_EVERY_MS = 2 * 60 * 1000; // 扫描周期
const IDLE_LIMIT_MS = 20 * 60 * 1000; // 呆滞阈值（超时就收工：释放运行时，档案保留）
let sweeper = null;

/** 扫一遍活跃表：不忙 + 呆滞超阈 → 当收工处理（焦点那一个永不回收：人正开着看，收了会清场） */
async function sweepIdle(bus) {
  const now = Date.now();
  for (const id of [...sessions.keys()]) {
    const entry = sessions.get(id); // 快照可能已过期（上一轮刚被收掉）：逐个现查
    if (!entry) continue;
    // 焦点豁免：activeId 那一场是用户当前正看着的（前端 chat 就挂着它），
    // 收了会把人正在读的对话清空 —— 再久也不动它，切走焦点后才重新纳入清理。
    if (id === activeId) continue;
    let busy = false;
    try {
      busy = !!(entry.agentSession.isStreaming || entry.agentSession.isCompacting);
    } catch {
      /* getter 异常按不忙处理（极罕见） */
    }
    if (busy) continue; // 在跑的一律不碰
    const idle = now - (entry.lastActiveAt ?? now);
    if (idle < IDLE_LIMIT_MS) continue;
    console.log(`[agent] 呆滞 ${Math.round(idle / 60000)} 分钟 → 自动收工 ${id}`);
    try {
      await closeSession(id, bus);
    } catch (err) {
      console.error(`[agent] 呆滞清理异常 ${id}: ${err?.message ?? err}`);
    }
  }
}

/** 启动呆滞清理（installAgentService 调一次）。unref：不让这个定时器拖住进程退出 */
function startIdleSweeper(bus) {
  if (sweeper) return;
  sweeper = setInterval(() => void sweepIdle(bus), SWEEP_EVERY_MS);
  sweeper.unref?.();
}

// ───────────────────────── prompt / abort ─────────────────────────

function truncateText(s, n = 60) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 内置命令识别：/名 [参数] 全串匹配（名不含空白；参数 = 名字后的全部，可含空白与 /）。
 *  口径对齐 SDK 的 _tryExecuteExtensionCommand / _expandSkillCommand（都只切第一个空格）。
 *  未命中 → null（原样下传：扩展命令 /skill:x /模板 由 SDK 内部自动处理，未知命令当普通文本发给模型）。 */
const BUILTIN_RE = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
function builtinOf(text) {
  const m = BUILTIN_RE.exec(String(text ?? "").trim());
  if (!m || !BUILTINS[m[1]]) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/** 受理 prompt（emit，无回执）：命令就地执行 / 空闲起一轮 / busy 插队。
 *  忙闲唯一判据 = agentSession.isStreaming（SDK 真值，不另存状态）。
 *  ★ 命令一律不挡忙（学 pi TUI）：分诊必须在 isStreaming 分叉之前，否则一忙就永远跑不了。 */
async function promptSession(sessionId, text, bus) {
  const key = String(sessionId ?? "").trim();
  const entry = sessions.get(key);
  if (!entry || typeof text !== "string" || !text.trim()) {
    notice(bus, { sessionId: key, type: "error", message: entry ? "内容为空" : `Session 未打开: ${key}` });
    if (entry) refreshFocus(bus, entry);
    return;
  }

  const hit = builtinOf(text);
  if (hit) {
    // 命令：不起 run、不产生用户消息、不进 transcript；受理即回（/compact 跑几十秒不能卡输入框）
    console.log(`[agent] 命令受理 ${key}: /${hit.name}`);
    BUILTINS[hit.name]
      .run(entry, hit.args, bus)
      .then((res) => {
        // run 可返回 { notice }（目前只有 /reload）：本文件是碰总线的唯一出口，命令体保持纯数据
        if (res?.notice) notice(bus, { sessionId: key, ...res.notice });
      })
      .catch((err) => {
        // 命令自身失败（未知模型 / 参数错 / 没得压缩）：只弹错，不灭 busy（它本就不起 run）
        console.error(`[agent] 命令 /${hit.name} 失败 ${key}: ${err?.message ?? err}`);
        notice(bus, { sessionId: key, type: "error", message: String(err?.message ?? err) });
      })
      .finally(() => {
        // ★ 唯一刷新点：/model /level /name 改的是 SDK 内部状态，不进 session.subscribe 桥
        void refreshFocus(bus, entry);
      });
    return;
  }

  if (entry.agentSession.isStreaming) {
    console.log(`[agent] steer 受理 ${key}: “${truncateText(text)}”（等当前 toolCall 收尾后投递）`);
    entry.agentSession.steer(text).catch((err) => {
      // 插队被拒（压缩 / 重试临界等）或扩展命令（SDK 不给插队）：run 还在跑，只弹错 + 补真值帧
      console.error(`[agent] steer 失败 ${key}: ${err?.message ?? err}`);
      notice(bus, { sessionId: key, type: "error", message: String(err?.message ?? err) });
      void refreshFocus(bus, entry);
    });
    return;
  }

  console.log(`[agent] prompt 受理 ${key}: “${truncateText(text)}”`);
  entry.agentSession.prompt(text).catch((err) => {
    // 没起跑就炸（无 key / 没选模型 / 压缩中 / 被抢先）→ 补真值帧（清 pending）+ 弹错
    console.error(`[agent] prompt 失败 ${key}: ${err?.message ?? err}`);
    notice(bus, { sessionId: key, type: "error", message: String(err?.message ?? err) });
    void refreshFocus(bus, entry);
  });
}

/** 停止当前轮：clearQueue（未投递插队回收，自带 queue_update）+ abort 到 idle；幂等。
 *  ★ SDK 的 abort() 在空闲时不发 settled → 末尾必须自己补一发真值帧（否则前端 pending 卡死）。 */
async function abortSession(sessionId, bus) {
  const key = String(sessionId ?? "").trim();
  const entry = sessions.get(key);
  if (!entry) {
    patchRows(bus, [{ id: key, status: "offline" }]);
    notice(bus, { sessionId: key, type: "error", message: `Session 未打开: ${key}` });
    return;
  }
  try {
    const queued = entry.agentSession.clearQueue();
    const n = (queued?.steering?.length ?? 0) + (queued?.followUp?.length ?? 0);
    console.log(`[agent] abort 受理 ${key}${n ? `（回收未投递 ${n} 条）` : ""}`);
    await entry.agentSession.abort();
  } catch (err) {
    console.error(`[agent] abort 失败 ${key}: ${err?.message ?? err}`);
    notice(bus, { sessionId: key, type: "error", message: String(err?.message ?? err) });
  }
  await refreshFocus(bus, entry);
}

// ───────────────────────── 读出勤历史：翻页 / toolResult 补全 ─────────────────────────

const PAGE_SIZE = 20; // 一页 20 条（只数"能投影成消息"的条目）

/** 向前翻一页：从 before 那条（含）沿 parentId 回溯，最多 20 条消息类条目。
 *  回执 before = 下一站的游标（到头 null）。非消息行（header/session_info/model_change/custom…）跳过。 */
async function moreMessages(sessionId, before) {
  const entry = sessions.get(String(sessionId ?? "").trim());
  if (!entry) throw new Error(`Session 未打开: ${sessionId}`);
  const byId = new Map(entry.sm.getEntries().map((e) => [e.id, e]));
  const out = [];
  let cur = before ? byId.get(String(before)) : null;
  let guard = 0;
  while (cur && out.length < PAGE_SIZE && guard++ < 20000) {
    const row = rowOfEntry(cur);
    if (row) out.unshift(row);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return { messages: out, before: cur?.id ?? null };
}

/** 补全一条被裁的 toolResult：直接翻档案按 toolCallId 找全文（内存对象，零 IO） */
async function toolResultText(sessionId, toolCallId) {
  const entry = sessions.get(String(sessionId ?? "").trim());
  if (!entry) throw new Error(`Session 未打开: ${sessionId}`);
  for (const e of entry.sm.getEntries()) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m?.role === "toolResult" && m.toolCallId === toolCallId) return { text: textOf(m) };
  }
  return { text: null };
}

// ───────────────────────── 挂到 bus ─────────────────────────

/** 事件型 handler 必须自己兜住 rejection：bus 的 dispatch 只 catch 同步异常，
 *  未处理的 reject 在 Node 会直接把进程掀了。 */
function safeOn(bus, event, fn) {
  bus.on(event, (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => console.error(`[agent] handler ${event} 异常: ${err?.message ?? err}`))
  );
}

export function installAgentService(bus) {
  // 连接建立 → 名册全量 + 对话全量（恢复现场靠推不靠拉；重连与首连同一条路，幂等）
  safeOn(bus, "$conn.open", async () => {
    await pushSessionsSync(bus, { fallback: true });
    await pushChatFull(bus);
  });

  // 换目录（Agent 下拉）：只改名册目录 + 推名册全量，不动 activeId、不切焦点
  safeOn(bus, "agent.sessions.list", async (p) => {
    const abs = String(p?.cwd ?? "").trim();
    cwd = abs ? resolve(abs) : null;
    await pushSessionsSync(bus);
  });

  // 生命周期（一律 emit，无回执）
  safeOn(bus, "agent.session.open", (p, _m, b) => openSession(p?.sessionId, b ?? bus));
  safeOn(bus, "agent.session.close", (p, _m, b) => closeSession(p?.sessionId, b ?? bus));
  safeOn(bus, "agent.session.create", (p, _m, b) => createSession(p?.cwd, b ?? bus));
  safeOn(bus, "agent.session.delete", (p, _m, b) => deleteSession(p?.sessionId, b ?? bus));
  safeOn(bus, "agent.session.prompt", (p, _m, b) => promptSession(p?.sessionId, p?.text, b ?? bus));
  safeOn(bus, "agent.session.abort", (p, _m, b) => abortSession(p?.sessionId, b ?? bus));

  // 读数据走 request：失败要让回执 ok:false，所以**不能**套 safeOn（会把错误吞成空回执）
  bus.on("agent.chat.more_messages", (p) => moreMessages(p?.sessionId, p?.before));
  bus.on("agent.chat.toolResult", (p) => toolResultText(p?.sessionId, p?.toolCallId));

  // 呆滞清理：每 2 分钟扫一次，不忙且超 20 分钟没收工的场次自动收工（档案保留；焦点那场豁免）
  startIdleSweeper(bus);
}
