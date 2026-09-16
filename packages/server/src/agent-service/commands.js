import { logWarn } from "../log.js";
// ───────────────────── agent-service / commands.js ─────────────────────
// / 命令域：内置命令表 + 四源清单（内置 / 扩展 / prompt 模板 / skill）+ 二级参数池。
//
// ★ 本文件是**闭合孤岛**：不吃 sessions 表、不读 watched、不摸 bus。
//   只吃传进来的 entry（仅碰 entry.agentSession / entry.commandsPromise / entry.reapplyPlugins），返回纯数据
//   （命令节点数组；run 可另返回 { notice:{type,message} } —— 文案由本文件拼，推帧交给 index.js 的分诊，
//     本文件依旧不碰总线）。
//   要外推的 commandsOfSafe 留在 index.js（它要读焦点），prompt 分诊用的 builtinOf 也留在 index.js，
//   两边都只 import 本文件导出的 BUILTINS / commandsOf。
//
// ───────────────────────── / 命令清单（随 chat.sync 的 commands 字段推，无独立帧） ─────────────────────────
// 四源合并（顺序对齐 pi interactive-mode 的 createBaseAutocompleteProvider）：
//   ① 内置（BUILTINS）② 扩展命令 ③ prompt 模板 ④ skill
// 节点形状只有一个 { value, description?, options? }：value 既是匹配键也是回填值（二级的 value 即
//   "bailian/qwen3.8-flash"，前端 split(/\s+/) 不切 "/"）；options 有 = 可下钻，缺 = 叶子。
// 二级参数池随清单全量推，前端本地模糊过滤（敲键零往返）；纯推送不做 request（构建要 await 扩展
//   函数，且焦点单数、容忍 1~2 秒陈旧，覆盖式更新即可）。

/** 内置命令表：清单元数据（description/options）+ 执行体 run。
 *  函数声明提升 → options / run 直接引用下面的 modelOptions/levelOptions/resolveModel 没问题。
 *  ★ 不设 needsIdle：照 pi TUI 口径，命令一律放行（pi 的 onSubmit 里命令分支就写在 isStreaming 之前，
 *    忙时不挡）。已知代价（均已实测）：
 *      · /compact 忙时会 await abort() 掐掉当前 run —— 已生成的那半截**不丢**，收成一条
 *        stopReason:"aborted" 的消息（正常走 message_start/message_end，并写进档案）。
 *        事件顺序是死的：abort() 里的 await waitForIdle() 卡到 agent_settled 广播完才返回，
 *        所以 settled 必早于 compaction_start。
 *      · /reload 忙时不 abort，直接在 run 底下换 extensionRunner/tools/provider（行为未定义）。
 *  ★ 也正因为放行，SDK 自带的两道闸（prompt() 里“压缩中拒接”“streaming 必须给 streamingBehavior”）
 *    碰不到我们 —— 我们绕开 prompt() 直接调 API，责任全在这一层。 */
/** /reload 回执：一句话说清「重载了什么（带名字）+ 几处问题」。notice 只带 message，前端不解析、原样展示。
 *  ★ 必须读 reload **之后**的对象：resourceLoader / extensionRunner 是 getter，reload 会把它们整个换掉。
 *  ★ reload() 本身不抛错：坏扩展 / 重名冲突全进 diagnostics（不报 = 静默烂掉），所以这里必须自己扫一遍。 */
function reloadSummary(e, plug) {
  const rl = e.agentSession.resourceLoader;
  const ext = rl.getExtensions(); // { extensions, errors }
  const groups = [
    ["扩展", ext.extensions.filter((x) => !x.hidden).map(extLabel)], // hidden = TUI 内部扩展，与 pi 口径一致
    ["技能", rl.getSkills().skills.map((x) => x.name)],
    ["提示词", e.agentSession.promptTemplates.map((x) => x.name)],
  ];
  const head = `已重载：${groups
    .map(([label, names]) => (names.length ? `${label} ${names.length}（${names.join("、")}）` : `${label} 0`))
    .join(" · ")}`;
  const issues = [
    ...ext.errors.map((x) => `${x.path}: ${x.error}`),
    ...rl.getSkills().diagnostics.map((d) => d.message),
    ...rl.getPrompts().diagnostics.map((d) => d.message),
    ...e.agentSession.extensionRunner.getCommandDiagnostics().map((d) => d.message),
  ];
  return head + plugNote(plug) + (issues.length ? `｜⚠ ${issues.length} 处问题：${issues[0]}` : "");
}

/** 插件开关的回执尾：说清“谁开着”，以及“要不要重开会话才生效”。
 *  ★ 两种状态要分开说：**激活**能 /reload 热更；**注册**（配置里新认领的插件）得重开。 */
function plugNote(plug) {
  if (!plug) return "";
  const on = (plug.active ?? []).join("、") || "（无）";
  const reopen = plug.needReopen ?? [];
  return `｜插件已开：${on}` + (reopen.length ? `｜⚠ ${reopen.join("、")} 需重开 Session（新建场时配置里还没它）` : "");
}

/** 扩展名：取文件名去掉扩展后缀（全路径太长，Alert 一行放不下；两名重了看诊断里的全路径） */
function extLabel(x) {
  const base = String(x?.path ?? "").split(/[\\/]/).pop() || "?";
  return base.replace(/\.(js|ts|mjs|cjs)$/i, "");
}

const BUILTINS = {
  model: {
    description: "切换当前 Session 的模型",
    options: modelOptions,
    run: async (e, a) => { await e.agentSession.setModel(resolveModel(e, a), { persist: false }); },
  },
  name: {
    description: "给当前 Session 改名",
    run: async (e, a) => {
      const name = a.trim();
      if (!name) throw new Error("用法：/name <名字>");
      e.agentSession.setSessionName(name); // 同步；改名事件由 session_info_changed 走状态流上浮
    },
  },
  level: {
    description: "设置思考等级",
    options: levelOptions,
    run: async (e, a) => {
      const lv = a.trim();
      const levels = e.agentSession.getAvailableThinkingLevels();
      // SDK 对未知 level 静默 clamp → 这里先挡一道，给用户明确报错
      if (!levels.includes(lv)) throw new Error(`未知思考等级: ${lv || "(空)"}（可选 ${levels.join(" / ")}）`);
      e.agentSession.setThinkingLevel(lv, { persist: false });
    },
  },
  compact: {
    description: "压缩对话上下文",
    run: async (e, a) => { await e.agentSession.compact(a.trim() || undefined); },
  },
  reload: {
    description: "重新加载扩展 / skills / prompts / 设置（含 .pi/pi-chamber.json 的插件开关）",
    run: async (e) => {
      await e.agentSession.reload();
      e.commandsPromise = null; // ★ 扩展/skill/模板全变了 → 清单缓存作废，下一个 pushFocus 重建
      // 插件开关：reload 会重建工具注册表（且把**扩展**工具全激活），这里重读 pi-chamber.json 再收敛一次
      const plug = await e.reapplyPlugins?.();
      // 成功无独立帧：靠 notice 回执（分诊统一推）+ 分诊 finally 的 refreshFocus 重推命令清单
      return { notice: { type: "reload", message: reloadSummary(e, plug) } };
    },
  },
};

/** /model 二级池：口径抄 pi —— scopedModels 优先，否则取配了 auth 的模型（value 带 provider/） */
function modelOptions(entry) {
  const s = entry.agentSession;
  const models = s.scopedModels.length
    ? s.scopedModels.map((x) => x.model)
    : s.modelRuntime.getAvailableSnapshot();
  return models.map((m) => ({ value: `${m.provider}/${m.id}`, description: m.provider }));
}

/** /level 二级池：随当前模型变（SDK 会静默 clamp，这里给的是可选全集） */
function levelOptions(entry) {
  return entry.agentSession.getAvailableThinkingLevels().map((l) => ({ value: l }));
}

/** /model 参数解析：先在本会话可选池里精确找（与二级池同一口径，含 scopedModels），
 *  找不到再问 runtime（provider/id 拆开查）。都找不到 → 抛错，由分诊的 catch 推 error 哨兵。 */
function resolveModel(entry, arg) {
  const s = entry.agentSession;
  const key = arg.trim();
  if (!key) throw new Error("用法：/model <provider/id>");
  const pool = s.scopedModels.length
    ? s.scopedModels.map((x) => x.model)
    : s.modelRuntime.getAvailableSnapshot();
  const hit = pool.find((m) => `${m.provider}/${m.id}` === key);
  if (hit) return hit;
  const slash = key.indexOf("/");
  const m = slash > 0 ? s.modelRuntime.getModel(key.slice(0, slash), key.slice(slash + 1)) : undefined;
  if (!m) throw new Error(`未知模型: ${key}（敲 /model 看可选清单）`);
  return m;
}

/** 扩展命令的二级池：getArgumentCompletions("") 约定空前缀 = 全量。
 *  是函数、不过网 → 失败/返回空一律降级为「没有二级」（纯手打），不抛给上边。 */
async function extensionOptions(cmd) {
  if (typeof cmd.getArgumentCompletions !== "function") return null;
  try {
    const items = await cmd.getArgumentCompletions("");
    if (!Array.isArray(items) || !items.length) return null;
    return items.map((it) => ({ value: it.value, description: it.description ?? "" }));
  } catch (err) {
    logWarn(`[agent] 扩展命令 /${cmd.invocationName} 参数补全失败（降级纯手打）: ${err?.message ?? err}`);
    return null;
  }
}

/** 命令清单：四源合并 */
async function listCommands(entry) {
  const s = entry.agentSession;
  const builtinNames = new Set(Object.keys(BUILTINS));
  const out = [];

  // ① 内置
  for (const [name, c] of Object.entries(BUILTINS))
    out.push({ value: name, description: c.description ?? "", ...(c.options ? { options: c.options(entry) } : {}) });

  // ② 扩展命令（与内置同名 → 跳过，跟 pi 一致：pi 源码比的是 c.name 而非 invocationName）
  for (const c of s.extensionRunner.getRegisteredCommands()) {
    if (builtinNames.has(c.name)) continue;
    const options = await extensionOptions(c);
    out.push({ value: c.invocationName, description: c.description ?? "", ...(options ? { options } : {}) });
  }

  // ③ prompt 模板（= resourceLoader.getPrompts().prompts）
  for (const t of s.promptTemplates)
    out.push({ value: t.name, description: t.description ?? "" });

  // ④ skill（pi 用 settingsManager 开关兜着，默认 true；命令名带 skill: 前缀）
  if (s.settingsManager.getEnableSkillCommands()) {
    for (const k of s.resourceLoader.getSkills().skills)
      out.push({ value: `skill:${k.name}`, description: k.description ?? "" });
  }

  return out;
}

/** 清单缓存：扩展参数补全要 await，不能每次连接都现算。缓的是 Promise（并发去重）；失败不缓存 */
function commandsOf(entry) {
  if (!entry.commandsPromise) {
    entry.commandsPromise = listCommands(entry).catch((err) => {
      entry.commandsPromise = null;
      throw err;
    });
  }
  return entry.commandsPromise;
}

export { BUILTINS, commandsOf };
