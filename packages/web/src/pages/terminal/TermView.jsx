// 一个终端面板 = 一个 xterm 实例（与 editor 页"每 tab 一个 CodeMirror 常驻"同思路）。
//
// 生命周期：
//   挂载 → new Terminal + open + 登记 sink（此后输出直通，见 term-store 头注）→ attach（整屏回放）
//   尺寸 → ResizeObserver（面板拖宽、窗口缩放、切 tab 显隐都会触发）→ fit() → 发 term.resize
//           ★ 只有 owner（attach 回执里给的）真发得出去，见 term-store 的 sendResize
//   卸载 → 退订（term.detach，后端别再推这个终端的输出）+ 注销 sink + dispose
// 重连（chamber 重启）：store.epoch 变化 → 重新 attach 一次，把断线期间的输出补回来。
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { T } from "../../theme/tokens.js";
import { TERM_THEME } from "../../theme/terminal.js";
import { registerSink, unregisterSink, useTermStore, termActions } from "../../stores/index.js";

export default function TermView({ termId, visible }) {
  const boxRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const epoch = useTermStore((s) => s.epoch);
  const { attach, detach, sendInput, sendResize } = termActions;

  // 建实例（每个 termId 一次）：只建不重建，切 tab 靠 display 显隐
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: T.fontFamily.mono,
      fontSize: T.fontSize.sm,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000, // 屏上回滚条数（服务端另存 200KB 原始字节用于重连回放，两者用途不同）
      allowProposedApi: true,
    });
    // Ctrl+Shift+C/V 复制粘贴（终端的常规约定；其余键一律交给 xterm 自己编）。
    // ★ xterm 6 里这不是构造项，是方法（旧版的 customKeyEventHandler 选项已删）。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyC" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.code === "KeyV") {
        navigator.clipboard
          ?.readText()
          .then((t) => t && sendInput(termId, t))
          .catch(() => {});
        return false;
      }
      return true;
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    termRef.current = term;
    fitRef.current = fit;
    registerSink(termId, term);

    // 键盘（含粘贴、方向键、Ctrl+C 等控制键）→ 原样透传（xterm 已编成终端要的字节序列）
    const sub = term.onData((d) => sendInput(termId, d));

    // 尺寸：容器可见时才量（隐藏时 offsetWidth=0，fit 会把 cols 算成垃圾）
    const apply = () => {
      if (!box.isConnected || box.offsetWidth < 20 || box.offsetHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sendResize(termId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    apply();

    return () => {
      ro.disconnect();
      sub.dispose();
      unregisterSink(termId);
      detach(termId); // ★ 退订：面板没了就别再推输出（否则字节照发、这边白收）
      try {
        term.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, [termId, sendInput, sendResize, detach]);

  // 接管屏幕：首次挂载 + 每次前端重连（epoch）都整屏回放一次。
  // 回执带 owner：是 owner 才量尺寸并纠正 PTY（PTY 只有一个尺寸，多窗口时归第一个 attach 的）
  useEffect(() => {
    attach(termId).then((r) => {
      if (!r?.owner) return;
      const t = termRef.current;
      if (!t) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      sendResize(termId, t.cols, t.rows);
    });
  }, [termId, epoch, attach, sendResize]);

  // 变成当前 tab：重新量尺寸 + 抢焦点（否则敲字进了别处）
  useEffect(() => {
    if (!visible) return;
    const t = termRef.current;
    const box = boxRef.current;
    if (!t || !box) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
      sendResize(termId, t.cols, t.rows);
      t.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, termId, sendResize]);
  return <div ref={boxRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />;
}
