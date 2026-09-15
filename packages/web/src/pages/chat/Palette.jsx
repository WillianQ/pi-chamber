// 输入框补全面板——纯展示（受控）：不碰 store、不碰 bus、不算匹配（规矩在 command-match.js / file-match.js）。
// 一份组件服务两种补全，靠 variant 分：
//   variant="command"（默认） / 命令清单：行首 `•`/`>`（有二级），主文本 `/value`，右侧说明
//   variant="file"            @ 文件引用：行首 📁/📄，主文本**完整路径**（目录带 /）—— 相对 cwd，与回填进 prompt 的一致
// 定位：绝对贴在输入框容器上沿（bottom:100%），向上盖住消息流下沿。
//   为何不上不下的：下面紧挨动作行 + 屏幕底，移动端键盘一弹就没了。
// 交互：↑↓ 在 InputBox 里接管（本组件只管画与点击）；行用 onPointerDown + preventDefault，
//   用 onClick 会先让 textarea 失焦、光标锚点丢、回填写错位置。
import { useEffect, useRef } from "react";
import { FileOutlined, FolderOutlined, RightOutlined } from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { isMobilePlatform } from "../../theme/platform.js";

const MOBILE = isMobilePlatform();
const MAX_ROWS = 8; // 渲染上限：扩展命令的二级池可能上千条，只在渲染层截断
const ROW_H = MOBILE ? 42 : 32; // 移动端手指要按

/** 行首图标：命令补全 = 有二级的下钻箭头（否则圆点）；文件补全 = 目录/文件 */
function rowIcon(it, isFile) {
  if (!isFile) return it.options?.length ? <RightOutlined /> : "•";
  return it.isDir ? <FolderOutlined /> : <FileOutlined />;
}

/** 图标着色：可下钻（目录 / 有二级）→ 主题色提醒“还能往里走”；否则淡色 */
function iconColor(it, isFile) {
  const drillable = isFile ? it.isDir : it.options?.length;
  return drillable ? T.color.primary : T.color.textFaint;
}

export default function Palette({
  open,
  items = [],
  selected = 0,
  header = null,
  variant = "command",
  leadSlash = true,
  onPick,
  onHover,
}) {
  const listRef = useRef(null);
  const isFile = variant === "file";

  // 选中项滚进视野（块级滚动，不整页跳）
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, selected, items.length]);

  if (!open || !items.length) return null;
  const shown = items.slice(0, MAX_ROWS);
  const more = items.length - shown.length;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        zIndex: 10,
        marginBottom: 4,
        background: T.color.panelBg,
        border: `1px solid ${T.color.hairline}`,
        borderRadius: T.radius.base,
        boxShadow: "0 -6px 18px rgba(0,0,0,.45)",
        overflow: "hidden",
      }}
    >
      {/* 二级上下文头：告诉用户正在给哪个命令填参数 */}
      {header && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "4px 10px",
            fontFamily: T.fontFamily.mono,
            fontSize: T.fontSize.xs,
            lineHeight: T.lineHeight.xs,
            borderBottom: `1px solid ${T.color.hairline}`,
          }}
        >
          <span style={{ color: T.color.textSecondary, flexShrink: 0 }}>/{header.value}</span>
          <span style={{ color: T.color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {header.description}
          </span>
        </div>
      )}

      <div ref={listRef} style={{ maxHeight: MAX_ROWS * ROW_H, overflowY: "auto" }}>
        {shown.map((it, i) => {
          const active = i === selected;
          return (
            <div
              key={isFile ? it.path : `${leadSlash ? "/" : ""}${it.value}#${i}`}
              data-i={i}
              onPointerDown={(e) => {
                e.preventDefault(); // 保住 textarea 焦点与光标锚点
                onPick?.(it);
              }}
              onMouseMove={() => !active && onHover?.(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: ROW_H,
                padding: "0 10px",
                cursor: "pointer",
                background: active ? T.color.activeRowBg : "transparent",
                boxShadow: active ? `inset 2px 0 0 ${T.color.primary}` : "none",
                userSelect: "none",
              }}
            >
              <span
                style={{
                  width: T.icon.sm,
                  flexShrink: 0,
                  textAlign: "center",
                  fontSize: T.icon.xs,
                  color: iconColor(it, isFile),
                }}
              >
                {rowIcon(it, isFile)}
              </span>
              <span
                style={{
                  fontFamily: T.fontFamily.mono,
                  fontSize: T.fontSize.sm,
                  lineHeight: T.lineHeight.sm,
                  color: T.color.textPrimary,
                  whiteSpace: "nowrap",
                  // 文件补全要显示完整路径（cwd 相对）→ 长路径得能收缩省略，否则撑破面板
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  ...(isFile ? { flex: 1 } : {}),
                }}
                title={isFile ? it.path : undefined}
              >
                {isFile ? `${it.path}${it.isDir ? "/" : ""}` : `${leadSlash ? "/" : ""}${it.value}`}
              </span>
              {!isFile && it.description && (
                <span
                  style={{
                    marginLeft: "auto",
                    paddingLeft: 8,
                    fontSize: T.fontSize.xs,
                    lineHeight: T.lineHeight.xs,
                    color: T.color.textMuted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.description}
                </span>
              )}
            </div>
          );
        })}

        {more > 0 && (
          <div
            style={{
              height: ROW_H,
              display: "flex",
              alignItems: "center",
              padding: "0 10px",
              fontSize: T.fontSize.xs,
              color: T.color.textFaint,
            }}
          >
            …还有 {more} 项，继续输入筛选
          </div>
        )}
      </div>

      {/* 键位条：只有桌面有键盘，移动端不占位 */}
      {!MOBILE && (
        <div
          style={{
            padding: "3px 10px",
            borderTop: `1px solid ${T.color.hairline}`,
            fontSize: T.fontSize.xs,
            lineHeight: T.lineHeight.xs,
            color: T.color.textFaint,
          }}
        >
          ↑↓ 选择 · ⏎ 回填 · Esc 关闭
        </div>
      )}
    </div>
  );
}
