// 服务端进程级 bus 单例：进程活着它就在，和业务 handler 的注册处
// requestTimeout 放宽到 15s：Agent 域首次建出勤要 reload 扩展 + 初始化 ModelRuntime，3s 不够
import { createBus } from "@pi-chamber/bus/core.js";

export const bus = createBus({ requestTimeout: 15000 });
