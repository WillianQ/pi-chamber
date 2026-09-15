// 鉴权小件：JWT 签发/校验 + Express 中间件
// （原 auth/ 目录的 jwt.js + middleware.js 合成一个：27 行不值得两个文件）
import jwt from "jsonwebtoken";
import { config } from "./config.js";

// 签发：单用户 owner，无额外 claim；TTL 由 env 定
export function signToken() {
  return jwt.sign({ sub: "owner" }, config.jwtSecret, {
    expiresIn: config.tokenTtl,
  });
}

// 校验失败抛异常，调用方捕获
export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
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
