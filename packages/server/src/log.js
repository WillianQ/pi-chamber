// 统一日志出口（服务端唯一）。四件事：
//  ① 前台**始终**打印（与写不写盘无关）；
//  ② 文件日志**只在 dev**（`LOG=1`，dev script 注入；start / bg / exe 都没有这个变量）；
//  ③ 启动即清空（记的是"本轮运行"）；
//  ④ 输出里的 base64 只留前 10 字符（终端 + 文件都削），整行还有长度上限。
//
// 做法：给 console.log/error/warn 挂一层薄 patch —— 业务代码调 log()，第三方（express / ws /
// pi SDK）调 console.*，**同一条路**：削一遍 → 打印 → （dev）写盘。所以：
//  - 全仓只有本文件出现 console（那三行 bind 原始函数，patch 时用它打印，不递归）；
//  - 谁都不用 import fs / 关心日志落哪，`log()` 就是个打印。
//
// 路径从**文件位置**算，不依赖 cwd（旧实现用 resolve("logs",…) 相对 cwd，在仓库根留过僵尸日志）；
// 打包版由入口注入 PI_CHAMBER_HOME（exe 里 import.meta.url 指向 exe 自己，"往上三层"会跑到 exe 外）。
// LOG_FILE 可覆盖 —— e2e 测试用它指到临时目录，免得清掉 dev 正在写的那份。
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LOG_DIR = process.env.PI_CHAMBER_HOME
  ? join(process.env.PI_CHAMBER_HOME, "logs")
  : join(ROOT, "logs");
const LOG_FILE = process.env.LOG_FILE ? resolve(process.env.LOG_FILE) : join(LOG_DIR, "server.log");
const DISK = process.env.LOG === "1";

if (DISK) {
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await writeFile(LOG_FILE, "");
}

// —— 脱敏：base64 → 前 10 字符 ——
// 判据：长度 ≥ 64 且整段都是 base64 字符集。图片（~150KB）与音频块（几 KB）必然命中；
// 普通文本/路径/中文不会（它们含空格、点、斜杠以外的分隔符或非 ASCII）。
const B64 = /[A-Za-z0-9+/=_-]{64,}/g;
const MAX_LINE = 4000; // 单行上限：chat.sync 首屏这类大帧不至于把日志撑爆

function scrub(s) {
  const t = s.replace(B64, (m) => `${m.slice(0, 10)}…(${m.length} 字符)`);
  return t.length <= MAX_LINE ? t : `${t.slice(0, MAX_LINE)}…(共 ${t.length} 字符)`;
}

/** 写进文件那一份：字符串原样、Error 取 stack、其它 JSON 化（循环引用退回 String） */
function toText(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const orig = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function emit(level, args) {
  // 终端那一份：字符串削一下（否则 base64 刷屏），对象原样（保住 devtools 的富展示）
  const shown = args.map((a) => (typeof a === "string" ? scrub(a) : a));
  orig[level](...shown);
  if (!DISK) return;
  // 文件那一份：全量文本化后再削一遍（对象里藏的 base64 也跑不掉；已是纯文本的削是幂等的）
  const line = scrub(shown.map(toText).join(" "));
  // 串成一条链：异步写不阻塞事件循环，但**顺序**跟调用顺序一致（裸 appendFile 并发会乱序）；写失败只忽略
  queue = queue.then(() => appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`)).catch(() => {});
}
let queue = Promise.resolve();

console.log = (...a) => emit("log", a);
console.error = (...a) => emit("error", a);
console.warn = (...a) => emit("warn", a);

// 业务代码统一用这三个（都是薄包装：patch 在上面，削 + 写盘全在 emit 里）
export const log = (...a) => console.log(...a);
export const logErr = (...a) => console.error(...a);
export const logWarn = (...a) => console.warn(...a);
