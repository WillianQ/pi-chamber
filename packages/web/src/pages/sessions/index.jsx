import { useMemo, useState } from "react";
import { Alert, Button, Flex, Popconfirm, Select, Space, Typography } from "antd";
import { CloseOutlined, DeleteOutlined, FolderOpenOutlined, PlusOutlined } from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { useChatStore, useSessionsStore, sessionsActions, sortRows } from "../../stores/index.js";
import DirPicker from "../../components/DirPicker.jsx";

// 左面板：三段式 —— 当前 Session 头部块 / 出勤史（滚动区）/ 底部（Agent 选择 + 新建双钮）。
// 版式沿用老 chamber SessionItem：**扁平行**（发丝分隔线，不画框中框），
//   row1 = 名称（焦点行左竖条 + 底色 + 标题主色），row2 = 灯 | 时间 | 条数（mono 辅助信息）。
// 交互：点任意位置 = 打开/切换焦点；hover 右侧浮现 ✕（收工，仅运行时在册时）与 🗑（销毁，必确认）。
// ★ 灯与状态全部来自服务端（status 五值：pending 琥珀 / running 蓝 / compacting 紫 / idle 绿 / offline 灰）——
//   前端不再推导（旧的 opening/ghosts/busy/open 四灯四方拼接已废）。
const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const shortId = (id) => (id ? id.split("-").slice(-1)[0].slice(0, 6) : "");

/** 数字缩写：1200000 → 1.2M / 45000 → 45k */
const fmtN = (n) => {
  if (n == null) return "?";
  if (n >= 1e6) {
    const v = n / 1e6;
    return (v % 1 === 0 ? v : v.toFixed(1)) + "M";
  }
  if (n >= 1e3) {
    const v = n / 1e3;
    return (v % 1 === 0 ? v : v.toFixed(1)) + "k";
  }
  return String(n);
};

/** 目录名：cwd 最后一段（全路径太长，头部只报“哪个 Agent”） */
function basename(p) {
  if (!p) return null;
  const s = String(p).replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 参数行：模型 | 推理档 | 成本 */
function paramLine(model, thinkingLevel, info) {
  const parts = [];
  if (model) parts.push(model);
  if (thinkingLevel) parts.push(thinkingLevel);
  if (info?.cost) parts.push(`$${info.cost.toFixed(3)}`);
  return parts.length ? parts.join(" | ") : null;
}

/** 用量行（最之前那种）：↑输入 ↓输出 R缓存 32k/1M 8%（整场累计，含被压缩掉的历史；
 *  刚压缩完 contextTokens 为 null → 上下文那两项不出现，只留 token 计数） */
function usageLine(info) {
  if (!info) return null;
  const parts = [];
  if (info.input) parts.push(`↑${fmtN(info.input)}`);
  if (info.output) parts.push(`↓${fmtN(info.output)}`);
  if (info.cacheRead) parts.push(`R${fmtN(info.cacheRead)}`);
  if (info.contextTokens) parts.push(`${fmtN(info.contextTokens)}/${fmtN(info.contextWindow)}`);
  if (info.contextPercent != null) parts.push(`${Math.round(info.contextPercent)}%`);
  return parts.length ? parts.join(" ") : null;
}

/** 头部块的三行 mono 小字（@目录 / 参数 / 用量）共用一套样子 */
const headLine = {
  fontFamily: T.fontFamily.mono,
  fontSize: T.fontSize.xs,
  lineHeight: T.lineHeight.xs,
  color: T.color.textMuted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** 出勤显示名：服务端合成的 name（sessionName || 首条消息）→ sessionId 短码 */
const sessionTitle = (s) => {
  const t = (s.name || "").replace(/\s+/g, " ").trim();
  if (t) return t.length > 36 ? t.slice(0, 36) + "…" : t;
  return shortId(s.id);
};

/** 状态灯：服务端 status 五值（pending 本地在途 / running 跑 / compacting 压缩 / idle 待机 / offline 只有档案） */
const LAMP = {
  pending: T.color.lampBoot,
  running: T.color.lampRun,
  compacting: T.color.summary,
  idle: T.color.lampIdle,
  offline: T.color.lampOff,
};
function Lamp({ status }) {
  const c = LAMP[status] ?? T.color.lampOff;
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: c,
        flex: "0 0 auto",
        // 在途/运行中给点动感，静态截图里也读得出"活着"
        animation: status === "running" || status === "pending" ? "pc-lamp-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/** 扁平行（列表行专用；顶部那个头部块刻意不共用此渲染，两者不能被认成一类）：
 *  row1 = 名称（焦点行左竖条 + 底色 + 标题主色），row2 = 灯 | 时间 | 条数。
 *  点任意位置 = 打开/切换焦点；hover 右侧浮现 ✕（收工，仅运行时在册时）与 🗑（销毁，必确认）。 */
function SessionRow({ row, isActive, hovered, setHoverId }) {
  const { openSession, closeSession, deleteSession } = sessionsActions;
  const id = row.id;
  const online = row.status !== "offline"; // 运行时在册才有「收工」可点
  return (
    <div
      onClick={() => !isActive && openSession(id)}
      onMouseEnter={() => setHoverId(id)}
      onMouseLeave={() => setHoverId(null)}
      style={{
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 8,
        // 老 chamber 扁平行：发丝分隔线 + 焦点左竖条，不画圆角框（根治"一筐一筐"）
        padding: "10px 12px",
        borderBottom: `1px solid ${T.color.hairline}`,
        borderLeft: `2px solid ${isActive ? T.color.primary : "transparent"}`,
        background: isActive
          ? T.color.activeRowBg
          : hovered
            ? T.color.hoverBg // hover 只轻微提亮，不加描边
            : "transparent",
        transition: "background 0.15s",
      }}
    >
      {/* 左：row1 名称 / row2 灯|时间|条数 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: T.fontSize.sm, // 标题 = 正文档 14
            lineHeight: T.lineHeight.base,
            color: isActive ? T.color.primary : undefined, // 焦点行标题染主色蓝（与左竖条同色，不加粗）
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sessionTitle(row)}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 4,
            fontSize: T.fontSize.xs, // row2 = 辅助档 12
            lineHeight: T.lineHeight.base,
            fontFamily: T.fontFamily.mono, // 时间/条数 mono，数字不跳动
            color: T.color.textMuted,
          }}
        >
          <Lamp status={row.status} />
          <span>{fmtTime(row.updateTime)}</span>
          <span>·</span>
          <span>{row.messageCount} 条</span>
        </div>
      </div>

      {/* 右：操作区 —— 常驻行尾（触屏无 hover，不浮盖标题）；收工钮仅运行时在册才摆，销毁恒摆 */}
      <Space size={2} style={{ flexShrink: 0 }}>
        {online && (
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              closeSession(id);
            }}
          />
        )}
        <Popconfirm
          title="销毁这个 Session？"
          description="对话记录将永久删除"
          okText="销毁"
          okButtonProps={{ danger: true }}
          onConfirm={(e) => {
            e?.stopPropagation?.();
            deleteSession(id);
          }}
          onCancel={(e) => e?.stopPropagation?.()}
        >
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => e.stopPropagation()}
          />
        </Popconfirm>
      </Space>
    </div>
  );
}

export default function SessionsPage() {
  const agents = useSessionsStore((s) => s.agents);
  const selectedCwd = useSessionsStore((s) => s.selectedCwd);
  const sessions = useSessionsStore((s) => s.sessions);
  const creating = useSessionsStore((s) => s.creating);
  const error = useSessionsStore((s) => s.error);
  const { selectAgent, createSession } = sessionsActions;
  const activeId = useChatStore((s) => s.activeId);
  // 激活 Session 的现场（chat.sync 带来，与 chat 头部同源）：cwd / 模型 / 强度 / 用量 / 成本
  const activeCwd = useChatStore((s) => s.cwd);
  const model = useChatStore((s) => s.model);
  const thinkingLevel = useChatStore((s) => s.thinkingLevel);
  const info = useChatStore((s) => s.info);
  const [hoverId, setHoverId] = useState(null); // 只有 hover 行显示操作区
  const [pickOpen, setPickOpen] = useState(false); // DirPicker 弹窗
  // 展示序：焦点 → 活着 → 其余按最近动过（updateTime）新到旧（规则细节在 sessions-store.js 的 sortRows）
  const rows = useMemo(() => sortRows(sessions, activeId), [sessions, activeId]);
  // 焦点行照旧留在列表里（不剔除）；头部只是把“你现在在哪一场”说清楚
  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  // 名字：名册行里有就用它（同目录）；焦点属于别的目录→名册里没这行，退化成短码
  const activeName = activeRow ? sessionTitle(activeRow) : shortId(activeId);
  const dirName = basename(activeCwd);
  const paramStr = paramLine(model, thinkingLevel, info);
  const usageStr = usageLine(info);
  const canJump = !!activeCwd && activeCwd !== selectedCwd; // 已在该目录就没必要再发一次 list

  return (
    <Flex vertical style={{ height: "100%" }}>
      {/* 当前 Session（**头部块**，不是列表行）：名称 / @目录名 / 模型|推理|成本 / ↑↓R + 上下文。
          刻意不像行：无左竖条、无底色、无 hover 操作钮、名称不染主色（不高亮）——
          把“你现在在哪一场”说清楚就够。它照旧留在下面清单里，不剔除也不特殊摆位。
          整块可点 = 在下方 Agent 下拉里选中它所在的目录（已在该目录就没事可做）。 */}
      <Flex
        vertical
        gap={2}
        onClick={() => canJump && selectAgent(activeCwd)}
        title={canJump ? `切到 ${activeCwd}` : undefined}
        style={{
          flexShrink: 0,
          padding: "12px",
          borderBottom: `1px solid ${T.color.hairline}`,
          cursor: canJump ? "pointer" : "default",
        }}
      >
        {/* 名称：头部主行（白字 + 半粗；不染主色 = 不高亮） */}
        <div
          style={{
            fontSize: T.fontSize.sm,
            fontWeight: 600,
            lineHeight: T.lineHeight.base,
            color: activeId ? T.color.textPrimary : T.color.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeId ? activeName : "未打开 Session"}
        </div>
        {activeId && (
          <>
            {/* @目录名（hover 看全路径） */}
            {dirName && (
              <div title={activeCwd || undefined} style={headLine}>
                @{dirName}
              </div>
            )}
            {/* 模型 | 推理档 | 成本 */}
            {paramStr && <div style={headLine}>{paramStr}</div>}
            {/* ↑输入 ↓输出 R缓存 32k/1M 8%（hover 看 token 全量） */}
            {usageStr && <div style={headLine}>{usageStr}</div>}
          </>
        )}
      </Flex>

      {/* 分组标题：头部是“当前那一场”，下面这一摧是全部——有它头部不必靠颜色抢眼 */}
      {selectedCwd && sessions.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            padding: "10px 12px 6px",
            fontSize: T.fontSize.xs,
            lineHeight: T.lineHeight.xs,
            color: T.color.textMuted,
          }}
        >
          全部 Session（{sessions.length}）
        </div>
      )}

      {/* 出勤史（通栏无侧边距：行自己管 padding，分隔线才能左右顶满）；
          顶部挂一层渐隐遮罩：列表从它下面钻过去，头部就有了“粘在顶上”的重量 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 10,
            zIndex: 1,
            pointerEvents: "none",
            background: `linear-gradient(${T.color.panelBg}, transparent)`,
          }}
        />
        <div style={{ height: "100%", overflow: "auto" }}>
          {selectedCwd ? (
            sessions.length === 0 ? (
              <Typography.Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 40 }}>
                这个 Agent 还没有 Session
              </Typography.Text>
            ) : (
              rows.map((row) => (
                <SessionRow
                  key={row.id}
                  row={row}
                  isActive={row.id === activeId}
                  hovered={hoverId === row.id}
                  setHoverId={setHoverId}
                />
              ))
            )
          ) : (
            <Typography.Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 40 }}>
              在下方选一个 Agent，再打开或新建 Session
            </Typography.Text>
          )}
        </div>
      </div>

      {/* 底部：Agent 选择 + 新建双钮（按钮放最下面，左右各一） */}
      <div style={{ borderTop: `1px solid ${T.color.hairline}`, padding: 10 }}>
        {error && (
          <Alert
            type="error"
            message={error}
            closable
            showIcon
            style={{ marginBottom: 8 }}
            onClose={() => useSessionsStore.setState({ error: null })}
          />
        )}

        <Select
          style={{ width: "100%" }}
          placeholder="选择 Agent（cwd）"
          value={selectedCwd || undefined}
          onChange={selectAgent}
          options={(agents || []).map((a) => ({
            value: a.cwd,
            label: a.basename,
          }))}
        />

        <Flex gap={8} style={{ marginTop: 8 }}>
          <Button
            style={{ flex: 1 }}
            icon={<PlusOutlined />}
            loading={creating}
            disabled={!selectedCwd || creating}
            onClick={() => createSession()}
          >
            当前目录
          </Button>
          <Button style={{ flex: 1 }} icon={<FolderOpenOutlined />} disabled={creating} onClick={() => setPickOpen(true)}>
            选择目录…
          </Button>
        </Flex>
      </div>

      {/* 从桌面起的目录选择器：选完即建（服务端把名册目录切过去，左栏跟过去） */}
      <DirPicker
        open={pickOpen}
        onClose={() => setPickOpen(false)}
        onPick={(cwd) => {
          setPickOpen(false);
          createSession(cwd);
        }}
      />
    </Flex>
  );
}
