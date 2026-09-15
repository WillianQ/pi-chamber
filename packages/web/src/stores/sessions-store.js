// Session 名册（agents + 某目录下的 Session 列表）：**纯服务端推送，前端零推导**。
//
// 数据源两条帧（都在 PROTOCOL.new.md 的「共用帧」）：
//   agent.sessions.sync  { agents, selectedCwd, sessions }   连接 / 换目录 → 整组替换
//   agent.sessions.patch { agents?, rows? }                  其余所有名册变化 → 字段级合并
//
// 三条写规则（协议里就叫这名）：
//   ① 本端发上行帧（open/close/delete）先置 "pending"（写行）；此后一律由帧写真值。
//      pending 只是本地暂态 —— 任何真值帧都覆盖它（服务端保证每条路都有结束帧）。
//   ② status 由后端推导（isCompacting/isStreaming），前端不推导、不猜。
//   ③ 合并：sync 整组替换；patch 按 id / cwd 合并，**插入新行前必须校验 row.cwd === selectedCwd**
//      （patch 是全员广播：后台别的目录的场次 settle 也会推，不校验就串台）。
//
// 与上一版的差别（故意删掉的）：opening 橙灯 / ghosts 幽灵行 / 四灯推导 / 断线重连后重拉列表
//   —— 全部由服务端的 status 与 sync 帧接管。这里只剩"收帧 + 合并 + 发上行"。
import { create } from "zustand";
import { bus, useConnStore } from "../bus.js";

const online = () => useConnStore.getState().state === "online";

export const useSessionsStore = create(() => ({
  agents: [], // { cwd, basename, sessionCount }
  selectedCwd: null, // Agent 下拉当前值（连接时由服务端给，之后是本端选择）
  sessions: [], // { id, cwd, name, updateTime, messageCount, status }
  creating: false, // 「新建 Session」按钮在途（此刻还没有 id，没行可置 pending）
  error: null, // 本地校验 / 服务端 notice 的错误文案
}));

// ───────────────────────── 合并工具 ─────────────────────────

/** 名册行合并：按 id 覆盖（缺的字段不动）；deleted → 删行；新行只在属于当前目录时才插入 */
function mergeRows(rows, selectedCwd, patches) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const p of patches) {
    if (!p?.id) continue;
    if (p.deleted) {
      byId.delete(p.id);
      continue;
    }
    const cur = byId.get(p.id);
    if (cur) byId.set(p.id, { ...cur, ...p });
    else if (p.cwd && p.cwd === selectedCwd) byId.set(p.id, p); // ★ 别的 cwd 的行不插（串台闸）
  }
  // 存储序按最近动过在前；**展示序**看 sortRows（页面唯一入口）
  return [...byId.values()].sort((a, b) => byTimeDesc(a.updateTime, b.updateTime));
}

/** ISO 时间串降序（新→旧）：三值比较，相等返回 0 —— 写 `a < b ? 1 : -1` 是错的
 *  （两边相等时恒返回 -1，比较器不自洽，V8 插入排序会把整个数组翻过来）。 */
function byTimeDesc(a, b) {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

/** 展示序（纯函数，页面唯一入口）：**树形** —— subagent 挂在它的父行下面（缩进一级），
 *  不参与顶层排序；顶层内部按最近动过（updateTime）新→旧。
 *
 *  为什么不再「焦点置顶」：置顶的后果是**点开哪个就把它弹到第一个** ——
 *  而 subagent 是 agent 派出去的临时产物，不该跟人手动开的场次抢位置（实测很刺眼）。
 *  现在：位置只由 updateTime 决定（稳定，点了不跳），焦点靠左边竖条 + 标题主色表达（本来就有）。
 *
 *  规则：
 *    ① 顶层 = 没有父（或父不在本列表里）的场次；
 *    ② 每个 subagent 挂在父下面，兄弟之间按 updateTime 新→旧；
 *    ③ 递归（孙子挂儿子下面）—— v1 只有一层，但规则不设限；
 *    ④ 父不在列表里（已删 / 不在本 cwd）→ 降级为顶层，**绝不静默吞行**。
 *
 *  ★ 返回的行多一个 `depth` 字段（0 = 顶层）：页面拿它做缩进，不必自己再推一遍树。
 *  ★ 名册协议里**没有 createTime**，排序一律只用 updateTime。
 */
export function sortRows(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map(); // parentId -> rows[]
  const roots = [];
  for (const r of rows) {
    // 自指（脏数据）当无父处理，免得把自己挂到自己下面转不出来
    const p = r.parentId && r.parentId !== r.id ? byId.get(r.parentId) : null;
    if (p) {
      const arr = childrenOf.get(p.id) ?? [];
      arr.push(r);
      childrenOf.set(p.id, arr);
    } else {
      roots.push(r);
    }
  }
  roots.sort(byTimeDesc);
  for (const arr of childrenOf.values()) arr.sort(byTimeDesc);

  const out = [];
  const seen = new Set();
  const walk = (r, depth) => {
    if (seen.has(r.id)) return; // 防环（父子互指）：第二遍走到就直接放回，不死循环
    seen.add(r.id);
    out.push({ ...r, depth });
    for (const c of childrenOf.get(r.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0); // 兜底：环里的行也得上榜
  return out;
}

/** agent 列表合并：按 cwd 覆盖 / 插入 */
function mergeAgents(agents, patches) {
  const byCwd = new Map(agents.map((a) => [a.cwd, a]));
  for (const a of patches) {
    if (!a?.cwd) continue;
    byCwd.set(a.cwd, { ...(byCwd.get(a.cwd) ?? {}), ...a });
  }
  return [...byCwd.values()];
}

// ───────────────────────── 帧 → store ─────────────────────────

bus.on("agent.sessions.sync", (p) => {
  useSessionsStore.setState({
    agents: p?.agents ?? [],
    selectedCwd: p?.selectedCwd ?? null,
    sessions: p?.sessions ?? [],
    error: null,
  });
});

bus.on("agent.sessions.patch", (p) => {
  if (!p) return;
  const st = useSessionsStore.getState();
  const next = {};
  if (p.agents?.length) next.agents = mergeAgents(st.agents, p.agents);
  if (p.rows?.length) next.sessions = mergeRows(st.sessions, st.selectedCwd, p.rows);
  if (Object.keys(next).length) useSessionsStore.setState(next);
});

// 对话整组帧（带 activeId 的那种）到达 = 服务端已受理上一个写动作 → 新建按钮收工
bus.on("agent.chat.sync", (p) => {
  if (p && "activeId" in p && useSessionsStore.getState().creating) useSessionsStore.setState({ creating: false });
});

// 服务端 notice（错误 / 重试）：清同类在途态，别让按钮转圈转到天荒
bus.on("agent.chat.notice", (p) => {
  if (p?.type === "error") useSessionsStore.setState({ creating: false, error: p.message ?? "操作失败" });
});

// ───────────────────────── 行级小工具（导出给 chat-store 置 pending） ─────────────────────────

/** 本端在途标记：上行帧发出即置 pending（行 status 一律由后端真值帧覆盖） */
export function markPendingRow(sessionId) {
  useSessionsStore.setState((s) => ({
    sessions: s.sessions.map((r) => (r.id === sessionId ? { ...r, status: "pending" } : r)),
  }));
}

// ───────────────────────── Actions ─────────────────────────

export const sessionsActions = {
  /** 换目录（Agent 下拉）：只让服务端重推名册，不动焦点 */
  selectAgent(cwd) {
    if (!cwd) return;
    useSessionsStore.setState({ selectedCwd: cwd }); // 乐观：同步帧会再确认一次
    bus.emit("agent.sessions.list", { cwd }, { net: true });
    return;
  },

  /** 打开 / 切换（emit，无回执）：行置 pending，随后由 patch + chat.sync 写真值 */
  openSession(sessionId) {
    if (!sessionId || !online()) return;
    const cur = useSessionsStore.getState().sessions.find((r) => r.id === sessionId);
    if (cur?.status === "pending") return; // 已在途，别重复按
    markPendingRow(sessionId);
    bus.emit("agent.session.open", { sessionId }, { net: true });
  },

  /** 新建（cwd 可指定：左钮 = selectedCwd，右钮 = DirPicker 选的目录） */
  createSession(cwdArg) {
    const cwd = cwdArg || useSessionsStore.getState().selectedCwd;
    if (!cwd) {
      useSessionsStore.setState({ error: "请先选一个 Agent，或用「选择目录…」指定目录" });
      return;
    }
    if (!online()) {
      useSessionsStore.setState({ error: "未连接服务器" });
      return;
    }
    useSessionsStore.setState({ creating: true, error: null });
    bus.emit("agent.session.create", { cwd }, { net: true });
  },

  /** 收工：释放运行时保留档案（emit） */
  closeSession(sessionId) {
    if (!sessionId || !online()) return;
    markPendingRow(sessionId);
    bus.emit("agent.session.close", { sessionId }, { net: true });
  },

  /** 销毁：释放 + 删档案（永久，前端已二次确认） */
  deleteSession(sessionId) {
    if (!sessionId || !online()) return;
    markPendingRow(sessionId);
    bus.emit("agent.session.delete", { sessionId }, { net: true });
  },
};
