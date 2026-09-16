#!/usr/bin/env node
/**
 * bg.mjs —— 后台启停后端（关掉命令行也照样跑）
 *
 * 用法：node scripts/bg.mjs <start|stop|status|restart>
 *       或双击根目录的 bg-start.bat / bg-stop.bat / bg-status.bat
 *
 * 原理：spawn 时带上 detached:true —— Windows 下子进程拿到 DETACHED_PROCESS 标志，
 *       不挂在本终端上；所以关 CMD / 关 VS Code 都不会把它带走。
 *       进程号写进 logs/bg.pid，stderr 落 logs/server.err.log。
 *
 * ★ stdout 直接丢弃（/dev/null）：生产不写日志 —— 内容流帧（agent.chat.delta / term.output）
 *   每秒几十条，接到文件上就是无限增长（旧实现落 logs/bg/server.out.log，已涨到 3.7MB）。
 *   想看日志：dev 用 `pnpm dev`（全量落 logs/server.log），或临时 `LOG=1 pnpm start`。
 *
 * 注意：Windows 上没有优雅退出（node 的 SIGTERM = 直接 TerminateProcess），
 *       停 = 硬杀。在途的对话轮次、编辑器里没保存的改动会没，其余无害。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(ROOT, "packages", "server");
const LOG_DIR = path.join(ROOT, "logs");
const PID_FILE = path.join(LOG_DIR, "bg.pid");
const ERR_LOG = path.join(LOG_DIR, "server.err.log");

// 服务端端口：以**设置文件**为准（不再有 .env）。路径规则与 server/src/setting.js 一致：
// PI_CHAMBER_SETTING 可覆盖（测试隔离），否则 ~/.pi/pi-chamber-global-setting.json。
function readPort() {
  const file =
    process.env.PI_CHAMBER_SETTING ||
    path.join(os.homedir(), ".pi", "pi-chamber-global-setting.json");
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isInteger(s?.port) && s.port > 0 && s.port < 65536) return s.port;
  } catch {}
  return 3000;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // 只探活，不真发信号
    return true;
  } catch {
    return false;
  }
}

async function portUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/me`, { signal: AbortSignal.timeout(1500) });
    return res.status; // 401 = 服务活着（没带 token）
  } catch {
    return null;
  }
}

async function status() {
  const pid = readPid();
  const port = readPort();
  const running = alive(pid);
  const code = await portUp(port);
  console.log(`pid 文件 : ${pid ?? "(无)"}  → ${running ? "进程活着" : "没在跑"}`);
  console.log(`端口     : ${port}  → ${code === null ? "端口不通" : `通（HTTP ${code}）`}`);
  console.log(`日志     : 生产不写日志（要就看控制台或 LOG=1 pnpm start）；崩溃堆栈落 ${ERR_LOG}`);
  return running && code !== null;
}

function start() {
  const pid = readPid();
  if (alive(pid)) {
    console.log(`已经在跑了（pid ${pid}），要重启用 restart。`);
    return;
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = `\n===== 启动 ${new Date().toLocaleString()} =====\n`;
  const err = fs.openSync(ERR_LOG, "a");
  fs.writeSync(err, stamp);

  const port = readPort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: SERVER_DIR,
    detached: true,      // ★ 脱离终端：关命令行不死
    stdio: ["ignore", "ignore", err],   // ★ stdout 丢弃（生产不写日志，见文件头注）；stderr 留档
    windowsHide: true,   // 不弹黑框
    // 端口以设置文件为唯一真相：setting.js 会把 PORT 当覆盖值用，这里显式钉死，
    // 免得外部 shell 里残留的 PORT（比如跑过 pnpm dev 的 3001）把后台进程顶到别的端口。
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`已后台启动：pid ${child.pid}，端口 ${port}（dist 静态页同端口托管）`);
  console.log(`停止：   node scripts/bg.mjs stop`);
}

function stop() {
  const pid = readPid();
  if (!alive(pid)) {
    console.log("没在跑（或 pid 文件是旧的）。");
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }
  process.kill(pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(`已停：pid ${pid}`);
}

const cmd = process.argv[2] ?? "status";
if (cmd === "start") start();
else if (cmd === "stop") stop();
else if (cmd === "restart") { stop(); setTimeout(start, 800); }
else if (cmd === "status") await status();
else {
  console.log("用法：node scripts/bg.mjs <start|stop|status|restart>");
  process.exit(1);
}
