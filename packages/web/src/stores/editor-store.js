// Editor 域 store：镜像服务端打开的文件集。
// 事实来源 = 服务端内存态：$conn.open → editor.files 全量；打开·改动·删除 → editor.file_changed 增量。
// 本端唯一动手的三处：nav.open_file（打开）/ editor.update（保存，request 回执）/ editor.close_file 事件（关，单向）。
//
// 铁律（详见 AGENTS.md "Editor 域"）：
//  - modified = content !== original（不单存布尔）。键入只改 content（setBuffer）；
//    保存回执 {ok} 后 original 才对齐 content；失败维持 modified 待重试。
//  - 后端推送（new/modify）**无论本地是否 modified 都整条覆盖** content+original（磁盘/后端为准，草稿直接丢）——
//    与老 chamber 的"dirty 保护跳过推送"刻意相反。
//  - 无自动保存：editor.update 只在用户显式保存（Ctrl+S/按钮）时发。
//  - 事件 handler 对不在表的 path 一律忽略（close 竞态 / 迟到事件自愈，见 removeLocal 幂等）。
import { create } from "zustand";
import { bus, waitOnline } from "../bus.js";
import { useUIStore } from "./ui-store.js";

export const useEditorStore = create((set, get) => ({
  files: [], // [{name, path, content, original, scrollPos}]（服务端序 = 打开顺序）
  activePath: null,
  cycleAt: 0, // 最近一次快捷键切 tab 的时间戳（Ctrl+; / Ctrl+'）——FileSwitcher 据此自动弹开清单
  mode: "edit", // 'edit' | 'preview'（预览仅 md/html 生效；活动页切换后仍保留）
  lineWrapping: true, // 代码模式自动换行（全局开关，老 chamber 同款；Compartment 热切不重建 view、不丢 undo）
  busy: false, // 打开/保存在途（保存按钮 loading）
  error: null,

  /** 打开：已在表 → 聚焦并切到编辑器页；否则发 nav.open_file，tab 由 file_changed(new) 建。失败置 error（人还在导航页，由导航页提示） */
  async openFile(p) {
    set({ error: null });
    const st = get();
    if (st.files.some((f) => f.path === p)) {
      set({ activePath: p });
      useUIStore.getState().openActivity("files");
      return true;
    }
    try {
      await waitOnline();
      set({ busy: true });
      const r = await bus.request("nav.open_file", { path: p }, { net: true });
      // tab 已由 file_changed(new) 建好（服务端先推事件再回执）；这里只兜底切页/聚焦
      useUIStore.getState().openActivity("files");
      if (r?.alreadyOpen) set({ activePath: p });
      return true;
    } catch (e) {
      set({ error: e?.message ?? "打开失败" });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  /** 关闭：本地删 tab（activePath 移到邻居），发 editor.close_file 单向通知后端清理。modified 的确认由 UI 层决定（当前=直接丢草稿，已拍板） */
  closeFile(p) {
    removeLocal(p);
    bus.emit("editor.close_file", { path: p }, { net: true });
  },

  /** 关当前 tab（快捷键 Ctrl+Alt+/）：“当前”的语义收在 store 里，UI 层不必自己拼 activePath + closeFile */
  closeActive() {
    const p = get().activePath;
    if (p) get().closeFile(p);
  },

  switchTab(p) {
    set({ activePath: p });
  },

  /** 上一个/下一个 tab（编辑器页 Ctrl+; / Ctrl+'）：按打开顺序循环，一个文件时原地踏步 */
  stepTab(dir) {
    const { files, activePath } = get();
    const n = files.length;
    if (n < 2) return;
    const i = files.findIndex((f) => f.path === activePath);
    // 无激活（i<0）时的落点：向后 → 头一个；向前 → 末一个
    const base = i < 0 ? (dir > 0 ? -1 : 0) : i;
    const next = files[(base + dir + n) % n];
    // cycleAt = “快捷键切过”的唯一信号（UI 拿它弹开清单）；手动点 tab 走 switchTab，不打点
    if (next) set({ activePath: next.path, cycleAt: Date.now() });
  },

  /** 键入回调（CodeMirror updateListener）：只动 content → modified 成立 */
  setBuffer(p, content) {
    set((s) => ({ files: patch(s.files, p, { content }) }));
  },

  setScrollPos(p, pos) {
    set((s) => ({ files: patch(s.files, p, { scrollPos: pos }) }));
  },

  toggleMode() {
    set((s) => ({ mode: s.mode === "edit" ? "preview" : "edit" }));
  },

  toggleLineWrapping() {
    set((s) => ({ lineWrapping: !s.lineWrapping }));
  },

  clearError() {
    set({ error: null });
  },

  /** 保存（显式触发）。回执 ok 才对齐 original；保存期间内容又被改（继续键入/后端推送）则保持现状，绝不误标 clean */
  async saveFile(p) {
    const f = get().files.find((x) => x.path === p);
    if (!f || f.content === f.original) return true; // 无改动：无事可做
    const snapshot = f.content;
    try {
      await waitOnline();
      set({ busy: true, error: null });
      await bus.request("editor.update", { path: p, content: snapshot }, { net: true });
      set((s) => ({
        files: s.files.map((x) =>
          x.path === p && x.content === snapshot ? { ...x, original: snapshot } : x
        ),
      }));
      return true;
    } catch (e) {
      set({ error: e?.message ?? "保存失败" }); // 维持 modified 待重试
      return false;
    } finally {
      set({ busy: false });
    }
  },
}));

// ── 模块级小工具（组件只读 store，不改） ────────────────────────────────────

/** 按 path 更新单条；不在表则原样返回（忽略未知 path，幂等） */
const patch = (arr, p, fields) => arr.map((x) => (x.path === p ? { ...x, ...fields } : x));

/** 本地移除（幂等）。activePath 是被删者 → 移到邻居（优先同位的后一个，没有则前一个） */
function removeLocal(p) {
  const s = useEditorStore.getState();
  const idx = s.files.findIndex((f) => f.path === p);
  if (idx < 0) return;
  const files = s.files.filter((f) => f.path !== p);
  let activePath = s.activePath;
  if (activePath === p) {
    activePath = files.length ? files[Math.min(idx, files.length - 1)].path : null;
  }
  useEditorStore.setState({ files, activePath });
}

// —— 订阅挂 bus 上（重连不重做）；服务器 $conn.open 一建立就推 editor.files，无需联网动作 ——

// 全量快照：重连/换终端恢复现场；服务重启后为空列表 = 清场。优先保留原 active，不在则回第一个
bus.on("editor.files", (s) => {
  const list = s?.files ?? [];
  const files = list.map((f) => ({
    name: f.name, path: f.path, content: f.content, original: f.content, scrollPos: 0,
  }));
  const st = useEditorStore.getState();
  const activePath = files.some((f) => f.path === st.activePath)
    ? st.activePath
    : files[0]?.path ?? null;
  useEditorStore.setState({ files, activePath });
});

// 增量：new 建 tab + 聚焦；modify 整条覆盖（后端为准）；delete 本地移除
bus.on("editor.file_changed", (c) => {
  if (!c?.path || !c.type) return;
  const st = useEditorStore.getState();
  if (c.type === "new") {
    const entry = { name: c.name, path: c.path, content: c.content ?? "", original: c.content ?? "", scrollPos: 0 };
    const exist = st.files.some((f) => f.path === c.path);
    useEditorStore.setState({
      files: exist ? st.files.map((f) => (f.path === c.path ? entry : f)) : [...st.files, entry],
      activePath: c.path, // 新文件被打开 → 自动聚焦（nav 打开 / 他处场景同理）
    });
  } else if (c.type === "modify") {
    useEditorStore.setState((s) => ({
      files: s.files.map((f) =>
        f.path === c.path ? { ...f, content: c.content ?? "", original: c.content ?? "" } : f
      ),
    }));
  } else if (c.type === "delete") {
    removeLocal(c.path); // 不发 close 事件：服务端已自行清理
  }
});
