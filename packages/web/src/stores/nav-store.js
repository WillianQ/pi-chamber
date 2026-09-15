// Nav 域 store：镜像服务端 {current, cwd} + 当前目录 items。
// 铁律：状态只由服务器推送（nav.state 全量 / nav.update 单条）驱动，本端不产状态；
//      本端唯一动手的地方是发 nav.open（把"想去哪"告诉服务器）。导航现场对任何终端同一份。
//      断线错过 nav.update 不补——重连后服务器推 nav.state 全量即最新。
import { create } from "zustand";
import { bus, waitOnline } from "../bus.js";

/** 上一级路径（跨 \\ / 分隔；盘根再上 = "" = 此电脑层）。null/空 → 无上一级 */
export function upPath(p) {
  if (!p) return null;
  const s = p.replace(/[\\/]+$/, "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? "" : s.slice(0, i);
}

const dirsFirst = (items) =>
  [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
  });

export const useNavStore = create((set, get) => ({
  current: null, // 浏览器位置（null = 此电脑层）
  cwd: null, // 当前 Agent 空间
  items: [], // current 下条目（服务器现拉现给）
  busy: false,
  error: null,

  /** 唯一手动改口：把浏览位置挪到某目录（"" = 回此电脑层）。结果由 nav.state 事件落地 */
  async navigate(current) {
    if (current === get().current) return;
    try {
      await waitOnline();
      set({ busy: true, error: null });
      await bus.request("nav.open", { current }, { net: true });
    } catch (e) {
      set({ error: e?.message });
    } finally {
      set({ busy: false });
    }
  },

  goUp() {
    const parent = upPath(get().current);
    if (parent === null) return;
    get().navigate(parent);
  },

  /** 快捷：回到当前 Agent 的 cwd（没有 cwd 就回此电脑层） */
  toAgentCwd() {
    get().navigate(get().cwd ?? "");
  },
}));

// —— 订阅挂在 bus 上（重连不重做）；服务器连接一建立就推 nav.state，这里无需联网动作 ——

bus.on("nav.state", (s) => {
  useNavStore.setState({
    current: s?.current ?? null,
    cwd: s?.cwd ?? null,
    items: s?.items ?? [],
    error: null, // 新一轮状态到达 = 上次错误翻篇
  });
});

bus.on("nav.update", (u) => {
  const items = [...useNavStore.getState().items];
  if (u?.add) {
    const i = items.findIndex((x) => x.abs_path === u.add.abs_path);
    i >= 0 ? (items[i] = u.add) : items.push(u.add);
  } else if (u?.change) {
    const i = items.findIndex((x) => x.abs_path === u.change.abs_path);
    i >= 0 ? (items[i] = u.change) : items.push(u.change);
  } else if (u?.remove) {
    const i = items.findIndex((x) => x.abs_path === u.remove.abs_path);
    if (i >= 0) items.splice(i, 1);
  } else {
    return; // 未知增量：不动（下个全量会自愈）
  }
  useNavStore.setState({ items: dirsFirst(items) });
});
