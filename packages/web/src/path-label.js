// 路径展示 helper（纯函数，nav 页 / DirPicker / editor 页共用，单一来源）。
// 展示层斜线归一纪律：只动给人看的字符串；fs/协议/store 里的原始路径绝不改。

// 展示层斜线归一：Windows 原生 `\` → `/`（只动给人看的字符串）
export const dispPath = (p) => (p == null ? p : String(p).replace(/\\/g, "/"));

// 路径展示：优先 cwd 相对（当前=Agent 目录显 ./、子目录 src/...）；越出 cwd 或没 cwd → 原样绝对
// （nav 顶栏与 editor 顶栏/TabBar 共用；出口统一 `/`，内部归一后比较）
export function relLabel(abs, cwd) {
  if (!abs) return "此电脑";
  abs = dispPath(abs);
  if (!cwd) return abs;
  cwd = dispPath(cwd);
  const sep = "/";
  const a = abs.split("/").filter(Boolean);
  const b = cwd.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  if (i === 0) return abs; // 不同盘符/根：cwd 前缀不成立，绝对展示
  if (i === b.length) {
    // cwd 前缀全匹配：等长 = 正停 Agent 目录；b 更短 = cwd 的子目录
    if (i === a.length) return "./";
    return a.slice(i).join(sep);
  }
  return abs; // current 是 cwd 的祖先（停在上级目录）→ 相对没意义，绝对展示
}

const joinSlash = (base, name) => (base.endsWith("/") ? base + name : base + "/" + name);

/**
 * 绝对路径 → 面包屑段链 [{label, abs}]（"/" 风格逐段回拼；abs 进 nav.open 前由服务端 path.resolve 归一，
 * Windows/POSIX 都吃这个写法——展示层归一纪律不在此适用，这里造的是等价可用路径，非改写给协议的原生值）。
 * 盘符根显 "C:/"（首段）；POSIX 根显 "/"。非绝对路径兑底单段原样。
 */
export function crumbChain(abs) {
  const norm = dispPath(abs);
  if (!norm) return [];
  const parts = norm.split("/").filter(Boolean);
  const drive = /^[A-Za-z]:$/.exec(parts[0] ?? "");
  if (drive) {
    const root = parts.shift() + "/"; // "C:" → abs "C:/"（可跳）；label 只显 "C:"（分隔符归面包屑自画，不出 "C://"）
    let cur = root;
    const segs = [{ label: drive[0], abs: root }];
    for (const p of parts) {
      cur = joinSlash(cur, p);
      segs.push({ label: p, abs: cur });
    }
    return segs;
  }
  if (norm.startsWith("/")) {
    let cur = "";
    const segs = [{ label: "/", abs: "/" }];
    for (const p of parts) {
      cur += "/" + p;
      segs.push({ label: p, abs: cur });
    }
    return segs;
  }
  return [{ label: norm, abs: norm }]; // 非绝对兑底
}
