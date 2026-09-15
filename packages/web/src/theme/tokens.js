// ============================================================================
// 全平台视觉参数唯一真相源（colors / fonts / sizes / radius）。
// 两级 token 纪律：
//   palette —— 原色板（one-dark 系 + 深底/亮壳基色），业务代码**不直接用**；
//   T       —— 语义层（"用在哪"）：角色色块、卡片 tone、文本层级……业务只引用这层。
// 三个出口都从这里派生，改本文件一处 = 全站换肤：
//   theme/antd.js —— antd ConfigProvider theme（组件库跟随）
//   theme/css.js  —— :root CSS 变量 --pc-*（MarkdownRenderer STYLES 等字符串样式跟随）
//   直接 import T —— React inline style 组件跟随
// ============================================================================

import { isMobilePlatform } from "./platform.js";

/** 移动态标记：tokens 内多处档位共用，模块加载时判定一次（详见 theme/platform.js） */
const MOBILE = isMobilePlatform();

/** #rrggbb → rgba() 字符串（tone/色块都从原色板按透明度推导，不再手写 rgba 字面量） */
export function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ── 原色板 ──────────────────────────────────────────────────────────────────
export const palette = {
  // 强调色（one-dark 系，label/图标/状态用）
  blue: "#61afef",
  sky: "#79b8ff",
  green: "#98c379",
  red: "#f47067",
  purple: "#c678dd",
  orange: "#d19a66",
  yellow: "#e5c07b",
  cyan: "#56b6c2",
  violet: "#b392f0",
  slate: "#8b949e",
  steel: "#9da6b3",
  gray: "#6b7280",
  faint: "#5c6370",
  ink: "#e6e8eb", // 用户输入正文（深色流上最亮）
  parchment: "#c9d1d9", // custom 正文
  userTint: "#388bfd", // user 行底色基（rgba 14%）

  // 深色消息流基座 + 线
  bgDeep: "#0f1115",
  bgPre: "#0a0a0a",
  bgCode: "#111a11",
  lineHard: "#1a1a1a",
  lineMid: "#222222",
  lineDash: "#2a2f3a",
  lineQuote: "#333333",

  // markdown 正文系
  mdText: "#c8c8c8",
  mdStrong: "#e0e0e0",
  mdDim: "#aaaaaa",
  mdQuote: "#888888",
  mdLink: "#5a9a6a",
  mdCode: "#7a9f7a",
  mdMarker: "#555555",
  mdThul: "#d19a66", // hljs 独有角色（与 one-dark 主色板的差异就地保留）
  hljsComment: "#6a8a6a",
  hljsParams: "#abb2bf",
  hljsVar: "#e06c75",
  white: "#ffffff",

  // 壳表面层（antd chrome：顶栏 / Sider / 卡片 / 浮层）—— 全站深色：画布最深，面板/悬浮/浮层逐级抬升
  primary: "#61afef", // 主色 = one-dark 蓝（与消息流蓝同源；改它 = 换 antd 主色，activeRowBg 由 alpha() 推导自动跟随）
  surface1: "#161a20", // 面板底：Sider / 顶栏 / 信息条 / 卡片容器
  surface2: "#1d2229", // 行 hover / 半高亮（面板之上抬一档）
  surface3: "#252b34", // 浮层最高：下拉 / 弹窗 / Tooltip
  hairline: "#1f242b", // 结构分隔线（面板边界 / 行分隔）
  controlLine: "#2e3540", // 控件描边（Input/Select 等）
  scrollThumb: "#2c333d", // 滚动条滑块
  scrollThumbHover: "#3d4551", // 滚动条滑块 hover
};

// ── 语义层 ──────────────────────────────────────────────────────────────────
export const T = {
  fontFamily: {
    sans:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    mono: "ui-monospace, SFMono-Regular, Consolas, Menlo, monospace",
  },

  // 字号四档：业务代码禁写字面量，一律从这里取。
  // ★ 语义契约：**sm = 正文唯一档（要读的内容：md 正文/代码/列表主行/输入框）**，
  //   **xs = 辅助唯一档（标签/时间/路径条/状态/提示/错误横幅）**；base/lg 停用（仅历史档位，勿再取用）。
  // ★ 移动/桌面两套档位（isMobilePlatform 一次判定，见 theme/platform.js）：手机盯屏幕近，
  //   正文 14 太小 → 提到 16（顺带根治 iOS「输入框字号 <16px 聚焦即整页放大」）；辅助只微涨到 13，
  //   免得标签和正文一样大、长列表糊成一片。这一处改动全站联动：antd 基准字号、--pc-font-size-*、
  //   markdown 正文（内部全用 em）都从这张表派生，63 个业务调用点一个字都不用改。
  fontSize: MOBILE ? { xs: 13, sm: 16, base: 18, lg: 20 } : { xs: 12, sm: 14, base: 16, lg: 18 },
  // 行高与字号档位配对（约 1.5 倍）：桌面 xs↔18 / sm↔21 / base↔24；移动随字号同步抬一档
  //（lg 由语境自定，如 markdown 1.7）。**改字号必须改这里**，否则 16px 字压 21px 行高会挤。
  lineHeight: MOBILE ? { xs: "20px", sm: "24px", base: "27px" } : { xs: "18px", sm: "21px", base: "24px" },
  radius: { xs: 3, sm: 4, base: 6 },
  // 图标/符号尺寸（不属于字号体系，也别写字面量）：xs=微小符号（●/✕/caret/分隔符）、
  // sm=行内图标、base=操作图标/活动栏、lg=悬浮控件放大档、xl=空态大图标。
  // 移动手指要按，图标跟着抬一档。
  icon: MOBILE ? { xs: 11, sm: 16, base: 18, lg: 24, xl: 34 } : { xs: 10, sm: 14, base: 16, lg: 22, xl: 30 },

  color: {
    // 壳（全站深色）：页面/画布同底，面板抬一档、悬浮再抬、浮层最高——层级用亮度表达
    primary: palette.primary, // 焦点左竖条 / 选中标题 / 主按钮（one-dark 蓝）
    pageBg: palette.bgDeep, // 整站最底：登录页背景 / 右内容区（与聊天流同底 = 画布）
    panelBg: palette.surface1, // 面板底：Sider / 顶栏 / 信息条 / 卡片容器
    hoverBg: palette.surface2, // 行 hover / 半高亮
    hairline: palette.hairline, // 结构分隔线（面板边界 / 行分隔）
    activeRowBg: alpha(palette.primary, 0.15), // 焦点行底（主色 tint，替代旧亮蓝，主色换它自动跟）

    // 深色流（与 pageBg 同底，画布即最底）
    streamBg: palette.bgDeep,
    dashedDivider: palette.lineDash,
    plainRowBg: alpha(palette.white, 0.04), // 未知角色/中性兜底

    // 文本层级（深底从亮到暗）
    textPrimary: palette.ink, // 用户正文
    textSecondary: palette.parchment, // custom 正文
    textBody: palette.steel, // 卡片头/代码预格式
    textMuted: palette.gray, // 次要说明/折叠预览
    textFaint: palette.faint, // 占位/摘要

    // 角色强调（label 行）
    user: palette.sky,
    assistant: palette.blue,
    tool: palette.slate,
    bash: palette.green,
    custom: palette.purple,
    summary: palette.faint,

    // 角色行底色
    userRowBg: alpha(palette.userTint, 0.14),
    toolRowBg: alpha(palette.slate, 0.1),
    bashRowBg: alpha(palette.green, 0.1),
    customRowBg: alpha(palette.purple, 0.1),
    summaryRowBg: alpha(palette.faint, 0.14),

    // 状态色（stopReason / 工具成败 / 挂起）
    ok: palette.green,
    error: palette.red,
    warn: palette.yellow, // 截断
    pending: palette.orange, // 中断/执行中

    // session list 四态状态灯：灰不在线 / 绿待机 / 蓝运行中 / 橙开机中
    lampOff: "#4b5563",
    lampIdle: palette.green,
    lampRun: palette.blue,
    lampBoot: palette.orange,
  },

  // CollapseCard 四 tone（全部由原色板 alpha 推导）
  card: {
    thinking: { bg: alpha(palette.purple, 0.09), border: alpha(palette.purple, 0.28) },
    ok: { bg: alpha(palette.green, 0.09), border: alpha(palette.green, 0.28) },
    error: { bg: alpha(palette.red, 0.09), border: alpha(palette.red, 0.3) },
    neutral: { bg: alpha(palette.white, 0.04), border: alpha(palette.white, 0.1) },
  },

  // markdown 深色系（css.js 转成 --pc-* 变量供 STYLES 字符串用）
  md: {
    text: palette.mdText,
    strong: palette.mdStrong,
    dim: palette.mdDim,
    quote: palette.mdQuote,
    link: palette.mdLink,
    codeBg: palette.bgCode,
    codeText: palette.mdCode,
    preBg: palette.bgPre,
    border: palette.lineMid,
    borderSoft: palette.lineHard,
    quoteBorder: palette.lineQuote,
    marker: palette.mdMarker,
    thBg: "#111111",
    thinkingText: alpha(palette.steel, 0.55),
    hljs: {
      comment: palette.hljsComment,
      keyword: palette.purple,
      title: palette.blue,
      number: palette.mdThul,
      string: palette.green,
      variable: palette.hljsVar,
      builtIn: palette.yellow,
      params: palette.hljsParams,
      meta: palette.cyan,
    },
  },
};
