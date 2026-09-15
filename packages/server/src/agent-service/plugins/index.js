// ───────────────────── agent-service / plugins ─────────────────────
// 插件域：chamber 内置的「**按 cwd 配置启用**的能力」——每个插件往 AgentSession 里注入一个工具。
//
// 为什么要这一层（而不是把 subagent 直接写进 index.js）：
//   subagent 之后还会有同类的（都是"给 agent 加一个能力，能不能用由目录决定"），
//   于是把公共部分抽出来：**读配置 → 判 enabled → 造工具 → 处理工具名归属**。
//   加新插件 = 写一个 plugins/xxx.js + 在本文件 PLUGINS 里加一行。
//
// ── 插件契约（plugins/xxx.js 必须导出）──
//   key        配置键名（= <cwd>/.pi/pi-chamber.json 里那一段的名字）
//   toolNames  本插件占用的工具名（数组；用于"归属"，见下）
//   create(ctx) → ToolDefinition | null（null = 本次不注入，比如深度到顶）
//
//   ctx = {
//     bus, cwd, depth, config,          // config = 该插件那一段（框架已确认 enabled === true）
//     getSession,                        // ★ 晚绑取值器：建场时本场的 AgentSession 还没造出来
//     modelRuntime, spawnSession, closeChild,
//   }
//
// ── 配置：<cwd>/.pi/pi-chamber.json ──
//   随目录走 —— 符合"一个 cwd = 一个 Agent Space，目录本身就定义了这个 agent"。
//   独立文件（不塞进 pi 自己的 .pi/settings.json）：pi 的 settings 是 global+project 两层深合并、
//   而且 pi 自己会回写它（setProjectTrusted 等），chamber 往里塞自定义键有被冲掉的风险。
//
//   { "subagent": { "enabled": true, "model": "ds/xxx", "maxConcurrent": 4, "timeoutMs": 360000 } }
//
//   ★ **缺省 enabled = false**：键不存在 = 这个能力不存在；键在但 enabled 不为 true = 注册了但没激活。
//     两个理由：① 不给默认能力（派单是要花钱的，得你点头）；② 零迁移成本（现有 cwd 一个都不用动）。
//   ★ 生效时机：**激活**可以 `/reload` 热更（见下）；**注册**只在建场时定，所以
//     「配置从没这个键变成有这个键」需要重开一次 Session（之后开关都是热的）。
//
// ── 工具名归属（重要，堵一个真实的洞）──
//   配置里**出现**了这个插件的键 = 你认领了 chamber 的这个能力 → 它占用的工具名就**归 chamber 管**：
//     · 插件正常建出来 → chamber 的 customTool 覆盖同名扩展工具（SDK 的 _refreshToolRegistry 后写覆盖）
//     · 插件自己 decline（如 subagent 深度到顶）→ 用 excludeTools 把同名扩展工具一起挡掉
//   不做这一步的话：agent 目录里装了个同名扩展，子场就能拿到它 → 绕过插件的递归闸（真踩过）。
//   ★ 配置里**没这个键** → chamber 完全不插手（用户自己装的同名扩展照常可用）。
//
// ── 注册与激活是两件事（热更的前提）──
//   注册（这个工具存不存在） = 建场时一次性（customTools 只在构造时赋值，reload 改不了它）
//   激活（这个工具现在活不活） = **每次都可以重算**（setActiveToolsByName 是公开 API，顺手重建系统提示词）
//   所以：**插件工具恒注册，开关只影响激活** —— 于是 `/reload` 能热更开关，不用重开会话。
//   ★ 唯一改不了的：配置从"没这个键"变成"有这个键"（注册表里没它）→ 得重开一次 Session。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as subagent from "./subagent.js";

/** 插件表：加新插件 = 加一行 import + 一行入表 */
const PLUGINS = [subagent];

/** 所有插件占用的工具名（收敛激活状态时要先把这些全摘掉，再按配置加回来） */
export const ALL_PLUGIN_TOOL_NAMES = PLUGINS.flatMap((p) => p.toolNames);

/** 读该 cwd 的 chamber 配置。
 *  文件不存在 / 坏 JSON / 不是对象 → 一律当"没配"（返回 {}）——
 *  **配置绝不能把建场搞挂**（一个手抖的逗号不该让整个 agent 打不开）。 */
async function readConfig(cwd) {
  const p = join(cwd, CONFIG_DIR_NAME, "pi-chamber.json");
  try {
    const j = JSON.parse(await readFile(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch (err) {
    if (err?.code !== "ENOENT") console.error(`[plugins] 配置读不了 ${p}: ${err?.message ?? err}`);
    return {};
  }
}

/**
 * 按配置造本场的插件工具。
 * @returns {{ tools: object[], excluded: string[], active: string[] }}
 *   tools    = 要交给 createAgentSession 的 customTools（**恒注册**，开关不管它）
 *   excluded = 要交给 createAgentSession 的 excludeTools（插件 decline 时挡同名扩展）
 *   active   = 本次配置允许**激活**的工具名（enabled === true 且插件真建出来了）
 */
export async function buildPluginTools(ctx) {
  const cfg = await readConfig(ctx.cwd);
  const tools = [];
  const excluded = [];
  const active = [];
  for (const p of PLUGINS) {
    const c = cfg[p.key];
    // ★ 键不存在 → chamber 完全不插手（用户自己装的同名扩展照常可用）
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const t = p.create({ ...ctx, config: c });
    if (t) tools.push(t);
    else excluded.push(...p.toolNames); // 插件自己 decline（如 subagent 深度到顶）
    if (c.enabled === true && t) active.push(...p.toolNames);
  }
  return { tools, excluded, active };
}

/**
 * 按配置收敛插件的激活状态（幂等）。
 *
 * ★ 必须在 createAgentSession **之后**调 —— 构造时 `_refreshToolRegistry` 会把 customTools 全部激活。
 * ★ `/reload` 之后也要重调一次 —— reload 会重建工具注册表（且 `includeAllExtensionTools: true`
 *   会把**扩展**工具全激活），插件的开关得重新收敛。customTools 不受那条影响 → chamber 保持控制权。
 *
 * @param session     本场的 AgentSession
 * @param activeNames 本次配置允许激活的插件工具名
 * @returns { needReopen: string[] } 配置要了但注册表里没有的工具名（= 配置从"没这个键"变成"有这个键"，得重开）
 */
export function applyPluginActivation(session, activeNames) {
  const plug = new Set(ALL_PLUGIN_TOOL_NAMES);
  const cur = session.getActiveToolNames();
  const next = [...cur.filter((n) => !plug.has(n)), ...activeNames];
  // 没变化就不动（免得白重建一次系统提示词）
  if (next.length !== cur.length || next.some((n, i) => n !== cur[i])) session.setActiveToolsByName(next);
  // 注册表里没有的 = 本次配置新认领的插件（建场时还没这个键）→ 只能重开会话
  return { needReopen: activeNames.filter((n) => !session.getToolDefinition(n)) };
}
