// 快捷键的唯一真相：一张表同时喂三个消费者 ——
//   DesktopLayout（window capture 监听，用 matchShortcut 通用匹配，本身不认识任何具体键）
//   设置页（照本表渲染说明）
//   将来文档 / 移动端长按菜单。
// 改键只改这里一处，说明与行为不可能对不上。
//
// 两条纪律（match 的全等比较天然满足）：
//  ① 只认 Ctrl、不认 Cmd —— Mac 上 Cmd+Q 退应用 / Cmd+` 切窗口 / Cmd+1..9 切标签都是系统与浏览器保留的。
//  ② 一律比 e.code（物理码位，与键盘布局无关），不比 e.key（Shift+1 的 key 是 "!"，中文布局又不同）。
//
// 字段：mods = 三个修饰键必须“全等”（防止 Ctrl+Shift+X 误命中 Ctrl+X 这类项）；
//       codes = 接受哪些物理码位（同一动作可多个）；scope = "global" 全局 | "editor" 仅编辑器面板展开时。
import { useUIStore } from "./stores/ui-store.js";
import { useEditorStore } from "./stores/editor-store.js";

// zustand store 在事件回调里直接 getState 取动作：快捷键表不该被 React 订阅绑住
const ui = () => useUIStore.getState();
const ed = () => useEditorStore.getState();

const CTRL = { ctrl: true, shift: false, alt: false };
const CTRL_SHIFT = { ctrl: true, shift: true, alt: false };
const CTRL_ALT = { ctrl: true, shift: false, alt: true };

/** 设置页分组（顺序 = 显示顺序） */
export const SHORTCUT_GROUPS = [
  { id: "panel", title: "面板" },
  { id: "editor", title: "编辑器" },
];

export const SHORTCUTS = [
  {
    group: "panel",
    keys: "Ctrl+`",
    label: "左面板（Session 管理）开合",
    mods: CTRL,
    codes: ["Backquote"],
    scope: "global",
    run: () => ui().toggleSessions(),
  },
  {
    group: "panel",
    keys: "Ctrl+Q",
    label: "右面板循环：导航 → 编辑器 → 收起",
    mods: CTRL,
    codes: ["KeyQ"],
    scope: "global",
    run: () => ui().cycleActivity(),
  },
  {
    group: "panel",
    keys: "Ctrl+Shift+1 / 2 / 3 / 4",
    label: "右面板直跳：1 导航 · 2 编辑器 · 3 设置 · 4 终端（再按同键 = 收起）",
    mods: CTRL_SHIFT,
    codes: ["Digit1", "Digit2", "Digit3", "Digit4"],
    scope: "global",
    run: (e) =>
      ui().toggleActivity({ Digit1: "nav", Digit2: "files", Digit3: "settings", Digit4: "term" }[e.code]),
  },
  {
    group: "panel",
    keys: "Ctrl+.",
    label: "设置面板开合",
    mods: CTRL,
    codes: ["Period"],
    scope: "global",
    run: () => ui().toggleActivity("settings"),
  },
  {
    group: "editor",
    keys: "Ctrl+;",
    label: "上一个文件（顺带弹开文件清单）",
    mods: CTRL,
    codes: ["Semicolon"],
    scope: "editor",
    run: () => ed().stepTab(-1),
  },
  {
    group: "editor",
    keys: "Ctrl+'",
    label: "下一个文件（顺带弹开文件清单）",
    mods: CTRL,
    codes: ["Quote"],
    scope: "editor",
    run: () => ed().stepTab(1),
  },
  {
    group: "editor",
    keys: "Ctrl+Alt+/",
    label: "关闭当前文件（未保存的改动直接丢，与 tab 上的 ✕ 同）",
    mods: CTRL_ALT,
    codes: ["Slash"],
    scope: "editor",
    run: () => ed().closeActive(),
  },
];

/** 通用匹配：修饰键全等 + 物理码位命中 → 条目；否则 null */
export function matchShortcut(e) {
  return (
    SHORTCUTS.find(
      (s) =>
        s.mods.ctrl === e.ctrlKey &&
        s.mods.shift === e.shiftKey &&
        s.mods.alt === e.altKey &&
        s.codes.includes(e.code)
    ) ?? null
  );
}
