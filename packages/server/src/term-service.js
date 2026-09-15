// Term 域（chamber 侧）：把前端那条 WS 与 termd 私线接起来。
//
// 职责边界（重要）：**chamber 完全不碰 node-pty** —— PTY 由独立守护进程 termd 持有，
//   本文件只说三件事：① 新建终端时的默认 cwd 从哪来（= 当前 Agent 空间，nav 域的 cwd）
//   ② 前端帧 ↔ termd 帧的白名单透传 ③ termd 没起来时报错要人话。
//
// 为什么 PTY 不归 chamber：chamber 是天天重启的网关（dev 是 node --watch），终端进程挂在它下面就会
//   随重启丢。交给 termd 之后，chamber 重启 = 断线重连，终端照跑（前端自动 attach 回放断线期间的输出）。
//
// 为什么不用第二条 bus：termd 不是 chamber 的模块，是它的**子进程**，自带线协议（见 daemon.js 头注）。
//   这边就是一个 WS 客户端 + 三张白名单，不需要 bus 中转，也不动主 bus 的 transport 槽。
//
// 帧名权威表见 AGENTS.md 4.2（term.* 九条）；本文件里字符串字面量与 daemon.js 各写一份（本仓惯例）。
import WebSocket from "ws";
import { ensureTermdRunning, readToken } from "@pi-chamber/termd/spawn.js";
import { config } from "./config.js";
import { navState } from "./nav-service.js";

// termd 端口：由 chamber 配置（.env 的 TERMD_PORT），拉起 termd 时显式传 --port → 两边必然一致。
const PORT = config.termdPort;

/** termd → 前端（下行：名册 / 输出 / 退出） */
const DOWN = new Set(["term.list", "term.output", "term.exit"]);
/** 前端 → termd（上行单向：键盘 / 尺寸 / 关 / 退订） */
const UP = new Set(["term.input", "term.resize", "term.close", "term.detach"]);
/** 前端 → termd（问答：新建 / 接管，回执原样带回前端） */
const RPC = new Set(["term.create", "term.attach"]);

export function installTermService(bus) {
  // cwdOf：新建终端的默认工作目录 = nav 域记的 cwd（它旁听 agent.chat.sync 维护，
  // 也就是"焦点 Session 所在的那台 agent 空间"）。没有焦点时 nav 的 cwd 为 null → termd 用自身 cwd。
  const cwdOf = () => navState().cwd;

  let ws = null;
  let connected = false;
  let error = null;
  let cache = { terms: [], shells: [], defaultShell: null }; // 最近一次名册（前端连上时直接喂）
  let retryTimer = null;
  let attempts = 0;
  let seq = 0;
  const pending = new Map(); // 在途问答：id → {resolve, reject, timer}

  const pushList = () => bus.emit("term.list", cache, { net: true });

  function send(obj) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /** 转发一条问答到 termd，回执原样兑现（失败必须 reject，否则前端永久 pending） */
  function rpc(e, p, timeoutMs = 20_000) {
    if (!connected) return Promise.reject(new Error(`终端服务未运行（termd）：${error ?? "未连接"}`));
    const id = `s${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${e} 超时`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ t: "q", e, p, id });
    });
  }

  function rejectInflight(why) {
    for (const w of pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
    }
    pending.clear();
  }

  // ── 连接 + 重连（退避 500ms → 10s） ───────────────────────────────────────
  function scheduleRetry(reason) {
    if (retryTimer) return;
    const delay = Math.min(500 * 2 ** attempts, 10_000);
    attempts += 1;
    console.log(`[term] 与 termd 断开（${reason}），${delay}ms 后重连（第 ${attempts} 次）`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    const token = readToken();
    if (!token) {
      connected = false;
      scheduleRetry("termd 未运行（无 token）");
      return;
    }
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const guard = setTimeout(() => {
      try {
        sock.terminate();
      } catch {}
    }, 3000);

    sock.on("open", async () => {
      clearTimeout(guard);
      ws = sock;
      connected = true;
      error = null;
      attempts = 0;
      console.log("[term] 已接入 termd");
      try {
        const p = await rpc("term.list", null); // 拉一次名册（同时喂前端）
        if (p?.terms) cache = p;
      } catch (err) {
        console.log(`[term] 拉名册失败: ${err?.message ?? err}`);
      }
      pushList();
    });

    sock.on("message", (raw) => {
      let f;
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return; // 坏帧静默丢
      }
      if (f.t === "e") {
        if (!DOWN.has(f.e)) return;
        if (f.e === "term.list") cache = f.p ?? cache; // 名册顺手缓存，供 $conn.open 时喂
        bus.emit(f.e, f.p, { net: true });
        return;
      }
      if (f.t === "s") {
        const w = pending.get(f.id);
        if (!w) return; // 迟到 / 陌生回执：静默丢
        pending.delete(f.id);
        clearTimeout(w.timer);
        if (f.ok) w.resolve(f.data);
        else w.reject(new Error(f.error ?? "termd 调用失败"));
      }
    });

    sock.on("error", (err) => console.log(`[term] 私线出错: ${err?.message ?? err}`));

    sock.on("close", () => {
      clearTimeout(guard);
      if (ws !== sock) return;
      ws = null;
      connected = false;
      error = "终端服务已断开";
      rejectInflight("终端服务已断开");
      // 名册清空后推给前端：终端不可达了，页面不该继续显示一排"活着"的假象
      cache = { terms: [], shells: cache.shells, defaultShell: cache.defaultShell };
      pushList();
      scheduleRetry("套接字关闭");
    });
  }

  // ── 上行：只转发"从线上下来的"（本地 emit 会先本地广播一份，不卡就自己转自己） ──
  for (const ev of UP) {
    bus.on(ev, (p, meta) => {
      if (meta?.from !== "wire") return;
      send({ t: "e", e: ev, p });
    });
  }

  // ── 问答转发 ─────────────────────────────────────────────────────────────
  bus.on("term.create", (p) =>
    rpc("term.create", {
      ...p,
      // cwd：显式给的优先；否则 chamber 注入的"当前 Agent 空间"；再没有就让 termd 用它的 cwd
      cwd: p?.cwd ? String(p.cwd) : (cwdOf() ?? undefined),
    })
  );
  bus.on("term.attach", (p) => rpc("term.attach", p));

  // 前端（重）连上 → 立刻喂最近一次名册，页面不用干等下一次变更
  bus.on("$conn.open", () => pushList());

  // ── 启动：探测 → 该拉就拉 → 连上 ──────────────────────────────────────────
  (async () => {
    if (!(await ensureTermdRunning({ port: PORT, spawnIfNeeded: true }))) {
      error = "termd 起不来（看 packages/termd/logs/）";
      console.log(`[term] ${error}`);
      scheduleRetry("就绪等待超时");
      return;
    }
    connect();
  })();

  console.log("[term] Term 域已装（终端进程归 packages/termd 的守护进程，chamber 只做帧桥接）");
  return {
    get connected() {
      return connected;
    },
    get error() {
      return error;
    },
  };
}
