// 移动端三页布局（竖向整屏，左右滑动翻页，scroll-snap）：
//   [0 Session 面板 | 1 聊天 | 2 活动页（内部底条切 导航/编辑器/设置）]
// 与桌面三栏同构——面板 → chat → 活动槽 + 选择器，只是把"并排"改成"翻页"：
//   - 壳最顶悬浮页点指示（不占高度、纯指示不可点：穿透不拦内容点击）
//   - 吸附：子页 scroll-snap-align + scroll-snap-stop:always（一页一停、fling 不跳页），
//     JS 兑底——滑动停止 250ms 后仍停在半页则平滑吸到最近页
//   - 点 session 行 / 新建（只发生在面板页）→ 焦点变化 → 自动滑到聊天页
//   - nav 里点文件 → 编辑器在第三页槽内自换（openFile 已切 activity='files'），无需翻页
// 子页一律 overflow:hidden：纵向滚动全在页面自己的内部滚动区，避免双层滚动条。
// 高度用 fixed inset 0（不依赖 #root 高度链），safe-area 顶部让位灵动岛、底部让位 home 条。
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  CompassOutlined,
  FileTextOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { alpha, T } from "../theme/tokens.js";
import { useChatStore, useUIStore } from "../stores/index.js";
import SessionsPage from "../pages/sessions/index.jsx";
import ChatPage from "../pages/chat/index.jsx";
import NavPage from "../pages/nav/index.jsx";
import SettingsPage from "../pages/settings/index.jsx";

// 编辑器懒加载（CodeMirror chunk 不进首屏），切到第三页的「编辑器」才拉
const EditorPage = lazy(() => import("../pages/editor/index.jsx"));

const PAGE_COUNT = 3;
const CHAT_IDX = 1; // 默认落地 = 聊天（中间页）

const ACT_TABS = [
  { id: "nav", label: "导航", icon: <CompassOutlined /> },
  { id: "files", label: "编辑器", icon: <FileTextOutlined /> },
  { id: "settings", label: "设置", icon: <SettingOutlined /> },
];

const pageStyle = {
  flex: "0 0 100%",
  width: "100%",
  overflow: "hidden",
  scrollSnapAlign: "start", // 没它 snap 不生效（容器只设了 type，子页缺 align）→ 会停在两页中间
  scrollSnapStop: "always", // fling 大动量也一页一停，不跳页
};

export function MobileLayout() {
  const scrollRef = useRef(null);
  const idxRef = useRef(CHAT_IDX);
  const programRef = useRef(false); // 程序滚动中：scroll 回调不抢 idx（防 snapTo 平滑滚动中途被手指残留事件打乱）
  const settleRef = useRef(null); // 手滑停止后吸附防抖（snap 失效兜底）
  const resetRef = useRef(null); // 程序滚动复位 programRef
  const [idx, setIdx] = useState(CHAT_IDX);

  const snapTo = (i) => {
    const el = scrollRef.current;
    if (!el || i === idxRef.current) return;
    idxRef.current = i;
    setIdx(i);
    programRef.current = true;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      programRef.current = false;
    }, 700); // 平滑动画多半 <700ms；动画尾帧若仍被当"手动"也无碍（settle 判整页）
  };

  // 落点非整页（CSS snap 失效的旧浏览器/异常）→ 平滑吸到最近页
  const settleSnap = () => {
    const el = scrollRef.current;
    if (!el || programRef.current) return;
    const frac = el.scrollLeft / el.clientWidth;
    const i = Math.round(frac);
    if (i >= 0 && i < PAGE_COUNT && Math.abs(frac - i) > 0.02 && i !== idxRef.current) snapTo(i);
  };

  useEffect(() => {
    return () => {
      clearTimeout(settleRef.current);
      clearTimeout(resetRef.current);
    };
  }, []);

  // 首屏落点 = 聊天页。初始 state 已是 CHAT_IDX，但浏览器初始 scrollLeft=0（首个 snap 页）
  // → 不主动滚一次，打开的其实是 Session 面板。无动画直跳，别让人看见横移过程。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const jump = () => {
      el.scrollLeft = CHAT_IDX * el.clientWidth;
    };
    jump();
    const raf = requestAnimationFrame(jump); // 首帧布局未稳（安全区/字体）再补一次
    return () => cancelAnimationFrame(raf);
  }, []);

  // 滑动 → 同步当前页（程序滚动期间忽略）；停下 250ms 后做一次吸附检查
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      clearTimeout(settleRef.current);
      settleRef.current = setTimeout(settleSnap, 250);
      if (programRef.current) return;
      const i = Math.round(el.scrollLeft / el.clientWidth);
      if (i >= 0 && i < PAGE_COUNT && i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 焦点 session 变化 → 自动滑到聊天页。只响应"人正在面板页(0)"的场合：
  // 点行/新建都在面板页发生；断线重连恢复现场（人在聊天/活动页）不会被拖走。
  useEffect(() => {
    let prev = useChatStore.getState().activeId ?? null;
    return useChatStore.subscribe((s) => {
      const next = s.activeId ?? null;
      if (next && next !== prev && idxRef.current === 0) snapTo(CHAT_IDX);
      prev = next;
    });
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: T.color.pageBg,
      }}
    >
      {/* 翻页区 */}
      <div
        ref={scrollRef}
        className="pc-hsnap"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflowX: "auto",
          scrollSnapType: "x mandatory",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* 第0页套 panelBg：与活动页（NavPage/ActivityPanel）同底，手机三页不再一页暗一页亮 */}
        <div style={{ ...pageStyle, background: T.color.panelBg }}>
          <SessionsPage />
        </div>
        <div style={pageStyle}>
          <ChatPage />
        </div>
        <div style={pageStyle}>
          <ActivityPanel />
        </div>
      </div>
    </div>
  );
}

// 第三页：活动页槽 + 底条切换（导航/编辑器/设置）。
// activity 从 ui-store 来（nav 点文件自动切 files）；null 时兜底显导航——不动 store，
// 保证桌面"收起"语义不被移动端污染。编辑器页懒加载，切到才拉 CodeMirror chunk。
function ActivityPanel() {
  const activity = useUIStore((s) => s.activity);
  const openActivity = useUIStore((s) => s.openActivity);
  const show = ACT_TABS.some((t) => t.id === activity) ? activity : "nav";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: T.color.panelBg,
      }}
    >
      {/* 槽 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {show === "files" ? (
          <Suspense fallback={null}>
            <EditorPage />
          </Suspense>
        ) : show === "settings" ? (
          <SettingsPage />
        ) : (
          <NavPage />
        )}
      </div>

      {/* 底条：活动切换（手机拇指区；常驻，点谁开谁，无收起态） */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          borderTop: `1px solid ${T.color.hairline}`,
          background: T.color.panelBg,
        }}
      >
        {ACT_TABS.map((t) => {
          const active = t.id === show;
          return (
            <button
              key={t.id}
              onClick={() => openActivity(t.id)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                padding: "10px 0",
                margin: 0,
                cursor: "pointer",
                background: "transparent",
                border: "none",
                borderTop: `2px solid ${active ? T.color.primary : "transparent"}`,
                color: active ? T.color.primary : T.color.textMuted,
                fontSize: T.fontSize.sm,
                userSelect: "none",
                fontFamily: T.fontFamily.sans,
              }}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
