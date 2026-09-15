import { useEffect } from "react";
import { Alert, Empty, Flex, Tag } from "antd";
import { useChatStore, chatActions } from "../../stores/index.js";
import MessageList from "./MessageList.jsx";
import InputBox from "./InputBox.jsx";
import TodosPanel from "./TodosPanel.jsx";
import ConnStatus from "../../components/ConnStatus.jsx";
import { T } from "../../theme/tokens.js";

/** 成本：整场累计花费（含被压缩掉的历史） */
function costLine(info) {
  if (!info?.cost) return null;
  return `$${info.cost.toFixed(3)}`;
}

/** 上下文占用：只报百分比（刚压缩完 contextTokens 为 null → 不显示，占位交给下一轮） */
function contextLine(info) {
  if (info?.contextPercent == null) return null;
  return `${Math.round(info.contextPercent)}%`;
}

// 聊天工作台：顶部细条（连接态 + 焦点状态 + model/推理/ctx/成本）+ 消息流 + 输入框。
// 全部状态来自 chat-store（帧驱动）：status 四值 idle/pending/running/compacting。
export default function ChatPage() {
  const activeId = useChatStore((s) => s.activeId);
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const retry = useChatStore((s) => s.retry);
  const info = useChatStore((s) => s.info);
  const model = useChatStore((s) => s.model);
  const thinkingLevel = useChatStore((s) => s.thinkingLevel);
  const error = useChatStore((s) => s.error);
  const notice = useChatStore((s) => s.notice);
  const { clearError, clearNotice } = chatActions;

  // ── Esc = 停止当前轮（挂在页面上，不挂输入框）─────────────────────────────
  // 为什么不挂 InputBox：发完 prompt 前端先自置 status="pending"，而 TextArea 是
  //   disabled={isCompacting || pending} —— disabled 的输入框会丢焦点（掉到 body），
  //   绑在它 onKeyDown 上的 Esc 从此收不到（点「发送」按钮也一样：焦点跑到按钮上）。
  // ★ 必须挂 window **冒泡**（不能照抄 DesktopLayout 的 capture）：
  //   React 18 把事件挂在自己的 root 容器（在 window 之内），冒泡监听天然排在 React 处理后 ——
  //   于是补全面板的 Esc（InputBox 里 preventDefault 后只关面板）会先被消费，
  //   这里读到 defaultPrevented 就让路，不会「面板没关还顺手把 run 掉了」。
  //   反过来若用 capture，就会抢在 React 前面，面板开着按 Esc 直接把正在跑的轮次掐了。
  // 弹层优先：模态/下拉/选择器开着时，Esc 归它们（关弹层），别顺手停一轮。
  //   .ant-*-hidden / 已关的弹层仍留在 DOM（display:none）→ 用 getClientRects 判「真的在屏幕上」。
  useEffect(() => {
    const overlayOpen = () =>
      [".ant-modal-wrap", ".ant-drawer", ".ant-dropdown", ".ant-select-dropdown", ".ant-picker-dropdown", ".ant-popover"]
        .some((sel) => document.querySelector(sel)?.getClientRects().length);
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return; // 输入框/编辑器已消费 → 让路
      if (overlayOpen()) return;
      if (document.activeElement?.closest?.(".cm-editor")) return; // 编辑器里交给 CodeMirror
      chatActions.abort(); // 幂等：idle 时 no-op
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctxStr = contextLine(info);
  const costStr = costLine(info);
  // header 就这四项，顺序固定：模型 → 推理档 → 上下文占用 → 成本（其余 token 明细不上条）
  const facts = [
    model && { key: "model", text: model, color: T.color.textSecondary, maxWidth: 200 },
    thinkingLevel && { key: "level", text: thinkingLevel, color: T.color.textMuted },
    ctxStr && { key: "ctx", text: ctxStr, color: T.color.textMuted },
    costStr && { key: "cost", text: costStr, color: T.color.textMuted },
  ].filter(Boolean);

  return (
    <Flex vertical style={{ height: "100%" }}>
      {/* 顶部细条：左=进行状态（忙/重试/压缩）+ model · 推理档 · 上下文 · 成本；右端只钉 wifi 连接符号 */}
      <Flex
        align="center"
        justify="space-between"
        gap={8}
        style={{
          minHeight: 32,
          flexShrink: 0,
          paddingInline: 12,
          borderBottom: `1px solid ${T.color.hairline}`,
        }}
      >
        <Flex align="center" gap={8} style={{ minWidth: 0 }}>
          {activeId && retry && (
            <Tag
              color="warning"
              style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {`重试 ${retry.attempt}/${retry.maxAttempts ?? "?"}：${(retry.message || "").slice(0, 40)}`}
            </Tag>
          )}
          {status === "compacting" && (
            <Tag color="processing" style={{ marginInlineEnd: 0 }}>
              压缩中
            </Tag>
          )}
          {facts.map((f, i) => (
            <Flex key={f.key} align="center" gap={8} style={{ minWidth: 0 }}>
              {i > 0 && <span style={{ color: T.color.textFaint, fontSize: T.icon.xs }}>|</span>}
              <span
                style={{
                  maxWidth: f.maxWidth,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: T.fontFamily.mono,
                  fontSize: T.fontSize.xs,
                  color: f.color,
                }}
              >
                {f.text}
              </span>
            </Flex>
          ))}
        </Flex>
        <div style={{ flexShrink: 0, marginLeft: "auto" }}>
          <ConnStatus />
        </div>
      </Flex>

      {!activeId ? (
        <Flex align="center" justify="center" style={{ flex: 1, minHeight: 0 }}>
          <Empty description="选择或新建一个 Session，开始对话" />
        </Flex>
      ) : (
        <Flex vertical style={{ flex: 1, minHeight: 0 }}>
          {/* 消息流 */}
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <MessageList messages={messages} status={status} sessionId={activeId} />
          </div>

          {/* 输入区（镜像左栏底部：发丝顶线 + padding；错误横幅置顶；InputBox 两层 = 输入行 + 动作行） */}
          <div style={{ borderTop: `1px solid ${T.color.hairline}`, padding: 10 }}>
            {error && (
              <Alert type="error" message={error} closable showIcon style={{ marginBottom: 8 }} onClose={clearError} />
            )}
            {/* /reload 回执：服务端拼好的整句；带 ⚠ = 有诊断（坏扩展 / 重名）转警示色 */}
            {notice && (
              <Alert
                type={notice.includes("⚠") ? "warning" : "success"}
                message={notice}
                closable
                showIcon
                style={{ marginBottom: 8 }}
                onClose={clearNotice}
              />
            )}
            {/* 待办清单（todos 插件）：无清单时整块不渲染 */}
            <TodosPanel />
            <InputBox />
          </div>
        </Flex>
      )}
    </Flex>
  );
}
