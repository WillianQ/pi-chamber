// Nav 域（目录导航 + FS 通用操作，一个文件管到底）：服务端唯一持有 {current, cwd}，
// 向任何连接的终端推送同一份"现场"；文件的新建/改名/删除/移动也在这落地。
//
// 设计要点（与用户讨论定稿）：
//  - 状态只记位置：current（文件浏览器停在哪，null=此电脑层）+ cwd（当前 Agent 空间）。
//    items 不进持久态，nav.state 推送时现拉现给（磁盘唯一真相，列表不缓存易腐数据）。
//  - 纯推送：连接建立（$conn.open）推全量 nav.state 恢复现场；nav.open/focused 联动生效后也推。
//    前端永远不"要"状态（无 nav.get）。断线错过 nav.update 不补，重连全量即最新。
//  - current 手动改口只有一个：nav.open。cwd 没有独立写口：nav 旁听 agent 域焦点帧
//    （agent.chat.sync 的 cwd 字段）联动 —— 切到不同 cwd 的 session 时 cwd/current 齐跳并推 nav.state。
//  - 变化监视：fs.watch 盯 current（depth 0），每条文件事件独立成一条 nav.update 单发（不合并）。
//  - FS 写侧（fs.create/rename/delete/move）是**纯事件、无回执**：发后即忘，失败只留服务端日志
//    （列表没变化 = 用户可见的失败信号，已拍板）。成功后服务端无脑补一次 pushState 全量——
//    幂等、单用户零成本，盖掉 watcher 的所有盲区（move 目标侧不在 watch 范围、current 本身被删等）。
//  - fs-service.js（纯只读原语库）已并入本文件上半区：导航域前后端各一个文件，对称收口。
//
// 帧协议：
//   事件 nav.state  {current, cwd, items}                      全量（连建立/每次变更后）
//   事件 nav.update {add|change:{type,name,abs_path}} / {remove:{abs_path}}   单条增量
//   请求 nav.open   {current: "C:\\..." | ""} → {ok} / error    移动 current
//   请求 fs.list    {path?} → {items}                            通用原语（同文件列目录）
//   请求 fs.desktop {}      → {desktop}                          通用原语（用户桌面）
//   请求 fs.search  {query?, limit?, dirs?} → {cwd, items}      通用原语（@ 文件引用 / 导航页搜索：在 Agent 空间里搜文件）
//     dirs:false → 只回文件（导航页找文件用；目录不再 +10 分挤掉文件）
//   事件 fs.create {parent, name, dir}    新建文件/目录（dir=true 建目录；已存在则跳过不覆盖）
//   事件 fs.rename {path, newName}        同目录换名（目标冲突跳过；纯换大小写放行）
//   事件 fs.delete {path}                 永久删除（目录连子项递归；回收站不做，已拍板）
//   事件 fs.move   {path, toDir}          移入目录（同名冲突/移进自己子孙/跨盘 跳过）
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ignore from "ignore";

// ── FS 静态原语（原 fs-service.js 整体并入；供 nav 域与 fs.* handler 共同调用） ──────────
// 与 Agent 域档案无关：这里操作的是用户文件系统（老 chamber /api/fs 的职责，改走 Bus 后收编于此）。
// 隐藏 dotfile、目录在前按名排 —— 与老 chamber 行为一致，需要"显示隐藏"以后加参数。

/** 盘符根列表（win32 探 A:-Z:；POSIX 返回 /） */
async function listRoots() {
  if (process.platform !== "win32") {
    return [{ type: "directory", name: "/", abs_path: "/" }];
  }
  const roots = [];
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`;
    try {
      await fs.access(root);
      roots.push({ type: "directory", name: root, abs_path: root });
    } catch {
      /* 该盘不存在 */
    }
  }
  return roots;
}

/** 用户桌面目录（DirPicker 起点）：常见名探测，全无 → 用户主目录兜底 */
async function getDesktop() {
  const home = os.homedir();
  for (const name of ["Desktop", "桌面"]) {
    const dir = path.join(home, name);
    if (await isDir(dir)) return dir;
  }
  return home;
}

/** 列目录（隐藏 dotfile，目录在前、localeCompare 排序）。非目录/不存在/无权限 → 抛错 */
async function listDir(absPath) {
  if (!path.isAbsolute(absPath)) throw new Error(`需要绝对路径: ${absPath}`);
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      type: e.isDirectory() ? "directory" : "file",
      name: e.name,
      abs_path: path.join(absPath, e.name),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
    });
}

/** 是否存在的目录 */
async function isDir(absPath) {
  try {
    return (await fs.stat(absPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 失效路径上溯：从 absPath 沿父链找最近一个"仍存在的目录"，找不到返回 null。
 * 持久化状态里记过的路径（目录被删/盘符没了）用它自愈，绝不让前端停在死胡同。
 */
async function nearestExistingDir(absPath) {
  if (!path.isAbsolute(absPath)) return null;
  let cur = absPath;
  for (;;) {
    if (await isDir(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // 已到盘根且盘根也不存在
    cur = parent;
  }
}

// ── FS 搜索原语（@ 文件引用补全；纯 node，零外部二进制） ─────────────────────
//
// 为什么不 spawn fd：pi 的 @ 补全调的是 `fd`（pi 起 TUI 时才自动下载到 ~/.pi/agent/bin）。
// 我们 server 只吃 SDK，不触发那次下载 ⇒ 换台机器部署 fd 大概率不在。好在 node 22.17+ 的
// fs.glob 已 stable（pi SDK 的 engines 底线是 >=22.19）⇒ 内建就够，零外部依赖。
// 实测本仓：194 条 / 8ms（exclude 是**真剪枝**，根本不进 node_modules；不带 exclude 是 39 万条/390ms）。
//
// .gitignore：fs.glob 不吃，用 `ignore` 包（纯 JS 零依赖）自己判。★ 目录规则要带尾斜杠才命中：
//   规则 `dist/` → ignores("dist") 是 false、ignores("dist/") 才 true ⇒ 目录两种写法都试。
//   v1 只读 cwd 根那一份 .gitignore（子目录里的 / .git/info/exclude / 全局配置不读）。
// 兜底清单：.git 不在 .gitignore 里（git 自己的元数据）必须硬排；node_modules 同理（没 .gitignore 时也要排）。
//
// 结果形状 {path, name, isDir}：path 是 **cwd 相对 + 正斜杠**，前端直接插进 prompt（与 pi 同口径）。
// 口径对齐 pi 的 CombinedAutocompleteProvider：打分用它的 scoreEntry（文件名命中优先于路径命中，
// 目录再 +10），同分按 深度 → 长度 → 字典序；空 query 列浅层全貌。**子串匹配，不是模糊子序列**。
const SKIP_NAMES = new Set([".git", "node_modules"]);
const INDEX_TTL = 10_000; // 索引缓存 10s：敲一个键就重走一遍全树没必要（有 .gitignore 兜着，8ms 一次够廉）
let indexCache = { root: null, at: 0, entries: null };

/** 弃掉索引缓存：fs.* 写侧成功后调用（否则刚建/删的文件最多 10s 搜不到，用户以为坏了） */
function invalidateIndex() {
  indexCache = { root: null, at: 0, entries: null };
}

/** 绝对路径 → cwd 相对 + 正斜杠（.gitignore 匹配与前端回填都用正斜杠，跨端一致） */
function relPosix(abs, root) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** 单条 dirent 该不该跳过（当 fs.glob 的 exclude 回调用：返回 true = 连子树都不进） */
function skipDirent(d, root, ig) {
  if (SKIP_NAMES.has(d.name)) return true;
  if (!ig) return false;
  const rel = relPosix(path.resolve(d.parentPath, d.name), root);
  return ig.ignores(rel) || ig.ignores(`${rel}/`);
}

/** 建/取索引：遍历 Agent 空间全树（跳过 .gitignore 命中项 + 兜底清单），10s 内复用 */
async function indexOf(root) {
  const now = Date.now();
  if (indexCache.root === root && now - indexCache.at < INDEX_TTL) return indexCache.entries;

  let ig = null;
  try {
    ig = ignore().add(await fs.readFile(path.join(root, ".gitignore"), "utf-8"));
  } catch {
    /* 没有 .gitignore（非 git 目录）：只靠兜底清单 */
  }

  const dirents = fsSync.globSync("**/*", {
    cwd: root,
    withFileTypes: true,
    exclude: (d) => skipDirent(d, root, ig),
  });

  const entries = dirents.map((d) => ({
    path: relPosix(path.resolve(d.parentPath, d.name), root),
    name: d.name,
    isDir: d.isDirectory(),
  }));
  indexCache = { root, at: now, entries };
  return entries;
}

/** 打分：照抄 pi CombinedAutocompleteProvider.scoreEntry（文件名命中优先于路径命中；目录 +10） */
function scoreEntry(entry, query) {
  const name = entry.name.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  if (name === q) score = 100;
  else if (name.startsWith(q)) score = 80;
  else if (name.includes(q)) score = 50;
  else if (entry.path.toLowerCase().includes(q)) score = 30;
  if (entry.isDir && score > 0) score += 10;
  return score;
}

/** 搜索：空 query 列浅层全貌（全 1 分，靠深度排序把顶层顶上来）；有 query 走打分排序。dirs:false 只回文件 */
function searchEntries(entries, query, limit, dirs = true) {
  const q = query.trim();
  const scored = [];
  for (const e of entries) {
    if (!dirs && e.isDir) continue; // 目录被滤掉后 scoreEntry 的 +10 也就不生效，无需另改打分
    const score = q ? scoreEntry(e, q) : 1;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const da = a.e.path.split("/").length;
    const db = b.e.path.split("/").length;
    if (da !== db) return da - db;
    if (a.e.path.length !== b.e.path.length) return a.e.path.length - b.e.path.length;
    return a.e.path.localeCompare(b.e.path, "zh-CN", { sensitivity: "base" });
  });
  return scored.slice(0, limit).map(({ e }) => {
    const cut = e.path.lastIndexOf("/");
    return { path: e.path, name: e.name, isDir: e.isDir, description: cut < 0 ? "" : e.path.slice(0, cut) };
  });
}

// ── FS 写侧闸口（fs.create/rename/delete/move 共用；全拒的只留日志，无回执） ──────────

const HOME = path.resolve(os.homedir());
const AGENT_DIR = path.join(HOME, ".pi", "agent"); // 与 agent-service 默认 agentDir 同式（auth/models/sessions 之家）

/** 路径归一比对键：绝对 + 去尾分隔符 + 小写（Windows 大小写不敏感，跨端比对都够） */
function normKey(p) {
  const s = path.resolve(String(p)).replace(/[\\/]+$/, "");
  return s.toLowerCase();
}

/** 盘根/文件系统根（C:\ 、 D:\ 、 /）：删/改/移是灾难，硬拒 */
function isRootLike(p) {
  const r = path.resolve(String(p));
  return r === path.parse(r).root;
}

/** 受保护本体：Agent 目录（nav.cwd）、agentDir、用户主目录——本体不可删/改名/移走（内部文件不拦） */
function isProtected(abs) {
  const k = normKey(abs);
  return k === normKey(HOME) || k === normKey(AGENT_DIR) || (state.cwd ? k === normKey(state.cwd) : false);
}

/** 名字合法性：非空、不含分隔符、非 . / ..（fs.* 的 parent+name 拼接入口共用） */
function badName(n) {
  return !n || /[\\/]/.test(n) || n === "." || n === "..";
}

async function existsAny(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** 目录内大小写不敏感同名探测（rename/move 冲突判定；existsAny 在 Windows 对纯换大小写也报"存在"，靠它放行） */
async function nameClash(dir, name, exceptName) {
  try {
    const names = (await listDir(dir)).map((i) => i.name);
    const low = name.toLowerCase();
    return names.some((n) => n !== exceptName && n.toLowerCase() === low);
  } catch {
    return true; // 读不了目录就当冲突，宁可不作为
  }
}

// ── 状态（内存唯一真相，变更即落盘） ─────────────────────────────────────────

const STATE_FILE =
  process.env.NAV_STATE_FILE || fileURLToPath(new URL("../data/nav-state.json", import.meta.url));
// ★ 路径可被 env 覆盖：e2e 测试用它指到临时目录。否则多个测试实例共享同一个
//   data/nav-state.json —— 上个测试留下的 current 指向已删目录，下一个测试启动时
//   fs.watch 就挂载失败（实测：bus-e2e 的日志里出现 fsops-e2e 的临时目录名）。
const VERSION = 1;

const state = { version: VERSION, current: null, cwd: null };

/** 只读出口：别的域要用"当前导航位置 / 当前 Agent 空间"时读这里（term 域新建终端就拿它当默认 cwd）。
 *  ★ 写口仍然只有本文件里的两处（nav.open 改 current；旁听 chat.sync 联 cwd）——state 不外泄。 */
export const navState = () => ({ current: state.current, cwd: state.cwd });

function loadState() {
  try {
    const raw = JSON.parse(fsSync.readFileSync(STATE_FILE, "utf-8"));
    if (raw.version === VERSION) {
      state.current = typeof raw.current === "string" ? raw.current : null;
      state.cwd = typeof raw.cwd === "string" ? raw.cwd : null;
    }
  } catch {
    /* 无存档（首跑）/ 损坏 → 用默认空态 */
  }
}

function saveState() {
  try {
    fsSync.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fsSync.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.log(`[nav] 落盘失败: ${err?.message}`);
  }
}

/** 推送前自愈：current/cwd 失效（目录被删/盘符没了）→ 沿父链上溯，再不行置 null */
async function sanitize() {
  state.current = state.current ? await nearestExistingDir(state.current) : null;
  state.cwd = state.cwd ? await nearestExistingDir(state.cwd) : null;
}

// ── Watcher：盯 current（depth 0），来啥推啥，单条直发 ───────────────────────

let watcher = null;
let knownNames = new Set(); // current 当前条目名（判 add/change 用，dotfile 不进列表故不盯）

function closeWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    knownNames = new Set();
  }
}

async function switchWatcher(bus) {
  closeWatcher();
  if (!state.current) return;
  try {
    knownNames = new Set((await listDir(state.current)).map((i) => i.name));
  } catch {
    knownNames = new Set();
  }
  try {
    watcher = fsSync.watch(state.current, { persistent: true }, (_event, filename) => {
      if (!filename || filename.startsWith(".")) return; // dotfile 不进列表，动了也不推
      handleWatchEvent(bus, String(filename));
    });
    watcher.on("error", (err) => {
      console.log(`[nav] watch ${state.current} 出错: ${err?.message}`);
      closeWatcher(); // 目录可能被删/盘符被拔：下次 nav.state 自愈后会重挂
    });
  } catch (err) {
    console.log(`[nav] watch ${state.current} 挂载失败: ${err?.message}`);
  }
}

async function handleWatchEvent(bus, name) {
  const abs = path.join(state.current, name);
  const isDirNow = await isDir(abs);
  if (isDirNow || (await existsAny(abs))) {
    // 存在：老名字 → change，新名字 → add（addDir 也归 add）
    const type = isDirNow ? "directory" : "file";
    const wasKnown = knownNames.has(name);
    knownNames.add(name);
    bus.emit(
      "nav.update",
      { [wasKnown ? "change" : "add"]: { type, name, abs_path: abs } },
      { net: true }
    );
  } else {
    // 不存在：删除（unlink / unlinkDir）
    knownNames.delete(name);
    bus.emit("nav.update", { remove: { abs_path: abs } }, { net: true });
  }
}

// ── 全量推送 ──────────────────────────────────────────────────────────────────

async function pushState(bus) {
  await sanitize();
  let items = [];
  if (state.current) {
    try {
      items = await listDir(state.current);
    } catch {
      items = []; // 权限等读不了：给空列表，前端可导航离开
    }
  } else {
    items = await listRoots();
  }
  bus.emit("nav.state", { current: state.current, cwd: state.cwd, items }, { net: true });
}

// ── 安装：注册协议 + 旁听焦点事件 + 连接即推 ────────────────────────────────

export function installNavService(bus) {
  loadState();

  // 通用原语：任何组件要"某个目录的内容"（DirPicker 临时浏览/手动刷新）用
  bus.on("fs.list", async (p) => {
    const pathStr = p?.path ? String(p.path) : "";
    if (!pathStr || pathStr === "/" || pathStr === "\\") return { items: await listRoots() };
    return { items: await listDir(pathStr) };
  });

  // DirPicker 起点：桌面目录（不存在则主目录兜底）
  bus.on("fs.desktop", async () => ({ desktop: await getDesktop() }));

  // @ 文件引用补全：在「当前 Agent 空间」（= 焦点 session 的 cwd，nav 旁听 chat.sync 维护）里搜文件/目录。
  // 无 cwd（没打开任何 Session）直接抛错 → 前端面板不弹（@ 在没 Agent 空间时没意义）。
  bus.on("fs.search", async (p) => {
    const root = state.cwd;
    if (!root || !(await isDir(root))) throw new Error("当前没有 Agent 空间（先打开一个 Session）");
    const query = String(p?.query ?? "");
    // 硬上限 200：二次池随打随拉，前端只要前 20 条；给个闸防有人拿它当全量导出接口
    const limit = Math.max(1, Math.min(Number(p?.limit) || 20, 200));
    return { cwd: root, items: searchEntries(await indexOf(root), query, limit, p?.dirs !== false) };
  });

  // ── FS 写侧：纯事件无回执，过闸才动手；成功后一律补推 nav.state 全量（watcher 盲区兜底） ──

  // 新建：前端把它看到的目录（parent）+ 名字发来，服务端拼接——不依赖共享 current，多终端无歧义
  bus.on("fs.create", async (p) => {
    const parent = p?.parent ? path.resolve(String(p.parent)) : "";
    const name = String(p?.name ?? "").trim();
    if (!parent || badName(name) || name.startsWith(".")) return; // 隐身文件建出来列表不可见，拒
    const target = path.join(parent, name);
    if (await existsAny(target)) {
      console.log(`[fs] create 跳过（已存在不覆盖）: ${target}`);
      return;
    }
    try {
      if (p.dir) await fs.mkdir(target, { recursive: true });
      else await fs.writeFile(target, "", "utf-8");
      console.log(`[fs] create ${p.dir ? "dir" : "file"}: ${target}`);
      invalidateIndex();
      await pushState(bus);
    } catch (err) {
      console.log(`[fs] create 失败 ${target}: ${err?.message}`);
    }
  });

  bus.on("fs.rename", async (p) => {
    const from = p?.path ? path.resolve(String(p.path)) : "";
    const newName = String(p?.newName ?? "").trim();
    if (!from || badName(newName) || newName.startsWith(".")) return;
    if (!(await existsAny(from))) return;
    const to = path.join(path.dirname(from), newName);
    // 纯换大小写（normKey 相等但字面不同）放行；其余同名冲突拒
    if (normKey(to) !== normKey(from) && (await existsAny(to))) {
      console.log(`[fs] rename 跳过（目标已存在）: ${to}`);
      return;
    }
    if (normKey(to) === normKey(from) && to === from) return; // 没改名
    if (isProtected(from) || isProtected(to)) {
      console.log(`[fs] rename 拒绝（受保护目录本体）: ${from}`);
      return;
    }
    try {
      await fs.rename(from, to);
      console.log(`[fs] rename: ${from} → ${to}`);
      invalidateIndex();
      await pushState(bus);
    } catch (err) {
      console.log(`[fs] rename 失败 ${from}: ${err?.message}`);
    }
  });

  bus.on("fs.delete", async (p) => {
    const target = p?.path ? path.resolve(String(p.path)) : "";
    if (!target || !(await existsAny(target))) return;
    if (isRootLike(target) || isProtected(target)) {
      console.log(`[fs] delete 拒绝（根/受保护目录）: ${target}`);
      return;
    }
    try {
      await fs.rm(target, { recursive: true, force: false, maxRetries: 2 }); // 永久删除、递归，已拍板
      console.log(`[fs] delete: ${target}`);
      invalidateIndex();
      await pushState(bus);
    } catch (err) {
      console.log(`[fs] delete 失败 ${target}: ${err?.message}`);
    }
  });

  bus.on("fs.move", async (p) => {
    const from = p?.path ? path.resolve(String(p.path)) : "";
    const toDir = p?.toDir ? path.resolve(String(p.toDir)) : "";
    if (!from || !toDir || !(await existsAny(from))) return;
    if (!(await isDir(toDir))) {
      console.log(`[fs] move 跳过（目标不是目录）: ${toDir}`);
      return;
    }
    if (isRootLike(from) || isProtected(from)) {
      console.log(`[fs] move 拒绝（根/受保护目录）: ${from}`);
      return;
    }
    const fromKey = normKey(from);
    const toKey = normKey(toDir);
    if (toKey === fromKey || toKey.startsWith(fromKey + path.sep.toLowerCase())) {
      console.log(`[fs] move 拒绝（目录移进自己/自己的子孙）: ${from} → ${toDir}`);
      return;
    }
    const to = path.join(toDir, path.basename(from));
    if (normKey(to) === fromKey) return; // 同目录原地，无意义
    if (await nameClash(toDir, path.basename(from))) {
      console.log(`[fs] move 跳过（目标目录已有同名）: ${to}`);
      return;
    }
    try {
      await fs.rename(from, to);
      console.log(`[fs] move: ${from} → ${to}`);
      invalidateIndex();
      await pushState(bus);
    } catch (err) {
      // 跨盘 = EXDEV：v1 不做 copy+delete 兜底（已拍板报错跳过）
      console.log(`[fs] move 失败${err?.code === "EXDEV" ? "（跨盘不支持，请复制后新建）" : ""} ${from}: ${err?.message}`);
    }
  });

  // current 唯一手动改口：换浏览位置
  bus.on("nav.open", async (p) => {
    const target = p?.current ? String(p.current).trim() : "";
    if (!target) {
      state.current = null; // 回"此电脑"
    } else if (!(await isDir(target))) {
      throw new Error(`不是目录或不存在: ${target}`);
    } else {
      state.current = target;
    }
    saveState();
    await switchWatcher(bus);
    await pushState(bus);
    return { ok: true };
  });

  // cwd 没有写口：旁听 agent 焦点帧联动。切到不同 cwd 的 session → cwd/current 齐跳 + 推送
  // （agent.chat.sync 只在 连接 / open / 状态变化 时推；cwd 字段只出现在 连接 / open 的全量帧里）
  bus.on("agent.chat.sync", async (p) => {
    if (!p || !("cwd" in p)) return; // 局部帧（status/steers/…）不带 cwd → 不是换焦点
    const cwd = p.cwd ? String(p.cwd) : "";
    if (!cwd || !(await isDir(cwd))) return; // 焦点被清（activeId:null → cwd:null）不动 nav 现场
    if (cwd === state.cwd && cwd === state.current) return; // 同 cwd 内换 session：现场没变，不推
    const currentMoved = cwd !== state.current;
    state.cwd = cwd;
    if (currentMoved) {
      state.current = cwd;
      await switchWatcher(bus);
    }
    saveState();
    await pushState(bus);
  });

  // 连接建立即推全量 = 恢复现场（终端切换无缝；无需前端请求，也无需 nav.get）
  bus.on("$conn.open", async () => {
    await switchWatcher(bus); // 重启后重新挂上（sanitize 可能已把 current 自愈/清空）
    await pushState(bus);
  });

  console.log("[nav] 目录导航 + FS 操作服务已装（state 持久于 data/nav-state.json）");
}
