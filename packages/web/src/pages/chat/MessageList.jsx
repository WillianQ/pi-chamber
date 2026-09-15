import { useEffect, useMemo, useRef, useState } from "react";
import { CaretRightOutlined, DownOutlined, PauseOutlined, SoundOutlined, StopFilled } from "@ant-design/icons";
import MessageBlock from "./MessageBlock.jsx";
import { T } from "../../theme/tokens.js";
import { useChatStore, chatActions, useTTSStore } from "../../stores";

// 贴底距离阈值：距底 < 60px 视为“在底部”，自动滚到位/用户滚回来都靠它判归队。
const NEAR_BOTTOM = 60;
// 触顶阈值：滚到距顶 < 80px 且还有更早的消息（before !== null）→ 拉上一页。
const NEAR_TOP = 80;

// 右下角圆形浮钮（「回到底部」同款）
const roundBtn = {
  width: 52,
  height: 52,
  borderRadius: "50%",
  border: `1px solid ${T.color.hairline}`,
  background: T.color.panelBg,
  color: T.color.textSecondary,
  cursor: "pointer",
  fontSize: T.icon.lg,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: 0.85,
};

// 消息流容器：深色"记账式"流水（无气泡），纵向铺开 + 自动滚底 + 触顶往前翻页。
// 数据层与档案 1:1；渲染层做一件事——toolResult 不再单独成行：
// 按 toolCallId 配进对应 toolCall 卡片内嵌展示（点开调用即见结果），
// 找不到归属的"孤儿" toolResult 仍照常成行，绝不丢内容。
export default function MessageList({ messages, status, sessionId }) {
  const ref = useRef(null);
  const { loadMore } = chatActions;
  const before = useChatStore((s) => s.before);
  const loadingMore = useChatStore((s) => s.loadingMore);
  // TTS 浮动控制：朗读中/暂停时右下角浮出 播放/暂停 + 停止（圆钮，与「回到底部」同款）
  const ttsPhase = useTTSStore((s) => s.phase);
  const autoLive = useTTSStore((s) => s.autoLive); // 自动朗读（流式跟读）总开关
  // 跟踪态：true = 新内容来了自动滚底。用户把画面往上滑即停止跟踪；点「回到底部」或滚回底部归队。
  const [stick, setStick] = useState(true);
  const lastTopRef = useRef(0);
  const firstKeyRef = useRef(null); // 头部锚：翻页前插时用它补 scrollTop，保住阅读位置
  const heightRef = useRef(0);

  const { resultsMap, visible } = useMemo(() => {
    const map = new Map();
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) map.set(m.toolCallId, m);
    }
    // 哪些 toolCallId 被某条 assistant 的 toolCall 块认领了
    const claimed = new Set();
    for (const m of messages) {
      if (m.role === "assistant")
        for (const b of m.blocks || []) if (b.type === "toolCall" && b.id) claimed.add(b.id);
    }
    return {
      resultsMap: map,
      visible: messages.filter((m) => !(m.role === "toolResult" && claimed.has(m.toolCallId))),
    };
  }, [messages]);

  // 切 session → 重新进入跟踪（新会话从底部看起），锚也重置
  useEffect(() => {
    setStick(true);
    firstKeyRef.current = null;
    heightRef.current = 0;
  }, [sessionId]);

  // 消息变化：翻页前插 → 按高度差补 scrollTop（阅读位置不动）；其余情况在跟踪态滚底
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const head = messages[0]?.key ?? null;
    if (firstKeyRef.current && head && head !== firstKeyRef.current) {
      // 头部变了 = 前插了一页：把视口钉回原处
      el.scrollTop += el.scrollHeight - heightRef.current;
      lastTopRef.current = el.scrollTop;
    } else if (stick) {
      el.scrollTop = el.scrollHeight; // 瞬时不用 smooth：delta 高频，smooth 动画会互相打断抽动
      lastTopRef.current = el.scrollTop;
    }
    firstKeyRef.current = head;
    heightRef.current = el.scrollHeight;
  }, [messages, stick]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist < NEAR_BOTTOM) {
        // 到底了（无论谁滚的）→ 自动归队，按钮消失
        setStick(true);
      } else if (el.scrollTop < lastTopRef.current - 2) {
        // 画面真实往上移动 = 用户在翻看历史 → 停止跟踪
        setStick(false);
      }
      if (el.scrollTop < NEAR_TOP) loadMore(); // 触顶拉上一页（store 内部挡重发；before=null 时直接返回）
      lastTopRef.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadMore]);

  const jumpToBottom = () => {
    setStick(true); // effect [messages, stick] 会滚底；这里再即时滚一次防本帧无 messages 变化
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <div
        ref={ref}
        style={{
          height: "100%",
          overflow: "auto",
          background: T.color.streamBg,
          padding: "20px 0",
        }}
      >
        {/* 顶部：翻页中提示 / 到头提示（贴顶一行，不占位时就消失） */}
        {loadingMore && (
          <div style={{ textAlign: "center", color: T.color.textFaint, fontSize: T.fontSize.xs, paddingBottom: 10 }}>
            正在加载更早的消息…
          </div>
        )}
        {!loadingMore && before === null && visible.length > 0 && (
          <div style={{ textAlign: "center", color: T.color.textFaint, fontSize: T.fontSize.xs, paddingBottom: 10 }}>
            —— 已到最早 ——
          </div>
        )}
        {/* 完全撑满：不限宽、不留左右边距，整版都是流水 */}
        {visible.map((m) => (
          <MessageBlock
            key={m.key}
            msg={m}
            // 正在流式 = 它就是那条 open 草稿（服务端同一时刻最多一条草稿，且永远最后一条）
            streaming={!!m.open}
            resultsMap={resultsMap}
          />
        ))}
      </div>
      {/* 右下角浮动钮栈：自上而下 = 停止、（播放/暂停）、回到底部（最下）——朗读控制在回到底部上方 */}
      <div
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          zIndex: 5,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
        }}
      >
        {/* 停止（方块） */}
        {ttsPhase !== "idle" && (
          <button style={roundBtn} title="停止" onClick={() => useTTSStore.getState().stop()}>
            <StopFilled />
          </button>
        )}
        {/* 播放 / 暂停（朗读态图标高亮主色） */}
        {ttsPhase !== "idle" && (
          <button
            style={{ ...roundBtn, color: ttsPhase === "paused" ? undefined : T.color.primary }}
            title={ttsPhase === "paused" ? "继续" : "暂停"}
            onClick={() =>
              ttsPhase === "paused" ? useTTSStore.getState().resume() : useTTSStore.getState().pause()
            }
          >
            {ttsPhase === "paused" ? <CaretRightOutlined /> : <PauseOutlined />}
          </button>
        )}
        {/* 「回到底部」：用户翻历史时出现（贴底，thumb 位） */}
        {!stick && (
          <button style={roundBtn} onClick={jumpToBottom} title="回到底部">
            <DownOutlined />
          </button>
        )}
        {/* autoLive 常驻开关（最底）：自动朗读总开关；开 = 主色高亮 */}
        <button
          style={{ ...roundBtn, color: autoLive ? T.color.primary : undefined }}
          title={autoLive ? "自动朗读：开（agent 生成回复时实时朗读）" : "自动朗读：关（点击开启）"}
          onClick={() => useTTSStore.getState().setAutoLive(!autoLive)}
        >
          <SoundOutlined />
        </button>
      </div>
    </div>
  );
}
