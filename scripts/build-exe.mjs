// 把 pi-chamber 打成**一个 exe**。
//
//   pnpm build:exe      →  build/dist/pi-chamber.exe
//
// ★ build/ 是**纯产物目录**（整个 gitignore）：gen/ 生成物 · out/ 中间件 · dist/ 成品。
//   构建源码在本目录（scripts/）：build-exe.mjs 构建脚本 · sea-entry.mjs exe 入口。
//
// 干五件事：
//   ① 构建前端（vite）                       → packages/web/dist
//   ② 收集要打进 exe 的资产（前端 dist + node-pty 整个平台包）
//   ③ 打包后端（rolldown：源码 + 全部依赖 → 单文件）
//   ④ 合成 exe（Node SEA：node.exe + 上面那个单文件 + 资产）
//   ⑤ 换图标（SEA 产物是 node.exe 的副本，图标还是 Node 的绿标，得事后改 PE 资源）
//
// ★ 为什么要打成一个 exe 而不是"exe + 一堆文件"：
//   运行时闭包有 13700+ 个文件，Windows Defender 逐个扫会让安装/启动都慢得难受。
//   打完之后只有 1 个文件。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { rolldown } from "rolldown";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "sea-entry.mjs"); // exe 入口（源码）
const ICON = path.join(ROOT, "pic", "pi-chamber.ico"); // exe 图标（手维资源，非生成物）
const BUILD = path.join(ROOT, "build"); // ★ 纯产物目录，整个 gitignore
const GEN = path.join(BUILD, "gen");
const OUT = path.join(BUILD, "out");
const DIST = path.join(BUILD, "dist");
const EXE = path.join(DIST, "pi-chamber.exe");

// node-pty 的平台包（预编译二进制按平台分包）
const PTY_PKG = `@lydell/node-pty-${process.platform}-${process.arch}`;
// 调试符号（.pdb 有 10 MB）和 sourcemap 不进包
const SKIP = /\.(pdb|map)$/i;

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** 列出目录下所有文件，返回相对路径（正斜杠） */
function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

// ───────────────────────── ① 前端 ─────────────────────────
step(1, "构建前端");
execFileSync("pnpm", ["--dir", "packages/web", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
const webDist = path.join(ROOT, "packages", "web", "dist");
if (!fs.existsSync(webDist)) throw new Error(`前端没构建出来：${webDist}`);

// ───────────────────────── ② 收集资产 ─────────────────────────
step(2, "收集要打进 exe 的资产");
const assets = [];
for (const rel of walk(webDist)) {
  assets.push({ key: `web/${rel}`, from: path.join(webDist, rel) });
}
for (const pkg of ["@lydell/node-pty", PTY_PKG]) {
  const src = path.join(ROOT, "node_modules", pkg);
  if (!fs.existsSync(src)) throw new Error(`找不到 ${pkg}（pnpm install 装了吗？）`);
  for (const rel of walk(src)) {
    if (SKIP.test(rel)) continue;
    assets.push({ key: `native/node_modules/${pkg}/${rel}`, from: path.join(src, rel) });
  }
}
const assetBytes = assets.reduce((n, a) => n + fs.statSync(a.from).size, 0);
console.log(`      ${assets.length} 个文件 / ${mb(assetBytes)}`);

// 资产清单喂给入口（入口按这份清单解压；BUILD_ID 变了就重解压）
fs.mkdirSync(GEN, { recursive: true });
const buildId = Date.now().toString(36);
fs.writeFileSync(
  path.join(GEN, "assets.js"),
  `// 由 scripts/build-exe.mjs 生成，勿手改。\n` +
    `export const BUILD_ID = ${JSON.stringify(buildId)};\n` +
    `export const ASSET_FILES = ${JSON.stringify(assets.map((a) => a.key), null, 2)};\n`
);

// ───────────────────────── ③ 打包后端 ─────────────────────────
step(3, "打包后端（rolldown）");
const t0 = Date.now();
const bundle = await rolldown({
  input: ENTRY,
  platform: "node",
  // 原生模块留外面：它由入口解压到磁盘后 require，不进 JS bundle（见 termd/src/pty-loader.js）
  external: [/^@lydell\/node-pty/],
});
fs.mkdirSync(OUT, { recursive: true });
const mainJs = path.join(OUT, "sea-entry.mjs");
await bundle.write({ file: mainJs, format: "esm", codeSplitting: false });
console.log(`      ${mb(fs.statSync(mainJs).size)} / ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ───────────────────────── ④ 合成 exe ─────────────────────────
step(4, "合成 exe（Node SEA）");
const seaConfig = path.join(OUT, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: mainJs,
      output: EXE,
      disableExperimentalSEAWarning: true,
      mainFormat: "module",
      useCodeCache: false, // 开了它动态 import() 会抛
      useSnapshot: false,
      assets: Object.fromEntries(assets.map((a) => [a.key, a.from])),
    },
    null,
    2
  )
);
fs.mkdirSync(DIST, { recursive: true });
await freeOldExe();
execFileSync(process.execPath, [`--build-sea=${seaConfig}`], { cwd: ROOT, stdio: "inherit" });

// ───────────────────────── ⑤ 图标 ─────────────────────────
step(5, "换 exe 图标");
applyIcon(EXE, ICON);
console.log(`      ${path.relative(ROOT, ICON)}`);

console.log(`\n✅ 产出：${path.relative(ROOT, EXE)}  ${mb(fs.statSync(EXE).size)}`);
console.log(`   双击它即可启动（会打印访问地址）；终端里的东西由独立进程持有，关窗口不会丢。`);

/**
 * 把上一版 exe 删掉（SEA 要求输出文件不存在）。
 *
 * 被占用是常态：上一版可能还在跑。★ 注意 **termd 也是同一个 exe 名**（`--termd` 模式）——
 * 关掉黑框只带走 chamber，termd 是脱离进程、会继续把文件锁住。所以这里直接全杀。
 */
async function freeOldExe() {
  try {
    fs.rmSync(EXE, { force: true });
    return;
  } catch {
    // 被占用，往下走
  }
  console.log("      旧 exe 被占用（上一版还在跑？），先结束残留进程…");
  try {
    execFileSync("taskkill", ["/IM", "pi-chamber.exe", "/F"], { stdio: "ignore" });
  } catch {
    // 没有残留进程时 taskkill 会报错，忽略
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      fs.rmSync(EXE, { force: true });
      return;
    } catch {
      // 还没释放，接着等
    }
  }
  throw new Error(
    `删不掉 ${path.relative(ROOT, EXE)}：它还被别的进程占用。\n` +
      `  请在任务管理器里结束所有 pi-chamber.exe 再重试。`
  );
}

/**
 * 把 pi-chamber.ico 写进 exe。
 *
 * 顺序不能反：必须**先合成 exe**（SEA blob 作为一条资源写进去），再换图标 ——
 * 这里只替换图标那几条资源，其余（含 type=10 的 NODE_SEA_BLOB）原样保留。
 * 图标组位置沿用 node.exe 的（id=1 / lang=1033）。
 */
function applyIcon(exePath, icoPath) {
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const ico = Data.IconFile.from(fs.readFileSync(icoPath));
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    ico.icons.map((i) => i.data)
  );
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}
