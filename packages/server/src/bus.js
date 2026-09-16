// 服务端进程级 bus 单例：进程活着它就在，和业务 handler 的注册处
// requestTimeout 放宽到 15s：Agent 域首次建出勤要 reload 扩展 + 初始化 ModelRuntime，3s 不够
import { createBus } from "@pi-chamber/bus/core.js";
import { log } from "./log.js";

// log 注入：bus 是前后端共用的协议机（零依赖、不认识日志落哪）—— 它只调注入进来的这个函数，
// 服务端把统一的 log 传下去（浏览器侧不传 → 默认空函数，前端输出照旧进 devtools）。
export const bus = createBus({ requestTimeout: 15000, log });
