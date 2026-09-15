import "./logger.js"; // 必须最先引入：接管 console 输出到日志文件
import http from "node:http";
import { config } from "./config.js";
import app from "./app.js";
import { attachWs, installUpgradeAuth } from "./ws.js";
import { bus } from "./bus.js";
import { installAgentService } from "./agent-service/index.js";
import { installNavService } from "./nav-service.js";
import { installEditorService } from "./editor-service.js";
import { installSttService } from "./stt-service.js";
import { installTtsService } from "./tts-service.js";
import { installTermService } from "./term-service.js";

// —— 业务 handler：启动时注册一次，与进程同寿（bus 是单例，不再关心是谁的连接）——
bus.on("$conn.open", (p) => {
  // 对端上线 → 回一份欢迎（net=true 上网；本地也会广播一份，无害）
  bus.emit("conn.welcome", { at: p.at, from: "server" }, { net: true });
});
bus.on("echo", (payload, meta) => {
  // 收到 echo 事件 → 回推 echo.reply（示例：通知类往返）
  bus.emit("echo.reply", { echo: payload, viaWire: meta.net }, { net: true });
});
bus.on("ping", async (payload) => {
  // 问答示例：request("ping", ..., {net:true}) 的响应端，返回值即回执 data
  return { pong: Date.now(), you: payload ?? null };
});
bus.on("whoami", async () => {
  // 抛错示例：对端 request 会 reject，错误信息透传
  throw new Error("not implemented yet");
});

// —— Agent 域：名册（sessions.sync/patch）+ 焦点对话（chat.sync/message/delta/notice）——
installAgentService(bus);

// —— Nav 域（目录导航）：旁听 agent.chat.sync 的 cwd 联动 cwd/current；fs.list 通用原语 ——
installNavService(bus);

// —— Editor 域（文件查看/编辑）：nav.open_file 打开 + editor.* 管理/保存/推送 ——
installEditorService(bus);

// —— STT 域（语音输入）：stt.audio/stt.end 缓冲管道 + partial/final/error 翻译 ——
installSttService(bus, config);

// —— TTS 域（语音输出）：tts.speak 会话 + audio/end 推送 + finish/stop 收尾 + break 测试口 ——
installTtsService(bus, config);

// —— Term 域（终端）：帧桥接到独立守护进程 termd（PTY 归它，chamber 重启不杀终端）——
installTermService(bus);

const server = http.createServer(app);
const wss = attachWs(server);
installUpgradeAuth(server, wss, "/ws");

server.listen(config.port, () => {
  console.log(
    `HTTP/WS 服务已启动: http://localhost:${config.port} (WS 路径 /ws, bus 单例在线)`
  );
});
