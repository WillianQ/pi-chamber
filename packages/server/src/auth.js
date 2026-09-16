// 鉴权小件：JWT 签发/校验 + Express 中间件
// （原 auth/ 目录的 jwt.js + middleware.js 合成一个：27 行不值得两个文件）
import jwt from "jsonwebtoken";
import { get } from "./setting.js";

// TTL 硬编码：设置项里没有它（用户要的配置只有密码/密钥/端口/语音，见 setting.js 字段表）
const TOKEN_TTL = "7d";

// 签发：单用户 owner，无额外 claim。
// ★ jwtSecret **现读**：改了密钥立刻对新 token 生效（老 token 随即失效 = 全员登出，符合直觉）
export function signToken() {
  return jwt.sign({ sub: "owner" }, get().jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
}

// 校验失败抛异常，调用方捕获（同样现读 —— 跟签发永远用同一把密钥）
export function verifyToken(token) {
  return jwt.verify(token, get().jwtSecret);
}

// Express 中间件：检查 Authorization: Bearer <token>
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "缺少 token" });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "token 无效或已过期" });
  }
}
