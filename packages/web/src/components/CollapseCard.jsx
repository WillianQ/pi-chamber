import { useEffect, useRef, useState } from "react";
import { T } from "../theme/tokens.js";

// 通用"可展开/可收起"小卡片（独立组件，内容走插槽 children）。
// 交互契约：**卡片任意位置点击都开合**；拖选文字（按下后位移>5px）不算点击、不误收。
// defaultOpen 不只是初值——它变化时同步一次开合（想固定开合就给常量）。
// tone = 配色皮肤：全部从 theme/tokens.js 的 T.card 取，本组件不写字面色值。

export const CARD_TONES = T.card;

export default function CollapseCard({ header, children, defaultOpen = false, tone = "neutral" }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const downRef = useRef(null);
  const t = CARD_TONES[tone] || CARD_TONES.neutral;

  return (
    <div
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: T.radius.base,
        padding: "6px 12px",
        margin: "6px 0",
        cursor: "pointer",
      }}
      onMouseDown={(e) => {
        downRef.current = [e.clientX, e.clientY];
      }}
      onClick={(e) => {
        const d = downRef.current;
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return; // 拖选文字，不收合
        setOpen((v) => !v);
      }}
    >
      <div
        style={{
          fontFamily: T.fontFamily.mono,
          fontSize: T.fontSize.xs,
          color: T.color.textBody,
          userSelect: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: T.lineHeight.sm,
        }}
      >
        {header}
      </div>
      {/* 内容插槽：收起时直接不挂载（DOM 干净、大结果不占内存） */}
      {open && <div style={{ paddingTop: 6, cursor: "auto" }}>{children}</div>}
    </div>
  );
}
