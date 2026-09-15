import "dotenv/config";

export const config = {
  // 端口：dev 由 dev script 用 cross-env 强制 3001（已存在的 env 不被 .env 覆盖）；默认 3000 供生产 start / 无 .env 兜底
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET,
  // 登录密码（明文，只在 .env 里自己用；不要进版本库）
  password: process.env.PASSWORD,
  tokenTtl: process.env.TOKEN_TTL || "7d",
  // 终端守护进程 termd 的端口（仅 loopback）：chamber 拉起 termd 时**显式传给它**（--port）。
  // termd 自己不读 env —— 端口来源唯一，就是这里。CLI（pnpm termd）要一致请用 `--port` 显式指定。
  termdPort: Number(process.env.TERMD_PORT) || 3002,
  // 语音识别（按住说话）：阿里 DashScope 流式 asr，未配则 STT 不可用（不拦服务启动）
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || "",
  // 语音合成（朗读）：TTS 域配置（与 STT 共用一把 DASHSCOPE_API_KEY）
  tts: {
    model: process.env.TTS_MODEL || "qwen-audio-3.0-tts-flash",
    voice: process.env.TTS_VOICE || "longanlingxi",
    sampleRate: Number(process.env.TTS_SAMPLE_RATE) || 22050,
    rate: Number(process.env.TTS_RATE) || 1.0, // 语速 [0.5,2]；前端每次 speak 可覆盖（下个会话生效）
  },
};

if (!config.jwtSecret || !config.password) {
  console.error("缺少 JWT_SECRET 或 PASSWORD（见 packages/server/.env.example）");
  process.exit(1);
}
