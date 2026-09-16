// attachments 纯函数回归：node --test packages/web/src/pages/chat/attachments.test.js
// （不接进 pnpm test —— 那条跑的是 packages/server 的用例，同 command-match/file-match 的规矩）
//
// 只测不碰 DOM 的那几个（pickImages / dataUrl / imageFilesFrom）；
// compressImage 依赖 canvas，归浏览器，不在这里假装测。
import { test } from "node:test";
import assert from "node:assert";
import { MAX_IMAGES, dataUrl, imageFilesFrom, pickImages } from "./attachments.js";

const f = (type) => ({ type });

test("pickImages：类型白名单（非图片滤掉并报数）", () => {
  const r = pickImages([f("image/png"), f("text/plain"), f("application/pdf")]);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].type, "image/png");
  assert.match(r.rejected, /2 个非图片/);
});

test("pickImages：按 room 截断（附件条已有图时 room 会变小）", () => {
  const r = pickImages(Array.from({ length: 8 }, () => f("image/jpeg")), 3);
  assert.equal(r.files.length, 3);
  assert.match(r.rejected, /最多再放 3 张/);
});

test("pickImages：room 用完一张不收，但也不算失败", () => {
  const r = pickImages([f("image/png")], 0);
  assert.equal(r.files.length, 0);
  assert.match(r.rejected, /最多再放 0 张/);
});

test("pickImages：干净入参不报错；空入参返回空", () => {
  const r = pickImages([f("image/webp")]);
  assert.equal(r.files.length, 1);
  assert.equal(r.rejected, null);
  assert.deepEqual(pickImages([]), { files: [], rejected: null });
  assert.deepEqual(pickImages(null), { files: [], rejected: null });
});

test("pickImages：默认 room = MAX_IMAGES", () => {
  const r = pickImages(Array.from({ length: MAX_IMAGES + 3 }, () => f("image/gif")));
  assert.equal(r.files.length, MAX_IMAGES);
});

test("dataUrl：拼出可直接用的 data URL；缺字段不崩", () => {
  assert.equal(dataUrl({ mimeType: "image/png", data: "AAA" }), "data:image/png;base64,AAA");
  assert.equal(dataUrl({}), "data:image/png;base64,");
  assert.equal(dataUrl(null), "data:image/png;base64,");
});

test("imageFilesFrom：items 优先，取不到再看 files；捞不到返回空（= 不拦默认粘贴）", () => {
  const fileA = { type: "image/png", tag: "A" };
  assert.deepEqual(imageFilesFrom({ items: [{ kind: "file", type: "image/png", getAsFile: () => fileA }] }), [fileA]);

  const fileB = { type: "image/jpeg", tag: "B" };
  const mixed = { items: [{ kind: "string", type: "text/plain" }], files: [fileB, { type: "text/plain" }] };
  assert.deepEqual(imageFilesFrom(mixed), [fileB]);

  assert.deepEqual(imageFilesFrom(null), []);
  assert.deepEqual(imageFilesFrom({ items: [], files: [] }), []);
});

test("MAX_IMAGES 与服务端口径一致（改这里要同时改 index.js 的 normalizeImages）", () => {
  assert.equal(MAX_IMAGES, 5);
});
