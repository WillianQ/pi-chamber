import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Flex, Input } from "antd";
import {
  AudioOutlined,
  LoadingOutlined,
  SendOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useChatStore, chatActions, useSTTStore } from "../../stores/index.js";
import { bus, useConnStore } from "../../bus.js";
import { T } from "../../theme/tokens.js";
import Palette from "./Palette.jsx";
import { completionContext, fillText, panelItems } from "./command-match.js";
import { atContext, fillAt } from "./file-match.js";

// prompt 输入区（两层，镜像左栏 Sessions 面板底部：输入行 + 动作行）：
//   上层 = 编辑区（TextArea 全宽）：Enter 发送（running 中 = steer 插队）/ Shift+Enter 换行 / Esc 停止；忙时不禁用
//     ★ Esc 只是这里的顺手一份：发送后 TextArea 变 disabled 会丢焦点（掉到 body），本处 handler 收不到，
//       真正兜底的是 chat 页那条 window 冒泡 Esc（见 pages/chat/index.jsx）。
//   下层 = 停止 | 按住说话 | 发送/插队（1:2:1 ≈ 25/50/25）
//   发送语义 = emit 无回执，**发出即清**（send 返回 false = 被挡下，文字保留）；
//   待插队条：steers（服务端 queue_update 镜像）非空时显示，投递后自动消失。
//
// 补全面板（一份 UI，两种来源）：
//   / 命令 = 本地算（command-match.js 纯函数，敲键零往返，清单随 chat.sync 的 commands 字段推）
//   @ 文件 = 服务端拉（fs.search 在 Agent 空间里搜，异步 → 防抖 + 丢陈旧响应）
//   优先级 @ > /：与 pi 的 getSuggestions 同序（先查 @ 前缀，命中就不走命令分支）。
//   ★ 两种来源共用一个面板与一套键位（↑↓/Tab/Enter/Esc），只靠 variant 换行渲染。
// 打开/关闭每次渲染现算，本地只存两个交互态：panelSel（选中下标）、dismissed（Esc 关掉后抑制重开）。
// 命令一律走同一条 send 通道（服务端分诊）；@ 回填完不发送（用户接着写完话再回车）。
//
// 按住说话（stt-store 接线）：按下锁光标锚点 + 开录开推；中间结果只上提示条（不碰输入框）；
// 等后端 stt.final（整轮终止确认）一次性注入锚点处，空文本跳过。失败 = 提示条报错，输入框从未被改过。
export default function InputBox() {
  // 状态全是帧驱动的 status（idle | pending | running | compacting）：
  //   running   = 一轮在跑 → Enter 自动走插队（steer）
  //   pending   = 本端刚发出申请/停止，等真值帧 → 挡输入与发送（停止钮仍可点，见下）
  //   compacting = 服务端会拒接普通 prompt → 直接禁输入
  const status = useChatStore((s) => s.status);
  const steers = useChatStore((s) => s.steers);
  const commands = useChatStore((s) => s.commands); // / 命令清单（随焦点走，chat.sync 整份覆盖）
  const busy = status === "running" || status === "compacting"; // 有活干（插队语义）
  const pending = status === "pending"; // 本端在途（输入与发送钮禁用；停止钮不受它管）
  const isCompacting = status === "compacting";
  const send = chatActions.send;
  const abort = chatActions.abort;
  const [text, setText] = useState("");

  // / 命令面板的两个交互态 + 光标位（光标进 state 才能现算面板）
  const [caret, setCaret] = useState(0);
  const [panelSel, setPanelSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // STT（按住说话）
  const isRecording = useSTTStore((s) => s.isRecording);
  const listening = useSTTStore((s) => s.listening); // 真在采样：false = 启动中（还没开录，别说话）
  const partialText = useSTTStore((s) => s.partialText);
  const sttError = useSTTStore((s) => s.error);
  const connState = useConnStore((s) => s.state); // 离线时录音等于白推 → 禁钮

  const taRef = useRef(null); // antd TextArea → 原生 textarea
  const textRef = useRef(""); // text 的即时镜像（录音回调在事件外，别吃闭包旧值）
  const anchorRef = useRef(null); // 按下时的光标锚点 {start, end}

  // 发出即清（新协议 emit 无回执，不回滚）；send 返回 false = 被挡下（在途/离线）→ 文字保留
  const doSend = async () => {
    if (pending) return;
    if (!text.trim()) return;
    if (send(text)) {
      textRef.current = ""; // 镜像一起清：否则下次语音注入会在残留旧文本上 splice（见 textRef 注释）
      setText("");
      setCaret(0);
      setPanelSel(0);
    }
  };

  const domTextArea = () => taRef.current?.resizableTextArea?.textArea ?? taRef.current;

  // ── 补全面板 ─────────────────────────────────────────────────────────────
  const cmdCtx = useMemo(() => completionContext(text, caret, commands), [text, caret, commands]);
  const cmdItems = useMemo(() => panelItems(cmdCtx), [cmdCtx]);
  const atCtx = useMemo(() => atContext(text, caret), [text, caret]);

  // @ 候选：服务端搜（fs.search）—— 防抖 120ms（敲键别一字符一往返）；
  // 用 alive 旗丢陈旧响应（bus.request 本身不可取消）；失败（断线/无 Agent 空间）静默置空 = 不弹。
  const cwd = useChatStore((s) => s.cwd); // 换 Agent 空间要重搜（服务端 cwd 随焦点变）
  const [fileItems, setFileItems] = useState([]);
  useEffect(() => {
    const q = atCtx?.query;
    if (q === undefined) {
      setFileItems([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await bus.request("fs.search", { query: q, limit: 20 }, { net: true });
        if (alive) setFileItems(r?.items ?? []);
      } catch {
        if (alive) setFileItems([]);
      }
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [atCtx?.query, cwd]);

  const fileMode = !!atCtx;
  const items = fileMode ? fileItems : cmdItems;
  const panelOpen = !dismissed && items.length > 0; // 搜不到就不弹（与 pi 同款）
  const sel = items.length ? Math.min(panelSel, items.length - 1) : 0;

  /** 落文本 + 落光标（textRef 是录音回调的即时镜像，必须同步，否则下次语音注入在旧文本上 splice） */
  const applyText = (next, pos) => {
    textRef.current = next;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = domTextArea();
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch {}
    });
  };

  /** 选中一条（回填不发送）：命令叶子/文件回填完面板自然收；目录回填带 / 继续下钻 */
  const pick = (node) => {
    if (!node) return;
    const r = fileMode ? fillAt(text, caret, atCtx, node) : fillText(text, caret, cmdCtx, node);
    setPanelSel(0);
    setDismissed(false);
    applyText(r.text, r.caret);
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent?.isComposing) return; // 中文输入法组词中：一切键归输入法（别把选词当发送）
    // 键位：Enter 发送（busy 中 = 插队）；Shift+Enter 换行（不拦，交给 textarea 默认）；Esc = 停止。
    // 面板开着时 Enter 例外 = 回填（不然面板没法用键盘确认）；Esc 也优先关面板，关掉后再按才停。
    if (panelOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPanelSel((sel + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPanelSel((sel - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(items[sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      abort(); // 幂等：不在跑就什么也不做
    }
  };

  // stt.final 一次性注入（空文本跳过：没说话不往输入框塞）
  const onSttFinal = (finalText) => {
    const ins = finalText || "";
    if (!ins.trim()) return;
    const len = textRef.current.length;
    const a = anchorRef.current ?? {};
    const start = a.start == null ? len : Math.min(a.start, len);
    const end = a.end == null ? start : Math.max(start, Math.min(a.end, len));
    applyText(textRef.current.slice(0, start) + ins + textRef.current.slice(end), start + ins.length);
  };

  // 按住说话：pointerdown 锁锚点+开录；up/leave/cancel 停录
  const onVoiceDown = (e) => {
    if (connState !== "online") return;
    e.preventDefault();
    const el = domTextArea();
    anchorRef.current = {
      start: el?.selectionStart ?? textRef.current.length,
      end: el?.selectionEnd ?? textRef.current.length,
    };
    useSTTStore.getState().startRecording(onSttFinal);
  };
  const onVoiceUp = () => {
    if (useSTTStore.getState().isRecording) useSTTStore.getState().stopRecording();
  };

  // 卸载清场：录音中则停并丢本轮
  useEffect(() => {
    return () => useSTTStore.getState().cleanup();
  }, []);

  return (
    <Flex vertical gap={8} style={{ position: "relative" }}>
      {/* / 命令面板：绝对贴本容器上沿，向上盖住消息流下沿（不吃布局） */}
      <Palette
        open={panelOpen}
        variant={fileMode ? "file" : "command"}
        items={items}
        selected={sel}
        header={
          !fileMode && cmdCtx?.level === 2 && cmdCtx.root
            ? { value: cmdCtx.root.value, description: cmdCtx.root.description }
            : null
        }
        leadSlash={cmdCtx?.level !== 2}
        onPick={pick}
        onHover={setPanelSel}
      />

      {/* 待插队条：服务端 queue 事件镜像（塞入→出现 / 投递→消失）；空则不占位。放在输入框上面，
          与聊天区消息同视界：插队请求已受理、等当前 toolCall 收尾即可见 */}
      {steers.length > 0 && (
        <Flex wrap gap={6} align="center" style={{ fontSize: T.fontSize.xs, color: T.color.textMuted }}>
          <LoadingOutlined style={{ fontSize: T.fontSize.xs, color: T.color.primary }} />
          <span>{steers.length > 1 ? `待插队 ${steers.length} 条` : "插队中"}</span>
          {steers.map((s, i) => (
            <span
              key={i}
              style={{
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: T.fontFamily.mono,
                color: T.color.textSecondary,
              }}
            >
              “{s}”
            </span>
          ))}
        </Flex>
      )}

      {/* 语音中间态条：录音中/识别中/出错才占位；final 注入后自动清空 */}
      {(isRecording || partialText || sttError) && (
        <Flex
          align="flex-start"
          gap={6}
          style={{
            fontSize: T.fontSize.xs,
            lineHeight: T.lineHeight.xs,
            color: sttError ? T.color.error : T.color.textMuted,
            background: sttError ? undefined : T.color.panelBg,
            border: `1px solid ${sttError ? T.color.error : T.color.hairline}`,
            borderRadius: T.radius.sm,
            padding: "4px 8px",
            maxHeight: 64,
            overflowY: "auto",
          }}
        >
          {sttError ? (
            <span style={{ color: T.color.error, flexShrink: 0 }}>⚠</span>
          ) : listening ? (
            <span
              style={{
                color: T.color.error,
                flexShrink: 0,
                lineHeight: T.lineHeight.xs,
                animation: "pc-blink 1.2s infinite",
              }}
            >
              ●
            </span>
          ) : (
            <span style={{ color: T.color.textMuted, flexShrink: 0, lineHeight: T.lineHeight.xs }}>⏳</span>
          )}
          <span style={{ wordBreak: "break-all" }}>
            {sttError
              ? sttError
              : !listening
                ? "正在启动麦克风…"
                : partialText || "正在聆听…"}
          </span>
        </Flex>
      )}

      <Input.TextArea
        ref={taRef}
        value={text}
        onChange={(e) => {
          textRef.current = e.target.value;
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setPanelSel(0);
          setDismissed(false); // 文本一变：解除 Esc 抑制，允许重开
        }}
        onSelect={(e) => setCaret(e.target.selectionStart ?? 0)} // 光标动（键盘/鼠标/方向键）→ 面板跟着重算
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setDismissed(true), 120)} // 点列表项走 pointerdown+preventDefault，不会飘到这里
        placeholder={
          isCompacting
            ? "压缩中…"
            : busy
              ? "回复中…Enter 插队"
              : "Shift+Enter 换行 · / 命令 · @ 引用文件"
        }
        disabled={isCompacting || pending}
        autoSize={{ minRows: 1, maxRows: 8 }}
      />

      {/* 动作行：停止(1) | 按住说话(2) | 发送/插队(1) */}
      <Flex gap={8}>
        <span style={{ flex: "1 1 25%" }}>
          {/* 停止：running / pending / compacting 都可点（口径同 chatActions.abort），只有空闲才禁用。
              ★ 别加 loading={pending}：antd 的 loading 会拦掉 onClick，pending 时就真点不动了。 */}
          <Button block icon={<StopOutlined />} disabled={status === "idle"} onClick={abort}>
            停止
          </Button>
        </span>
        <span style={{ flex: "2 1 50%" }}>
          <Button
            block
            danger={isRecording}
            disabled={connState !== "online" || isCompacting}
            icon={isRecording ? <LoadingOutlined /> : <AudioOutlined />}
            onPointerDown={onVoiceDown}
            onPointerUp={onVoiceUp}
            onPointerLeave={onVoiceUp}
            onPointerCancel={onVoiceUp}
            style={{ userSelect: "none", touchAction: "none" }}
          >
            {isRecording ? (listening ? "松开结束" : "松开取消") : "按住说话"}
          </Button>
        </span>
        <Button
          style={{ flex: "1 1 25%" }}
          type="primary"
          icon={<SendOutlined />}
          disabled={pending || !text.trim() || isCompacting}
          onClick={doSend}
        >
          {busy ? "插队" : "发送"}
        </Button>
      </Flex>
    </Flex>
  );
}
