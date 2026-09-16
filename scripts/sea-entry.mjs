// pi-chamber.exe 的入口 —— **一个 exe，两个角色**：
//
//   pi-chamber.exe              → chamber（前台跑服务，用户双击的就是这个）
//   pi-chamber.exe --termd      → termd 守护进程（chamber 自己 detached 拉起，见 termd/src/spawn.js）
//
// 它还负责一件 chamber / termd 都不该管的事：**首次运行把 exe 里的资产解压到磁盘**。
//   为什么必须落盘：
//     web/      express.static 要一个真目录
//     native/   node-pty 内部会 `fork(conpty_console_list_agent.js)` —— 那个 .js 必须在盘上
//
// 解压完通过环境变量把位置告诉下面两个包（它们只认环境变量，不认自己在不在 exe 里，
// 这样 dev 跑源码时这些变量不存在，行为一字不变）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRawAsset, isSea } from "node:sea";

// 生成物（资产清单）由 scripts/build-exe.mjs 写到这里，与本文件不在同一目录
import { ASSET_FILES, BUILD_ID } from "../build/gen/assets.js";

const HOME = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");

if (isSea()) {
  extractAssets();
  process.env.PI_CHAMBER_HOME = HOME;
  process.env.PI_CHAMBER_WEB_DIR = path.join(HOME, "web");
  process.env.PI_CHAMBER_NATIVE_DIR = path.join(HOME, "native");
}

if (process.argv.includes("--termd")) {
  await import("../packages/termd/src/daemon.js");
} else {
  await import("../packages/server/src/server.js");
}

/**
 * 把打进 exe 的资产解压到 HOME。
 *
 * 用 BUILD_ID 戳文件判断「这一版解压过没」—— 版本变了就整个删掉重来，
 * 免得上一版残留的文件被继续用（前端 dist 是指纹文件名，混版本会出诡异问题）。
 */
function extractAssets() {
  const stamp = path.join(HOME, ".assets-build");
  try {
    if (fs.readFileSync(stamp, "utf8").trim() === BUILD_ID) return;
  } catch {
    // 没有戳文件 = 首次运行
  }

  for (const sub of ["web", "native"]) {
    fs.rmSync(path.join(HOME, sub), { recursive: true, force: true });
  }

  for (const rel of ASSET_FILES) {
    const dest = path.join(HOME, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(getRawAsset(rel)));
  }

  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(stamp, BUILD_ID);
  console.log(`[pi-chamber] 首次运行：已解压 ${ASSET_FILES.length} 个文件到 ${HOME}`);
}
