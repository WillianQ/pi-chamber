// bus 单元测试：同进程两个 bus 实例内存互连（不起任何服务）
// 语义：on 不分域；emit 本地必投 + net 可选上网；request 单选（本地 xor 网络）
import { test } from "node:test";
import assert from "node:assert";
import { createBus } from "@pi-chamber/bus/core.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A(模拟客户端) <-> B(模拟服务端)，内存 transport 互喂
function makePair() {
  const A = createBus({ requestTimeout: 300 });
  const B = createBus({ requestTimeout: 300 });
  A.attachTransport({ send: (s) => queueMicrotask(() => B.feed(s)) });
  B.attachTransport({ send: (s) => queueMicrotask(() => A.feed(s)) });
  return [A, B];
}

test("emit：本地必投，net 可选再上网", async () => {
  const [A, B] = makePair();
  let aHits = 0, bHits = 0;
  A.on("x", () => aHits++);
  B.on("x", () => bHits++);

  A.emit("x", { v: 1 }); // 纯本地
  await sleep(10);
  assert.strictEqual(aHits, 1, "本地广播 1 次");
  assert.strictEqual(bHits, 0, "没上网，对面收不到");

  A.emit("x", { v: 2 }, { net: true }); // 本地 + 上网
  await sleep(10);
  assert.strictEqual(aHits, 2, "发送方本地也投了一份（单域广播）");
  assert.strictEqual(bHits, 1, "对面收到网络份");
});

test("net 但没插线：emit 静默丢，request 立即 reject offline", async () => {
  const C = createBus({ requestTimeout: 300 }); // 从不 attach
  let hits = 0;
  C.on("x", () => hits++);
  C.emit("x", {}, { net: true }); // 不炸
  assert.strictEqual(hits, 1, "本地那份照样投");
  await assert.rejects(C.request("y", {}, { net: true }), /offline/);
});

test("request 本地：成功 / 抛错 / 无人应答 / 只问本地不上网", async () => {
  const A = createBus({ requestTimeout: 300 });
  // 本地 request 不需要网络：故意不 attach transport，证明它绝不会偷偷上网
  await assert.rejects(A.request("calc", { a: 1 }), /no handler/, "本地无人应答 → reject（不会转发上网）");

  A.on("calc", ({ a }) => a * 2);
  assert.strictEqual(await A.request("calc", { a: 21 }), 42);

  A.on("boom", () => {
    throw new Error("local-boom");
  });
  await assert.rejects(A.request("boom"), /local-boom/);

  // 异步 handler + 超时对本地同样生效
  A.on("forever", () => sleep(9999));
  await assert.rejects(A.request("forever", null, { timeout: 100 }), /超时/);
});

test("request 网络：成功 / 透传错误 / no handler / 超时 / 乱序并发", async () => {
  const [A, B] = makePair();

  B.on("user.get", async ({ id }) => (id === 7 ? { name: "boss" } : null));
  assert.deepStrictEqual(await A.request("user.get", { id: 7 }, { net: true }), {
    name: "boss",
  });

  B.on("bad", async () => {
    throw new Error("wire-boom");
  });
  await assert.rejects(A.request("bad", null, { net: true }), /wire-boom/);

  await assert.rejects(A.request("nobody", null, { net: true }), /no handler/);

  B.on("slow", () => sleep(9999));
  await assert.rejects(A.request("slow", null, { net: true }), /超时/);
  await sleep(20); // 超时后的迟到回执应被丢弃，不炸

  B.on("r.a", async () => {
    await sleep(40);
    return "A";
  });
  B.on("r.b", async () => "B");
  const [ra, rb] = await Promise.all([
    A.request("r.a", null, { net: true }),
    A.request("r.b", null, { net: true }),
  ]);
  assert.deepStrictEqual([ra, rb], ["A", "B"], "靠 id 乱序配对");
});

test("坏帧/非法帧一律静默丢弃", async () => {
  const [A] = makePair();
  let hits = 0;
  A.on("x", () => hits++);
  A.feed("{{{不是JSON");
  A.feed(JSON.stringify({ t: "???" }));
  A.feed(JSON.stringify({ t: "s", id: "不存在的id", ok: true }));
  A.feed("[1,2]");
  A.feed('"str"');
  A.feed(JSON.stringify({ t: "e" })); // 缺 e 字段
  await sleep(20);
  assert.strictEqual(hits, 0);
  assert.strictEqual(A.pendingCount, 0);
});

test("系统事件：插线 $conn.open，拔线 $conn.close 且在途 request 全部 reject", async () => {
  const A = createBus({ requestTimeout: 5000 });
  const events = [];
  A.on("$conn.open", (p) => events.push(["open", !!p.at]));
  A.on("$conn.close", () => events.push("close"));

  const t = { send: () => {} }; // 对端永远不回话
  A.attachTransport(t);
  const p = A.request("hang", {}, { net: true });
  await sleep(10);
  assert.strictEqual(A.pendingCount, 1);

  A.detachTransport("test kick");
  await assert.rejects(p, /连接断开.*test kick/);
  assert.strictEqual(A.pendingCount, 0);
  assert.deepStrictEqual(events, [["open", true], "close"]);
});

test("自动接管：attach 新线会先 detach 旧线", async () => {
  const A = createBus({ requestTimeout: 5000 });
  A.attachTransport({ send: () => {} });
  const p = A.request("hang", {}, { net: true });
  A.attachTransport({ send: () => {} }); // 换线 → 旧在途作废
  await assert.rejects(p, /连接断开/);
  assert.strictEqual(A.connected, true);
});
