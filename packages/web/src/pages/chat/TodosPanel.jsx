// 待办面板（todos 插件）：焦点 Session 的清单 + 进度，挂在输入框上方。
//
// 数据源 = sessions-store 的 `pluginState[activeId].todos`（**帧驱动，服务端是唯一真值**）：
//   · 工具每写一次 → 服务端推一次 agent.plugin.state（该场全量）；连接 / open 时补推。
//   · 空清单 / 没这个插件 → 整块不渲染（零打扰）。
//
// 两个展开状态（纯展示层，不碰数据）：
//   ① **自动退场**：全部 done → 自己折叠成一条绿细条（`✔ 5/5 全部完成`），把地方让回给输入框；
//      不清数据 —— 点一下照样展开回看，模型下次更新（新的一条 waiting）也会自动重新展开。
//      为什么不靠模型主动清空：它经常忘；且"干完了"该由界面自己认，不该求模型配合（实测）。
//   ② 手动：点标题行随时折叠/展开，直到下一份清单到达（新清单 → 回到自动行为）。
//
// ★ 为什么读 sessions-store 而不是 chat-store：状态是**按场**存的（后台 subagent 的进度也要能显），
//   而且换会话不该丢 —— 见 stores/sessions-store.js 的 pluginState 头注。
import { useEffect, useState } from "react";
import { alpha, palette, T } from "../../theme/tokens.js";
import { useChatStore, useSessionsStore } from "../../stores/index.js";

/** 稳定空引用：selector 每次返回新数组会让 zustand 反复重渲染 */
const NONE = [];

const MARK = { done: "✔", doing: "▸", waiting: "☐" };

export default function TodosPanel() {
  const activeId = useChatStore((s) => s.activeId);
  const todos = useSessionsStore((s) => (activeId ? s.pluginState[activeId]?.todos : null) ?? NONE);
  // null = 跟自动行为走；true/false = 用户手动开合过。下一份清单到达就归位（见下）
  const [manual, setManual] = useState(null);
  useEffect(() => setManual(null), [todos]);

  if (!todos.length) return null;
  const total = todos.length;
  const done = todos.filter((t) => t.status === "done").length;
  const doing = todos.find((t) => t.status === "doing");
  const allDone = done === total;
  const open = manual ?? !allDone; // 自动退场：全完成就折叠

  return (
    <div
      style={{
        background: T.card.neutral.bg,
        border: `1px solid ${T.card.neutral.border}`,
        borderRadius: T.radius.base,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      {/* 标题行：折叠开关 + 进度条 + 计数（+ 折叠时的"正在做"） */}
      <div
        onClick={() => setManual(!open)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ color: T.color.textFaint, fontSize: T.icon.xs, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span
          style={{
            fontFamily: T.fontFamily.mono,
            fontSize: T.fontSize.xs,
            color: T.color.textFaint,
            letterSpacing: 1,
            flexShrink: 0,
          }}
        >
          TODO
        </span>
        <div style={{ flex: 1, minWidth: 40, height: 4, background: alpha(palette.white, 0.12), borderRadius: 2 }}>
          <div
            style={{
              width: `${Math.round((done / total) * 100)}%`,
              height: "100%",
              borderRadius: 2,
              background: allDone ? T.color.ok : T.color.primary,
              transition: "width .2s",
            }}
          />
        </div>
        <span
          style={{
            fontFamily: T.fontFamily.mono,
            fontSize: T.fontSize.xs,
            color: allDone ? T.color.ok : T.color.textMuted,
            flexShrink: 0,
          }}
        >
          {allDone ? `✔ ${done}/${total} 全部完成` : `${done}/${total}`}
        </span>
        {doing && !open && (
          <span
            style={{
              maxWidth: "40%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: T.fontFamily.mono,
              fontSize: T.fontSize.xs,
              color: T.color.primary,
              flexShrink: 1,
            }}
          >
            ▸ {doing.description}
          </span>
        )}
      </div>

      {/* 清单（展开时；长了就滚，别把输入框顶走） */}
      {open && (
        <div style={{ padding: "0 10px 6px", maxHeight: 180, overflowY: "auto" }}>
          {todos.map((t, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "flex-start",
                fontFamily: T.fontFamily.mono,
                fontSize: T.fontSize.xs,
                lineHeight: T.lineHeight.sm,
                color:
                  t.status === "done" ? T.color.textMuted : t.status === "doing" ? T.color.primary : T.color.textBody,
                textDecoration: t.status === "done" ? "line-through" : "none",
              }}
            >
              <span style={{ flexShrink: 0 }}>{MARK[t.status] ?? MARK.waiting}</span>
              <span style={{ wordBreak: "break-word" }}>{t.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
