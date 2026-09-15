// xterm 主题：全部从 tokens.js 的原色板派生（视觉参数唯一真相仍在 theme/tokens.js）。
// 终端有它自己的硬约束——必须给出 **16 个 ANSI 色位**（black/red/…/brightWhite），
// 所以这里做的是"把 one-dark 原色板映射到 ANSI 槽位"，而不是挑几个色用：
//   正常位 = 原色板主色；亮位（bright*）= 更亮的一档（xterm 的 bright 是给 bold/高亮用的）。
import { alpha, palette } from "./tokens.js";

export const TERM_THEME = {
  background: palette.bgDeep, // 与聊天流同底（画布最深处），终端面板不另开一层色
  foreground: palette.parchment,
  cursor: palette.primary,
  cursorAccent: palette.bgDeep,
  selectionBackground: alpha(palette.primary, 0.3),

  black: palette.bgDeep,
  red: palette.red,
  green: palette.green,
  yellow: palette.yellow,
  blue: palette.blue,
  magenta: palette.purple,
  cyan: palette.cyan,
  white: palette.parchment,

  brightBlack: palette.faint,
  brightRed: palette.red,
  brightGreen: palette.green,
  brightYellow: palette.yellow,
  brightBlue: palette.sky,
  brightMagenta: palette.violet,
  brightCyan: palette.cyan,
  brightWhite: palette.ink,
};
