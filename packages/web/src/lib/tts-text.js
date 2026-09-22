// TTS 文本处理 —— 朗读前的纯函数活：切块 + 清洗 + 补尾标点，一步到位。
// 无 React / 无 store / 无 bus，可单跑单测：node --test packages/web/src/lib/tts-text.test.js
//
// 调用链（tts-store 里）：
//   inject(text) ──filterFences──→ textBuf ──cutBlock──→ { text, raw, rest } ──→ tts.speak
//     ★ filterFences 在 tts-store.js 里：把围栏代码（```js … ```）整块剔掉，**不进 textBuf**
//       —— 所以 cutBlock 看不到代码，代码也不占切块长度（见 tts-store 的围栏过滤器）
//     text = 已清洗、末尾保证是句末标点的朗读文本（可直接送 speak；全被洗空则是 ""）
//     raw  = 这一块的**原文**片段（只给失败退回用，见 tts-store 的 catch）
//     rest = 原文里没切到的余量（未清洗，原样攒着）
// 切块基于**原始 markdown** 算长度，清洗只作用于切出来那一块 —— 否则每次 tick 要重洗整个 buf。

// ───────────────────────── 切块（防阿里缓存对赌） ─────────────────────────
// ───────────────────────── 切块（防阿里缓存对赌） ─────────────────────────
// 规则（用户定）：一趟逐字符扫描计分 —— 中文字 4 分 / 英文字母 1 分 / 句末标点 4 分。
//   满 300 分起：往后碰到的第一个句末标点就是切点；一直没标点则满 600 分硬切；不足 300 分整段发。
//   300 分 ≈ 75 中文字 ≈ 300 英文字母 → 两种语言读出来时长齐平
//   （不这么算的话英文 100 字符只读 8 秒、中文 100 字读 25 秒，块碎成渣）。
// ★ 块尾必须有句末标点 → 每块 continue 都被阿里即时合成，无缓存错位（旧版卡死的总根源）；
//   硬切时 build 补一个句号（阿里对不完整句会缓存不吐，补标点 = 告诉它可以合成）。
//
// 句末标点三类（用户指定）：中文句末标点 / 换行 / 英文句号。
// ★ 英文句号要看后一个字符（必须是空白或到头）：否则 3.14、e.g.、v0.84.4、Mr. Smith
//   里的点会被当成句末，切出「…3.」+「14…」，阿里念出来是两截。
const SENT_PUNCT = new Set([10, 33, 46, 63, 12290, 65281, 65311]); // \n ! . ? 。！？
const SENT_TAIL = /[。！？!?\n.]$/; // 末尾已是句末标点 → 不补

/** 切一块：切 → 洗 → 补尾标点，返回可直接送 speak 的文本 + 原文余量
 *  @returns {{ text: string, raw: string, rest: string }} */
export function cutBlock(text) {
  let score = 0;
  let cut = text.length; // 默认整段发（不足 400 分 / 没摸到切点）
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    score += c > 127 || SENT_PUNCT.has(c) ? 4 : 1; // 中文字 / 句末标点 4 分；英文字母等 1 分
    if (score < 300) continue;
    if (isSentenceEnd(text, i, c) || score >= 600) {
      cut = i + 1;
      break;
    }
  }
  return build(text.slice(0, cut), text.slice(cut));
}

/** 句末标点？（英文句号要看后一个字符：空白或到头才算，躲开 3.14 / e.g. / v0.84.4） */
function isSentenceEnd(text, i, c) {
  if (c !== 46) return SENT_PUNCT.has(c);
  const n = text.charCodeAt(i + 1);
  return Number.isNaN(n) || n <= 32; // 空白类码点全 ≤ 32；越界得 NaN
}

/** 收尾一道：洗 markdown → 末尾不是句末标点就补句号（补的只进 text，raw/rest 一个字不动） */
function build(chunk, rest) {
  const spoken = cleanForSpeech(chunk);
  if (!spoken) return { text: "", raw: chunk, rest }; // 整块是纯标记/纯围栏 → text 空，调用方跳过
  return { text: SENT_TAIL.test(spoken) ? spoken : `${spoken}。`, raw: chunk, rest };
}

// ───────────────────────── 围栏过滤（"不读代码"） ─────────────────────────
// 有状态：要跨多次 feed 保持（delta 会把围栏从中间切开）→ 用工厂函数造独立实例。
// 规则（用户定）：
//   ```js（带语言、且不是 md）→ 内容整块不念，原位换成"下面是 js 代码。"（告诉人这儿有段代码）
//   ```md                   → 内容照读，标记行丢
//   ```（裸标记）            → 标记行丢，内容照读
// 保险：① reset() 清状态（新任务 / 清场 / 播完必调）② 围栏内遇 # 标题行 → 强制解除
//   （模型忘写闭围栏时的逃生口，否则后面整段正文都会被吞）。
export function createFenceFilter() {
  let inFence = false;
  let tail = ""; // "只差一个换行就成行"的尾巴（整行就是 1~3 个反引号 —— 可能下一片 delta 才补上语言）

  return {
    /** 吃一段流式文本，返回"该念的部分"（围栏标记与代码内容一律不返回） */
    feed(text) {
      const buf = tail + text;
      tail = "";
      const nl = buf.lastIndexOf("\n");
      let head = buf;
      if (nl >= 0) {
        const t = buf.slice(nl + 1);
        if (/^[ \t]{0,3}`{1,3}$/.test(t)) {
          tail = t; // 只差换行的围栏标记 → 留到下次
          head = buf.slice(0, nl + 1);
        }
      } else if (/^[ \t]{0,3}`{1,3}$/.test(buf)) {
        tail = buf; // 整段就是"没长完"的围栏标记
        return "";
      }
      if (!head) return "";
      const endedNl = head.endsWith("\n");
      const lines = head.split("\n");
      if (endedNl) lines.pop(); // split 末尾多出的空串
      const keep = [];
      for (const line of lines) {
        const m = line.match(/^[ \t]{0,3}```(.*)$/);
        if (m) {
          if (inFence) {
            inFence = false; // 闭围栏
            continue;
          }
          const lang = m[1].trim();
          if (lang && lang.toLowerCase() !== "md") {
            inFence = true; // 开围栏（带语言、非 md）→ 后面整块不念
            keep.push(`下面是 ${lang} 代码。`);
          }
          continue; // 裸标记 / ```md：标记丢，内容照读
        }
        if (inFence) {
          if (/^[ \t]{0,3}#{1,6}\s/.test(line)) {
            inFence = false; // ★ 保险：围栏忘闭合，遇标题强行解开
            keep.push(line);
          }
          continue;
        }
        keep.push(line);
      }
      return keep.length ? keep.join("\n") + (endedNl ? "\n" : "") : "";
    },

    /** 收尾：把卡在围栏判断里的尾巴吐出来（它可能不是围栏标记，不能丢） */
    flush() {
      const t = tail;
      tail = "";
      return t;
    },

    /** 清状态（新任务 / 清场 / 播完必调） */
    reset() {
      inFence = false;
      tail = "";
    },
  };
}

// ───────────────────────── 清洗（markdown → 能念的人话） ─────────────────────────
// 铁律：**只删/换字符，绝不"理解"内容**。宁可漏清洗，不可丢正文 ——
//   念错一个标点无所谓，漏念半句话就是事故。
//
// 例外（已知并接受）：HTML 标签规则 /<\/?[a-zA-Z][^>]*>/ 会把泛型当标签吃掉 ——
//   `Promise<string>` → `Promise`。用户明确要求"所有 html 全部杀"，代价认了。
//
// 代价（认了）：跨块的 markdown 洗不干净。代码围栏不在此列 —— 它在 tts-store 的
//   围栏过滤器里整块剔掉了（不进 textBuf），根本到不了这里。
// 正则全部内联在本函数里，不抽常量：每块才跑一次（≈2s 一次），不是热路径，可读性优先。
export function cleanForSpeech(md) {
  return (
    String(md ?? "")
      // 图片整条删（念 alt 没意义）；必须排在链接之前，否则 ![]() 会先被链接规则吃掉 ! 留下尾巴
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // 链接 [文字](url) → 只留文字
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 自定义属性 [文字]{颜色/大小/形式…} → 只留文字（花括号那段是渲染指令，念出来没意义）
      .replace(/\[([^\]]*)\]\{[^}\n]*\}/g, "$1")
      // 表格分隔行（|---|:--:|）整行删 —— 必须排在表格行之前，否则会被当成普通行变成"逗号横线逗号"
      .replace(/^[ \t]*(?=[^\n]*\|)[ \t:|-]*-[ \t:|-]*$/gm, "")
      // 表格行：首尾 | 删掉，中间的 | 换成逗号（阿里会把"竖线"念出来，很吵）
      .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, inner) =>
        inner
          .split("|")
          .map((s) => s.trim())
          .join("，"),
      )
      // 裸链接 <https://…> → 删（整条含尖括号；否则只剩 <> 会被当 HTML 标签残留）
      .replace(/<https?:\/\/[^>]*>/g, "")
      // 裸 URL → 删（排除中文标点，免得把句末的"。"一起吃掉、导致补标点判断错位）
      .replace(/https?:\/\/[^\s，。、；：！？）】」"'<>]+/g, "")
      // 代码围栏：只删 ``` 与紧跟的语言标识（内容已在 tts-store 的围栏过滤器里处理过，这里是兜底）
      .replace(/```[a-zA-Z0-9+#-]*/g, "")
      // 行内代码 `x` → x（符号不念，内容念）
      .replace(/`([^`\n]+)`/g, "$1")
      // 强调标记：**粗** __粗__ ~~删~~ → 只脱壳（.+? 至少一字符，所以 *** / ___ 这些分隔线打不着）
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      // 标题 ## 与引用 >
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      // 分隔线：同一字符三个起步（--- / *** / ___）。与列表的 "- " 区分开：列表**保留不动**
      .replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, "")
      // 残留 HTML 标签（★ 泛型 <string> 也会被吃掉 —— 已知并接受，见下）
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // 收尾压空白：行内连续空格并一个，三连换行并两个
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
