// 前端总线：浏览器侧单例 + 连接生命周期。
//
// 分工（两层）：
//   @pi-chamber/bus（共享包）＝协议机 core + 网线包装 transport —— 只管"帧"，不管连接生死；
//   本文件＝WS 生命周期：connect(token) / 自动退避重连 / 被踢 4001 停手 / 连接态。
//
// 特性：bus 的订阅挂在总线上不挂在 WS 上 —— 重连只是换一根网线（attachTransport），
// 订阅者（store 层）无需重订。拔线瞬间在途 request 会被 core 全部 reject。
//
// 竞态约定：业务请求（agent.*）一律先 await waitOnline() ——
// 登录成功/刷新后 Layout 渲染比 WS 握手快，直接 request 会撞空 transport 槽 reject "offline";
// 等待把"正在连"变成"已连上再发"，只有真超时才报错。
import { createBus } from "@pi-chamber/bus/core.js";
import { browserTransport } from "@pi-chamber/bus/transport-browser.js";
import { create } from "zustand";

/** 连接态（ConnStatus 读它）：offline | connecting | online */
export const useConnStore = create(() => ({ state: "offline" }));
const conn = (state) => useConnStore.setState({ state });

/** 等到 bus 在线（state=online）再继续；超时 reject。request 前的标准闸门 */
export function waitOnline({ timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    if (useConnStore.getState().state === "online") return resolve();
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("未连接服务器"));
    }, timeout);
    const unsub = useConnStore.subscribe((s) => {
      if (s.state === "online") {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

export const bus = createBus({ requestTimeout: 15000 });

let ws = null;
let token = null;
let manualClose = false; // 主动断开（logout）：不再重连
let reconnectTimer = null;
let attempts = 0; // 连续失败次数（退避指数）

function scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** attempts, 15000);
  attempts++;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(openSocket, delay);
}

function openSocket() {
  if (!token || manualClose) return;
  conn("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    attempts = 0;
    conn("online");
    bus.attachTransport(browserTransport(ws)); // core 自动拔旧线再插新线
  };
  ws.onmessage = (ev) => bus.feed(ev.data);
  ws.onclose = (ev) => {
    bus.detachTransport(`ws closed ${ev.code} ${ev.reason}`);
    ws = null;
    if (manualClose) {
      conn("offline");
      return;
    }
    // 4001 replaced：有更新的连接接管（如另一标签/客户端）——不自动抢，交给用户
    if (ev.code === 4001) {
      conn("offline");
      return;
    }
    // 握手失败（401/网络）也走 1006：token 失效会无限重试 → 连续 3 次没开过线就停手
    if (attempts >= 3) {
      conn("offline");
      return;
    }
    scheduleReconnect();
  };
}

/** 登录成功后调用：带 token 上线（幂等：已在线则无视） */
export function connect(tok) {
  if (tok) token = tok;
  manualClose = false;
  if (!ws || ws.readyState >= 2) openSocket();
}

/** 登出：拔线并停止一切重连 */
export function disconnect() {
  manualClose = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {}
    ws = null;
  }
  if (bus.connected) bus.detachTransport("manual disconnect");
  conn("offline");
}

/** 手动重连（ConnStatus 断线时点击） */
export function reconnect() {
  attempts = 0;
  if (!token || manualClose) return;
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  openSocket();
}