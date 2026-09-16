import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Flex, Input } from "antd";
import {
  AudioOutlined,
  CloseOutlined,
  LoadingOutlined,
  PictureOutlined,
  SendOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useChatStore, chatActions, useSTTStore, useSettingStore } from "../../stores/index.js";
import { bus, useConnStore } from "../../bus.js";
import { T } from "../../theme/tokens.js";
import Palette from "./Palette.jsx";
import { completionContext, fillText, panelItems } from "./command-match.js";
import { atContext, fillAt } from "./file-match.js";
import { MAX_IMAGES, compressAll, dataUrl, imageFilesFrom, pickImages } from "./attachments.js";

// ───────────────────── pages/chat / InputBox.jsx ─────────────────────
// prompt 输入区（三层，镜像左栏 Sessions 面板底部：提示条 + 输入行 + 动作行）：
//   输入行 = TextArea（占满）+ 图片钮（贴右边，与输入框底对齐）
//     Enter 发送（running 中 = steer 插队）/ Shift+Enter 换行 / Esc 停止；忙时不禁用
//     ★ Esc 只是这里的顺手一份：发送后 TextArea 变 disabled 会丢焦点（掉到 body），本处 handler 收不到，
//       真正兜底的是 chat 页那条 window 冒泡 Esc（见 pages/chat/index.jsx）。
//   动作行 = 停止 | 按住说话 | 发送/插队（1:2:1 ≈ 25/50/25）
//   发送语义 = emit 无回执，**发出即清**（send 返回 false = 被挡下，文字保留）；
//
// 文件内按「能力域」分块（每块自足、互不相干；改一块不用读别的）：
//   useCompletionPanel —— / 命令 + @ 文件补全（一份面板两种来源）
//   useImageAttachments —— 图片附件（三条入口 + 压缩 + 上限 + 切会话清空）
//   useVoiceInput —— 按住说话（STT）
//   SteerBar / VoiceStatusBar / AttachmentStrip / ActionBar —— 四块纯展示 UI
// 主组件只剩「编排 + TextArea + 两个共享原语（applyText / onKeyDown）」。
//
// ── 补全面板（useCompletionPanel）──
//   / 命令 = 本地算（command-match.js 纯函数，敲键零往返，清单随 chat.sync 的 commands 字段推）
//   @ 文件 = 服务端拉（fs.search 在 Agent 空间里搜，异步 → 防抖 + 丢陈旧响应）
//   优先级 @ > /：与 pi 的 getSuggestions 同序（先查 @ 前缀，命中就不走命令分支）。
//   ★ 两种来源共用一个面板与一套键位（↑↓/Tab/Enter/Esc），只靠 variant 换行渲染。
//   打开/关闭每次渲染现算，本地只存两个交互态：sel（选中下标）、dismissed（Esc 关掉后抑制重开）。
//   命令一律走同一条 send 通道（服务端分诊）；@ 回填完不发送（用户接着写完话再回车）。
//
// ── 按住说话（useVoiceInput）──
//   按下锁光标锚点 + 开录开推；中间结果只上提示条（不碰输入框）；
//   等后端 stt.final（整轮终止确认）一次性注入锚点处，空文本跳过。失败 = 提示条报错，输入框从未被改过。
//
// ── 图片附件（useImageAttachments）──
//   粘贴 / 拖拽 / 选文件三条入口，都是浏览器原生。
//   · 压缩在**前端**做（1280px / JPEG 0.8，~150KB）—— 图进了消息就必然落盘 jsonl，
//     压不压都得存，压一遍档案和线帧一起瘦（为什么不在服务端压：见 attachments.js 头注）。
//   · 开关 = chat.sync 的 modelInput（服务端预判的模型输入能力）：不支持图时
//     按钮置灰、粘贴/拖拽也拦（挡在入口，不等到 provider 报错）。
//   · 手机端靠 <input accept="image/*"> 自动弹「拍照 / 相册」（不用 getUserMedia，那个要 HTTPS）。

// ═══════════════════════════ 能力域：补全面板 ═══════════════════════════

/**
 * / 命令 + @ 文件补全。一份面板两种来源，一套键位。
 * @param text/caret      输入框当前文本与光标（面板每次渲染现算，不存状态）
 * @param commands        命令清单（chat.sync 推）
 * @param cwd             Agent 空间（换目录要重搜 @ 候选）
 * @param applyText(next, pos) 回填（共享原语，在壳里定义）
 * @returns { open, items, sel, fileMode, cmdCtx, pick, hover, handleKey, reset, onTextChange }
 *   handleKey(e) → boolean：true = 已消费（壳里的 onKeyDown 据此短路）
 */
function useCompletionPanel({ text, caret, commands, cwd, applyText }) {
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [fileItems, setFileItems] = useState([]);

  const cmdCtx = useMemo(() => completionContext(text, caret, commands), [text, caret, commands]);
  const cmdItems = useMemo(() => panelItems(cmdCtx), [cmdCtx]);
  const atCtx = useMemo(() => atContext(text, caret), [text, caret]);

  // @ 候选：服务端搜（fs.search）—— 防抖 120ms（敲键别一字符一往返）；
  // 用 alive 旗丢陈旧响应（bus.request 本身不可取消）；失败（断线/无 Agent 空间）静默置空 = 不弹。
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
  const open = !dismissed && items.length > 0; // 搜不到就不弹（与 pi 同款）
  const selected = items.length ? Math.min(sel, items.length - 1) : 0;

  /** 选中一条（回填不发送）：命令叶子/文件回填完面板自然收；目录回填带 / 继续下钻 */
  const pick = useCallback(
    (node) => {
      if (!node) return;
      const r = fileMode ? fillAt(text, caret, atCtx, node) : fillText(text, caret, cmdCtx, node);
      setSel(0);
      setDismissed(false);
      applyText(r.text, r.caret);
    },
    [fileMode, text, caret, atCtx, cmdCtx, applyText]
  );

  /** 面板键位（↑↓ 选择 / Tab·Enter 回填 / Esc 收起）。返回 true = 已消费 */
  const handleKey = (e) => {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((selected + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((selected - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      pick(items[selected]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return {
    open,
    items,
    sel: selected,
    fileMode,
    cmdCtx,
    pick,
    hover: setSel,
    handleKey,
    /** 文本一变：选中归零 + 解除 Esc 抑制（允许重开） */
    onTextChange: () => {
      setSel(0);
      setDismissed(false);
    },
    /** 输入框失焦 → 收起面板（点列表项走 pointerdown+preventDefault，不会飘到这里） */
    dismiss: () => setDismissed(true),
    /** 发出消息后归位 */
    reset: () => {
      setSel(0);
      setDismissed(false);
    },
  };
}

// ═══════════════════════════ 能力域：图片附件 ═══════════════════════════

/**
 * 图片附件：收文件 → 挑选 → 压缩 → 挂到附件条。
 * canImage 是闸：不支持图的模型，粘/拖/选一律拦在入口（附提示），不等到 provider 报错。
 * @returns { images, note, canImage, addFiles, removeImage, clear, pickerRef }
 *   pickerRef → 隐藏的 <input type="file">（壳里渲染，点它 = 开系统选择器）
 */
function useImageAttachments() {
  const activeId = useChatStore((s) => s.activeId);
  const modelInput = useChatStore((s) => s.modelInput); // 服务端预判的模型输入能力
  const canImage = modelInput?.includes("image") ?? false;

  const [images, setImages] = useState([]); // 线帧形状的图片块（已压缩）
  const [note, setNote] = useState(null); // 附件区的提示（超量/类型不对/处理失败）
  const imagesRef = useRef([]); // images 的即时镜像（window 拖拽回调在事件外）
  const pickerRef = useRef(null); // 隐藏的 <input type="file">

  const addFiles = useCallback(
    async (files) => {
      if (!canImage) {
        setNote("当前模型不支持图片");
        return;
      }
      const room = MAX_IMAGES - imagesRef.current.length;
      if (room <= 0) {
        setNote(`最多 ${MAX_IMAGES} 张`);
        return;
      }
      const { files: ok, rejected } = pickImages(files, room);
      if (!ok.length) {
        setNote(rejected);
        return;
      }
      setNote(rejected);
      const { images: done, failed } = await compressAll(ok);
      if (failed) setNote(`有 ${failed} 张处理失败`);
      if (!done.length) return;
      const next = [...imagesRef.current, ...done].slice(0, MAX_IMAGES);
      imagesRef.current = next;
      setImages(next);
    },
    [canImage]
  );

  // 拖拽：挂 window（只挂输入区的话，拖到消息流上浏览器会直接打开图片）
  useEffect(() => {
    const onDragOver = (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDrop = (e) => {
      const files = imageFilesFrom(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  // 换会话：附件不跟着跑（图是给这一场发的）
  useEffect(() => {
    imagesRef.current = [];
    setImages([]);
    setNote(null);
  }, [activeId]);

  const removeImage = (i) => {
    const next = imagesRef.current.filter((_, j) => j !== i);
    imagesRef.current = next;
    setImages(next);
  };

  const clear = useCallback(() => {
    imagesRef.current = [];
    setImages([]);
    setNote(null);
  }, []);

  /** 粘贴：剪贴板里有图就吃下来（没有图 → 不拦，走默认的文本粘贴） */
  const onPaste = (e) => {
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };

  return { images, note, canImage, addFiles, removeImage, clear, pickerRef, onPaste };
}

// ═══════════════════════════ 能力域：按住说话 ═══════════════════════════

/**
 * 按住说话（STT）：pointerdown 锁锚点 + 开录；up/leave/cancel 停录。
 * @param textRef       文本即时镜像（录音回调在事件外，别吃闭包旧值）
 * @param getTextarea   取原生 textarea（拿当前选区当锚点）
 * @param applyText     注入原语（共享）
 * @param busy          压缩中（与其它入口同口径的禁用）
 * @returns { isRecording, listening, partialText, error, disabled, onDown, onUp }
 */
function useVoiceInput({ textRef, getTextarea, applyText, busy }) {
  // ★ 识别功能总开关（服务端设置）：关着时话筒钮照常渲染，只置灰不可按（布局不跳）
  const sttEnabled = useSettingStore((s) => s.setting?.stt?.enabled) ?? false;
  const connState = useConnStore((s) => s.state); // 离线时录音等于白推 → 禁钮
  const isRecording = useSTTStore((s) => s.isRecording);
  const listening = useSTTStore((s) => s.listening); // 真在采样：false = 启动中（还没开录，别说话）
  const partialText = useSTTStore((s) => s.partialText);
  const error = useSTTStore((s) => s.error);
  const anchorRef = useRef(null); // 按下时的光标锚点 {start, end}

  // 话筒钮可用口径：一处定义，disabled 与 onDown 共用。
  // ★ 光靠 antd 的 disabled 拦不住 pointer 事件（React 只对 click/mouse* 做 disabled 检查）
  //   → 按下仍会开录，所以 handler 里必须再判一次。
  const disabled = !sttEnabled || connState !== "online" || busy;

  // stt.final 一次性注入（空文本跳过：没说话不往输入框塞）
  const onFinal = (finalText) => {
    const ins = finalText || "";
    if (!ins.trim()) return;
    const len = textRef.current.length;
    const a = anchorRef.current ?? {};
    const start = a.start == null ? len : Math.min(a.start, len);
    const end = a.end == null ? start : Math.max(start, Math.min(a.end, len));
    applyText(textRef.current.slice(0, start) + ins + textRef.current.slice(end), start + ins.length);
  };

  const onDown = (e) => {
    if (disabled) return;
    e.preventDefault();
    const el = getTextarea();
    anchorRef.current = {
      start: el?.selectionStart ?? textRef.current.length,
      end: el?.selectionEnd ?? textRef.current.length,
    };
    useSTTStore.getState().startRecording(onFinal);
  };
  const onUp = () => {
    if (useSTTStore.getState().isRecording) useSTTStore.getState().stopRecording();
  };

  // 卸载清场：录音中则停并丢本轮
  useEffect(() => {
    return () => useSTTStore.getState().cleanup();
  }, []);

  return { isRecording, listening, partialText, error, disabled, onDown, onUp };
}

// ═══════════════════════════ 纯展示 UI（props 进、事件出）═══════════════════════════

/** 待插队条：服务端 queue 事件镜像（塞入→出现 / 投递→消失）；空则不占位。
 *  放在输入框上面，与聊天区消息同视界：插队请求已受理、等当前 toolCall 收尾即可见。 */
function SteerBar({ steers }) {
  if (!steers.length) return null;
  return (
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
          “{s || "（图片）"}”
        </span>
      ))}
    </Flex>
  );
}

/** 语音中间态条：录音中/识别中/出错才占位；final 注入后自动清空 */
function VoiceStatusBar({ isRecording, listening, partialText, error }) {
  if (!isRecording && !partialText && !error) return null;
  return (
    <Flex
      align="flex-start"
      gap={6}
      style={{
        fontSize: T.fontSize.xs,
        lineHeight: T.lineHeight.xs,
        color: error ? T.color.error : T.color.textMuted,
        background: error ? undefined : T.color.panelBg,
        border: `1px solid ${error ? T.color.error : T.color.hairline}`,
        borderRadius: T.radius.sm,
        padding: "4px 8px",
        maxHeight: 64,
        overflowY: "auto",
      }}
    >
      {error ? (
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
        {error ? error : !listening ? "正在启动麦克风…" : partialText || "正在聆听…"}
      </span>
    </Flex>
  );
}

/** 附件条：已选图片的缩略图（点 × 删）+ 一行提示（超量/类型不对/处理失败）。
 *  位置紧贴输入框上方 —— 与即将发出去的那条消息同一个视界。 */
function AttachmentStrip({ images, note, onRemove }) {
  if (!images.length && !note) return null;
  return (
    <Flex wrap gap={6} align="center" style={{ fontSize: T.fontSize.xs, color: T.color.textMuted }}>
      {images.map((im, i) => (
        <div key={i} style={{ position: "relative", lineHeight: 0 }}>
          <img
            src={dataUrl(im)}
            alt=""
            style={{
              width: 56,
              height: 56,
              objectFit: "cover",
              borderRadius: T.radius.sm,
              border: `1px solid ${T.color.hairline}`,
              display: "block",
            }}
          />
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={() => onRemove(i)}
            title="移除"
            style={{
              position: "absolute",
              top: -8,
              right: -8,
              minWidth: 18,
              width: 18,
              height: 18,
              padding: 0,
              fontSize: 10,
              color: T.color.textPrimary,
              background: T.color.panelBg,
              border: `1px solid ${T.color.hairline}`,
              borderRadius: "50%",
            }}
          />
        </div>
      ))}
      {note && <span style={{ color: T.color.warn }}>{note}</span>}
    </Flex>
  );
}

/** 动作行：停止(1) | 按住说话(2) | 发送/插队(1)。三颗钮恒定布局（25/50/25）；
 *  语音识别关着时话筒钮照常渲染，只是置灰不可按 —— 布局不因开关而变。 */
function ActionBar({ isRecording, listening, voiceDisabled, onVoiceDown, onVoiceUp, canSend, onSend, onAbort }) {
  const status = useChatStore((s) => s.status);
  const busy = status === "running" || status === "compacting";
  const pending = status === "pending";
  return (
    <Flex gap={8}>
      <span style={{ flex: "1 1 25%" }}>
        {/* 停止：running / pending / compacting 都可点（口径同 chatActions.abort），只有空闲才禁用。
            ★ 别加 loading={pending}：antd 的 loading 会拦掉 onClick，pending 时就真点不动了。 */}
        <Button block icon={<StopOutlined />} disabled={status === "idle"} onClick={onAbort}>
          停止
        </Button>
      </span>
      <span style={{ flex: "2 1 50%" }}>
        <Button
          block
          danger={isRecording}
          disabled={voiceDisabled}
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
        disabled={pending || !canSend || status === "compacting"}
        onClick={onSend}
      >
        {busy ? "插队" : "发送"}
      </Button>
    </Flex>
  );
}

// ═══════════════════════════ 壳：编排 ═══════════════════════════

export default function InputBox() {
  // 状态全是帧驱动的 status（idle | pending | running | compacting）：
  //   running   = 一轮在跑 → Enter 自动走插队（steer）
  //   pending   = 本端刚发出申请/停止，等真值帧 → 挡输入与发送（停止钮仍可点）
  //   compacting = 服务端会拒接普通 prompt → 直接禁输入
  const status = useChatStore((s) => s.status);
  const steers = useChatStore((s) => s.steers);
  const commands = useChatStore((s) => s.commands); // / 命令清单（随焦点走，chat.sync 整份覆盖）
  const cwd = useChatStore((s) => s.cwd); // 换 Agent 空间要重搜 @ 候选
  const pending = status === "pending";
  const isCompacting = status === "compacting";

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0); // 光标位（面板现算要用）

  const taRef = useRef(null); // antd TextArea → 原生 textarea
  const textRef = useRef(""); // text 的即时镜像（录音回调在事件外，别吃闭包旧值）

  const getTextarea = useCallback(() => taRef.current?.resizableTextArea?.textArea ?? taRef.current, []);

  /** 落文本 + 落光标（**共享原语**：补全回填、语音注入都走它）。
   *  textRef 是录音回调的即时镜像，必须同步，否则下次语音注入在旧文本上 splice。 */
  const applyText = useCallback(
    (next, pos) => {
      textRef.current = next;
      setText(next);
      setCaret(pos);
      requestAnimationFrame(() => {
        const el = getTextarea();
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {}
      });
    },
    [getTextarea]
  );

  const panel = useCompletionPanel({ text, caret, commands, cwd, applyText });
  const img = useImageAttachments();
  const voice = useVoiceInput({ textRef, getTextarea, applyText, busy: isCompacting });

  const canSend = !!text.trim() || img.images.length > 0; // 文本与图至少一个非空

  // 发出即清（新协议 emit 无回执，不回滚）；send 返回 false = 被挡下（在途/离线）→ 内容保留
  const doSend = () => {
    if (pending || !canSend) return;
    if (chatActions.send(text, img.images)) {
      textRef.current = "";
      setText("");
      setCaret(0);
      panel.reset();
      img.clear();
    }
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent?.isComposing) return; // 中文输入法组词中：一切键归输入法（别把选词当发送）
    // 面板优先（开着时 Enter = 回填、Esc = 收面板）；其余：Enter 发送（busy 中 = 插队）、Esc 停止
    if (panel.handleKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      chatActions.abort(); // 幂等：不在跑就什么也不做
    }
  };

  return (
    <Flex vertical gap={8} style={{ position: "relative" }}>
      {/* 补全面板：绝对贴本容器上沿，向上盖住消息流下沿（不吃布局） */}
      <Palette
        open={panel.open}
        variant={panel.fileMode ? "file" : "command"}
        items={panel.items}
        selected={panel.sel}
        header={
          !panel.fileMode && panel.cmdCtx?.level === 2 && panel.cmdCtx.root
            ? { value: panel.cmdCtx.root.value, description: panel.cmdCtx.root.description }
            : null
        }
        leadSlash={panel.cmdCtx?.level !== 2}
        onPick={panel.pick}
        onHover={panel.hover}
      />

      <SteerBar steers={steers} />
      <VoiceStatusBar
        isRecording={voice.isRecording}
        listening={voice.listening}
        partialText={voice.partialText}
        error={voice.error}
      />
      <AttachmentStrip images={img.images} note={img.note} onRemove={img.removeImage} />

      {/* 隐藏的选文件入口：accept="image/*" 在手机上会自动弹「拍照 / 相册 / 浏览」。
          ★ 故意不加 capture —— 加了就只剩相机，相册入口没了。 */}
      <input
        ref={img.pickerRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void img.addFiles([...(e.target.files ?? [])]);
          e.target.value = ""; // 清掉：同一个文件再选一次也要能触发 change
        }}
      />

      {/* 输入行：TextArea 占满 + 图片钮贴右边（align=flex-end：输入框长高时按钮跟底对齐） */}
      <Flex gap={6} align="flex-end">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input.TextArea
            ref={taRef}
            value={text}
            onChange={(e) => {
              textRef.current = e.target.value;
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              panel.onTextChange();
            }}
            onSelect={(e) => setCaret(e.target.selectionStart ?? 0)} // 光标动（键盘/鼠标/方向键）→ 面板跟着重算
            onKeyDown={onKeyDown}
            onPaste={img.onPaste}
            onBlur={() => setTimeout(() => panel.dismiss(), 120)}
            placeholder={
              isCompacting
                ? "压缩中…"
                : status === "running"
                  ? "回复中…Enter 插队"
                  : "Shift+Enter 换行 · / 命令 · @ 引用文件"
            }
            disabled={isCompacting || pending}
            autoSize={{ minRows: 1, maxRows: 8 }}
          />
        </div>
        <Button
          icon={<PictureOutlined />}
          disabled={!img.canImage || isCompacting}
          onClick={() => img.pickerRef.current?.click()}
          title={img.canImage ? `添加图片（最多 ${MAX_IMAGES} 张）` : "当前模型不支持图片"}
        />
      </Flex>

      <ActionBar
        isRecording={voice.isRecording}
        listening={voice.listening}
        voiceDisabled={voice.disabled}
        onVoiceDown={voice.onDown}
        onVoiceUp={voice.onUp}
        canSend={canSend}
        onSend={doSend}
        onAbort={chatActions.abort}
      />
    </Flex>
  );
}
