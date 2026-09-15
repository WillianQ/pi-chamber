// / 命令面板的解析与回填——纯函数（无 React / 无 bus / 无 DOM），可单跑单测：
//   node --test packages/web/src/pages/chat/command-match.test.js
//
// 数据形状（后端 chat.sync.commands，见 server/src/agent-service/commands.js）：
//   节点只有一种 { value, description?, options? }
//     · value 既是匹配键也是回填值（二级的 value = "provider/id"，带 / 也算**一整段**，不当第三级）
//     · options 有 = 可下钻；缺 = 叶子（如 /reload）
//
// 分级口径对齐 pi（CombinedAutocompleteProvider.getSuggestions）：**只看第一个空格**
//   · 还没空格  → 一级：过滤命令名
//   · 有第一个空格 → 取出命令名；它有 options 就给二级（第一个空格之后**全部**当过滤词），
//     没有就关（叶子 / 未知名）。pi 同样不逐段下钻（argumentText = slice(spaceIndex+1)）。
import { fuzzyFilter } from "../../lib/fuzzy.js";

/** 光标前能否触发面板：能 → { level, pool, query }，不能 → null
 *  硬约束：光标前不能有换行（面板是行内补全，回填锚点必须在同一行）。 */
export function completionContext(text, caret, commands = []) {
  const before = String(text ?? "").slice(0, caret ?? 0);
  if (before.includes("\n")) return null;
  const trimmed = before.trimStart();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1);
  const sp = body.indexOf(" ");

  // 一级（还没空格）：精确命中有二级的命令 → 直接下钻（不靠尾空格）；精确命中叶子 → 无可补，收面板
  if (sp === -1) {
    const exact = commands.find((n) => n?.value === body);
    if (exact) return exact.options?.length ? { level: 2, pool: exact.options, query: "", root: exact } : null;
    return { level: 1, pool: commands, query: body };
  }

  // 二级：第一个空格之后**全部**当过滤词（pi 同口径）；参数已精确填满 → 收面板
  const name = body.slice(0, sp);
  const hit = commands.find((n) => n?.value === name);
  if (!hit?.options?.length) return null; // 叶子命令 / 未知名 / 自由文本命令（/name /compact）
  const query = body.slice(sp + 1);
  if (hit.options.some((n) => n?.value === query.trim())) return null;
  return { level: 2, pool: hit.options, query, root: hit };
}

/** 模糊过滤的取值函数：一级只搜命令名（同 pi）；二级搜「参数 + 说明」（近似 pi 的二级搜索文本） */
export function matchTextOf(ctx) {
  return ctx?.level === 2
    ? (n) => `${n?.value ?? ""} ${n?.description ?? ""}`
    : (n) => String(n?.value ?? "");
}

/** 过滤出当前该展示的条目（空 = 不弹） */
export function panelItems(ctx, limit = Infinity) {
  if (!ctx) return [];
  const items = fuzzyFilter(ctx.pool ?? [], ctx?.query ?? "", matchTextOf(ctx));
  return items.length > limit ? items.slice(0, limit) : items;
}

/** 光标所处的「整段 token」范围：向前到行首/上一个空白，向后到行尾/下一个空白。
 *  整体替换这一段（而非只替换光标前的半截），光标在词中间时也不会拼出残句。 */
function tokenRange(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  const rest = text.slice(caret);
  const m = rest.search(/[\s]/);
  const end = m === -1 ? text.length : caret + m;
  return { start, end };
}

/** 选中一条 → 回填后的 { text, caret }（保留光标后的文字；新光标落在插入串末尾）
 *  一级：插入 "/value"，**有子级补一个尾空格**（立刻展开二级）、叶子不补（回车即可发）
 *  二级：插入 value 本身（替换掉正在敲的那一段参数） */
export function fillText(text, caret, ctx, node) {
  const t = String(text ?? "");
  const c = Math.max(0, Math.min(caret ?? t.length, t.length));
  const { start, end } = tokenRange(t, c);
  const ins = ctx?.level === 2 ? String(node?.value ?? "") : `/${node?.value ?? ""}${node?.options?.length ? " " : ""}`;
  return { text: t.slice(0, start) + ins + t.slice(end), caret: start + ins.length };
}
