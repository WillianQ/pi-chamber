import { WifiOutlined } from "@ant-design/icons";
import { T } from "../theme/tokens.js";
import { useConnStore, reconnect } from "../bus.js";

// 连接状态 = 一个 wifi 符号，颜色表状态（无文字）：绿=已连 / 蓝=连接中 / 红=断线。
// 断线时图标可点 = 手动重连（自动退避停手后才 manual）。
const MAP = {
  online: { color: T.color.ok },
  connecting: { color: T.color.lampRun },
  offline: { color: T.color.error },
};

export default function ConnStatus() {
  const state = useConnStore((s) => s.state);
  const { color } = MAP[state] || MAP.offline;
  const offline = state === "offline";
  return (
    <WifiOutlined
      onClick={offline ? reconnect : undefined}
      style={{ fontSize: T.icon.sm, color, cursor: offline ? "pointer" : "default" }}
    />
  );
}
