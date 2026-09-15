// 编辑器活动页（bar「编辑器」唤起 / nav 单击文件自动切来）。
// 结构：顶部细条 header = 活动文件路径（cwd 相对，高度同 chat 顶栏 minHeight 32）；正文 = 活动 tab 的
// CodeMirror（每 tab 一个实例常驻，display 切活）或 md/html 预览；底部 TabBar =
// 切换器（下拉向上开，列已打开文件：名字 + 淡色相对目录 + modified 点 + 关闭，照老 chamber；同名文件靠目录段区分）
// + 右侧（换行开关 + 预览开关 + 保存）。
// TabBar 行高与 chat 输入区动作行 / nav 底部动作行对齐：外框 padding 10 + 内容高 32（= 默认 Button 高）。
// 错误横幅住页内（store.error）。数据流全走 editor-store：文件集是服务端内存态的镜像，本页只渲染 + 发动作。
import { useEffect, useRef, useState } from "react";
import { Dropdown, Flex, Typography } from "antd";
import {
  CaretUpOutlined,
  CloseOutlined,
  CodeOutlined,
  EnterOutlined,
  EyeOutlined,
  FileTextOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { useEditorStore, useNavStore } from "../../stores/index.js";
import { relLabel } from "../../path-label.js"; // 路径相对化单一来源（nav/editor 共用）
import CodeEditor from "./CodeEditor.jsx";
import MarkdownRenderer from "../../components/MarkdownRenderer.jsx";

const previewable = (p) => /\.md$/i.test(p) || /\.html?$/i.test(p);
const parentOf = (p) => p.replace(/[\\/][^\\/]*$/, ""); // 削尾得目录（Windows/POSIX 通吃）

// ── 预览窗：md → MarkdownGo；html → 沙箱 iframe ─────────────────────────────
function PreviewPane({ tab }) {
  if (/\.html?$/i.test(tab.path)) {
    return (
      <iframe
        title={tab.path}
        srcDoc={tab.content}
        sandbox="allow-scripts"
        style={{ width: "100%", height: "100%", border: "none", background: "#ffffff" }}
      />
    );
  }
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "8px 14px 40px", background: T.color.pageBg }}>
      <MarkdownRenderer content={tab.content} />
    </div>
  );
}

// ── 切换器（住底部 TabBar 左侧）：「当前文件名 ▴」按钮，点开 = 已打开文件清单（点行切换、点 ✕ 关闭）—————
// 受控 open：除了点击，快捷键切 tab（Ctrl+; / Ctrl+'，信号 = store.cycleAt）也会自动弹开清单，
// 连续按能看到高亮一路往下跑；停手 SWITCH_POP_MS 后自动收。
const SWITCH_POP_MS = 900;
function FileSwitcher({ files, activePath, cwd, cycleAt, onSwitch, onClose }) {
  const active = files.find((f) => f.path === activePath) || null;
  const dirty = active ? active.content !== active.original : false;
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!cycleAt) return;
    setOpen(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(false), SWITCH_POP_MS);
    return () => clearTimeout(timerRef.current);
  }, [cycleAt]);

  return (
    <Dropdown
      trigger={["click"]}
      open={open}
      onOpenChange={setOpen}
      placement="topLeft"
      popupRender={() => (
        <div
          style={{
            maxWidth: 300,
            maxHeight: 320,
            overflowY: "auto",
            background: T.color.panelBg,
            border: `1px solid ${T.color.hairline}`,
            borderRadius: T.radius.base,
            padding: "4px 0",
            boxShadow: "0 6px 18px rgba(0,0,0,.45)",
          }}
        >
          {files.map((f) => {
            const isActive = f.path === activePath;
            const mod = f.content !== f.original;
            return (
              <Flex
                key={f.path}
                align="center"
                gap={6}
                onClick={() => onSwitch(f.path)}
                style={{
                  padding: "5px 10px",
                  cursor: "pointer",
                  background: isActive ? T.color.activeRowBg : "transparent",
                  color: isActive ? T.color.textPrimary : T.color.textSecondary,
                }}
              >
                {mod && (
                  <span style={{ color: T.color.warn, fontSize: T.icon.xs, lineHeight: 1 }}>●</span>
                )}
                <span
                  style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: T.fontFamily.mono,
                    fontSize: T.fontSize.sm,
                  }}
                >
                  {f.name}
                </span>
                {/* 相对目录（xs 淡色）：同名文件（如两个 package.json）靠它认领；越出 cwd 回退绝对 */}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    direction: "rtl", // 长路径截前保尾：packages/server/…/package.json 被截时后段才是身份
                    textAlign: "left",
                    fontFamily: T.fontFamily.mono,
                    fontSize: T.fontSize.xs,
                    color: T.color.textFaint,
                  }}
                >
                  {relLabel(parentOf(f.path), cwd)}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(f.path);
                  }}
                  style={{ display: "flex", cursor: "pointer", color: T.color.textFaint, fontSize: T.icon.xs, padding: "0 2px" }}
                >
                  <CloseOutlined />
                </span>
              </Flex>
            );
          })}
        </div>
      )}
    >
      <Flex
        align="center"
        gap={5}
        style={{ minWidth: 0, cursor: "pointer", height: 32, paddingInline: 6, borderRadius: T.radius.sm }}
        title="切换文件（Ctrl+; 上一个 / Ctrl+' 下一个 / Ctrl+Alt+/ 关闭）"
      >
        {dirty && (
          <span style={{ color: T.color.warn, fontSize: T.icon.xs, lineHeight: 1 }}>●</span>
        )}
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: T.fontFamily.mono,
            fontSize: T.fontSize.sm,
            color: T.color.textPrimary,
          }}
        >
          {active?.name ?? "文件"}
        </span>
        <CaretUpOutlined style={{ fontSize: T.icon.xs, color: T.color.textFaint, flexShrink: 0 }} />
      </Flex>
    </Dropdown>
  );
}

export default function EditorPage() {
  const files = useEditorStore((s) => s.files);
  const activePath = useEditorStore((s) => s.activePath);
  const mode = useEditorStore((s) => s.mode);
  const lineWrapping = useEditorStore((s) => s.lineWrapping);
  const toggleLineWrapping = useEditorStore((s) => s.toggleLineWrapping);
  const busy = useEditorStore((s) => s.busy);
  const error = useEditorStore((s) => s.error);
  const switchTab = useEditorStore((s) => s.switchTab);
  const cycleAt = useEditorStore((s) => s.cycleAt);
  const closeFile = useEditorStore((s) => s.closeFile);
  const toggleMode = useEditorStore((s) => s.toggleMode);
  const saveFile = useEditorStore((s) => s.saveFile);
  const clearError = useEditorStore((s) => s.clearError);
  const cwd = useNavStore((s) => s.cwd); // Agent 目录：路径相对化参照（与 nav 顶栏同源）

  const active = files.find((f) => f.path === activePath) || null;
  const activeModified = active ? active.content !== active.original : false;
  const showPreview = !!(active && mode === "preview" && previewable(active.path));

  const saveActive = async () => {
    if (!active || !activeModified) return;
    await saveFile(active.path); // 成功 → 点消失；失败 → 横幅 error（modified 保留）
  };

  return (
    <Flex vertical style={{ height: "100%", background: T.color.panelBg }}>
      {/* header：活动文件路径（相对 cwd，截断就截断，已无 tooltip），高度与 chat 顶栏对齐 */}
      <Flex
        align="center"
        style={{
          minHeight: 32,
          flexShrink: 0,
          paddingInline: 12,
          borderBottom: `1px solid ${T.color.hairline}`,
        }}
      >
        {active && (
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: T.fontFamily.mono,
              fontSize: T.fontSize.xs,
              color: T.color.textSecondary,
            }}
          >
            {relLabel(active.path, cwd)}
          </span>
        )}
      </Flex>

      {/* 正文 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {files.length === 0 ? (
          <Flex
            vertical
            align="center"
            justify="center"
            gap={10}
            style={{ height: "100%", color: T.color.textFaint }}
          >
            <FileTextOutlined style={{ fontSize: T.icon.xl, opacity: 0.5 }} />
            <Typography.Text style={{ color: T.color.textFaint, fontSize: T.fontSize.xs }}>
              从「目录导航」单击文件打开编辑
            </Typography.Text>
          </Flex>
        ) : (
          files.map((f) => {
            const isActive = f.path === activePath;
            const inPreview = isActive && showPreview;
            return (
              <div key={f.path} style={{ display: isActive ? "block" : "none", height: "100%" }}>
                {inPreview ? (
                  <PreviewPane tab={f} />
                ) : (
                  <CodeEditor file={f} onSave={saveActive} />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 错误横幅 */}
      {error && (
        <div style={{ padding: "0 10px", paddingTop: 8, flexShrink: 0 }}>
          <Typography.Text type="danger" style={{ fontSize: T.fontSize.xs }}>
            {error}
          </Typography.Text>
        </div>
      )}

      {/* 底部 TabBar：切换器（下拉向上开）+ 右侧控件 */}
      {files.length > 0 && (
        <Flex
          align="center"
          gap={4}
          style={{
            flexShrink: 0,
            padding: 10,
            borderTop: `1px solid ${T.color.hairline}`,
            minWidth: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <FileSwitcher files={files} activePath={activePath} cwd={cwd} cycleAt={cycleAt} onSwitch={switchTab} onClose={closeFile} />
          </div>

          {/* 右侧控件：换行开关（仅代码模式露脸，预览不排版）· 预览开关 · 保存 */}
          <Flex gap={4} align="center" style={{ flexShrink: 0 }}>
            {active && !showPreview && (
              <span
                onClick={toggleLineWrapping}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  color: lineWrapping ? T.color.primary : T.color.textMuted,
                  fontSize: T.icon.base,
                }}
              >
                <EnterOutlined />
              </span>
            )}
            {active && previewable(active.path) && (
              <span
                onClick={toggleMode}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  color: T.color.textMuted,
                  fontSize: T.icon.base,
                }}
              >
                {mode === "edit" ? <EyeOutlined /> : <CodeOutlined />}
              </span>
            )}
            {activeModified && (
              <span
                onClick={saveActive}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  cursor: busy ? "wait" : "pointer",
                  color: T.color.ok,
                  fontSize: T.icon.base,
                }}
              >
                <SaveOutlined />
              </span>
            )}
          </Flex>
        </Flex>
      )}
    </Flex>
  );
}
