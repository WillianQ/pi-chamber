// ★ 终端守护进程（termd）—— 独立进程，**唯一持有 node-pty 的东西**。
//
// 为什么要有它：PTY 子进程挂在"谁起的它"这棵进程树下。chamber 是 dev 模式（node --watch）天天重启的
// 网关，若由它起 PTY，重启时 Windows 的 ConPTY **不会**连带收掉子进程（实测：孤儿照跑、输出没人接、
// 表里也没有它 → 谁也关不掉）。把 PTY 交给一个不重启的守护进程，问题从根上没了：
//   chamber 重启 → 终端还在（断线重连，回放断线期间的输出）；
//   termd 退出 → 它自己 kill 全部 PTY（它是直接父进程，这活儿只有它干得干净）。
//
// 形态：只绑 127.0.0.1 的**固定端口**（`--port N` 指定，默认 3002）+ 一层极简鉴权。
// 协议不依赖 @pi-chamber/bus —— termd 不是 chamber 的模块，是它的**子进程**，自带一套 40 行的线协议：
//   {t:"e", e, p}                  事件（单向）
//   {t:"q", e, p, id}              请求
//   {t:"s", id, ok:true, data}     回执
//   {t:"s", id, ok:false, error}   失败回执
// 帧名权威表见 AGENTS.md 4.2；本文件里字符串字面量与 chamber 侧各写一份（本仓惯例，前端也这样）。
//
// 鉴权三层（全在这一个文件里）：
//   ① loopback：非 127.0.0.1 来源一律拒（termd 永不进公网）
//   ② Origin 头存在即拒：合法客户端只有 chamber（node ws，从不带 Origin）；浏览器发起的连接必带
//      → 这一条挡掉「你随手打开的一个被 XSS 的网页就能在本机开 shell」
//   ③ token：随机生成落 data/token 一行（chamber / CLI 读它），挡本机其他进程
//
// 用法：node src/daemon.js        （一般不用手起，chamber 会按需拉起；
//                                   手动管理走 scripts/termd.mjs 的 start|stop|status|restart）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { loadPty } from "./pty-loader.js";
import { createSessions } from "./sessions.js";

// node-pty 的取法因环境而异（dev 直 import / 打包版从解压目录 require），见 pty-loader.js
const pty = await loadPty();


// 端口只认命令行 `--port N`（chamber 拉起时显式传，CLI 可用 --port 指定）；★ 不读 env —— 端口来源唯一，
// 免去「chamber 的环境变量悄悄改了 termd 端口」这类隐式耦合。
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3002;
})();
// ★ 家目录与 spawn.js / setting.js 同一套口径（`PI_CHAMBER_HOME` > `~/.pi/pi-chamber`）：
//   dev 与打包版落到同一处 → **token 只有一份**，谁先起谁当 daemon，另一个连上去（不再各写各的）。
const HOME = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");
const DATA_DIR = path.join(HOME, "data");
const TOKEN_FILE = path.join(DATA_DIR, "token");
// 日志与 chamber 的 server.log 同一处（找日志只需看一个目录）
const LOG_FILE = path.join(HOME, "logs", "termd.log");

// ── 日志：控制台 + 写文件（照 server/logger.js 的 tee 做法，自带一份不依赖别人） ──
// termd 只在生命周期事件（起 / 退出 / 连接）写，**不写终端输出流** —— 所以很小，不需轮转。
// 启动即清空：它重启 = 新的一轮（要留历史的是 termd.boot.log，那个只追加）。
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.writeFileSync(LOG_FILE, "");
const origLog = console.log.bind(console);
console.log = (...args) => {
  const line = `${new Date().toISOString()} ${args.join(" ")}`;
  origLog(line);
  fs.appendFile(LOG_FILE, line + "\n", () => {});
};

// ── shell 探测：启动时探一次，列给前端做「新建终端」的下拉 ────────────────────────
// 纪律：
//  - 只认**存在**的可执行文件（绝对路径走 fs.existsSync；裸名走 PATH 探测：Windows 上 which 不可靠，
//    故只列我们确信存在的裸名 —— PowerShell / cmd 由系统目录保证，Unix 上 /bin/sh 恒定）。
//  - Git Bash 额外挂 CHERE_INVOKING=1 且带 -l：CHERE_INVOKING 是 Git for Windows 的约定，
//    "invoked from here" —— 没有它，login shell 的 /etc/profile 会把 cwd 甩回 $HOME，
//    "终端开在 agent 的工作目录"就落空了（实测过：不带它会被甩走）。
const WIN = process.platform === "win32";

function firstExisting(cands) {
  return cands.find((p) => p && fs.existsSync(p)) ?? null;
}

function listShells() {
  const seen = new Set();
  const shells = [];
  const push = (id, label, file, args = []) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    shells.push({ id, label, file, args });
  };
  if (!WIN) {
    push("zsh", "zsh", firstExisting(["/bin/zsh", "/usr/bin/zsh"]));
    push("bash", "bash", firstExisting([process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/bin/sh"]));
    push("sh", "sh", firstExisting(["/bin/sh"]));
    return shells;
  }
  const gitBash = firstExisting([
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    "C:/Program Files/Git/bin/bash.exe", // 即便 env 缺失也兜一把
  ]);
  if (gitBash) shells.push({ id: "bash", label: "Git Bash", file: gitBash, args: ["-l"] });
  const sysRoot = process.env.SystemRoot ?? "C:/Windows";
  push("powershell", "PowerShell", firstExisting([path.join(sysRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")]), ["-NoLogo"]);
  push("cmd", "命令提示符", firstExisting([process.env.ComSpec, path.join(sysRoot, "System32/cmd.exe")]));
  push("wsl", "WSL", firstExisting([path.join(sysRoot, "System32/wsl.exe")]));
  return shells;
}

const shells = listShells();

/** 前端点名要的 shell（id）→ 候选实体；点名不存在 / 没点名 → 第一个（=默认） */
function resolveShell(id) {
  if (!shells.length) throw new Error("这台机器上没探测到任何可用的 shell");
  if (!id) return shells[0];
  return shells.find((s) => s.id === id) ?? shells[0];
}

/** 起 shell 用的 env：保住 CHERE_INVOKING（bash 不甩回 home），并钉死 TERM */
function shellEnv() {
  const env = { ...process.env };
  delete env.TERM_PROGRAM; // 让 shell 别以为自己在 VS Code 里
  env.TERM = "xterm-256color";
  env.CHERE_INVOKING = "1";
  return env;
}

// ── 连接表（每个 ws = 一个 conn；每个 conn 自己决定 attach 哪些终端） ─────────────
let connSeq = 0;
const conns = new Set();

function send(conn, obj) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
}
function sendEvent(conn, e, p) {
  send(conn, { t: "e", e, p });
}
function broadcast(e, p) {
  const raw = JSON.stringify({ t: "e", e, p });
  for (const c of conns) if (c.ws.readyState === 1) c.ws.send(raw);
}

// ── 会话表 ────────────────────────────────────────────────────────────────────
const sessions = createSessions({
  spawn: (shell, { cwd, cols, rows }) =>
    pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv(),
    }),
  // 输出**按连接单播**（只发给 attach 过这个终端的连接；没人 attach 就不出帧）
  onOutput: (conn, termId, data) => sendEvent(conn, "term.output", { termId, data }),
  // 退出是控制面信息：广播给所有连接（没 attach 的也该把名册行标成 exited）
  onExit: (termId, info) => broadcast("term.exit", { termId, ...info }),
  // 名册变更（增 / 删 / 退出）：广播全量
  onChange: () => broadcast("term.list", listPayload()),
});

function listPayload() {
  return {
    terms: sessions.list(),
    shells: shells.map(({ id, label }) => ({ id, label })),
    defaultShell: shells[0]?.id ?? null,
  };
}

// ── 协议 handler ─────────────────────────────────────────────────────────────
function handle(conn, msg) {
  const { t, e, p, id } = msg;

  // 事件（单向，前端 → termd）
  if (t === "e") {
    try {
      switch (e) {
        case "term.input":
          sessions.input(String(p?.termId ?? ""), p?.data);
          break;
        case "term.resize":
          sessions.resize(conn, String(p?.termId ?? ""), p?.cols, p?.rows);
          break;
        case "term.detach":
          sessions.detach(conn, String(p?.termId ?? ""));
          break;
        case "term.close":
          sessions.close(String(p?.termId ?? ""));
          break;
        default:
          console.log(`[termd] 未知事件帧: ${e}`);
      }
    } catch (err) {
      console.log(`[termd] ${e} 丢弃: ${err?.message ?? err}`);
    }
    return;
  }

  // 请求（一问一答，前端 → termd）
  if (t === "q") {
    let data;
    let error;
    try {
      switch (e) {
        case "term.list":
          data = listPayload();
          break;
        case "term.create": {
          const shell = resolveShell(p?.shell);
          const cwd = p?.cwd ? String(p.cwd) : process.cwd();
          data = sessions.create({ shell, cwd, cols: p?.cols, rows: p?.rows });
          break;
        }
        case "term.attach":
          data = sessions.attach(conn, String(p?.termId ?? ""), p?.cols, p?.rows);
          break;
        default:
          throw new Error(`未知请求帧: ${e}`);
      }
    } catch (err) {
      error = err?.message ?? String(err);
    }
    send(conn, error ? { t: "s", id, ok: false, error } : { t: "s", id, ok: true, data });
  }
}

// ── 鉴权 token：env 优先（便于固定调试），否则随机 24 字节；落盘一行供 chamber / CLI 读 ──
const TOKEN = process.env.TERMD_TOKEN || randomBytes(24).toString("hex");

// ── HTTP：/health 探活 + /shutdown 优雅退出（都走同一套鉴权） ────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!authOk(req, url)) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, terms: sessions.count, uptime: process.uptime() }));
    return;
  }
  // 优雅退出（CLI stop 走这条）：由**它自己**杀光 PTY —— 强杀进程在 Windows 上不会带走 ConPTY 子进程，
  // 只有守护进程手里的 write/pty 句柄能干净地把它收掉
  if (url.pathname === "/shutdown") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, killed: sessions.count }));
    shutdown("HTTP /shutdown");
    return;
  }
  res.writeHead(404).end();
});

/** 三层鉴权：loopback + 无 Origin（挡浏览器）+ token */
function authOk(req, url) {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!loopback) return false;
  // 有 Origin 头 = 浏览器发起的连接。合法客户端（chamber）是 node ws，从不带 Origin。
  // 这一条挡掉「任意网页的 JS 连 ws://127.0.0.1:3002」——也顺带挡掉 DNS rebinding。
  if (req.headers.origin) return false;
  return url.searchParams.get("token") === TOKEN;
}

// ── 私线 WS（客户端 = chamber；允许多个，各自 attach 各自的终端） ────────────────
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/ws" || !authOk(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  const conn = { id: `c${++connSeq}`, ws };
  conns.add(conn);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 坏帧静默丢
    }
    handle(conn, msg);
  });
  ws.on("close", () => {
    conns.delete(conn);
    sessions.dropConn(conn); // ★ 必须：否则 attachedTo 里留着死连接（泄漏 + 往死 socket 写）
    console.log(`[termd] chamber 断开 ${conn.id}（剩 ${conns.size} 个；终端继续跑）`);
  });
  console.log(`[termd] chamber 已接入 ${conn.id}（共 ${conns.size} 个）`);
  sendEvent(conn, "term.list", listPayload()); // 新接入方立刻拿到名册，不用等下一次变更
});

const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// ── 兵底：守护进程的存活 > 单次操作的完整性 ────────────────────────────────
// 它一死，所有 PTY 陪葬（而这正是本进程存在的意义）。node-pty 在 Windows 上
// 偶有异步抛错（如 kill 已退出的 PTY）—— try/catch 拓不住，所以这里必须接住。
process.on("uncaughtException", (err) => {
  console.log(`[termd] 未捕获异常（已忽略，进程继续）: ${err?.stack ?? err}`);
});
process.on("unhandledRejection", (err) => {
  console.log(`[termd] 未处理的 Promise 拒绝（已忽略）: ${err?.stack ?? err}`);
});

// ── 生命周期：只绑 loopback；退出时杀光自己管的 PTY + 抹掉**自己的** token 文件 ──
let shuttingDown = false;
// 只删自己写的那份 token（内容比对）：★ 因端口被占而放弃启动的进程从未落盘 token，
// 若照删不误，就会把活着的 daemon 的 token 抹掉 → 之后 stop/health 全报“没在跑”（真踩过）。
function removeOwnToken() {
  try {
    if (fs.readFileSync(TOKEN_FILE, "utf-8").trim() === TOKEN) fs.unlinkSync(TOKEN_FILE);
  } catch {}
}
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[termd] 收工（${reason}）：杀掉 ${sessions.count} 个终端`);
  clearInterval(hb);
  sessions.closeAll();
  removeOwnToken();
  try {
    wss.close();
    httpServer.close();
  } catch {}
  setTimeout(() => process.exit(0), 50).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  sessions.closeAll(); // 兜底（同步路径）：exit 里不能 await，kill 是同步的
  removeOwnToken();
});

// 端口被占 = 已经有一个在跑（或别的程序占了 3002）→ 放弃本次启动。
// ★ 必须在**写 token 文件之前**判定，否则会把活着的 daemon 的 token 覆盖掉。
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[termd] 端口 ${PORT} 已被占用（已有一个在跑？看 pnpm termd status），本次启动放弃`);
    process.exit(0);
  }
  console.error(`[termd] 启动失败: ${err?.message ?? err}`);
  process.exit(1);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, TOKEN); // 一行字符串（不是 json）：chamber / CLI 读它来连
  console.log(`[termd] 已起：http://127.0.0.1:${PORT}（仅 loopback）pid=${process.pid}`);
  console.log(`[termd] token 落 ${TOKEN_FILE}`);
  console.log(`[termd] 可用 shell: ${shells.map((s) => `${s.id}(${s.label})`).join(" / ") || "（无！）"}`);
});
