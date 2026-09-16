// 跨平台"tee"：同时打印到控制台并写日志文件。
//
// 两条规矩：
//  ① **只在显式开启时写文件**（`LOG=1`，由 dev script 注入）。生产 / bg 不写 —— 内容流帧
//     （agent.chat.delta / term.output）每秒几十条，写下去纯占空间，而生产没有看日志的场景。
//     临时想看：`LOG=1 pnpm start`。
//  ② **路径从文件位置算，不依赖 cwd** —— 从哪启动都落在仓库根 `logs/server.log`。
//     旧实现是 `resolve("logs", ...)` 相对 cwd，于是仓库根冒出过一个十天前的僵尸日志。
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// ★ 打包成 exe 后 import.meta.url 指向 exe 自己，「往上三层」会跑到 exe 外面去 →
//   打包版由入口注入 PI_CHAMBER_HOME，日志改落 <HOME>/logs。dev 不设这个变量，行为一字不变。
const LOG_DIR = process.env.PI_CHAMBER_HOME
  ? join(process.env.PI_CHAMBER_HOME, "logs")
  : join(ROOT, "logs");
// 默认落 logs/server.log；LOG_FILE 可覆盖 —— e2e 测试用它指到临时目录，
// 免得测试进程（带 LOG=1）把 dev 正在写的那份清空
const LOG_FILE = process.env.LOG_FILE ? resolve(process.env.LOG_FILE) : join(LOG_DIR, "server.log");
export { LOG_FILE };

if (process.env.LOG === "1") {
  await mkdir(dirname(LOG_FILE), { recursive: true });
  // 启动即清空：文件日志记的是"本轮运行"，跨重启的历史没价值（实时观察看控制台那一路）
  await writeFile(LOG_FILE, "");

  const origLog = console.log.bind(console);
  console.log = (...args) => {
    origLog(...args);
    // 换行 + 时间戳前缀，异步追加不阻塞事件循环；写失败只忽略，不影响服务
    appendFile(LOG_FILE, `${new Date().toISOString()} ${args.join(" ")}\n`).catch(() => {});
  };
}
