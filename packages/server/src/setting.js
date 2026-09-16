// setting.js —— pi-chamber 全局设置：唯一真相 + 落盘 + 首次生成
//
// 文件：<PI_CHAMBER_HOME>/pi-chamber-global-setting.json
//       默认 <PI_CHAMBER_HOME> = ~/.pi/pi-chamber（打包版由入口注入；dev 不设 → 走这个默认值）
//       环境变量 PI_CHAMBER_SETTING 可覆盖路径 —— 冒烟/测试隔离用（否则跑一次测试就把生产密码改了）
//       （老版本放在 ~/.pi/pi-chamber-global-setting.json，首次运行自动搬过来，见 migrateLegacyFile）
//
// 纪律（改本文件前先读）：
//   ① 本文件是**纯存储层**：读盘 / 生成默认值 / 原子写盘。**不碰 bus** —— 广播归 setting-service.js。
//   ② 消费者一律**现读** get().xxx。设置只在"前端推着走"时才被读，只有 port / termdPort 例外
//      （启动时读一次 —— 服务要 listen、要拉起 termd；改了要重启后端，用户自己重启）。
//   ③ 只有白名单字段能进文件：前端乱塞的脏字段直接丢，不落盘。
//   ④ 原子写：写临时文件再 rename —— 断电写一半不能把用户密码弄丢。
//
// 字段（这就是全部；加字段要同时改 DEFAULT / FIELD / toWire 三处）：
//   password   登录密码（明文；**不下发前端**，前端只能"设置"）
//   jwtSecret  JWT 签名密钥（自动生成；**永不下发**）
//   port       HTTP/WS 端口（启动时读；改了要重启后端）
//   termdPort  终端守护端口（启动时读；改了要重启后端）
//   tts        { enabled, dashscopeApiKey, voice, rate }  —— 朗读
//   stt        { enabled, dashscopeApiKey }               —— 识别
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PI_DIR = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");
const FILE =
  process.env.PI_CHAMBER_SETTING || path.join(PI_DIR, "pi-chamber-global-setting.json");

/**
 * 一次性迁移：老版本把设置文件直接放 ~/.pi/ 下（没有 pi-chamber 子目录）。
 * 不搬的话用户的密码 / jwtSecret 会凭空消失（被当成首次运行、重生成默认值）。
 * 只在没设 PI_CHAMBER_SETTING（= 测试/冒烟隔离）时动手。
 */
function migrateLegacyFile() {
  if (process.env.PI_CHAMBER_SETTING) return;
  const legacy = path.join(os.homedir(), ".pi", "pi-chamber-global-setting.json");
  try {
    if (fs.existsSync(FILE) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.renameSync(legacy, FILE);
    console.log(`[setting] 设置文件已迁移：${legacy} → ${FILE}`);
  } catch {}
}

migrateLegacyFile();

/** 首次生成时的默认密码 —— 必须让用户知道（启动时控制台打印），且公网暴露前必须改 */
export const DEFAULT_PASSWORD = "demo123456";

/** 默认值（首次启动 / 字段缺失时的兜底）。tts.voice 是百炼系统音色名 */
function defaults() {
  return {
    version: 1,
    password: null, // null = 待生成
    jwtSecret: null, // null = 待生成
    port: 3000,
    termdPort: 3002,
    tts: { enabled: false, dashscopeApiKey: null, voice: "longanhuan_v3.6", rate: 1.0 },
    stt: { enabled: false, dashscopeApiKey: null },
  };
}

// —— 内存缓存（进程内唯一真值；改完立刻同步，读永远拿最新的）——
let cache = null;

/**
 * 环境变量覆盖 —— **只认 PORT**（dev 用 `cross-env PORT=3001`；生产没有这个变量）。
 * ★ 绝不覆盖 password / jwtSecret：机器上任何同名环境变量都会静默顶掉设置文件（踩过：
 *   这个 shell 里就有从 .env 漏进来的 PASSWORD / JWT_SECRET，一覆盖就把用户的密码吃了）。
 * ★ 覆盖值只作用于 get()，**永不落盘**（否则 dev 的 3001 会被写进生产配置文件）。
 */
function portOverride() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

// —— 校验：非法值一律 throw（由 setting-service 转成 notice 推给前端）——
function assertValid(patch) {
  if ("password" in patch) {
    const v = patch.password;
    if (typeof v !== "string" || !v.trim()) throw new Error("密码不能为空");
    if (v.length > 200) throw new Error("密码过长");
  }
  if ("jwtSecret" in patch) {
    // 前端永不改这个；留口子只为测试/迁移
    if (typeof patch.jwtSecret !== "string" || !patch.jwtSecret) throw new Error("jwtSecret 非法");
  }
  for (const k of ["port", "termdPort"]) {
    if (k in patch) {
      const v = patch[k];
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`${k} 必须是 1~65535 的整数`);
    }
  }
  for (const k of ["tts", "stt"]) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${k} 必须是一个对象`);
    if ("enabled" in v && typeof v.enabled !== "boolean") throw new Error(`${k}.enabled 必须是布尔值`);
    if ("dashscopeApiKey" in v) {
      const key = v.dashscopeApiKey;
      if (key !== null && typeof key !== "string") throw new Error(`${k}.dashscopeApiKey 必须是字符串或 null`);
    }
    if (k === "tts") {
      if ("voice" in v && (typeof v.voice !== "string" || !v.voice.trim()))
        throw new Error("tts.voice 不能为空");
      if ("rate" in v) {
        const r = v.rate;
        if (typeof r !== "number" || !Number.isFinite(r) || r < 0.5 || r > 2)
          throw new Error("tts.rate 必须在 0.5 ~ 2.0 之间");
      }
    }
  }
}

/** 白名单深合并：只认已知字段，其余丢弃。返回新对象（不动入参） */
function merge(base, patch) {
  const out = {
    version: base.version,
    password: base.password,
    jwtSecret: base.jwtSecret,
    port: base.port,
    termdPort: base.termdPort,
    tts: { ...base.tts },
    stt: { ...base.stt },
  };
  if (typeof patch !== "object" || patch === null) return out;
  for (const k of ["password", "jwtSecret", "port", "termdPort"]) {
    if (k in patch) out[k] = patch[k];
  }
  for (const k of ["tts", "stt"]) {
    if (!(k in patch)) continue;
    const src = patch[k];
    if (typeof src !== "object" || src === null) continue;
    for (const f of Object.keys(out[k])) {
      if (f in src) out[k][f] = src[f];
    }
  }
  return out;
}

/** 读盘 → 合并默认值（脏文件也不崩：解析失败就当空文件，用默认值重来） */
function readFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return merge(defaults(), raw);
  } catch {
    return null; // 不存在 / 解析失败 → 调用方决定生成
  }
}

/** 原子写：临时文件 + rename。目录不存在就先建 */
function writeToDisk(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE); // Windows 上也是覆盖语义（Node 用 MOVEFILE_REPLACE_EXISTING）
  try {
    fs.chmodSync(FILE, 0o600); // Windows/NTFS 上基本无效，Linux/macOS 上生效；失败不拦
  } catch {}
}

/**
 * 启动时调一次：读盘 → 补生成的字段 → 落盘。
 * 返回是否新建了文件（调用方据此决定要不要把默认密码打印出来告诉用户）。
 */
export function init() {
  const fromDisk = readFromDisk();
  cache = fromDisk ?? defaults();

  let generated = false;
  if (!cache.jwtSecret) {
    cache.jwtSecret = crypto.randomBytes(32).toString("hex");
    generated = true;
  }
  const freshPassword = !cache.password;
  if (freshPassword) {
    cache.password = DEFAULT_PASSWORD;
    generated = true;
  }

  if (!fromDisk || generated) writeToDisk(cache);
  return { freshPassword, freshFile: !fromDisk, file: FILE };
}

/** 全量只读快照（浅拷贝，防止调用方改到内部缓存）。PORT 环境变量在此生效（不落盘） */
export function get() {
  if (!cache) init();
  const port = portOverride();
  return {
    ...cache,
    ...(port === undefined ? {} : { port }),
    tts: { ...cache.tts },
    stt: { ...cache.stt },
  };
}

/**
 * 合并 + 校验 + 原子落盘。非法值 throw（不落盘、不改内存）。
 * ★ 不负责广播 —— 广播归 setting-service.js（它收到 setting.update 才调这里）。
 */
export function update(patch) {
  if (!cache) init();
  const next = merge(cache, patch);
  assertValid(patch);
  writeToDisk(next);
  cache = next;
  return get();
}

/** 下发前端的版本：剔掉 jwtSecret（签名密钥）与 password（前端只能"设置"，不该读到） */
export function toWire() {
  const s = get();
  return {
    version: s.version,
    port: s.port,
    termdPort: s.termdPort,
    tts: { ...s.tts },
    stt: { ...s.stt },
  };
}

/** 配置文件绝对路径（日志/报错用） */
export function filePath() {
  return FILE;
}
