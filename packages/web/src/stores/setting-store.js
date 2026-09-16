// 全局设置 store：密码 / 端口 / 语音（朗读 + 识别）
//
// 两条帧（emit，无回执 —— 见 AGENTS.md 4.2）：
//   setting.sync   { port, termdPort, tts:{enabled,dashscopeApiKey,voice,rate}, stt:{...} }
//                  ← 连接时 + 每次变更后。**剔掉了 password / jwtSecret**（服务端私有）
//   setting.notice { type:"error", message }   ← 保存失败（真值已由随后的 sync 回滚）
//
// 前端只做两件事：把 sync 存下来（谁要谁读）+ 把改动 emit 上去。
// ★ 没有本地乐观更新：改完等服务端 sync 回来才是真值（失败会自动回滚成旧值）。
//
// 谁在读：
//   - 设置页：渲染当前值
//   - tts-store：rate / voice / enabled（朗读参数以服务端为准，不再存 localStorage）
//   - InputBox / MessageList：enabled 决定语音按钮显不显
import { create } from "zustand";
import { bus } from "../bus.js";

export const useSettingStore = create(() => ({
  setting: null, // null = 还没收到 setting.sync（连接前）。形状见文件头
  notice: null, // { type, message } 保存失败提示
}));

/** 当前设置（未连接时给一份保守默认，免得消费方到处判空） */
export function currentSetting() {
  return (
    useSettingStore.getState().setting ?? {
      port: 3000,
      termdPort: 3002,
      tts: { enabled: false, dashscopeApiKey: null, voice: "longanhuan_3.6", rate: 1 },
      stt: { enabled: false, dashscopeApiKey: null },
    }
  );
}

export const settingActions = {
  /** 改设置：只发变化的字段（服务端做白名单合并）。无回执 —— 结果靠 setting.sync 回来 */
  update(patch) {
    bus.emit("setting.update", patch, { net: true });
  },
  clearNotice() {
    useSettingStore.setState({ notice: null });
  },
};

bus.on("setting.sync", (p) => {
  if (!p) return;
  useSettingStore.setState({ setting: p });
});

bus.on("setting.notice", (p) => {
  useSettingStore.setState({ notice: p ?? null });
});
