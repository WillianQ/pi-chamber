// ───────────────────── agent-service / plugins / todos.js ─────────────────────
// todos 插件：给 agent 一份**公开的待办清单** —— 它边干边把计划写下来，
// 前端在输入框上方实时显示（进度条 + 清单），人和 agent 看的是同一份。
//
// ★ 定位（改这个文件前先过这道闸）：**它是「模型 → 用户的进度汇报窗口」，不是「模型的自我管理工具」**。
//   推论两条：① 想影响模型行为 → 写进 tool description / promptGuidelines（系统提示词层，
//   零成本、不破 prompt cache）；**绝不做"定时注入提醒"这类催促** —— 代价是假更新（模型随手把
//   没做完的标 done，而清单一旦变假，这个面板就废了）+ 破 prompt cache。
//   ② **可信 > 及时**：状态一律用模型给的原始值，界面绝不猜（不推算、不自动打勾）。
//
// ── 配置（<cwd>/.pi/pi-chamber.json 的 todos 段；随目录走）──
//   { "todos": { "enabled": true } }   // 缺省 false（框架层判，见 plugins/index.js）
//
// ── 状态怎么走（★ 零手动持久化）──
//   工具返回值里带 `details = { todos: [...] }` —— SDK 在 message_end 处把整条 toolResult
//   （含 details）`appendMessage` 进 jsonl，**落盘是白送的**，本文件一行持久化代码都不用写。
//   恢复现场：attachSession 时沿 leaf 链回溯，取最后一条本工具的 toolResult（见本文件的 stateOf
//   + plugins/index.js 的 restorePluginStates）。
//   推帧：execute 里调注入的 publishState（框架存 entry + 推 agent.plugin.state）；
//   本文件**不碰总线**（与 commands.js 同款纪律：能力单元只产出数据，总线出口在 index.js）。
//
// ── 语义：全量替换（学 Claude Code 的 TodoWrite）──
//   模型每次把**整份清单**发过来，没有 add/update/remove 三个动作 ——
//   不发 id、不做合并、天然幂等，模型少一类犯错机会（改错条、丢条）。
//   空数组 = 清空（前端整块收起）。
//
// ── 三个状态（waiting / doing / done）──
//   doing 是这份清单的价值所在：没有它，"进度"就只是个百分比，人不知道 agent 此刻在干哪一条。

import { Type } from "typebox";

/** 插件标识（= 配置里的键名）+ 占用的工具名（框架用它做"归属"，见 plugins/index.js） */
export const key = "todos";
export const toolNames = ["todos"];

const STATUSES = ["waiting", "doing", "done"];
const MAX_ITEMS = 20; // 条数上限：清单是"当前计划"不是需求文档，超了截断
const MAX_DESC = 200; // 单条描述上限（前端一行放不下）

/** 状态归一（防御式）：认不出的 status → waiting；空白描述丢掉；超长/超量截断。
 *  为什么救而不是拒：模型偶尔写错一个词/多写一条，不该让整份清单作废。 */
function normalize(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of list) {
    const description = String(it?.description ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description) continue;
    out.push({
      description: description.slice(0, MAX_DESC),
      status: STATUSES.includes(it?.status) ? it.status : "waiting",
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 回给模型的清单（纯文本，不用 JSON：模型读这个比读 JSON 稳，也省 token） */
function render(todos) {
  if (!todos.length) return "清单已清空。";
  const done = todos.filter((t) => t.status === "done").length;
  const lines = todos.map((t) => `${t.status === "done" ? "[x]" : t.status === "doing" ? "[>]" : "[ ]"} ${t.description}`);
  return `清单 ${done}/${todos.length}：\n${lines.join("\n")}`;
}

/**
 * 造本场的 todos 工具。
 * @param publishState 框架注入的状态发布原语：publishState(state) → 存 entry + 推 agent.plugin.state
 *                     （**已绑好本插件的 key**，插件不用知道帧长什么样）
 *                     ★ 本插件的 state **就是数组本身**（= 前端 pluginState[场].todos），
 *                       不是 { todos } 包一层 —— 线帧与 store 的形状以此为准。
 * @returns ToolDefinition
 */
export function create({ publishState }) {
  return {
    name: "todos",
    label: "Todo",
    description: [
      "维护一份**给人看的待办清单**：每次调用把整份清单发过来（全量替换，不是增量修改）。",
      "用户会在界面上实时看到这份清单和进度 —— 这是让他知道你在干什么、干到哪了的主要方式。",
      "多步任务开工前先列一遍；每完成一步就更新一次（那条改 done，下一条改 doing）。",
    ].join(""),
    promptSnippet: "todos: 维护一份给人看的待办清单（全量替换；多步任务边干边更新）",
    promptGuidelines: [
      "Use todos for multi-step work: write the whole plan up front, then keep it updated as you go.",
      "Always send the **complete** list (full replace) — an item you leave out is a deleted item.",
      "At most one item may be \"doing\" at a time; switch it to \"done\" the moment that step finishes.",
      "Send an empty list to clear it once the work is over.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          description: Type.String({ description: "要做的事（一句话，动词开头）" }),
          // 用 enum（不是 anyOf of const）：各家 provider 的 strict schema 都认 enum
          status: Type.String({
            enum: STATUSES,
            description: "waiting = 还没做 / doing = 正在做（同时最多一条）/ done = 已完成",
          }),
        }),
        { description: "完整清单（全量替换：这里没有的条目等于被删掉）" },
      ),
    }),

    async execute(toolCallId, params) {
      const todos = normalize(params?.todos);
      try {
        publishState?.(todos); // state = 数组本身（见 create 的入参说明）
      } catch (err) {
        // 推帧失败不影响工具结果（清单照样回给模型、照样落档案）
        console.error(`[plugins] todos 状态发布失败: ${err?.message ?? err}`);
      }
      return {
        content: [{ type: "text", text: render(todos) }],
        // ★ 落档案靠它（SDK 自动 appendMessage 整条 toolResult），
        //   也是重开会话 / chamber 重启后恢复清单的唯一来源
        details: { todos },
      };
    },
  };
}

/** 框架用（恢复现场）：从一条 toolResult 消息里取出本插件的状态。
 *  @returns state（数组） | null（不是本工具的 / 没有状态 → null） */
export function stateOf(message) {
  if (message?.toolName !== "todos") return null;
  if (!message.details) return null; // 老档案/异常形态：当作没状态
  return normalize(message.details.todos);
}
