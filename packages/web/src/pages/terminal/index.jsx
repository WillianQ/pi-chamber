// 终端活动页（bar「终端」唤起 / Ctrl+Shift+4）。
// 结构照 editor 页那套语言：顶部细条（当前终端的 cwd · shell · 状态）+ 中部画布 + 底部 TabBar。
//
// 版式要点：
//   · 每个终端一个常驻面板（display 切显隐，**不重建** xterm 实例）——重建就等于清屏，回放又得重来；
//   · 底部 TabBar = 终端清单（序号 + 灯 + ✕）+ 右侧「+ 新建」（下拉选 shell，默认 Git Bash）；
//   · 新建终端的工作目录 = 焦点 Session 的 Agent 空间（本端把 chat.cwd 随 term.create 带上，
//     服务端没有就回退到 nav 的 cwd）；两者都没有 → 落 termd 自己的 cwd。
//
// 数据流全在 term-store：名册来自 term.list 全量帧（服务端唯一真相），
// 输出**不进 store**（直通 xterm），本页只渲染控制态。
import { Flex, Dropdown, Button, Tooltip, Typography } from "antd";
import { CloseOutlined, PlusOutlined, WarningOutlined } from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { useNavStore, useTermStore, termActions } from "../../stores/index.js";
import { relLabel } from "../../path-label.js";
import TermView from "./TermView.jsx";

/** 状态灯：running 蓝 / exited 灰（与 session 灯同色系，含义各不相同：这里是"进程活着/已退出"） */
const lamp = (status) => (status === "running" ? T.color.lampRun : T.color.lampOff);

export default function TerminalPage() {
  const terms = useTermStore((s) => s.terms);
  const shells = useTermStore((s) => s.shells);
  const activeId = useTermStore((s) => s.activeId);
  const creating = useTermStore((s) => s.creating);
  const error = useTermStore((s) => s.error);
  const navCwd = useNavStore((s) => s.cwd);
  const { create, close, setActive, clearError } = termActions;

  const active = terms.find((t) => t.termId === activeId) ?? null;

  return (
    <Flex vertical style={{ height: "100%", background: T.color.panelBg }}>
      {/* 顶部细条：当前终端的 cwd（相对当前 Agent 空间）+ shell + 状态 */}
      <Flex
        align="center"
        gap={8}
        style={{
          flexShrink: 0,
          minHeight: 32,
          padding: "6px 10px",
          borderBottom: `1px solid ${T.color.hairline}`,
          fontFamily: T.fontFamily.mono,
          fontSize: T.fontSize.xs,
          color: T.color.textMuted,
        }}
      >
        {active ? (
          <>
            <span style={{ color: lamp(active.status), fontSize: T.icon.xs, lineHeight: 1 }}>●</span>
            <span
              title={active.cwd}
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {relLabel(active.cwd, navCwd)}
            </span>
            <span style={{ flexShrink: 0, color: T.color.textFaint }}>{active.shellLabel}</span>
            <span style={{ flexShrink: 0, color: T.color.textFaint }}>
              {active.status === "running" ? `${active.cols}×${active.rows}` : `已退出 ${active.exitCode ?? ""}`}
            </span>
          </>
        ) : (
          <span style={{ color: T.color.textFaint }}>终端</span>
        )}
      </Flex>

      {/* 错误条（住 store.error）：多为"终端服务未运行（termd）"这类人话 */}
      {error && (
        <Flex
          align="center"
          gap={6}
          onClick={clearError}
          style={{
            flexShrink: 0,
            padding: "6px 10px",
            background: T.card.error.bg,
            borderBottom: `1px solid ${T.card.error.border}`,
            color: T.color.error,
            fontSize: T.fontSize.xs,
            cursor: "pointer",
          }}
          title="点一下关掉"
        >
          <WarningOutlined />
          <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
        </Flex>
      )}

      {/* 画布：所有终端面板常驻，靠 display 切显隐（隐藏时不量尺寸，见 TermView） */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: T.color.pageBg }}>
        {terms.length === 0 ? (
          <Typography.Text
            type="secondary"
            style={{ display: "block", textAlign: "center", marginTop: 40, fontSize: T.fontSize.xs }}
          >
            还没有终端 —— 点下面「新建」，它会开在当前的 Agent 空间里
          </Typography.Text>
        ) : (
          terms.map((t) => (
            <div
              key={t.termId}
              style={{
                position: "absolute",
                inset: 0,
                display: t.termId === activeId ? "block" : "none",
                padding: "2px 4px 0",
              }}
            >
              <TermView termId={t.termId} visible={t.termId === activeId} />
            </div>
          ))
        )}
      </div>

      {/* 底栏：终端清单 + 新建（下拉选 shell） */}
      <Flex
        align="center"
        gap={4}
        style={{
          flexShrink: 0,
          padding: 8,
          borderTop: `1px solid ${T.color.hairline}`,
          overflowX: "auto",
        }}
      >
        {terms.map((t, i) => {
          const on = t.termId === activeId;
          return (
            <Flex
              key={t.termId}
              align="center"
              gap={4}
              onClick={() => setActive(t.termId)}
              title={`${t.shellLabel} · ${t.cwd}`}
              style={{
                flexShrink: 0,
                height: 32,
                padding: "0 6px 0 8px",
                borderRadius: T.radius.sm,
                cursor: "pointer",
                background: on ? T.color.activeRowBg : "transparent",
                color: on ? T.color.primary : T.color.textMuted,
                fontSize: T.fontSize.xs,
                fontFamily: T.fontFamily.mono,
                userSelect: "none",
              }}
            >
              <span style={{ color: lamp(t.status), fontSize: T.icon.xs, lineHeight: 1 }}>●</span>
              <span>{`终端 ${i + 1}`}</span>
              <Tooltip title="关闭（真杀进程）">
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.termId);
                  }}
                  style={{ display: "flex", padding: "0 2px", color: T.color.textFaint, fontSize: T.icon.xs }}
                >
                  <CloseOutlined />
                </span>
              </Tooltip>
            </Flex>
          );
        })}

        <div style={{ flex: 1, minWidth: 8 }} />

        <Dropdown
          trigger={["click"]}
          disabled={creating}
          menu={{
            items: (shells.length ? shells : [{ id: "", label: "默认 shell" }]).map((s) => ({
              key: s.id,
              label: s.label,
            })),
            onClick: ({ key }) => create(key || undefined),
          }}
        >
          <Button size="small" type="text" loading={creating} icon={<PlusOutlined />} title="新建终端（下拉选 shell）">
            新建
          </Button>
        </Dropdown>
      </Flex>
    </Flex>
  );
}
