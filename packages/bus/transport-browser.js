// 浏览器侧 transport：包装一条 WebSocket（前端接入时使用）
// 用法：
//   const ws = new WebSocket(`wss://host/ws?token=${token}`)
//   const bus = createBus()
//   ws.onopen    = () => bus.attachTransport(browserTransport(ws))
//   ws.onmessage = (ev) => bus.feed(ev.data)
//   ws.onclose   = () => bus.detachTransport("ws closed")
export function browserTransport(ws) {
  return {
    send: (s) => {
      if (ws.readyState === 1) ws.send(s);
    },
  };
}
