// 冒烟脚本共用的登录凭据 —— 从**设置文件**读（不再有 .env，也不看环境变量）。
//
// 路径规则与 server 完全一致：PI_CHAMBER_SETTING 可覆盖（测试隔离），否则
// <PI_CHAMBER_HOME>/pi-chamber-global-setting.json（默认 ~/.pi/pi-chamber/…；
// 老位置 ~/.pi/ 下作为只读兜底）。两处都写死一份是有意的 —— 冒烟脚本不该 import
// server 的 src（那会把整个服务端依赖树拖进来，而且 init() 会顺手建文件）。
//
// 用法：
//   const token = await getToken(BASE, jwt);   // 先试密码登录，失败/无密码就自签
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE = process.env.PI_CHAMBER_SETTING || defaultSettingFile();

/** 默认位置 = ~/.pi/pi-chamber/…；老位置（~/.pi/ 下）只在新的还没生成时兜底 */
function defaultSettingFile() {
  const dir = process.env.PI_CHAMBER_HOME || path.join(os.homedir(), ".pi", "pi-chamber");
  const now = path.join(dir, "pi-chamber-global-setting.json");
  const legacy = path.join(os.homedir(), ".pi", "pi-chamber-global-setting.json");
  try {
    if (!fs.existsSync(now) && fs.existsSync(legacy)) return legacy;
  } catch {}
  return now;
}

export function settingFile() {
  return FILE;
}

/** 读设置文件（读不到返回 null —— 调用方自己决定怎么报错） */
export function readSetting() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** 直接用 jwtSecret 本地签一个 token（不登录、不打网络）—— 前端 store 冒烟用 */
export function selfSign(jwt, ttl = "10m") {
  const s = readSetting();
  if (!s?.jwtSecret) {
    console.error(`读不到 jwtSecret：${FILE}（先启动一次后端生成它）`);
    process.exit(1);
  }
  return jwt.sign({ sub: "owner" }, s.jwtSecret, { expiresIn: ttl });
}

/** 拿一个能连 WS 的 token：先试密码登录；失败/无密码就走 jwtSecret 自签 */
export async function getToken(base, jwt) {
  const s = readSetting();
  if (!s) {
    console.error(`读不到设置文件：${FILE}\n（先启动一次后端生成它，或用 PI_CHAMBER_SETTING 指一个）`);
    process.exit(1);
  }
  if (s.password) {
    try {
      const r = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: s.password }),
      });
      const t = (await r.json())?.token;
      if (t) return t;
    } catch {}
  }
  if (!s.jwtSecret) {
    console.error(`设置文件里没有 jwtSecret：${FILE}`);
    process.exit(1);
  }
  console.log("（用 jwtSecret 自签 token）");
  return jwt.sign({ sub: "owner" }, s.jwtSecret, { expiresIn: "10m" });
}
