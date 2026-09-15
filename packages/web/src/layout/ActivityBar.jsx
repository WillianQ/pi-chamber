import { Flex } from "antd";
import {
  CodeOutlined,
  CompassOutlined,
  FileTextOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { T } from "../theme/tokens.js";

// 最右竖条（活动条）：上区 = 活动页选择（导航 / 编辑器 / 终端），贴底 = 设置。
// 点选中项 = 唤起活动页；再点同一项 = 收起。老 chamber 同语义，只是从最左挪到最右。
// hint 仅供 hover 提示（快捷键唯一真相在 DesktopLayout 的 keydown 里，此处理不判键）。
const TOP_ITEMS = [
  { id: "nav", label: "导航", hint: "Ctrl+Shift+1", icon: <CompassOutlined /> },
  { id: "files", label: "编辑器", hint: "Ctrl+Shift+2", icon: <FileTextOutlined /> },
  { id: "term", label: "终端", hint: "Ctrl+Shift+4", icon: <CodeOutlined /> },
];
const BOTTOM_ITEMS = [{ id: "settings", label: "设置", hint: "Ctrl+Shift+3", icon: <SettingOutlined /> }];

const btnBase = {
  width: 34,
  height: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: T.icon.base,
  transition: "color .15s, background .15s",
};

export default function ActivityBar({ active, onSelect }) {
  const renderItem = (it) => {
    const isActive = active === it.id;
    const style = {
      ...btnBase,
      color: isActive ? T.color.primary : T.color.textMuted,
      background: isActive ? T.color.activeRowBg : "transparent",
      ...(it.disabled ? { opacity: 0.35, cursor: "not-allowed" } : {}),
    };
    return (
      <div
        key={it.id}
        style={style}
        onClick={() => !it.disabled && onSelect(it.id)}
        className="pc-baritem"
        title={`${it.label} (${it.hint}) · 打开/收起`}
      >
        {it.icon}
      </div>
    );
  };

  return (
    <Flex
      vertical
      align="center"
      style={{
        width: 44,
        flexShrink: 0,
        background: T.color.panelBg,
        borderLeft: `1px solid ${T.color.hairline}`,
        paddingTop: 8,
        paddingBottom: 8,
        userSelect: "none",
      }}
    >
      <Flex vertical gap={2} align="center">
        {TOP_ITEMS.map(renderItem)}
      </Flex>
      <div style={{ flex: 1, minHeight: 8 }} />
      <Flex vertical gap={2} align="center">
        {BOTTOM_ITEMS.map(renderItem)}
      </Flex>
    </Flex>
  );
}
