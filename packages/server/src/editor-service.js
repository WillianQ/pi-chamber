// Editor 域（文件查看/编辑）：服务端内存唯一持有"当前打开的文件集"，watch 外部改动即时推送。
//
// 与 Nav 域同哲学：状态服务端唯一、纯推送（editor.files 全量 / editor.file_changed 增量）、无 get。
// 差异：**无持久化** —— 服务重启（dev 是 node --watch，常重启）即全丢，前端收空 editor.files 清场自愈。
//
// 打开动作归属 nav（nav.open_file，入口在 nav/DirBrowser 双击）；文件落地后的管理/编辑属 editor。
//
// 协议（详见 AGENTS.md "Editor 域"）：
//   请求 nav.open_file   {path} → {ok, alreadyOpen, name} / error   资格闸口在此
//   请求 editor.update   {path, content} → {ok} / error             显式保存（Ctrl+S/按钮才发）
//   事件 editor.close_file {path}   前端→后端，单向无回执            出列 + unwatch
//   事件 editor.files    {files:[{name,path,content}]}              $conn.open 推全量（恢复现场）
//   事件 editor.file_changed {path, type:"new"|"modify"|"delete", name?, content?}   增量
//
// watch：单 chokidar watcher（awaitWriteFinish 等写稳定再响），open→add / close·delete→unwatch。
//   回声抑制 = 内容比对：change 读盘 ≠ 内存已知 content 才推 modify —— 自己保存后内存已同步 → 静默；
//   外部（agent/其他进程）写入 → 内容不同 → 推 modify 全量新内容。
// 冲突 = 磁盘/后端为准：无 rev 无检测，谁后写算谁的（主要外部写者 = chamber 里的 agent）。
import { log } from "./log.js";
import fs from "node:fs/promises";
import chokidar from "chokidar";

const MAX_FILE_SIZE = 500 * 1024; // 500KB 上限（老 chamber 同款闸）
const BINARY_PROBE = 1024; // 前 1KB 查 NUL 判二进制

/** @type {Map<string, {name, path, content}>} 打开的文件集（Map 保序 = tab 序） */
const files = new Map();

const watcher = chokidar.watch([], {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

function baseName(p) {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
}

/** 打开闸口：不是文件 / 超 500KB / 二进制 / 非 UTF-8 → throw（走回执 error，前端提示） */
async function checkReadable(abs) {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`不存在或无权限: ${abs}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件: ${abs}`);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大 ${(stat.size / 1024).toFixed(1)}KB（上限 500KB）`);
  }
  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    throw new Error(`读取失败: ${err?.message ?? err}`);
  }
  if (buf.length > 0 && buf.subarray(0, Math.min(buf.length, BINARY_PROBE)).includes(0)) {
    throw new Error("二进制文件不支持");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf); // 非 UTF-8 拒开：避免当文本写回毁掉原编码
  } catch {
    throw new Error("非 UTF-8 编码文件不支持（拒开以避免写回破坏原编码）");
  }
}

export function installEditorService(bus) {
  const pushChanged = (payload) => bus.emit("editor.file_changed", payload, { net: true });

  // ── watcher：闹钟只是敲门砖，真相以读盘结果为准 ─────────────────────────────
  watcher.on("change", async (abs) => {
    const f = files.get(abs);
    if (!f) return; // 只关心打开中的文件
    let content;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      return; // 读失败：unlink 事件会兜底，这里忽略
    }
    if (content === f.content) return; // 自己保存的回声 / 无实质变化 → 静默
    f.content = content;
    pushChanged({ path: abs, type: "modify", name: f.name, content });
  });

  watcher.on("unlink", (abs) => {
    if (!files.has(abs)) return;
    files.delete(abs);
    watcher.unwatch(abs);
    pushChanged({ path: abs, type: "delete" });
  });

  watcher.on("error", (err) => {
    log(`[editor] watch 出错: ${err?.message ?? err}`);
  });

  // ── nav.open_file：浏览入口把文件拉进编辑器（归属 nav 命名，入口在 nav） ───
  bus.on("nav.open_file", async (p) => {
    const abs = p?.path ? String(p.path).trim() : "";
    if (!abs) throw new Error("缺少 path");
    const exist = files.get(abs);
    if (exist) return { ok: true, alreadyOpen: true, name: exist.name };
    const content = await checkReadable(abs); // 不合法 → throw → 回执 error
    const name = baseName(abs);
    files.set(abs, { name, path: abs, content });
    watcher.add(abs);
    // 先推 new（前端建 tab）再回执：同一条 WS 上帧序保证前端先见 tab 后见 ok
    pushChanged({ path: abs, type: "new", name, content });
    return { ok: true, alreadyOpen: false, name };
  });

  // ── editor.update：显式保存（回执 ok 才算数）。写盘后更新内存 = 回声抑制关键 ──
  bus.on("editor.update", async (p) => {
    const abs = p?.path ? String(p.path).trim() : "";
    const content = typeof p?.content === "string" ? p.content : null;
    if (!files.has(abs)) throw new Error(`文件未打开: ${abs}`);
    if (content === null) throw new Error("缺少 content");
    try {
      await fs.writeFile(abs, content, "utf-8"); // 权限/文件被删等 → throw → 回执 error
    } catch (err) {
      throw new Error(`写入失败: ${err?.message ?? err}`);
    }
    files.get(abs).content = content; // 先同步内存：后续 watcher change 读盘相同 → 静默不回声
    return { ok: true };
  });

  // ── editor.close_file：前端已本地删 tab，这里只是单向清理通知（无回执、可丢） ──
  bus.on("editor.close_file", (p) => {
    const abs = p?.path ? String(p.path).trim() : "";
    if (files.delete(abs)) watcher.unwatch(abs);
  });

  // ── $conn.open 即推全量 = 恢复现场（重连/换终端；重启后为空列表 = 前端清场） ──
  bus.on("$conn.open", () => {
    bus.emit("editor.files", { files: [...files.values()] }, { net: true });
  });

  log("[editor] 文件编辑服务已装（内存态、重启即清；上限 500KB；watch=chokidar 单例）");
}
