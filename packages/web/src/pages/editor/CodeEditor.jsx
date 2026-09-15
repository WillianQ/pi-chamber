// CodeEditor：单个 tab 的 CodeMirror 6 实例（老 chamber TabEditor 移植，重选型前端自绘壳）。
//
// 要点：
//  - 每 tab 一个 EditorView 常驻（display 由页面切活）。EditorPage 本身懒加载（chunk 不进首屏），
//    语言包再按扩展名动态 import——python/json/md/html 只在真打开那种文件时才进内存。
//  - ExternalUpdate Annotation：程序性同步（后端推送替换 doc）与用户键入区分——
//    updateListener 见 annotation 不回流 setBuffer（防环）；用户键入才写 store。
//  - Mod-s 显式保存（无自动保存；保存走 editor-store.saveFile → editor.update 回执）。
//  - 自动换行：store.lineWrapping 全局开关，走 Compartment 热切（老 chamber 是改开关即重建 view，丢 undo；
//    这里同效不同法——只重配 wrap 扩展，实例常驻不动）。
//  - 主题：one-dark 语法色 + 本仓 token 壳色（背景/字族/字号/装订线），观感跟全站走。
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Annotation, Compartment } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { T } from "../../theme/tokens.js";
import { useEditorStore } from "../../stores/index.js";

// 程序性同步标记：后端推送替换 doc 用（updateListener 据此不回流 store）
const External = Annotation.define();

/** 语言包：按扩展名懒 import（返回 Promise<Extension> | null=纯文本）；null/失败回退纯文本 */
function langFor(p) {
  if (/\.(mjs|cjs|js)$/i.test(p)) return import("@codemirror/lang-javascript").then((m) => m.javascript());
  if (/\.jsx$/i.test(p)) return import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
  if (/\.tsx$/i.test(p)) return import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true }));
  if (/\.(ts|mts|cts)$/i.test(p)) return import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true }));
  if (/\.py$/i.test(p)) return import("@codemirror/lang-python").then((m) => m.python());
  if (/\.json$/i.test(p)) return import("@codemirror/lang-json").then((m) => m.json());
  if (/\.md$/i.test(p)) return import("@codemirror/lang-markdown").then((m) => m.markdown());
  if (/\.(html?|xml|svg)$/i.test(p)) return import("@codemirror/lang-html").then((m) => m.html());
  return null;
}

// 壳面（背景/字族/装订线）随 token；语法色交给 one-dark（与全站 one-dark 系同源）
const cmShell = EditorView.theme({
  "&": { height: "100%", fontSize: `${T.fontSize.sm}px`, backgroundColor: T.color.pageBg },
  ".cm-content": { fontFamily: T.fontFamily.mono, caretColor: T.color.primary },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: T.color.primary },
  ".cm-gutters": {
    backgroundColor: T.color.pageBg,
    color: T.color.textFaint,
    borderRight: `1px solid ${T.color.hairline}`,
  },
  ".cm-activeLine": { backgroundColor: T.color.plainRowBg },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-focused": { outline: "none" },
});

export default function CodeEditor({ file, onSave }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const setBuffer = useEditorStore((s) => s.setBuffer);
  const setScrollPos = useEditorStore((s) => s.setScrollPos);
  const lineWrapping = useEditorStore((s) => s.lineWrapping);
  const wrapComp = useRef(new Compartment()).current; // 每实例一个换行槽：开关只重配它

  // 建实例（path 一变即重建——重建丢 undo，老 chamber 同款取舍；语言包就位前不建）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    let disposed = false;
    let view = null;
    const create = (lang) => {
      if (disposed || viewRef.current) return;
      view = new EditorView({
        state: EditorState.create({
          doc: file.content,
          extensions: [
            basicSetup,
            oneDark,
            cmShell,
            lang,
            wrapComp.of(useEditorStore.getState().lineWrapping ? EditorView.lineWrapping : []), // 建实例时取最新开关（异步加载语言包期间可能已被切）
            keymap.of([
              indentWithTab,
              { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
            ]),
            EditorView.updateListener.of((u) => {
              // 用户键入（无 External 标记）→ 写 store 的 content（modified 由此而来）
              if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
                setBuffer(file.path, u.state.doc.toString());
              }
              if (u.viewportChanged) setScrollPos(file.path, u.view.scrollDOM.scrollTop);
            }),
          ],
        }),
        parent: host,
      });
      view.scrollDOM.scrollTop = file.scrollPos || 0;
      viewRef.current = view;
    };
    const job = langFor(file.path);
    if (job) {
      job.then(create).catch(() => create([])); // 语言包加载失败 → 纯文本兜底
    } else {
      create([]);
    }
    return () => {
      disposed = true;
      if (view) {
        view.destroy();
        viewRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  // 开关变化：热切 Compartment（不重建 view，滚动/undo 保持）；view 未就位（语言包在途）则等 create 时自取最新值
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: wrapComp.reconfigure(lineWrapping ? EditorView.lineWrapping : []) });
  }, [lineWrapping]);

  // 外部内容更新（后端推送 modify / new 覆盖）：整条替换 doc（打 External 标记防回流）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== file.content) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: file.content },
        annotations: External.of(true),
      });
    }
  }, [file.content]);

  return (
    <div
      ref={hostRef}
      style={{ height: "100%", minHeight: 0, overflow: "hidden", background: T.color.pageBg }}
    />
  );
}
