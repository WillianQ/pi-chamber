// Term 域 store（终端）：**控制面**，不是数据面。
//
// ★ 唯一的规矩：**终端输出不进 store**。输出是每秒几百帧、每帧几 KB 的字节流，
//   若经 zustand → React 重渲染，敲个 `ls` 就能把界面卡死。所以：
//     模块级 sinks: Map<termId, xterm 实例>（TermView 挂载时登记、卸载时注销）
//     bus.on("term.output") 拿到帧 → 直接 sink.write(bytes)，React 全程不知情。
//   store 只管"有哪些终端 / 哪个是焦点 / 谁在创建 / 出错没有"这类低频控制态。
//
// 事实来源 = 服务端（term.list 全量帧）：$conn.open 时 chamber 喂一份缓存名册，
// 之后每次增/删/退出都推。本端动手的几处：term.create（问答）/ term.attach（问答，回放整屏）
// / term.input·resize·close·detach（单向事件）。断线（chamber 重启）时名册会被推成空 —— 那代表"现在够不着"，
// 前端如实清屏；重连后 chamber 再推真名册，本 store 自动重新 attach（epoch 变化 → TermView 重挂回放）。
//
// ★ 订阅是**每连接**的（服务端按连接算）：
//   · term.detach —— 面板卸载（切走活动页）时退订，后端就不再推这个终端的输出（否则字节照发、前端白收）
//   · owners —— attach 回执里的 resize 权。PTY 只有一个尺寸，多个窗口看同一个终端时只有 owner 能改；
//     非 owner 的窗口画面可能与该 PTY 尺寸不一致（已知且接受，胜在不会互相改乱）
//
// 帧名照本仓惯例写字面量（权威表在 AGENTS.md 4.2；web 端不 import node 包）。
import { create } from "zustand";
import { bus, waitOnline } from "../bus.js";
import { b64ToBytes, strToB64 } from "../lib/b64.js";
import { useChatStore } from "./chat-store.js";
import { useNavStore } from "./nav-store.js";

/** termId → xterm 实例（输出直通，见文件头注） */
const sinks = new Map();
export const registerSink = (termId, term) => sinks.set(termId, term);
export const unregisterSink = (termId) => sinks.delete(termId);

export const useTermStore = create((set, get) => ({
  terms: [], // [{termId, cwd, shell, shellLabel, cols, rows, status, exitCode, startedAt}]
  shells: [], // 本机可用 shell（[新建] 下拉用）：[{id, label}]
  defaultShell: null,
  activeId: null,
  creating: false,
  error: null,
  epoch: 0, // 每次"前端重连"自增：TermView 靠它重新 attach（回放断线期间的输出）
  owners: {}, // termId → 本连接有没有 resize 权（attach 回执的真值；undefined = 还没 attach 过）
}));

// ── 动作（纯函数对象，不进 hook 订阅；调用处直接 `termActions.create()`） ──────
const set = (patch) => useTermStore.setState(patch);
const get = () => useTermStore.getState();

export const termActions = {
  /** 新建终端（shell 省略 = 服务端默认）；成功后置焦，名册由 term.list 帧写真值。
   *  ★ cwd 本端显式带上（焦点 Session 的 Agent 空间）——不靠服务端旁听 nav 去猜：
   *    服务端 nav.cwd 只在 open/连接时更新，刚连上或刚点开 Session（读档案要几秒）时还是 null，
   *    那时建终端就会掉到 termd 自己的 cwd（packages/termd）。本端 chat.cwd 是同一份真值、且早就在手。 */
  async create(shell) {
    set({ creating: true, error: null });
    try {
      await waitOnline();
      const p = {};
      if (shell) p.shell = shell;
      const cwd = useChatStore.getState().cwd ?? useNavStore.getState().cwd;
      if (cwd) p.cwd = cwd;
      const r = await bus.request("term.create", p, { net: true });
      if (r?.termId) set({ activeId: r.termId });
      return r?.termId ?? null;
    } catch (e) {
      set({ error: e?.message ?? "新建终端失败" });
      return null;
    } finally {
      set({ creating: false });
    }
  },

  /** 关闭（真杀进程）：只发事件，名册由帧回填；本地先把焦点挪走，避免闪一下空屏 */
  close(termId) {
    const { terms, activeId } = get();
    const idx = terms.findIndex((t) => t.termId === termId);
    if (idx >= 0 && activeId === termId) {
      const rest = terms.filter((t) => t.termId !== termId);
      set({ activeId: rest[Math.min(idx, rest.length - 1)]?.termId ?? null });
    }
    bus.emit("term.close", { termId }, { net: true });
    set((s) => {
      const owners = { ...s.owners };
      delete owners[termId];
      return { owners };
    });
  },

  setActive(termId) {
    set({ activeId: termId });
  },

  /** 接管/恢复屏幕：**先 reset 再整份写**回放（原始字节重放 = 一屏重画），之后转流式。
   *  回执带 owner = 本连接有没有 PTY 尺寸话语权（第一个 attach 的才有） */
  async attach(termId) {
    try {
      await waitOnline();
      const r = await bus.request("term.attach", { termId }, { net: true });
      const term = sinks.get(termId);
      if (term) {
        term.reset();
        term.write(b64ToBytes(r?.data));
      }
      set((s) => ({ owners: { ...s.owners, [termId]: !!r?.owner } }));
      return r;
    } catch (e) {
      set({ error: e?.message ?? "接管终端失败（终端服务可能没在跑）" });
      return null;
    }
  },

  /** 退订：面板卸载（切走活动页）时告诉后端"这个终端别推了"。只是不再收输出，不影响终端本身 */
  detach(termId) {
    bus.emit("term.detach", { termId }, { net: true });
    set((s) => {
      const owners = { ...s.owners };
      delete owners[termId];
      return { owners };
    });
  },

  sendInput(termId, data) {
    if (data) bus.emit("term.input", { termId, data: strToB64(data) }, { net: true });
  },

  sendResize(termId, cols, rows) {
    // PTY 只有一个尺寸：只有**明确拿到 resize 权**（attach 回执 owner=true）的连接才能改。
    // 未 attach 过（undefined）也不发 —— 否则新窗口一挂载就抢先把 PTY 改成自己的尺寸，
    // 把已经在看的窗口画面改乱（量完尺寸由 attach 回执那条路径补发）。
    if (get().owners[termId] !== true) return;
    if (cols > 1 && rows > 1) bus.emit("term.resize", { termId, cols, rows }, { net: true });
  },

  clearError() {
    set({ error: null });
  },
};

// ── 订阅（挂 bus 上，重连不重做） ──────────────────────────────────────────────

// 全量名册：整组替换（缺字段不动这套在这里没必要——服务端每次给的都是完整行）
bus.on("term.list", (p) => {
  if (!p) return;
  const terms = p.terms ?? [];
  const st = useTermStore.getState();
  const activeId = terms.some((t) => t.termId === st.activeId)
    ? st.activeId
    : (terms[terms.length - 1]?.termId ?? null);
  useTermStore.setState({
    terms,
    shells: p.shells ?? st.shells,
    defaultShell: p.defaultShell ?? st.defaultShell,
    activeId,
  });
});

// 输出：直通 xterm，**不进 React**（本文件头注的第一条纪律）
bus.on("term.output", ({ termId, data } = {}) => {
  const term = sinks.get(termId);
  if (term) term.write(b64ToBytes(data));
});

// 退出：标状态 + 在屏幕上留一行人话（PTY 自己那点收尾输出照常先到）
bus.on("term.exit", ({ termId, code, signal } = {}) => {
  const term = sinks.get(termId);
  if (term) {
    const why = signal ? `signal ${signal}` : `code ${code}`;
    term.write(`\r\n\x1b[2m[终端已退出：${why}]\x1b[0m\r\n`);
  }
  useTermStore.setState((s) => ({
    terms: s.terms.map((t) => (t.termId === termId ? { ...t, status: "exited", exitCode: code ?? null } : t)),
  }));
});

// 前端重连（chamber 重启 / 换网络）：点名册由 chamber 重推，同时打点 epoch 让 TermView 重新 attach
bus.on("$conn.open", () => {
  useTermStore.setState((s) => ({ epoch: s.epoch + 1 }));
});
