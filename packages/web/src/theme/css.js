// tokens → CSS 变量（--pc-*）。字符串样式（MarkdownRenderer STYLES、index.css）
// 拿不到 JS 对象，统一走 var(--pc-*) 消费同一份 token。
import { T, palette } from "./tokens.js";

/** 生成 :root 块文本。变量名 = kebab(--pc-组-名)，md.hljs.x → --pc-md-hljs-x */
export function themeCssVars() {
  const vars = {
    "--pc-font-sans": T.fontFamily.sans,
    "--pc-font-mono": T.fontFamily.mono,
    ...Object.fromEntries(Object.entries(T.fontSize).map(([k, v]) => [`--pc-font-size-${k}`, `${v}px`])),
    ...Object.fromEntries(Object.entries(T.radius).map(([k, v]) => [`--pc-radius-${k}`, `${v}px`])),

    "--pc-bg-deep": palette.bgDeep,
    "--pc-bg-page": palette.bgDeep,
    "--pc-bg-hover": palette.surface2,
    "--pc-text-high": palette.ink,
    "--pc-scroll-thumb": palette.scrollThumb,
    "--pc-scroll-thumb-hover": palette.scrollThumbHover,
    "--pc-bg-pre": palette.bgPre,
    "--pc-bg-code": palette.bgCode,
    "--pc-line-hard": palette.lineHard,
    "--pc-line-mid": palette.lineMid,
    "--pc-line-quote": palette.lineQuote,
    "--pc-md-text": T.md.text,
    "--pc-md-strong": T.md.strong,
    "--pc-md-dim": T.md.dim,
    "--pc-md-quote": T.md.quote,
    "--pc-md-link": T.md.link,
    "--pc-md-code-text": T.md.codeText,
    "--pc-md-marker": T.md.marker,
    "--pc-md-th-bg": T.md.thBg,
    ...Object.fromEntries(Object.entries(T.md.hljs).map(([k, v]) => [`--pc-md-hljs-${kebab(k)}`, v])),
  };
  return `:root{color-scheme:dark;${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** 一次性把 :root 变量注入 document.head（main.jsx 启动时调用，先于首次渲染） */
export function applyThemeCss() {
  if (typeof document === "undefined" || document.getElementById("pc-theme-vars")) return;
  const style = document.createElement("style");
  style.id = "pc-theme-vars";
  style.textContent = themeCssVars();
  document.head.appendChild(style);
}
