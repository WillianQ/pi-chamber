// base64 ↔ 字节 ↔ 字符串（终端流专用，纯函数）。
//
// 为什么终端要走 base64 而不是直接搬字符串：PTY 输出是 **UTF-8 字节流**，一帧的边界可能正好落在
// 多字节字符中间。字符串过一道 JS 的 UTF-16 语义再拼回去，半个字符就会变成 U+FFFD（中文变问号）。
// 所以线上传的是**字节**的 base64 —— 与 stt/tts 传 PCM 是同一套路（AGENTS.md 4.2）。
// 前端把每帧解回 Uint8Array 直接喂 xterm.write()：xterm 内部有跨帧状态机，半个字符会在下一帧拼回来。

/** base64 → Uint8Array（浏览器 atob；空串/非法串 → 空数组） */
export function b64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array → base64（分块，避免 fromCharCode 展开大数组爆栈） */
export function bytesToB64(bytes) {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** UTF-8 字符串 → base64（键盘输入走这条：xterm 给的是字符串，含多字节时按 UTF-8 编成字节） */
export function strToB64(s) {
  return bytesToB64(new TextEncoder().encode(s ?? ""));
}
