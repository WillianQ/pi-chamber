import { useEffect, useMemo } from "react";
import { Flex, Image } from "antd";
import { CopyOutlined, SoundOutlined } from "@ant-design/icons";
import MarkdownRenderer from "../../components/MarkdownRenderer.jsx";
import CollapseCard from "../../components/CollapseCard.jsx";
import { T } from "../../theme/tokens.js";
import { chatActions, sessionsActions, useTTSStore, useSettingStore } from "../../stores";
import { dataUrl } from "./attachments.js";

// 单条消息 = 一行"记账式"记录（无气泡）：角色标签行 + 正文平铺。
// 全角色与档案 1:1；渲染层按 role 选样式，未知 role 走兜底不崩。
// 视觉：不同 role 用不同背景色区分；assistant 透明（正文是主角，不给它加框）。
// 颜色/字号零字面量：全从 theme/tokens.js 语义层取。
//
// 数据来源 = chat-store 的 Message（与实时帧 + 翻页同构）：
//   assistant.blocks[] 带 ci（增量按 ci 入格）；toolCall 的 args 是字符串（流式中是半截 JSON）；
//   toolResult 的 text 被服务端裁到前 50 字 + truncated → 展开时走 chat.toolResult 要全文。

const ROLE_META = {
  user: { label: "你", color: T.color.user, bg: T.color.userRowBg }, // 浅蓝整块：用户输入一眼认；无标签行，身份靠色块
  assistant: { label: "pi", color: T.color.assistant, bg: "transparent" }, // 无标签行，透明底
  toolResult: { label: "工具结果", color: T.color.tool, bg: T.color.toolRowBg },
  bashExecution: { label: "! 命令", color: T.color.bash, bg: T.color.bashRowBg },
  custom: { label: "扩展消息", color: T.color.custom, bg: T.color.customRowBg },
  branchSummary: { label: "分支摘要", color: T.color.summary, bg: T.color.summaryRowBg },
  compactionSummary: { label: "压缩摘要", color: T.color.summary, bg: T.color.summaryRowBg },
};

const STOP_HINT = {
  length: { text: "输出被截断", color: T.color.warn },
  aborted: { text: "已中断", color: T.color.pending },
  error: { text: "出错", color: T.color.error },
  deferred: { text: "异步挂起", color: T.color.tool },
};

/** 一条 assistant 消息 → 纯文本：text 块拼接（thinking/toolCall 天然不在内） */
function msgCopyText(m) {
  const tb = (m.blocks || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
  return (tb || m.text || "").trim();
}

/** role → 行容器样式：背景色区分；assistant 透明且零内边距/零外边距
 *  （间距统一由卡片/文本块自己的 margin 控制，否则跨消息的卡片间距会多出容器 padding，宽窄不一） */
function rowStyle(role, { divider = false } = {}) {
  const meta = ROLE_META[role];
  if (role === "assistant" && !divider)
    return { background: "transparent", borderRadius: T.radius.base, padding: "0 14px", marginBottom: 0 };
  return {
    background: meta ? meta.bg : T.color.plainRowBg,
    borderRadius: 0, // 通栏整块：撑满后圆角不再需要
    padding: divider ? "6px 14px" : "10px 14px",
    marginBottom: 10,
    ...(divider ? { textAlign: "center" } : null),
  };
}

function LabelLine({ role, extra, error }) {
  const meta = ROLE_META[role] || { label: role || "?", color: T.color.tool };
  return (
    <div
      style={{
        fontFamily: T.fontFamily.mono,
        fontSize: T.fontSize.xs,
        lineHeight: T.lineHeight.xs,
        marginBottom: 4,
        display: "flex",
        gap: 8,
        alignItems: "baseline",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
      {extra && <span style={{ color: T.color.textMuted }}>{extra}</span>}
      {error && <span style={{ color: T.color.error }}>失败</span>}
    </div>
  );
}

const preStyle = {
  margin: 0,
  fontFamily: T.fontFamily.mono,
  fontSize: T.fontSize.sm,
  lineHeight: T.lineHeight.sm,
  color: T.color.textBody,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/** toolCall 的参数名（一行一个，mono + 加粗）：与值（preStyle 正文）拉开层级 ——
 *  名字是标签（淡），值才是内容。 */
const argNameStyle = {
  fontFamily: T.fontFamily.mono,
  fontSize: T.fontSize.xs,
  fontWeight: 600,
  color: T.color.textMuted,
};

/** 参数值 → 显示文本：字符串原样（\n 保留）、对象/数组走 pretty JSON、其余 String()。
 *  ★ 绝不吞换行：edit 的 oldText / write 的 content 都是多行文本，换成单行就废了。 */
function argText(v) {
  if (typeof v === "string") return v;
  if (v == null) return String(v);
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** toolCall 参数：解析成对象后**逐字段铺开**（一整坨 JSON 读起来太累）：
 *
 *      参数名
 *      参数值
 *
 *      参数名2
 *      参数值
 *
 *  ★ 流式中 args 可能是**半截 JSON**（provider 边解析边吐，或 pi-ai 的 partialJson）
 *    → parse 失败就退回原样 pre，**绝不丢内容**（终稿会整条替换成解析得动的）。 */
function ToolArgs({ args }) {
  const parsed = useMemo(() => {
    if (typeof args !== "string" || !args.trim()) return null;
    try {
      const v = JSON.parse(args);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null; // 半截 JSON / 非对象：退回原样
    }
  }, [args]);

  if (!parsed) return <pre style={preStyle}>{args || "（参数生成中…）"}</pre>;
  const entries = Object.entries(parsed);
  if (!entries.length) return <pre style={preStyle}>{"{ }"}</pre>;

  return (
    <div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 8 }}>
          <div style={argNameStyle}>{k}</div>
          <pre style={{ ...preStyle, marginTop: 2 }}>{argText(v)}</pre>
        </div>
      ))}
    </div>
  );
}

/** 可折叠区（工具输出/命令回显）：summary 一行预览，展开看全文。
 *  onOpen：展开时回调（toolResult 被裁过 → 这时候才去要全文）。 */
function Fold({ preview, children, defaultOpen = false, onOpen }) {
  return (
    <details
      open={defaultOpen}
      onToggle={(e) => {
        if (e.currentTarget.open) onOpen?.();
      }}
      style={{ marginTop: 2 }}
    >
      <summary
        style={{
          fontFamily: T.fontFamily.mono,
          fontSize: T.fontSize.xs,
          color: T.color.textMuted,
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {preview}
      </summary>
      <div style={{ paddingTop: 6 }}>{children}</div>
    </details>
  );
}

/** 图片条：一条消息里的所有图（我发的 / agent 读到的）。点击放大（antd Image 自带预览）。
 *  两个消费者：user 消息（随帧带）与 toolResult（点开时才拉，见 ToolResultBody）。 */
function ImageStrip({ images }) {
  if (!images?.length) return null;
  return (
    <Flex wrap gap={6} style={{ marginTop: 6 }}>
      {images.map((im, i) => (
        <Image
          key={i}
          src={dataUrl(im)}
          alt=""
          height={160}
          style={{
            borderRadius: T.radius.sm,
            border: `1px solid ${T.color.hairline}`,
            objectFit: "cover",
            display: "block",
          }}
        />
      ))}
    </Flex>
  );
}

/** 工具结果正文：被裁过（truncated）就在**挂载时**自动要全文
 *  （CollapseCard 收起时不挂 children → 挂载 = 用户刚展开）。
 *  ★ 图也在这时候一并拉（agent 读的图首屏/翻页故意不带，见服务端 messages.js）。 */
function ToolResultBody({ result }) {
  useEffect(() => {
    if (result?.truncated && result.toolCallId) chatActions.expandToolResult(result.toolCallId);
  }, [result?.truncated, result?.toolCallId]);
  return (
    <>
      <pre style={preStyle}>{result?.text || "（空结果）"}</pre>
      <ImageStrip images={result?.images} />
    </>
  );
}

/** subagent 工具的额外入口：它派出去的是一份**真出勤**（独立档案、独立上下文），
 *  这里给一个跳过去看它完整对话的钮 —— 子 Session 本身就在名册里，点了就置焦。
 *  childSessionId 来自 toolResult.details（服务端 messages.js 白名单投影）。 */
const SUB_STATUS = { ok: "已完成", error: "失败", aborted: "已中止", timeout: "超时" };
function SubagentLink({ sub }) {
  const cost = sub.usage?.cost;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" }}>
      <button
        onClick={() => sessionsActions.openSession(sub.childSessionId)}
        title="跳到这份子 Session，看它的完整对话与工具调用"
        style={{
          background: T.color.toolRowBg,
          border: `1px solid ${T.color.dashedDivider}`,
          borderRadius: T.radius.base,
          color: T.color.tool,
          cursor: "pointer",
          fontFamily: T.fontFamily.mono,
          fontSize: T.fontSize.xs,
          padding: "3px 8px",
        }}
      >
        ↳ 打开子 Session → {sub.childSessionId.slice(0, 8)}
      </button>
      {SUB_STATUS[sub.status] && (
        <span style={{ fontFamily: T.fontFamily.mono, fontSize: T.fontSize.xs, color: T.color.textMuted }}>
          {SUB_STATUS[sub.status]}
        </span>
      )}
      {typeof cost === "number" && cost > 0 && (
        <span style={{ fontFamily: T.fontFamily.mono, fontSize: T.fontSize.xs, color: T.color.textMuted }}>
          ${cost.toFixed(4)}
        </span>
      )}
    </div>
  );
}

/** assistant 的小框列表：text → markdown；thinking / toolCall → CollapseCard 小卡片；未知块兜底 */
function BlockItem({ b, streaming, result }) {
  if (b.type === "text") {
    return b.text ? (
      <div style={{ marginTop: 4 }}>
        <MarkdownRenderer content={b.text} />
      </div>
    ) : null;
  }
  if (b.type === "thinking") {
    // 紫色思考卡：始终收起（流式中也不展开——内容忽高忽低会带动滚动条乱跳）；点卡片任意处开合
    return (
      <CollapseCard
        tone="thinking"
        header={streaming ? `✦ Thinking... · ${b.text.length}` : b.text ? `✦ Think · ${b.text.length}` : "✦ Think · Empty"}
      >
        <div
          style={{
            fontStyle: "italic",
            color: T.md.thinkingText,
            fontSize: T.fontSize.sm,
            lineHeight: T.lineHeight.sm,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {b.redacted ? "（思考内容被安全过滤隐去）" : b.text}
        </div>
      </CollapseCard>
    );
  }
  if (b.type === "toolCall") {
    // 绿=正常 / 红=出错（背景跟着结果状态翻转）；结果按 toolCallId 配进卡片内嵌，收起态标题也有 ✓/✗/⏳
    const state = !result ? " · ⏳" : result.isError ? " · ✗ 失败" : " · ✓";
    const sub = result?.subagent; // subagent 工具：多一个「跳去看那份子 Session」的入口
    return (
      <CollapseCard
        tone={result?.isError ? "error" : "ok"}
        header={`⚙ Tool · ${b.name || "(未知工具)"}${state}${sub ? " · 子 Session" : ""}`}
      >
        <ToolArgs args={b.args} />
        {sub?.childSessionId && <SubagentLink sub={sub} />}
        {result ? (
          <>
            <div style={{ borderTop: `1px dashed ${T.color.dashedDivider}`, margin: "8px 0 6px" }} />
            <div
              style={{
                fontFamily: T.fontFamily.mono,
                fontSize: T.fontSize.xs,
                color: result.isError ? T.color.error : T.color.textMuted,
                marginBottom: 4,
              }}
            >
              ↳ 返回{result.isError ? " · 失败" : ""}
              {result.truncated ? " · 已截断，展开加载全文" : ""}
            </div>
            <ToolResultBody result={result} />
          </>
        ) : (
          <>
            <div style={{ borderTop: `1px dashed ${T.color.dashedDivider}`, margin: "8px 0 6px" }} />
            <div style={{ fontFamily: T.fontFamily.mono, fontSize: T.fontSize.xs, color: T.color.pending }}>
              ⏳ 执行中，结果到达自动显示
            </div>
          </>
        )}
      </CollapseCard>
    );
  }
  // 未知块兜底：可展开看 raw，不崩
  return (
    <CollapseCard header={`? 未知块 · ${b.type}`}>
      <pre style={preStyle}>{b.raw ?? JSON.stringify(b, null, 2)}</pre>
    </CollapseCard>
  );
}

export default function MessageBlock({ msg, streaming, resultsMap }) {
  const { role, text } = msg;
  // TTS 朗读控制（顶层 hook：喇叭 = activeKey 命中且非 idle → 变暂停/停止）
  const ttsPhase = useTTSStore((s) => s.phase);
  const ttsActive = useTTSStore((s) => s.activeKey);
  const ttsEnabled = useSettingStore((s) => s.setting?.tts?.enabled) ?? false; // 朗读总开关（设置页）

  switch (role) {
    case "user": {
      // 无标签，身份由色块表达
      // text 里那个 "[图片]" 占位（服务端 flattenText 摊出来的）在有真图时滤掉，免得看着重复
      const body = msg.images?.length
        ? (text || "")
            .split("\n")
            .filter((l) => l.trim() !== "[图片]")
            .join("\n")
            .trim()
        : text;
      return (
        <div style={rowStyle(role)}>
          <ImageStrip images={msg.images} />
          {body ? (
            <div
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: T.color.textPrimary,
                fontSize: T.fontSize.sm,
                lineHeight: T.lineHeight.base,
                marginTop: msg.images?.length ? 6 : 0,
              }}
            >
              {body}
            </div>
          ) : null}
        </div>
      );
    }

    case "assistant": {
      const hint = STOP_HINT[msg.stopReason];
      const blocks = msg.blocks;
      return (
        <div style={rowStyle(role)}>
          {blocks?.length ? (
            blocks.map((b) => (
              <BlockItem
                key={b.ci ?? b.id}
                b={b}
                streaming={streaming}
                result={b.type === "toolCall" && b.id ? resultsMap?.get(b.id) : undefined}
              />
            ))
          ) : text ? (
            <MarkdownRenderer content={text} />
          ) : (
            <div style={{ fontFamily: T.fontFamily.mono, fontSize: T.fontSize.xs, color: T.color.textFaint }}>…</div>
          )}
          {hint && (
            <div style={{ fontFamily: T.fontFamily.mono, fontSize: T.fontSize.xs, color: hint.color, marginTop: 4 }}>
              · {hint.text}
              {msg.stopReason === "error" && msg.errorMessage ? `：${String(msg.errorMessage).slice(0, 200)}` : ""}
            </div>
          )}
          {/* 底排操作：复制 + 朗读本条纯文本（thinking/toolCall 不含）；open 草稿未敲定不显示
              播放/暂停/停止统一在消息流右下角的浮动控制条，这里只有触发钮 */}
          {(() => {
            if (msg.open) return null;
            const copyText = msgCopyText(msg);
            if (!copyText) return null;
            const mine = ttsActive === msg.key && ttsPhase !== "idle";
            return (
              <div className="pc-msgacts" style={{ display: "flex", justifyContent: "start", gap: 2, marginTop: 8 }}>
                <button
                  className="pc-msgacts-btn"
                  title="复制纯文本"
                  onClick={() => navigator.clipboard?.writeText(copyText).catch(() => {})}
                >
                  <CopyOutlined />
                </button>
                {/* 朗读钮：朗读功能总开关关着就隐藏（开关在「设置 → 朗读」） */}
                {ttsEnabled && (
                  <button
                    className="pc-msgacts-btn"
                    title={mine ? "正在朗读本条，点击从头重读" : "朗读本条回答"}
                    onClick={() => {
                      const s = useTTSStore.getState();
                      s.start("manual", msg.key); // 无条件抢权：正在读的 live/其他手动全停（含重读同条）
                      s.inject(copyText);
                      s.finish();
                    }}
                    style={mine ? { color: T.color.primary } : undefined}
                  >
                    <SoundOutlined />
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      );
    }

    case "toolResult":
      // 孤儿行（没被任何 toolCall 认领）：照常成行；裁过就展开时补全文
      return (
        <div style={rowStyle(role)}>
          <LabelLine role={role} extra={msg.toolName} error={msg.isError} />
          <Fold
            preview={`${text.split("\n")[0] || "（空结果）"}${msg.truncated ? " …（点开加载全文）" : ""}`}
            onOpen={() => msg.truncated && chatActions.expandToolResult(msg.toolCallId)}
          >
            <pre style={preStyle}>{text}</pre>
            <ImageStrip images={msg.images} />
          </Fold>
        </div>
      );

    case "bashExecution": {
      const bad = msg.exitCode != null && msg.exitCode !== 0;
      return (
        <div style={rowStyle(role)}>
          <LabelLine
            role={role}
            extra={
              msg.truncated ? "（输出已截断）" : bad ? `exit ${msg.exitCode}` : msg.cancelled ? "已取消" : null
            }
            error={bad}
          />
          <div
            style={{
              fontFamily: T.fontFamily.mono,
              fontSize: T.fontSize.sm,
              color: bad ? T.color.error : T.color.bash,
              wordBreak: "break-all",
            }}
          >
            $ {msg.command}
          </div>
          {text && (
            <Fold preview={`${text.split("\n").length} 行输出`}>
              <pre style={preStyle}>{text}</pre>
            </Fold>
          )}
        </div>
      );
    }

    case "custom":
      if (msg.display === false) return null; // 只进上下文，不进 UI
      return (
        <div style={rowStyle(role)}>
          <LabelLine role={role} extra={msg.customType} />
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: T.color.textSecondary, fontSize: T.fontSize.sm }}>
            {text}
          </div>
        </div>
      );

    case "branchSummary":
    case "compactionSummary":
      return (
        <div style={rowStyle(role, { divider: true })}>
          <Fold
            preview={
              msg.open
                ? `—— 压缩中 ——`
                : msg.error
                  ? `—— 压缩失败 ——`
                  : `—— ${ROLE_META[role].label} ——`
            }
          >
            <div
              style={{
                whiteSpace: "pre-wrap",
                color: msg.error ? T.color.error : T.color.textMuted,
                fontSize: T.fontSize.sm,
                textAlign: "left",
              }}
            >
              {text}
            </div>
          </Fold>
        </div>
      );

    default:
      // 未知角色兜底：灰色原文，不崩、可见
      return (
        <div style={rowStyle(role)}>
          <LabelLine role={role || `unknown:${JSON.stringify(role)}`} />
          <pre style={preStyle}>{text || JSON.stringify(msg, null, 2)}</pre>
        </div>
      );
  }
}
