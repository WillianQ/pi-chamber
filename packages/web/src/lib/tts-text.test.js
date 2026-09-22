// tts-text 纯函数回归：node --test packages/web/src/lib/tts-text.test.js
// （不接进 pnpm test —— 那条跑的是 packages/server 的用例）
import { test } from "node:test";
import assert from "node:assert";
import { cutBlock, cleanForSpeech, createFenceFilter } from "./tts-text.js";

// ───────────────────────── cutBlock ─────────────────────────

test("cutBlock：不足 100 字全量发", () => {
  assert.deepEqual(cutBlock("短句。"), { text: "短句。", raw: "短句。", rest: "" });
  assert.deepEqual(cutBlock(""), { text: "", raw: "", rest: "" });
});

test("cutBlock：中文满 300 分后遇句号收尾", () => {
  // 120 个中文字 = 480 分；到第 75 字（300 分）后接着扫，
  // 第 121 个字符是「。」→ 4 分 → 切点 121
  const r = cutBlock("甲".repeat(120) + "。后面还有很长很长的内容要接着往下写不能停");
  assert.equal(r.text, "甲".repeat(120) + "。");
  assert.equal(r.rest[0], "后");
});

test("cutBlock：换行也算句末", () => {
  const r = cutBlock("x".repeat(399) + "\n下一行内容很长很长很长很长很长很长很长很长很长"); // 399 分 + \n(4) = 403 → 切
  // 切在 \n 后（块边界对）；后续清洗 trim 掉 \n → 末尾无标点 → 补一个句号（等价停顿）
  assert.equal(r.text, "x".repeat(399) + "。");
  assert.equal(r.rest[0], "下");
});

test("cutBlock：英文句号带 lookahead —— 3.14 里的点不当句末", () => {
  // 窗口里先遇到 3.14 的假句号（后面是 1）→ 不当切点，再遇到真句号（后面是空格）→ 切
  const r = cutBlock("a".repeat(399) + "3.14 结束了." + " ".repeat(5) + "更多内容".repeat(30));
  assert.equal(r.text, "a".repeat(399) + "3.14 结束了.");
  assert.equal(r.rest.startsWith(" "), true);
});

test("cutBlock：英文按词算 —— 英文块远长于中文块（不会读 8 秒就断）", () => {
  const rEn = cutBlock("This is a test. ".repeat(60)); // 每组 19 分（句号算 4 分）→ 切点 ≈255 字符
  const rZh = cutBlock("这是一句测试。".repeat(40)); // 每组 28 分 → 切点 ≈77 字符
  assert.ok(rEn.text.length > 250, `英文块应 >250 字符，实得 ${rEn.text.length}`);
  assert.ok(rZh.text.length < 130, `中文块应 ≈75 字，实得 ${rZh.text.length}`);
  assert.equal(rEn.text.endsWith("."), true);
  assert.equal(rZh.text.endsWith("。"), true);
});

test("cutBlock：满 600 分仍无标点 → 硬切并补句号", () => {
  const r = cutBlock("字".repeat(250)); // 1000 分；600 分落在第 150 字 → 硬切
  assert.equal(r.text, "字".repeat(150) + "。");
  assert.equal(r.rest, "字".repeat(100));
});

test("cutBlock：内部已完成清洗（含 markdown 的块直接可念）", () => {
  // 不足 100 字 → 全量走 build：洗 markdown + 末尾无标点补句号
  assert.equal(cutBlock("**重点**。后面继续").text, "重点。后面继续。");
  assert.equal(cutBlock("看 [文档](https://a.com) 吧").text, "看 文档 吧。");
});

test("cutBlock：整块纯标记 → text 空（调用方跳过）", () => {
  assert.equal(cutBlock("```js\n```").text, "");
});

// ───────────────────── 围栏过滤（"不读代码"） ─────────────────────

test("围栏：```js 整块不念，原位换成一句提示", () => {
  const f = createFenceFilter();
  assert.equal(f.feed("前文。\n\n```js\nconst a = 1;\n```\n\n后文。\n"), "前文。\n\n下面是 js 代码。\n\n后文。\n");
});

test("围栏：裸 ``` 内容照读，标记丢", () => {
  const f = createFenceFilter();
  assert.equal(f.feed("```\n裸围栏内容\n```\n"), "裸围栏内容\n");
});

test("围栏：```md 内容照读", () => {
  const f = createFenceFilter();
  assert.equal(f.feed("```md\n# 示例\n```\n"), "# 示例\n");
});

test("围栏：被 delta 从中间切开也认（半行缓冲）", () => {
  const f = createFenceFilter();
  assert.equal(f.feed("前。\n``"), "前。\n"); // 只差换行的围栏标记 → 留着等
  assert.equal(f.feed("`js\ncode\n"), "下面是 js 代码。\n"); // 补上后识别
  assert.equal(f.feed("```\n后。\n"), "后。\n");
});

test("围栏：忘写闭围栏 → 遇标题强行解除（保险）", () => {
  const f = createFenceFilter();
  // 注意：filterFences 只做"剔代码"，不清洗 —— ## 要留给 cutBlock 里的 cleanForSpeech
  assert.equal(f.feed("```js\ncode\n## 标题\n正文\n"), "下面是 js 代码。\n## 标题\n正文\n");
});

test("围栏：reset 清状态（新任务不能带着上一轮的围栏）", () => {
  const f = createFenceFilter();
  f.feed("```js\ncode\n");
  f.reset();
  assert.equal(f.feed("正文\n"), "正文\n");
});

test("围栏：flush 吐出卡住的尾巴（不丢文本）", () => {
  const f = createFenceFilter();
  assert.equal(f.feed("正文\n``"), "正文\n");
  assert.equal(f.flush(), "``");
});

// ───────────────────────── cleanForSpeech ─────────────────────────

test("链接与图片", () => {
  assert.equal(cleanForSpeech("看 [文档](https://a.com/b) 吧"), "看 文档 吧");
  assert.equal(cleanForSpeech("![截图](https://a.com/x.png)结束了"), "结束了");
  assert.equal(cleanForSpeech("访问 <https://a.com> 即可"), "访问 即可");
});

test("自定义属性 [文字]{...} → 只留文字", () => {
  assert.equal(cleanForSpeech("这是[重点]{color:red}内容"), "这是重点内容");
});

test("裸 URL 删掉，但不动句末标点", () => {
  assert.equal(cleanForSpeech("见 https://x.com/a 和 http://y.cn。"), "见 和 。");
});

test("表格：分隔行整行删，数据行 | → 逗号", () => {
  assert.equal(
    cleanForSpeech("| 名称 | 端口 |\n| --- | --- |\n| 后端 | 3000 |"),
    "名称，端口\n\n后端，3000",
  );
  assert.equal(cleanForSpeech("|:--|--:|\n| a | b |"), "a，b");
});

test("代码", () => {
  assert.equal(cleanForSpeech("用 `pnpm dev` 启动"), "用 pnpm dev 启动");
  assert.equal(cleanForSpeech("```js\nconst a = 1;\n```"), "const a = 1;"); // 围栏标记删，内容留
  assert.equal(cleanForSpeech("```\n裸围栏\n```"), "裸围栏");
});

test("强调标记脱壳", () => {
  assert.equal(cleanForSpeech("这是**重点**内容"), "这是重点内容");
  assert.equal(cleanForSpeech("这是__重点__内容"), "这是重点内容");
  assert.equal(cleanForSpeech("这是~~删掉~~内容"), "这是删掉内容");
});

test("块级：标题 / 引用", () => {
  assert.equal(cleanForSpeech("# 标题\n正文"), "标题\n正文");
  assert.equal(cleanForSpeech("### 三级\n正文"), "三级\n正文");
  assert.equal(cleanForSpeech("> 引用一句"), "引用一句");
});

test("分隔线删掉，列表原样保留", () => {
  assert.equal(cleanForSpeech("前文\n\n---\n\n后文"), "前文\n\n后文");
  assert.equal(cleanForSpeech("***"), "");
  assert.equal(cleanForSpeech("___"), "");
  assert.equal(cleanForSpeech("- 项目一\n- 项目二"), "- 项目一\n- 项目二"); // 列表不清洗
  assert.equal(cleanForSpeech("1. 第一\n2. 第二"), "1. 第一\n2. 第二");
});

test("HTML 标签删掉（泛型也一起吃掉 —— 已知并接受）", () => {
  assert.equal(cleanForSpeech("<div>内容</div>"), "内容");
  assert.equal(cleanForSpeech("换行<br>标签"), "换行标签");
  assert.equal(cleanForSpeech("返回 Promise<string>"), "返回 Promise");
});

test("空白收尾 + 空输入", () => {
  assert.equal(cleanForSpeech("  \n\n\n  多  空格  \n\n\n\n  "), "多 空格");
  assert.equal(cleanForSpeech(""), "");
  assert.equal(cleanForSpeech(null), "");
  assert.equal(cleanForSpeech(undefined), "");
});

test("综合：一段真实回复", () => {
  const md = [
    "## 结论",
    "",
    "用 [`pnpm dev`](https://pnpm.io) 启动，详见 ![图](a.png)<https://x.com>",
    "",
    "- 端口 3000",
    "- 前端 5173",
    "",
    "---",
    "",
    "> 注意：**别**改 `.npmrc`。",
  ].join("\n");
  assert.equal(
    cleanForSpeech(md),
    "结论\n\n用 pnpm dev 启动，详见 \n\n- 端口 3000\n- 前端 5173\n\n注意：别改 .npmrc。",
  );
});
