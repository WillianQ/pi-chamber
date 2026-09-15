// @ 文件引用补全的解析与回填 —— 纯函数（无 React / 无 bus / 无 DOM），可单跑单测：
//   node --test packages/web/src/pages/chat/file-match.test.js
//
// 语义（对齐 pi TUI）：@ 只是「把文件路径插进 prompt」，**不展开文件内容** —— pi 的
//   CombinedAutocompleteProvider 插完 `@src/app.ts ` 就收工，文件由模型自己 read。
//   （pi CLI 的 `pi @a.ts` 参数才展开成 <file>…</file>，那是另一条路，这里不学。）
//
// 触发口径（照抄 pi 的 extractAtPrefix）：只看**光标所在行**；@ 必须落在 token 起始 ——
//   行首，或前一字符是 空白 / " / ' / =（pi 的 PATH_DELIMITERS）。所以 `a@b.com` 不弹。
//   引号形式 @"my file" 单独判：引号内的空格不算分隔符。
// 回填口径（照抄 pi 的 applyCompletion）：
//   文件 → 「@path 」补尾空格（接着往下打）；目录 → 「@path/」不补空格（继续下钻）；
//   路径含空格 → 用 @"…" 包起来；带引号的目录光标落在收尾引号**之前**（引号留着继续拼）。
//
// 数据形状（后端 fs.search 的 items，见 server/src/nav-service.js）：
//   { path, name, isDir, description }  —— path 是 cwd 相对 + 正斜杠，直接插进 prompt。

const DELIMS = new Set([" ", "\t", "\n", '"', "'", "="]);
const isDelim = (ch) => DELIMS.has(ch);
const posix = (p) => String(p ?? "").replace(/\\/g, "/");

function clamp(n, len) {
  const v = Number.isFinite(n) ? Math.floor(n) : len;
  return Math.max(0, Math.min(v, len));
}

/** 行内下标 i 是否 token 起始（行首，或前一字符是分隔符） */
function isTokenStart(line, i) {
  return i === 0 || isDelim(line[i - 1]);
}

/** 行内最后一个分隔符的下标（无 → -1） */
function lastDelimIndex(line) {
  for (let i = line.length - 1; i >= 0; i--) if (isDelim(line[i])) return i;
  return -1;
}

/** 未闭合引号的下标（引号内在语义上是一整段，里面的空格不算分隔符）；全闭合 → null */
function unclosedQuoteStart(line) {
  let inQuote = false;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '"') continue;
    inQuote = !inQuote;
    if (inQuote) start = i;
  }
  return inQuote ? start : null;
}

/** 组装上下文：token 绝对范围 [start, end) + 过滤词 + 是否引号形式 */
function buildContext(text, caret, lineStart, tokenStartInLine, quoted) {
  const start = lineStart + tokenStartInLine;
  const raw = text.slice(start + 1, caret); // @ 之后、光标之前
  const query = quoted && raw.startsWith('"') ? raw.slice(1) : raw;

  // token 尾巴：引号形式找到闭合引号（含），否则找到下一个空白
  let end;
  if (quoted) {
    const j = text.indexOf('"', caret);
    end = j === -1 ? text.length : j + 1;
  } else {
    const m = text.slice(caret).search(/\s/);
    end = m === -1 ? text.length : caret + m;
  }
  return { query, start, end, quoted };
}

/** 光标前能否触发 @ 补全：能 → { query, start, end, quoted }，不能 → null
 *  硬约束：只看光标所在行（@ 是行内补全，回填锚点必须在同一行）。 */
export function atContext(text, caret) {
  const t = String(text ?? "");
  const c = clamp(caret, t.length);
  const lineStart = t.lastIndexOf("\n", c - 1) + 1;
  const line = t.slice(lineStart, c); // 光标前的本行内容

  // 未闭合引号优先：@"my fi|le 里的空格不是分隔符，得从引号（或它前面的 @）起算
  const quoteStart = unclosedQuoteStart(line);
  if (quoteStart !== null) {
    if (quoteStart > 0 && line[quoteStart - 1] === "@" && isTokenStart(line, quoteStart - 1))
      return buildContext(t, c, lineStart, quoteStart - 1, true);
    return null; // 光有引号、前面没 @：不是 @ 补全（普通输入）
  }

  const tokenStart = lastDelimIndex(line) + 1;
  if (line[tokenStart] !== "@") return null;
  return buildContext(t, c, lineStart, tokenStart, false);
}

/** 选中一条 → 回填后的 { text, caret }（整段替换当前 @token，保留光标后文字）
 *  目录不补尾空格（继续下钻）；文件补一个（接着写话）；含空格/引号形式 → @"…" */
export function fillAt(text, caret, ctx, node) {
  const t = String(text ?? "");
  const c = clamp(caret, t.length);
  const start = clamp(ctx?.start ?? c, t.length);
  const end = Math.max(start, clamp(ctx?.end ?? c, t.length));

  const rawPath = posix(node?.path ?? "");
  const isDir = !!node?.isDir;
  const pathValue = isDir ? `${rawPath}/` : rawPath;
  const quoted = !!ctx?.quoted || pathValue.includes(" ");
  const ins = quoted ? `@"${pathValue}"` : `@${pathValue}`;
  // 尾空格只在“后面没东西 / 紧贴着别的字”时补：token 后面本来就跟了空格，再补就成了双空格
  const next = t[end];
  const suffix = isDir || (next !== undefined && /\s/.test(next)) ? "" : " ";

  // 带引号的目录：光标落在收尾引号**之前**，让引号留着继续往里拼（pi 同款）
  const caretOffset = isDir && quoted ? ins.length - 1 : ins.length;
  return { text: t.slice(0, start) + ins + suffix + t.slice(end), caret: start + caretOffset + suffix.length };
}
