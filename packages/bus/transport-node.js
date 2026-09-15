// Node 侧 transport：包装一条 ws 连接（readyState 1 === OPEN）
export function nodeTransport(ws) {
  return {
    send: (s) => {
      if (ws.readyState === 1) ws.send(s);
    },
  };
}
