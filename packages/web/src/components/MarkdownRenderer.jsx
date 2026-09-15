// MarkdownRenderer：MarkdownGo 渲染的 React 壳（从老 chamber 直贴，后已接主题）
// 引擎是独立发布的 npm 包 @willianqrunning/markdown-go（纯解析零框架），这里只做 new MarkdownGo().render().html + 挂样式。
// 样式纪律：STYLES 只留**结构**（选择器/间距/em 比例），颜色字号一律 var(--pc-*)，
// 真相在 src/theme/tokens.js（md 组）——改 token 这里自动跟随。
// 注意仍是深底配色 —— 使用时外层容器要放深底（聊天 assistant 气泡即深色卡片）。
import { memo, useMemo } from "react";
import MarkdownGo from "@willianqrunning/markdown-go";
import "katex/dist/katex.min.css"; // 公式样式（引擎插件不注入，使用层负责）

const STYLES = `
.markdown-body { color: var(--pc-md-text); line-height: 1.7; font-size: var(--pc-font-size-sm); font-family: var(--pc-font-sans); }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  color: var(--pc-md-strong); font-weight: 600; margin: 1.5em 0 0.5em;
  padding-bottom: 0.3em;
}
.markdown-body h1 { font-size: 1.7em; }
.markdown-body h2 { font-size: 1.4em; }
.markdown-body h3 { font-size: 1.2em; }
.markdown-body h4 { font-size: 1.1em; }
.markdown-body h5, .markdown-body h6 { font-size: 1em; color: var(--pc-md-dim); }
.markdown-body p { margin: 0.8em 0; }
.markdown-body a { color: var(--pc-md-link); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body strong { color: var(--pc-md-strong); font-weight: 600; }
.markdown-body em { font-style: italic; color: var(--pc-md-text); opacity: 0.85; }
.markdown-body code {
  background: var(--pc-bg-code); color: var(--pc-md-code-text); padding: 0.15em 0.4em;
  border-radius: var(--pc-radius-xs); font-size: 0.9em;
  font-family: var(--pc-font-mono);
}
.markdown-body pre {
  background: var(--pc-bg-pre); border: 1px solid var(--pc-line-hard); border-radius: var(--pc-radius-base);
  padding: 1em; overflow-x: auto; margin: 1em 0;
}
.markdown-body pre code { background: none; padding: 0; color: var(--pc-md-text); font-size: 0.9em; }
.markdown-body ul, .markdown-body ol { padding-left: 2em; margin: 0.5em 0; }
.markdown-body ul { list-style-type: disc; }
.markdown-body ol { list-style-type: decimal; }
.markdown-body li { margin: 0.3em 0; }
.markdown-body li::marker { color: var(--pc-md-marker); }
.markdown-body blockquote {
  border-left: 3px solid var(--pc-line-quote); color: var(--pc-md-quote); padding: 0.5em 1em;
  margin: 1em 0; background: var(--pc-bg-pre);
}
.markdown-body hr { border: none; border-top: 1px solid var(--pc-line-mid); margin: 1.5em 0; }
.markdown-body table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: var(--pc-font-size-sm); }
.markdown-body th, .markdown-body td { border: 1px solid var(--pc-line-mid); padding: 0.5em 0.8em; text-align: left; }
.markdown-body th { background: var(--pc-md-th-bg); color: var(--pc-md-strong); font-weight: 600; }
.markdown-body tr:nth-child(even) { background: var(--pc-bg-pre); }
.markdown-body img { max-width: 100%; border-radius: var(--pc-radius-sm); margin: 0.5em 0; }
.hljs { background: var(--pc-bg-pre); color: var(--pc-md-text); }
.hljs-comment, .hljs-quote { color: var(--pc-md-hljs-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag { color: var(--pc-md-hljs-keyword); }
.hljs-function .hljs-title, .hljs-title { color: var(--pc-md-hljs-title); }
.hljs-number, .hljs-literal { color: var(--pc-md-hljs-number); }
.hljs-string, .hljs-regexp { color: var(--pc-md-hljs-string); }
.hljs-variable, .hljs-template-variable { color: var(--pc-md-hljs-variable); }
.hljs-built_in, .hljs-builtin-name { color: var(--pc-md-hljs-built-in); }
.hljs-type, .hljs-class .hljs-title { color: var(--pc-md-hljs-built-in); }
.hljs-params { color: var(--pc-md-hljs-params); }
.hljs-attr, .hljs-attribute { color: var(--pc-md-hljs-number); }
.hljs-meta { color: var(--pc-md-hljs-meta); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
`;

function MarkdownRenderer({ content, className = "" }) {
  const html = useMemo(() => {
    const md = new MarkdownGo();
    return md.render(content).html;
  }, [content]);
  // ★ 这个对象必须缓存：每次传新对象时 React 用 === 比 dangerouslySetInnerHTML（见
  //   react-dom updateProperties），永远判为"变了" → domElement.innerHTML 整段重设 →
  //   插件 setTimeout 画上去的 echarts canvas 被抹掉（滚动触发的重渲染就够触发）。
  //   同引用 → React 跳过 → canvas 存活。
  const htmlProp = useMemo(() => ({ __html: html }), [html]);

  return (
    <>
      <style>{STYLES}</style>
      <div className={`markdown-body ${className}`} dangerouslySetInnerHTML={htmlProp} />
    </>
  );
}

// memo：内容没变就不重渲染（流式 delta 内容变时照常更新）。
export default memo(MarkdownRenderer);
