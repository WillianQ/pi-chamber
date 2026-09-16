// ───────────────────── agent-service / plugins / subagent.js ─────────────────────
// subagent 插件：把「派一份新出勤」做成一个真 Session（而不是 spawn 一个子进程）。
//
// 为什么这么做（对比 pi 生态现成的 subagent 扩展）：
//   官方例子 spawn `pi --mode json` 子进程 —— 子 agent 的每一步都在另一个进程里，
//   父 session 的 subscribe 只能看到「一个 toolCall 跑完了」，中间过程前端全瞎。
//   这里改成「chamber 自己建一个真 Session」→ 子 agent 的每一步都走 chamber 现成的
//   名册帧 + 对话帧，于是白捡：名册里看得见、能点开看实时流式、能 abort、能翻页、
//   有独立档案、成本单独核算（见 AGENTS.md 第 4 章）。
//
// ── 配置（<cwd>/.pi/pi-chamber.json 的 subagent 段；随目录走 = 符合"一个 cwd = 一个 agent"）──
//   {
//     "subagent": {
//       "enabled": true,          // 缺省 false（框架层判，见 plugins/index.js）—— 不配就没有这个能力
//       "model": "ds/xxx",        // 子场模型（"provider/id"）；缺省 = 跟父场一致
//       "maxConcurrent": 4,       // 本场同时能跑几个 subagent（缺省 4）
//       "timeoutMs": 360000       // 单个 subagent 超时（缺省 360000 = 6 分钟）
//     }
//   }
//
// ── 四条硬规矩（都是踩过才知道的）──
//   ① **失败一律 return、绝不 throw** —— agent-loop 的 catch 会把 details 换成 {}，
//      前端就拿不到 childSessionId（而失败时恰恰最需要"点进去看看它怎么了"）。
//      代价：isError 拿不到 true（SDK 对 return 的结果一律写 false）→ 真值放 details.status。
//   ② **闸在插件层**，不放 spawnSession —— 否则用户手动新建 Session 也占额度。
//   ③ **递归靠创建期掐断**：depth 到顶直接返回 null（框架就不会注册本工具），
//      不做运行期判断（那种判断总会有漏网的路）。用户明确要求：subagent 不能再调 subagent。
//   ④ **给模型的 content 只要「成本头 + 结论」**，绝不给 transcript（那等于白派）。

import { logWarn } from "../../log.js";
import { Type } from "typebox";

const MAX_DEPTH = 1; // 只允许一层：子场拿不到本工具 → 递归天然断掉（不要改，见铁律③）

/** 插件标识（= 配置里的键名）+ 占用的工具名（框架用它做"归属"，见 plugins/index.js） */
export const key = "subagent";
export const toolNames = ["subagent"];

/** 正整数兜底：配置写错了不至于把功能搞挂 */
function posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1000000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1000000).toFixed(1)}M`;
}

/** 子 session 的账（防御式读：SDK 结构漂了也不崩，最差给 0） */
function statsOf(session) {
  let st = null;
  try {
    st = session.getSessionStats?.() ?? null;
  } catch {
    /* 忽略：拿不到账不影响把结论带回去 */
  }
  const t = st?.tokens ?? {};
  return {
    turns: st?.assistantMessages ?? 0,
    input: Number(t.input) || 0,
    output: Number(t.output) || 0,
    cacheRead: Number(t.cacheRead) || 0,
    cacheWrite: Number(t.cacheWrite) || 0,
    total: Number(t.total) || 0,
    cost: Number(st?.cost) || 0,
  };
}

/** 子 session 的账 → AgentToolResult.usage（父的成本统计会累加它，见 getSessionStats 口径）。
 *  SDK 只给 cost 总额、没有分项，所以分项一律 0、总额照填。 */
function usageOf(a) {
  return {
    input: a.input,
    output: a.output,
    cacheRead: a.cacheRead,
    cacheWrite: a.cacheWrite,
    totalTokens: a.total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: a.cost },
  };
}

/** 失败结果（铁律①：return，不 throw）。
 *  ★ `isError` 在当前 SDK 里是**死字段**：agent-loop 对「正常 return」的工具结果一律写 false，
 *    而 throw 会把 details 换成 {}。两者相权：**保 details**（失败时前端恰恰最需要 childSessionId）。
 *    所以真值放 `details.status`，前端按它渲染；isError 照填，是给未来 SDK 修正留的口子。 */
function fail(text, details) {
  return { content: [{ type: "text", text }], details, isError: true };
}

/** 给模型看的成本头：让它对"派一次单要花多少"有体感（成本可见是本项目的核心诉求之一） */
function costLine(a) {
  return `${a.turns} turns · ↑${fmtTokens(a.input)} ↓${fmtTokens(a.output)} · $${a.cost.toFixed(4)}`;
}

/**
 * 造本场的 subagent 工具。
 * @param cwd           父的工作目录（子与父同处一个 Agent Space）
 * @param depth         本场在派单树里的深度（0 = 人手动开的）
 * @param config        <cwd>/.pi/pi-chamber.json 里的 subagent 段（框架已确认 enabled === true）
 * @param getSession    取本场的 AgentSession（**晚绑**：建场时还没有，见 index.js 的 self）
 * @param modelRuntime  用于把配置里的 "provider/id" 解析成 Model 对象
 * @param spawnSession  注入的建场原语（index.js 的，**不置焦、不动名册目录**）
 * @param closeChild    注入的收工原语（释放子场运行时、保留档案；焦点上不动）
 * @returns ToolDefinition | null（null = 本次不注入，框架会转而屏蔽同名扩展工具）
 */
export function create({ cwd, depth, config, getSession, modelRuntime, spawnSession, closeChild }) {
  if (depth >= MAX_DEPTH) return null; // ★ 递归闸：到顶就不注册（铁律③）

  const maxConcurrent = posInt(config.maxConcurrent, 4);
  const timeoutMs = posInt(config.timeoutMs, 360_000);
  let running = 0; // 本场正在跑的 subagent 数（闭包状态，随本场生灭）

  /** 子场用什么脑子：配了 model 就用配的，否则**跟父场一致**。
   *  配了模型时**不继承思考等级** —— 换到便宜模型通常也不该把父场的高档位带过去。 */
  function pickBrain() {
    const self = getSession();
    const ref = String(config.model ?? "").trim();
    if (!ref) return { model: self?.model, thinkingLevel: self?.thinkingLevel };
    const slash = ref.indexOf("/");
    const m = slash > 0 ? modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
    if (!m) {
      logWarn(`[plugins] subagent.model 认不出「${ref}」→ 退回父场模型`);
      return { model: self?.model, thinkingLevel: self?.thinkingLevel };
    }
    return { model: m };
  }

  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "把一件自足的任务派给一份**新的独立 Session**去做，等它落定后把结论取回。",
      "它跟你同处一个工作目录、共用同一批工具，但有**独立的上下文窗口和独立档案**。",
      "它看不到你的对话历史 —— task 必须自足（路径、约束、期望产出都写清楚）。",
      "适合：大范围搜索、长日志分析、读很多文件这类会把你的上下文淹掉，或可以独立推进的子任务。",
    ].join(""),
    promptSnippet: "subagent: 把一件自足的任务派给一份新的独立 Session，拿回它的结论",
    promptGuidelines: [
      "Use subagent when a task would flood your context (broad search, long logs, reading many files) or can run independently.",
      "subagent 看不到你的上下文 —— 调它时把 task 写自足（路径、约束、期望产出）。",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "自足的任务描述（它看不到你的对话历史）" }),
      name: Type.Optional(Type.String({ description: "这次出勤的显示名（默认取 task 开头）" })),
    }),

    async execute(toolCallId, params, signal, onUpdate) {
      const task = String(params?.task ?? "").trim();
      if (!task) return fail("subagent 失败：task 不能为空", {});
      if (running >= maxConcurrent) {
        return fail(`subagent 并发已达上限（${maxConcurrent}）—— 等一个跑完再派，或把任务合并成一条`, {});
      }

      // 额度从建场那一刻占到子场跑完（"同时跑着 ≤ maxConcurrent"），跑完/失败都归还
      running += 1;
      let child = null;
      try {
        // ── 建场（只建不置焦：用户还在看父这一场）──
        const self = getSession();
        const name = String(params?.name ?? "").trim();
        const fallbackName = name || `↳ ${task.replace(/\s+/g, " ").slice(0, 20)}`;
        try {
          child = await spawnSession({
            cwd,
            fallbackName,
            parentPath: self?.sessionFile ?? null, // 写进子档案头 → 前端 isSubAgent 的持久来源
            parentId: self?.sessionId ?? null,
            depth: depth + 1,
            ...pickBrain(),
          });
        } catch (err) {
          return fail(`subagent 创建失败：${err?.message ?? err}`, {});
        }

        const childId = child.agentSession.sessionId;
        const details = { childSessionId: childId }; // 前端 toolCall 卡片据此渲染「打开 →」
        // 立刻回一发进度：名册里已经有一行了，用户可以点进去看它干活
        onUpdate?.({
          content: [{ type: "text", text: `已派出 → ${childId.slice(0, 8)}（名册里点开可看实时）` }],
          details,
        });

        // ── 派单 + 等落定（abort 传播 + 超时兜底）──
        // prompt() 内部 await 到 agent_settled，所以它 resolve 时子已经跑完；
        // 被 abort 时 prompt() 也会被解开（SDK 的 abort 会走到 settled），不会挂死。
        let stopReason = null; // null | "aborted" | "timeout"
        const stop = (why) => {
          if (!stopReason) stopReason = why;
          void child.agentSession.abort().catch(() => {});
        };
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        const onAbort = () => stop("aborted");
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        let runErr = null;
        try {
          await child.agentSession.prompt(task);
          await child.agentSession.waitForIdle();
        } catch (err) {
          runErr = err; // 起跑就炸：没选模型 / 没 key / 压缩中
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }

        // ── 收账（无论成败都带回去：钱已经花了）──
        const a = statsOf(child.agentSession);
        let text = "";
        try {
          text = String(child.agentSession.getLastAssistantText?.() ?? "").trim();
        } catch {
          /* 忽略 */
        }
        const tail = text ? `\n---\n${text}` : "";
        // childSessionId 只在**子场真落了档**时给：一条 assistant 都没出过的场次（没模型/没 key/起跑就被 abort）
        // 是幽灵，不落盘 → 给了按钮也只会点出「Session 不存在」，不如不给。
        const persisted = a.turns > 0;
        // details.usage = statsOf 形状（turns/input/output/cost，给 UI 显示）；
        // 顶层 usage = SDK Usage 形状（给成本累加）—— 两个不同消费者，不合并。
        const done = { ...(persisted ? details : {}), status: "ok", usage: a };
        const usage = usageOf(a);

        if (stopReason === "timeout") {
          return { ...fail(`subagent 超时（${Math.round(timeoutMs / 1000)} 秒）已中止 · ${costLine(a)}${tail}`, { ...done, status: "timeout" }), usage };
        }
        if (stopReason === "aborted") {
          return { ...fail(`subagent 已中止 · ${costLine(a)}${tail}`, { ...done, status: "aborted" }), usage };
        }
        if (runErr) {
          return { ...fail(`subagent 失败：${runErr?.message ?? runErr}${tail}`, { ...done, status: "error" }), usage };
        }
        return {
          // 给模型：只要结论 + 成本感知（**绝不给 transcript** —— 那等于白派）
          content: [
            { type: "text", text: `[subagent] ${costLine(a)}\n---\n${text || "(subagent 无文本输出)"}` },
          ],
          // 给前端 + 落盘：瘦，只放指针和账
          details: done,
          // 给父的成本账：getSessionStats 会累加 toolResult.usage → 父的 info 帧自动含 subagent 开销
          usage,
        };
      } finally {
        running -= 1;
        // 用完即收工：释放子场运行时（档案保留 → 名册行转 offline，点它随时能回看）。
        // ★ 必须在读账**之后**（收工要 dispose，dispose 后就读不到 stats 了）—— 所以在 finally 里做，
        //   上面所有 return 都已经把 result 算完了。
        if (child) await closeChild?.(child.agentSession.sessionId);
      }
    },
  };
}
