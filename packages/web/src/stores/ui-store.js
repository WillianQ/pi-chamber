// UI 壳层共享态：活动页槽（DesktopLayout）与内部动作（导航页单击文件自动切到编辑器）
// 都要切页，放 zustand 免 props 层层下钻。
// Session 面板开合（sessionsOpen）：最左把手（DesktopLayout）与全局快捷键 Ctrl+`（同为
// DesktopLayout 的 window 监听）两处改口，故上收到这里。
// ACTIVITY_ORDER：右面板循环次序（Ctrl+Q 一格一格往下走，走完最后一格 = 收起，再按从头来），
// 与 DesktopLayout 的 Ctrl+Shift+1/2/4 直键共用同一批 id。
// ★ 不含 "settings"：设置面板不进循环（它靠 Ctrl+. 或最右 bar 手动开关）。
// 活动页宽度（actWidth）与拖拽仍是 DesktopLayout 本地事（纯布局参数，无人旁路），不升级到这里。
import { create } from "zustand";

// 右面板循环次序（与 bar 自上而下的排布一致：导航 / 编辑器 / 终端）
export const ACTIVITY_ORDER = ["nav", "files", "term"];

export const useUIStore = create((set) => ({
  activity: null, // 'nav' | 'files' | 'term' | 'settings' | null（null = 右面板收起）
  sessionsOpen: true, // 左面板（Session 管理）展开态；桌面端专用
  openActivity(id) {
    set({ activity: id });
  },
  toggleActivity(id) {
    set((s) => ({ activity: s.activity === id ? null : id }));
  },
  // 左面板（Session 管理）开合（Ctrl+` / 最左把手）
  toggleSessions() {
    set((s) => ({ sessionsOpen: !s.sessionsOpen }));
  },
  // 右面板列循环（Ctrl+Q）：导航 → 编辑器 → 终端 → 收起 → 导航…（设置不在循环里）
  cycleActivity() {
    set((s) => {
      // 收起时 indexOf = -1 → +1 正好落在头一格；末格 +1 越界 → null（收起）
      const i = ACTIVITY_ORDER.indexOf(s.activity);
      return { activity: ACTIVITY_ORDER[i + 1] ?? null };
    });
  },
}));
