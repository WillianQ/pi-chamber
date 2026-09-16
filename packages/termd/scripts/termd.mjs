#!/usr/bin/env node
/**
 * termd.mjs —— 终端守护进程的启停控制器
 *
 * 用法：pnpm termd <start|stop|status|restart> [--port N]   （或 node packages/termd/scripts/termd.mjs …）
 *
 * 端口：默认 3002（DEFAULT_PORT），`--port N` 可指定 —— CLI 拉起与管控都用这个端口。
 * 注意：chamber 自己拉起的 termd 端口由 chamber 的 .env（TERMD_PORT）决定；两边不同就管不到对方，
 * 要一致就把端口显式传给 CLI。
 *
 * 为什么 stop 要先走 HTTP /shutdown：强杀进程（Windows 的 taskkill /F、Unix 的 SIGKILL）不会让
 * 守护进程执行清场逻辑 —— 它手里的那批 PTY 在 Windows 上**不会**被连带收掉，直接变孤儿。
 * 所以：先请它自己杀光 PTY 再退；超时没退才硬杀（硬杀前也先试整棵进程树）。
 */
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_PORT, ensureTermdRunning, health, requestShutdown } from "../src/spawn.js";

// 家目录口径与 spawn.js / daemon.js 一致（token 与日志都落这儿 —— 别报一个不存在的路径）
const HOME = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");
const LOG_FILE = path.join(HOME, "logs", "termd.log");

// 端口：`--port N` > 默认 3002（本文件不读 env —— 与 daemon/spawn 口径一致）
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  const h = await health({ port: PORT });
  console.log(`端口     : ${PORT}（仅 loopback）`);
  console.log(`健康     : ${h ? `✅ 在跑（pid ${h.pid}，终端 ${h.terms} 个，已活 ${Math.round(h.uptime)}s）` : "❌ 没响应"}`);
  console.log(`日志     : ${LOG_FILE}`);
  return !!h;
}

async function start() {
  if (await health({ port: PORT })) {
    console.log(`[termd] 已经在跑（端口 ${PORT}）`);
    return true;
  }
  const ok = await ensureTermdRunning({ port: PORT, spawnIfNeeded: true });
  console.log(ok ? `[termd] 已就绪（端口 ${PORT}）` : `[termd] 起不来，看 ${LOG_FILE}`);
  return ok;
}

async function stop() {
  const h = await health({ port: PORT });
  if (!h) {
    console.log("[termd] 本来就没在跑");
    return true;
  }
  console.log(`[termd] 请它优雅退出（会自己杀光 ${h.terms} 个终端）…`);
  await requestShutdown({ port: PORT });
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (!(await health({ port: PORT }))) {
      console.log("[termd] 已退出");
      return true;
    }
  }
  // 兜底：硬杀（先试整棵进程树；Windows 用 taskkill /T，Unix 用进程组信号）
  console.log(`[termd] 优雅退出超时，硬杀 pid ${h.pid}`);
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/T", "/PID", String(h.pid)]);
    else process.kill(-h.pid, "SIGKILL");
  } catch (err) {
    console.log(`[termd] 硬杀失败: ${err?.message ?? err}`);
    return false;
  }
  await sleep(300);
  const gone = !(await health({ port: PORT }));
  console.log(gone ? "[termd] 已强杀" : "[termd] 还在？看 " + LOG_FILE);
  return gone;
}

const cmd = process.argv[2] ?? "status";
switch (cmd) {
  case "start":
    process.exit((await start()) ? 0 : 1);
  case "stop":
    process.exit((await stop()) ? 0 : 1);
  case "restart":
    await stop();
    process.exit((await start()) ? 0 : 1);
  case "status":
    process.exit((await status()) ? 0 : 1);
  default:
    console.log("用法: pnpm termd <start|stop|status|restart> [--port N]");
    process.exit(1);
}
