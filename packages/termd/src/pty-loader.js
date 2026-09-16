// 加载 node-pty —— termd 是独立进程的**唯一理由**就是它持有这个原生模块。
//
// 两种来源：
//   dev     → 直接从 node_modules 解（`import("@lydell/node-pty")`）
//   打包版  → exe 入口已把整个平台包解压到 <HOME>/native/node_modules/，从那儿 require
//
// ★ 打包版为什么不能走 import：
//   ① SEA 里的代码**不能从磁盘加载模块**（只能加载内置模块）—— 必须用 `createRequire` 拿到文件版 require
//   ② node-pty 内部会 `fork(path.join(__dirname, "conpty_console_list_agent"))` 起一个子进程，
//      那个 .js 必须真实存在于磁盘上 → 所以是**整个包**解压（JS + .node + ConPTY 的 OpenConsole.exe / conpty.dll），
//      不是只解压 .node 文件
import { createRequire } from "node:module";
import path from "node:path";

let cached = null;

/** 取 node-pty 模块。结果缓存 —— 多次调用无额外开销。 */
export async function loadPty() {
  if (cached) return cached;
  const nativeDir = process.env.PI_CHAMBER_NATIVE_DIR;
  const mod = nativeDir
    ? // createRequire 只要一个「锚点文件路径」，文件本身不需要存在
      createRequire(path.join(nativeDir, "anchor.cjs"))("@lydell/node-pty")
    : await import("@lydell/node-pty");
  // CJS require 给的是 module.exports 本身；ESM import 给的是 namespace（真身挂在 .default）
  cached = typeof mod.spawn === "function" ? mod : mod.default;
  return cached;
}
