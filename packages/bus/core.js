// 事件总线核心（前后端共用同一份，零依赖纯 ESM）
//
// 模型：
//   bus 是进程级单例，启动即在线；WS 连接只是插在 transport 槽上的"可拔网线"。
//   emit(event, payload, {net})     → 本地永远广播给订阅者；net=true 且已联网，再向网络复制一份
//   request(event, payload, {net})  → 单选：net=false 只问本地 handler；net=true 只问对面
//   任何一端收到事件：有人订阅就投，没有就静默丢弃
//
// 线协议（一行 JSON 一帧）：
//   {t:"e", e, p}                 事件帧（emit net 广播）
//   {t:"q", e, p, id}             请求帧（request net）
//   {t:"s", id, ok:true,  data}   回执
//   {t:"s", id, ok:false, error}  失败回执
// 坏帧/未知帧型/迟到回执 → 一律静默丢弃。
//
// 系统保留事件（$ 前缀，仅本地广播）：
//   $conn.open  {at}   transport 插入（对端上线）
//   $conn.close {at}   transport 拔出（对端下线）

// 8 hex 字符（32bit）随机 id：只需在【本端在途的几秒窗口】内唯一，
// 同时在途几十个请求的撞号概率 ≈ 千万分之一量级，撞了也只是该请求超时，不会错配答案。
// 用 getRandomValues 而非 randomUUID：后者在浏览器非安全上下文（http://内网、file://）不可用，
// 而前者所有环境都可用——反正只要 32bit 随机数，不需要完整 UUID 的格式。
function randId32() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function createBus({ requestTimeout = 3000, log = () => {} } = {}) {
  const handlers = new Map(); // event -> Set<fn>
  const pending = new Map(); // id -> { resolve, reject, timer }
  let transport = null; // 唯一的线（transport 槽）

  const sendFrame = (f) => {
    if (transport) transport.send(JSON.stringify(f));
  };

  function localSubs(event) {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    return set;
  }

  // 本地广播：有人订阅就投，没有就返回 false
  // 回调形态：fn(payload, meta, bus) —— payload 业务数据（无数据时 null）；
  // meta 来路信息；bus 总总线（谁要反手 emit/request 谁声明第三参，总线负责注入）
  function dispatch(event, payload, meta) {
    const set = handlers.get(event);
    if (!set?.size) return false;
    for (const fn of set) {
      try {
        fn(payload, meta, bus);
      } catch (err) {
        log(`[bus] handler(${event}) 异常: ${err?.message ?? err}`);
      }
    }
    return true;
  }

  // 问答类：取第一个 handler 的返回值作为响应（异步安全，带超时）
  // 回调同样收 fn(payload, meta, bus)，bus 由总线注入
  async function answer(fn, payload, meta, timeout) {
    const timer = { id: null };
    const result = new Promise((resolve, reject) => {
      timer.id = setTimeout(() => reject(new Error(`request 超时(${timeout}ms)`)), timeout);
      Promise.resolve()
        .then(() => fn(payload, meta, bus))
        .then((data) => resolve(data ?? null), reject)
        .finally(() => clearTimeout(timer.id));
    });
    return result;
  }

  const bus = {
    requestTimeout,
    get connected() {
      return !!transport;
    },
    get pendingCount() {
      return pending.size;
    },

    /** 订阅（不分本地/网络，来者都收）。返回取消函数。 */
    on(event, fn) {
      localSubs(event).add(fn);
      return () => localSubs(event).delete(fn);
    },

    /** 发事件：本地永远投一份；{net:true} 且在线 → 再发给对面 */
    emit(event, payload, { net = false } = {}) {
      dispatch(event, payload ?? null, { net: false, from: "local" });
      if (net && transport) sendFrame({ t: "e", e: event, p: payload ?? null });
      // net=true 但没联网：静默丢弃（"丢了就丢"策略）
    },

    /** 问答：net=false 只问本地；net=true 只问对面（单选，避免双响应者） */
    request(event, payload, { net = false, timeout = requestTimeout } = {}) {
      if (!net) {
        const set = handlers.get(event);
        if (!set?.size) return Promise.reject(new Error(`no handler: ${event}`));
        return answer(set.values().next().value, payload ?? null, { net: false, from: "local" }, timeout);
      }
      if (!transport) return Promise.reject(new Error(`offline: ${event}`));
      const id = randId32();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); // 先删：迟到回执会因查不到 id 被丢弃
          reject(new Error(`request 超时(${timeout}ms): ${event}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
      });
      sendFrame({ t: "q", e: event, p: payload ?? null, id });
      return promise;
    },

    /** 插线（幂等：已有旧线则先拔出）。由集成层在连接建立时调用。 */
    attachTransport(t) {
      if (transport === t) return;
      if (transport) bus.detachTransport(); // 自动接管：踢旧迎新由集成层负责关旧 socket
      transport = t;
      dispatch("$conn.open", { at: Date.now() }, { net: false, from: "bus" });
    },

    /** 拔线：在途 request 全部 reject（它们的问题发在旧线上，永远等不到回执） */
    detachTransport(reason = "detached") {
      if (!transport) return;
      transport = null;
      for (const [, w] of pending) {
        clearTimeout(w.timer);
        w.reject(new Error(`连接断开: ${reason}`));
      }
      pending.clear();
      dispatch("$conn.close", { at: Date.now() }, { net: false, from: "bus" });
    },

    /** transport 收到原始消息时调用（坏帧/未知帧型 → 扔） */
    async feed(raw) {
      if (!transport) return; // 已拔线：旧连接残留的帧不再处理
      let f;
      try {
        f = JSON.parse(raw);
      } catch {
        return;
      }
      if (!f || typeof f !== "object") return;

      switch (f.t) {
        case "e": {
          // 网络事件 → 和本地事件走同一个广播（有订阅就投，没有就扔）
          if (typeof f.e !== "string") return;
          dispatch(f.e, f.p ?? null, { net: true, from: "wire" });
          return;
        }
        case "q": {
          if (typeof f.e !== "string" || typeof f.id !== "string") return;
          const set = handlers.get(f.e);
          if (!set?.size) {
            sendFrame({ t: "s", id: f.id, ok: false, error: "no handler" });
            return;
          }
          try {
            const data = await answer(
              set.values().next().value,
              f.p ?? null,
              { net: true, from: "wire", id: f.id },
              requestTimeout
            );
            sendFrame({ t: "s", id: f.id, ok: true, data: data ?? null });
          } catch (err) {
            sendFrame({ t: "s", id: f.id, ok: false, error: String(err?.message ?? err) });
          }
          return;
        }
        case "s": {
          const w = pending.get(f.id);
          if (!w) return; // 超时后迟到的回执 / 不认识的 id → 扔
          pending.delete(f.id);
          clearTimeout(w.timer);
          f.ok ? w.resolve(f.data ?? null) : w.reject(new Error(String(f.error ?? "request failed")));
          return;
        }
        default:
          return;
      }
    },
  };
  return bus;
}
