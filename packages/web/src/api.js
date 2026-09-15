// HTTP 封装：只管 login / me。401/登录失败统一抛 Error（页面自己展示）。
// dev 走 vite 同源代理（/api → 3001），无 CORS 负担。
const TOKEN_KEY = "chamber_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function login(password) {
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `登录失败(${r.status})`);
  return j.token;
}

/** 探活：token 还在不在有效期（后端只认 Authorization Bearer） */
export async function me() {
  const r = await fetch("/api/me", {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  return r.ok;
}
