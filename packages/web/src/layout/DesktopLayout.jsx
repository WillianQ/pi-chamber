import { lazy, useCallback, useEffect, useRef, useState, Suspense } from "react";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { T } from "../theme/tokens.js";
import SessionsPage from "../pages/sessions/index.jsx";
import ChatPage from "../pages/chat/index.jsx";
import NavPage from "../pages/nav/index.jsx";
import SettingsPage from "../pages/settings/index.jsx";
import ActivityBar from "./ActivityBar.jsx";
import { useUIStore } from "../stores/index.js";
import { matchShortcut } from "../shortcuts.js";

// 编辑器页懒加载：CodeMirror 全家不进首屏（bar 点「编辑器」/单击文件时才拉 chunk）
const EditorPage = lazy(() => import("../pages/editor/index.jsx"));
// 终端页懒加载：xterm 全家同样不进首屏
const TerminalPage = lazy(() => import("../pages/terminal/index.jsx"));

// 桌面工作台（纯三栏到底，无全局顶栏）：
//   [把手（最左常驻） | session 管理（可收起） | Chat（常驻） | 活动页面 | bar（最右）]
// 三栏各自独立滚动；bar 选谁，活动页槽加载谁（导航/编辑器/设置）。
// 活动页开关 = useUIStore（导航页单击文件要自动切到编辑器页），不在此地私藏。
// 配色纪律：左面板/活动页 = 面板层 panelBg，Chat 区 = 画布 pageBg（与消息流同底）。
const SESS_W = 270;
const BAR_W = 44;
const CHAT_MIN = 400;
const ACT_MIN = 280;

const ACTIVITY_PAGES = {
  nav: NavPage,
  files: EditorPage,
  term: TerminalPage,
  settings: SettingsPage,
};

export function DesktopLayout() {
  const containerRef = useRef(null);

  // session 面板折叠（住 useUIStore：最左把手 + 快捷键 Ctrl+` 两处改口）
  const sessOpen = useUIStore((s) => s.sessionsOpen);
  const toggleSessions = useUIStore((s) => s.toggleSessions);
  // 活动页开关住 useUIStore（'nav' | 'files' | 'settings' | null；null=收起）
  const activity = useUIStore((s) => s.activity);
  const toggleActivity = useUIStore((s) => s.toggleActivity);
  // 活动页宽度（可拖拽，chat 是 flex-1 自动吸收）
  const [actWidth, setActWidth] = useState(400);
  const dragRef = useRef(null);

  // ── 全局快捷键（桌面端）─────────────────────────────────────────────
  // 键位、说明、动作全在 src/shortcuts.js 一张表里（设置页渲染同一张表）；这里只做通用派发，
  // 本身不认识任何具体键——改键改表，别在这里加分支。
  // capture 阶段收：任何子层（CodeMirror / antd）即使 stopPropagation 也挡不住；
  // 未命中的键原样下落，输入与输入法完全不受影响（CodeMirror 的 Ctrl+/ 注释因此完好）。
  useEffect(() => {
    const onKey = (e) => {
      const hit = matchShortcut(e);
      if (!hit) return;
      // 编辑器类快捷键只在编辑器面板展开时生效：不设这道门，
      // 会把输入法的标点类 Ctrl 组合（各家 IME 爱占）也吞掉
      if (hit.scope === "editor" && activity !== "files") return;
      e.preventDefault();
      hit.run(e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activity]);

  // ── 活动页宽度拖拽 ────────────────────────────────────────────────
  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: actWidth };
  }, [actWidth]);

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const container = containerRef.current;
      if (!container) return;
      // 边界右移（向 bar 拖）→ 活动页变窄
      const avail =
        container.clientWidth - (sessOpen ? SESS_W : 0) - 16 - BAR_W - CHAT_MIN;
      const next = Math.max(
        ACT_MIN,
        Math.min(d.startW + (d.startX - e.clientX), Math.max(ACT_MIN, avail))
      );
      setActWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [sessOpen]);

  return (
    <div ref={containerRef} className="pc-shell" style={{ display: "flex", height: "100%" }}>
      {/* ⓪ 收起/展开把手：最左侧常驻细条，位置不随面板开合挪动；整条可点（hover 全高亮提示） */}
      <div
        onClick={toggleSessions}
        className="pc-baritem"
        title={`${sessOpen ? "收起" : "展开"} Session 面板 (Ctrl+\`)`}
        style={{
          width: 16,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: T.color.pageBg,
          borderRight: `1px solid ${T.color.hairline}`,
          color: T.color.textMuted,
          cursor: "pointer",
          fontSize: T.icon.xs,
          userSelect: "none",
        }}
      >
        {sessOpen ? <LeftOutlined /> : <RightOutlined />}
      </div>

      {/* ① Session 管理（可收起；收起时 Chat 自动变宽） */}
      <div
        style={{
          width: sessOpen ? SESS_W : 0,
          flexShrink: 0,
          overflow: "hidden",
          background: T.color.panelBg,
          // 面板与 Chat 的分隔线（把手已在最左，这里自带右 border；收起时不画免得双线）
          borderRight: sessOpen ? `1px solid ${T.color.hairline}` : "none",
          transition: "width .18s ease",
        }}
      >
        <SessionsPage />
      </div>

      {/* ② Chat（常驻核心）——画布底 */}
      <div
        style={{
          flex: 1,
          minWidth: CHAT_MIN,
          minHeight: 0,
          background: T.color.pageBg,
        }}
      >
        <ChatPage />
      </div>

      {/* ③ 活动页面槽（bar 选择；可拖宽） */}
      {activity !== null && (
        <>
          {/* 拖拽把手 */}
          <div
            onMouseDown={onDragStart}
            className="pc-hresize"
            style={{
              width: 5,
              flexShrink: 0,
              cursor: "col-resize",
              background: "transparent",
            }}
          />
          <div
            style={{
              width: actWidth,
              flexShrink: 0,
              overflow: "hidden",
              background: T.color.panelBg,
              borderLeft: `1px solid ${T.color.hairline}`,
            }}
          >
            <Suspense fallback={null}>
              {(() => {
                const Page = ACTIVITY_PAGES[activity];
                return Page ? <Page /> : null;
              })()}
            </Suspense>
          </div>
        </>
      )}

      {/* ④ 最右 bar */}
      <ActivityBar active={activity} onSelect={toggleActivity} />
    </div>
  );
}
