// command-match 纯函数回归：node --test packages/web/src/pages/chat/command-match.test.js
// （不接进 pnpm test —— 那条跑的是 packages/server 的用例）
import { test } from "node:test";
import assert from "node:assert";
import { completionContext, panelItems, fillText } from "./command-match.js";

const COMMANDS = [
  { value: "model", description: "切换模型", options: [{ value: "bailian/qwen3.8-flash", description: "bailian" }] },
  { value: "level", description: "思考等级", options: [{ value: "high" }] },
  { value: "name", description: "改名" }, // 自由文本：无二级
  { value: "reload", description: "重新加载" }, // 叶子
];

test("completionContext：分级只看第一个空格", () => {
  assert.equal(completionContext("/", 1, COMMANDS)?.level, 1);
  assert.equal(completionContext("/mo", 3, COMMANDS)?.level, 1);
  assert.equal(completionContext("/model", 6, COMMANDS)?.level, 2); // 精确命中即有二级 → 下钻（不靠尾空格）
  assert.equal(completionContext("/model ", 7, COMMANDS)?.level, 2); // 尾空格同样二级
  assert.equal(completionContext("/model q", 8, COMMANDS)?.query, "q");
});

test("completionContext：无可补就收面板", () => {
  assert.equal(completionContext("/reload", 7, COMMANDS), null); // 叶子命令
  assert.equal(completionContext("/name", 5, COMMANDS), null); // 自由文本命令（无 options）
  assert.equal(completionContext("/name 我的会话", 12, COMMANDS), null);
  assert.equal(completionContext("/model bailian/qwen3.8-flash", 28, COMMANDS), null); // 参数已填满
  assert.equal(completionContext("/foo bar", 8, COMMANDS), null); // 未知名
});

test("completionContext：不在行首 / 跨行 → 不弹", () => {
  assert.equal(completionContext("看下 /model", 8, COMMANDS), null);
  assert.equal(completionContext("第一行\n/model", 10, COMMANDS), null);
  assert.equal(completionContext("", 0, COMMANDS), null);
});

test("panelItems：一级按命令名筛、二级按参数+说明筛", () => {
  assert.deepEqual(panelItems(completionContext("/mo", 3, COMMANDS)).map((n) => n.value), ["model"]);
  assert.deepEqual(panelItems(completionContext("/model", 6, COMMANDS)).map((n) => n.value), ["bailian/qwen3.8-flash"]);
  assert.deepEqual(panelItems(completionContext("/model q", 8, COMMANDS)).map((n) => n.value), ["bailian/qwen3.8-flash"]); // 用户流程第 3 步
  assert.deepEqual(panelItems(completionContext("/model ", 7, COMMANDS)).map((n) => n.value), ["bailian/qwen3.8-flash"]);
});

test("fillText：有子级补空格、叶子不补、保留光标后文字", () => {
  const withKids = fillText("/m", 2, completionContext("/m", 2, COMMANDS), COMMANDS[0]);
  assert.deepEqual(withKids, { text: "/model ", caret: 7 }); // 尾空格 = 二级立刻展开

  const leaf = fillText("/re", 3, completionContext("/re", 3, COMMANDS), COMMANDS[3]);
  assert.deepEqual(leaf, { text: "/reload", caret: 7 }); // 叶子不补空格：回车直接发

  const tail = fillText("/m 后面的话", 2, completionContext("/m 后面的话", 2, COMMANDS), COMMANDS[0]);
  assert.deepEqual(tail, { text: "/model  后面的话", caret: 7 }); // 光标后文字一字不丢
});

test("fillText：替换整段 token（光标在词中间也不拼残句）", () => {
  const text = "/model qwen";
  const ctx = completionContext(text, 9, COMMANDS);
  assert.equal(ctx?.level, 2);
  assert.deepEqual(fillText(text, 9, ctx, COMMANDS[0].options[0]), {
    text: "/model bailian/qwen3.8-flash",
    caret: 28,
  });
});

test("fuzzyFilter 落地：打 38qwen 也能找到 qwen3.8-flash（字母数字对调彩蛋）", () => {
  const ctx = completionContext("/model 38qwen", 13, COMMANDS);
  assert.deepEqual(panelItems(ctx).map((n) => n.value), ["bailian/qwen3.8-flash"]);
});
