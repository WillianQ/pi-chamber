// sessions.js 单测（node --test）：纯逻辑，spawn 是注入的假 PTY，不需要真终端。
// 重点覆盖「每连接 attach」这套新语义 —— 旧实现的会话级 attached 在多连接下是坏的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessions, createRing } from "../src/sessions.js";

/** 假 PTY：手动触发 onData / onExit */
function fakePty() {
  const dataCbs = [];
  const exitCbs = [];
  const calls = { writes: [], resizes: [], kills: 0 };
  return {
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (d) => calls.writes.push(d),
    resize: (c, r) => calls.resizes.push([c, r]),
    kill: () => calls.kills++,
    emitData: (t) => dataCbs.forEach((cb) => cb(t)),
    emitExit: (info) => exitCbs.forEach((cb) => cb(info)),
    calls,
  };
}

/** 造一个被测实例：假 PTY + 手工定时器（flush 由 runTimers 触发，结果确定） */
function setup(overrides = {}) {
  const pty = fakePty();
  const out = []; // [conn, termId, text]
  const exits = [];
  const changes = [];
  const timers = new Map();
  let tid = 0;
  const shell = { id: "bash", label: "Git Bash" };
  const sessions = createSessions({
    spawn: () => pty,
    onOutput: (conn, termId, b64) => out.push([conn, termId, Buffer.from(b64, "base64").toString("utf8")]),
    onExit: (termId, info) => exits.push([termId, info]),
    onChange: () => changes.push(1),
    setTimer: (fn) => {
      const id = ++tid;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    ...overrides,
  });
  const runTimers = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  const created = sessions.create({ shell, cwd: "/tmp", cols: 80, rows: 24 });
  return { sessions, pty, out, exits, changes, runTimers, created, shell };
}

const A = { id: "A" };
const B = { id: "B" };

// ── 环形缓冲 ────────────────────────────────────────────────────────────────

test("环形缓冲：按整块丢最老的，字节数封顶", () => {
  const ring = createRing(10);
  ring.push("12345");
  ring.push("67890");
  ring.push("ABC"); // 13 字节 > 10 → 丢最老那块
  assert.equal(ring.read(), "67890ABC");
  assert.equal(ring.bytes, 8);
});

// ── 没 attach 就不出帧 ──────────────────────────────────────────────────────

test("没人 attach：输出只进缓冲，不出帧", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  pty.emitData("hello");
  runTimers();
  assert.deepEqual(out, [], "没有订阅者时不该有任何输出帧");
  // 但缓冲里有 —— 之后 attach 能回放出来
  const r = sessions.attach(A, created.termId);
  assert.equal(Buffer.from(r.data, "base64").toString("utf8"), "hello");
});

test("attach 之后转流式：回放 + 新输出", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  pty.emitData("old");
  sessions.attach(A, created.termId); // 回放里含 old
  pty.emitData("new");
  runTimers();
  assert.deepEqual(out, [[A, created.termId, "new"]], "只推 attach 之后的增量（old 在回放里）");
});

// ── 每连接 attach：旧实现的两个 bug 都在这测 ────────────────────────────────

test("第二个 attach 不会吞掉第一个连接的待发批次（旧实现 pending='' 的 bug）", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  sessions.attach(A, created.termId);
  out.length = 0;
  pty.emitData("AAA"); // 攒在 pending，还没到 flush 时间
  const r = sessions.attach(B, created.termId); // B 接管：应先还清 A 的欠账
  assert.deepEqual(out, [[A, created.termId, "AAA"]], "A 的欠账必须先发出去");
  assert.equal(Buffer.from(r.data, "base64").toString("utf8"), "AAA", "B 从回放里拿到同一批字节（不重复不丢）");
  runTimers();
  assert.deepEqual(out, [[A, created.termId, "AAA"]], "之后不该再重复推给 B");
});

test("没 attach 过的连接收不到输出（旧实现会广播给所有人）", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  sessions.attach(A, created.termId);
  out.length = 0;
  pty.emitData("x");
  runTimers();
  assert.deepEqual(out.map(([c]) => c), [A], "只有订阅者 A 收到，B 一条都没有");
});

test("detach 后不再收输出，且不影响其他订阅者", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  sessions.attach(A, created.termId);
  sessions.attach(B, created.termId);
  sessions.detach(A, created.termId);
  out.length = 0;
  pty.emitData("x");
  runTimers();
  assert.deepEqual(out.map(([c]) => c), [B]);
});

test("连接断开（dropConn）：从所有会话的订阅者里摘掉", () => {
  const { pty, out, runTimers, sessions, created } = setup();
  sessions.attach(A, created.termId);
  sessions.dropConn(A);
  out.length = 0;
  pty.emitData("x");
  runTimers();
  assert.deepEqual(out, [], "摘掉后不该再往它推（也不该往死 socket 写）");
});

// ── resize 权（owner） ──────────────────────────────────────────────────────

test("resize：第一个 attach 的成为 owner，只有它能改 PTY 尺寸", () => {
  const { sessions, pty, created, changes } = setup();
  const ra = sessions.attach(A, created.termId);
  const rb = sessions.attach(B, created.termId);
  assert.equal(ra.owner, true, "A 是第一个，拿到 resize 权");
  assert.equal(rb.owner, false, "B 晚到，没有");

  changes.length = 0;
  sessions.resize(A, created.termId, 120, 40);
  assert.deepEqual(pty.calls.resizes, [[120, 40]]);
  assert.equal(changes.length, 1, "尺寸变了要推名册（前端顶部条读它）");
  sessions.resize(B, created.termId, 90, 30); // 非 owner：静默忽略
  assert.deepEqual(pty.calls.resizes, [[120, 40]], "B 的 resize 不该落到 PTY");
  assert.equal(sessions.list()[0].cols, 120);
  changes.length = 0;
  sessions.resize(A, created.termId, 120, 40); // 同尺寸：什么都不做
  assert.equal(changes.length, 0, "尺寸没变不推名册");
});

test("owner detach / 断开后移交给下一个订阅者", () => {
  const { sessions, pty, created } = setup();
  sessions.attach(A, created.termId);
  sessions.attach(B, created.termId);
  sessions.detach(A, created.termId);
  sessions.resize(B, created.termId, 100, 30); // 移交后 B 说了算
  assert.deepEqual(pty.calls.resizes, [[100, 30]]);
});

// ── 退出与关闭 ──────────────────────────────────────────────────────────────

test("PTY 自己退出：留档（status=exited）+ 发 term.exit", () => {
  const { pty, exits, sessions, created } = setup();
  sessions.attach(A, created.termId);
  pty.emitExit({ exitCode: 0, signal: 0 });
  assert.deepEqual(exits, [[created.termId, { code: 0, signal: 0 }]]);
  assert.equal(sessions.list()[0].status, "exited");
  assert.equal(sessions.count, 1, "退出不删档：还能 attach 回看屏幕");
});

test("close：真杀进程 + 出列，且不再发 term.exit（是我关的，不是它自己死的）", () => {
  const { pty, exits, sessions, created } = setup();
  sessions.close(created.termId);
  assert.equal(pty.calls.kills, 1);
  assert.equal(sessions.count, 0);
  pty.emitExit({ exitCode: 0, signal: 0 }); // kill 触发的 onExit
  assert.deepEqual(exits, [], "主动关闭不该再推 term.exit");
});

test("close 幂等：重复 / 迟到一律无事", () => {
  const { sessions, created } = setup();
  sessions.close(created.termId);
  sessions.close(created.termId);
  sessions.close("t999");
  assert.equal(sessions.count, 0);
});

// ── 输入与尺寸夹取 ──────────────────────────────────────────────────────────

test("input：已退出的终端静默丢弃，不抛", () => {
  const { sessions, pty, created } = setup();
  pty.emitExit({ exitCode: 1, signal: 0 });
  sessions.input(created.termId, Buffer.from("ls\n", "utf8").toString("base64"));
  assert.deepEqual(pty.calls.writes, []);
});

test("input：base64 → utf8 原样透传", () => {
  const { sessions, pty, created } = setup();
  sessions.input(created.termId, Buffer.from("ls\n", "utf8").toString("base64"));
  assert.deepEqual(pty.calls.writes, ["ls\n"]);
});

test("尺寸夹取：非法值走兜底，超限夹到边界", () => {
  const { sessions, created } = setup();
  const r = sessions.create({ shell: { id: "bash", label: "Git Bash" }, cwd: "/tmp", cols: 9999, rows: 0 });
  assert.equal(r.cols, 500);
  assert.equal(r.rows, 30); // 0 → 兜底 defaultRows
  assert.equal(created.cols, 80);
  assert.equal(sessions.count, 2);
});

test("create 返回体形状（前端拿它置焦，字段别漂）", () => {
  const { created } = setup();
  assert.deepEqual(Object.keys(created).sort(), ["cols", "cwd", "rows", "shell", "shellLabel", "termId"]);
  assert.match(created.termId, /^t\d+$/);
});

test("closeAll：全杀 + 清表（守护进程退出前调用）", () => {
  const { sessions, pty } = setup();
  sessions.create({ shell: { id: "bash", label: "Git Bash" }, cwd: "/tmp" });
  sessions.closeAll();
  assert.equal(sessions.count, 0);
  assert.equal(pty.calls.kills, 2);
});
