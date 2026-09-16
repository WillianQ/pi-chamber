import express from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get as getSetting } from "./setting.js";
import { signToken } from "./auth.js";
import { requireAuth } from "./auth.js";

const app = express();
app.use(express.json());

// 明文密码比对（常时间，避免计时侧信道；长度不同时直接 false）
function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// 登录：只需密码，成功后返回 JWT
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "请提供 password" });
  }
  // ★ 密码**现读**：设置页改完密码立即生效，不用重启（见 setting.js 纪律②）
  if (!safeCompare(password, getSetting().password)) return res.status(401).json({ error: "密码错误" });
  return res.json({ token: signToken() });
});

// 示例受保护接口：检查登录态是否还有效
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ ok: true, expiresAt: req.user.exp });
});

// —— 静态托管 web 构建产物（生产单进程：pnpm build 后 node src/server.js 即整站自服）——
// dev 不经这里（vite 5173 代理 /api /ws）；dist 不存在则静默跳过，纯 API 模式不受影响。
// ★ 打包成 exe 后 import.meta.url 指向 exe 自己，下面那条相对路径会算错 →
//   打包版由入口注入 PI_CHAMBER_WEB_DIR（指向首次运行解压出来的目录）。
const webDist =
  process.env.PI_CHAMBER_WEB_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist)); // index.html/指纹 assets 直接命中
  // SPA 兑底：非 GET、/api 前缀、真文件未命中的路径依次放行；其余（前端路由刷新）回 index.html
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/assets/")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
}

export default app;
