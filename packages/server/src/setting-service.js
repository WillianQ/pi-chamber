// Setting 域（chamber 侧）：把 setting.js 那份"全局设置"接上总线。
//
// 边界（重要）：**本文件只说两件事** ——
//   ① 收前端的 setting.update（emit，无回执）→ 落盘 → 推真值
//   ② 连接时推全量（$conn.open）
// 存储归 setting.js（读盘/校验/原子写），本文件不碰文件。
//
// 线协议（两条都是 emit，按 AGENTS.md 4.2 的裸名约定）：
//   emit(w→s) setting.update { 变化的字段 }   前端改了任意设置项；**无回执**
//   emit(s→w) setting.sync   { 全量设置 }     连接时 + 每次变更后；**剔掉 jwtSecret / password**
//   emit(s→w) setting.notice { type, message } 保存失败时（真值已由随后的 sync 回滚）
//
// ★ 为什么失败要补发 sync：setting.update 是 emit（无回执），前端无从知道成没成。
//   按"每条上行帧都要有结束帧"的纪律 → 失败 = 推旧真值（前端自动回滚）+ notice 说明原因。
//
// ★ 为什么 sync 不带 jwtSecret / password：签名密钥下发 = 谁都能自己签 token；
//   密码前端只需要"设置"、不需要"读到"（见 setting.js 的 toWire）。
import { log, logErr } from "./log.js";
import { get, toWire, update } from "./setting.js";

/** 下发当前设置真值（$conn.open / 每次变更后）。
 *  ★ 载荷口径锁在这一处：**只能走 toWire()** —— 写成 get() 会把 jwtSecret / password 发给前端。 */
function pushSettings(bus) {
  bus.emit("setting.sync", toWire(), { net: true });
}

export function installSettingService(bus) {
  // 前端改设置：落盘 → 成功推真值；失败推旧真值（回滚）+ notice
  // （不加 meta.from==="wire" 闸：服务端自己从不 emit setting.update，没有自收自发的环）
  bus.on("setting.update", (patch) => {
    try {
      update(patch);
      pushSettings(bus);
    } catch (err) {
      logErr("[setting] 保存失败:", err?.message ?? err);
      pushSettings(bus); // 前端拿到的是旧真值 → 自动回滚 UI
      bus.emit(
        "setting.notice",
        { type: "error", message: `保存失败：${err?.message ?? err}` },
        { net: true }
      );
    }
  });

  // 连接 / 重连：推全量（前端据此渲染设置页、决定语音按钮显不显）
  bus.on("$conn.open", () => {
    const s = get();
    log(
      `[setting] 下发设置（tts=${s.tts.enabled ? "开" : "关"} stt=${s.stt.enabled ? "开" : "关"}）`
    );
    pushSettings(bus);
  });
}
