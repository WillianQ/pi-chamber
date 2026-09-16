// 「保证 termd 在跑」的唯一实现 —— chamber 侧（term-service.js）与 CLI（scripts/termd.mjs）共用。
//
// 零依赖、不 import node-pty：chamber 引用本文件不会把原生模块拖进它的依赖树
// （chamber 一行 pty 代码都不写，这条隔离是 termd 独立成包的唯一理由）。
//
// 端口**由调用方显式给**（chamber 传 config.termdPort，CLI 传 --port），默认 3002；本文件不读 env。
// 拉起 daemon 时用 `--port N` 传下去 → 端口来源唯一，daemon 与探活端必然一致。
// token 落在 data/token 一行 → 不需要「pid/port/token 三字段 json」。
// 单实例闸在 daemon 侧（listen 撞 EADDRINUSE 即退出），这边只管探活与拉起。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_JS = path.join(PKG_DIR, "src", "daemon.js");
// 家目录：与 setting.js / logger.js / nav-service.js 同一套口径（dev 与打包版**落到同一处**）
//   → token / 日志天然共用一份：谁先起谁当 daemon，另一个连上去，不再各写各的 token。
const HOME = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");
// ★ 打包判据 = 「我是不是跑在 exe 里」：exe 里 import.meta.url 指向 exe 自己（不以 .js 结尾），
//   而且 daemon.js 根本不在磁盘上 → 拉起方式要改成「exe 自己再起一份，带 --termd」
//   （见 scripts/sea-entry.mjs）。
//   ★ 绝不能用 PI_CHAMBER_HOME 判：exe 会把这个变量注入给子进程，从 chamber 内嵌终端里跑 dev
//     代码会被误判成打包版，去读打包版的 token（真踩过：`pnpm termd status` 一直报"没响应"）。
const SEA = !fileURLToPath(import.meta.url).endsWith(".js");
const TOKEN_FILE = path.join(HOME, "data", "token");
export const DEFAULT_PORT = 3002;
export const DAEMON_PATH = DAEMON_JS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 token（daemon 启动时写的一行）。没有 = daemon 没起过 */
export function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** 探活：打 /health（带 token）。任何一步失败都当"没在跑" */
export async function health({ port = DEFAULT_PORT, timeoutMs = 1200 } = {}) {
  const token = readToken();
  if (!token) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health?token=${token}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 拉起守护进程（detached：chamber 死了它还活着 —— 这正是本功能的意义） */
export function spawnDaemon({ port = DEFAULT_PORT } = {}) {
  const child = spawn(
    process.execPath,
    SEA ? ["--termd", "--port", String(port)] : [DAEMON_JS, "--port", String(port)],
    {
      cwd: SEA ? path.dirname(process.execPath) : PKG_DIR,
      detached: true,
      // ★ 三路都丢：termd 不打日志（它自己一个字节都不写）—— 要探活走 /health，不要看日志文件
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    }
  );
  child.unref();
  return child.pid;
}

/**
 * 就绪保证：探活 → 必要时拉起 → 等到 /health 通过。
 * ★ 只在 install（chamber 启动）与 CLI start 时调用；运行期掉线**只重连不拉起**，
 *   否则 `pnpm termd stop` 会被 chamber 在背后复活，用户就再也停不掉了。
 */
export async function ensureTermdRunning({ port = DEFAULT_PORT, spawnIfNeeded = true, waitMs = 10_000 } = {}) {
  if (await health({ port })) return true;
  if (!spawnIfNeeded) return false;
  try {
    const pid = spawnDaemon({ port });
    console.log(`[term] 已拉起 termd（pid ${pid}，端口 ${port}），等它就绪…`);
  } catch (err) {
    console.log(`[term] 拉起 termd 失败: ${err?.message ?? err}`);
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await health({ port })) return true;
  }
  return false;
}

/** 请它自己优雅退出（先杀光 PTY 再退）。超时由调用方决定要不要硬杀 */
export async function requestShutdown({ port = DEFAULT_PORT, timeoutMs = 3000 } = {}) {
  const token = readToken();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown?token=${token}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
