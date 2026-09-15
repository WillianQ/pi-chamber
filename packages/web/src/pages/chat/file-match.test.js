// file-match 纯函数回归：node --test packages/web/src/pages/chat/file-match.test.js
// （不接进 pnpm test —— 那条跑的是 packages/server 的用例）
import { test } from "node:test";
import assert from "node:assert";
import { atContext, fillAt } from "./file-match.js";

const FILE = { path: "src/app.ts", name: "app.ts", isDir: false, description: "src" };
const DIR = { path: "src/components", name: "components", isDir: true, description: "src" };
const SPACED = { path: "docs/my note.md", name: "my note.md", isDir: false, description: "docs" };

test("atContext：token 起始才触发（行首 / 分隔符后）", () => {
  assert.deepEqual(atContext("@", 1)?.query, "");
  assert.deepEqual(atContext("看下 @src/ap", 11)?.query, "src/ap");
  assert.deepEqual(atContext('@"my fi', 7)?.query, "my fi"); // 引号形式
  assert.equal(atContext("a@b.com", 7), null); // @ 前是字母 → 不是引用，是邮箱
  assert.equal(atContext("没有 at 符号", 6), null);
});

test("atContext：只看光标所在行", () => {
  assert.equal(atContext("@a\n第二行", 6), null); // @ 在上一行
  assert.deepEqual(atContext("第一行\n@a", 7)?.query, "a"); // 光标行里有 @
  assert.deepEqual(atContext("x\ny @src", 8)?.query, "src");
});

test("atContext：token 起止范围（回填要整段替换）", () => {
  const t = "看下 @ap 然后";
  const ctx = atContext(t, 6); // 光标在 "ap" 之后、空格之前
  assert.equal(ctx.start, 3);
  assert.equal(ctx.end, 6); // 不含尾随空格
});

test("fillAt：文件补尾空格，目录不补（继续下钻）", () => {
  assert.deepEqual(fillAt("@ap", 3, atContext("@ap", 3), FILE), { text: "@src/app.ts ", caret: 12 });
  assert.deepEqual(fillAt("@co", 3, atContext("@co", 3), DIR), { text: "@src/components/", caret: 16 });
});

test("fillAt：后面本来就有空格时不补（防双空格）", () => {
  const t = "看下 @ap 然后";
  const r = fillAt(t, 6, atContext(t, 6), FILE);
  assert.equal(r.text, "看下 @src/app.ts 然后"); // 单空格，不是两个
});

test("fillAt：路径含空格 → 引号包起来", () => {
  assert.deepEqual(fillAt("@my", 3, atContext("@my", 3), SPACED), { text: '@"docs/my note.md" ', caret: 19 });
});

test("fillAt：引号形式的目录，光标落在收尾引号之前", () => {
  const t = '@"my ';
  const ctx = atContext(t, 4);
  const r = fillAt(t, 4, ctx, { path: "my dir", name: "my dir", isDir: true });
  assert.equal(r.text, '@"my dir/"');
  assert.equal(r.caret, 9); // 指向收尾引号（可继续拼）
});

test("fillAt：替换整段 token，并保留后面的文字", () => {
  const t = "@src/ap 然后继续";
  const r = fillAt(t, 7, atContext(t, 7), FILE);
  assert.equal(r.text, "@src/app.ts 然后继续");
});
