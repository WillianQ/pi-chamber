// DirPicker：弹窗式目录选择器（两处消费者：新建 Session 的「选择目录…」入口、nav 行「移动到…」）。
// 弹窗文案可换（title/okText props）——选择动作本身通用，"在此目录新建"还是"移入此目录"只是措辞。
// 与导航页（pages/nav）的区别：不碰 nav 共享现场 —— 位置是本组件私有 state，
// 每次进入重置回「桌面」（fs.desktop：桌面 → 探测常见名，全无回主目录），
// 列目录走 fs.list 独立请求（只展示目录，文件不显示）。
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Flex, Modal, Spin, Typography } from "antd";
import {
  FolderOutlined,
  HomeOutlined,
  VerticalAlignTopOutlined,
} from "@ant-design/icons";
import { T } from "../theme/tokens.js";
import { bus, waitOnline } from "../bus.js";
import { upPath } from "../stores/nav-store.js";
import { dispPath } from "../path-label.js"; // 展示层斜线归一（选中回传的路径仍用原始值）

const pathLabel = (p) => (p ? dispPath(p) : "此电脑"); // "" = 根层（盘符列表）

export default function DirPicker({
  open,
  onClose,
  onPick,
  title = "选择目录新建 Session",
  okText = "在此目录新建",
}) {
  const [home, setHome] = useState(null); // 桌面路径（打开时取一次，Home 按钮回它）
  const [current, setCurrent] = useState(undefined); // undefined = 正在取桌面；"" = 根层
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const seqRef = useRef(0); // 连续开关/快速导航：旧响应作废，防串台

  // 打开 → 重置并取桌面起点
  useEffect(() => {
    if (!open) return;
    const my = ++seqRef.current;
    setCurrent(undefined);
    setItems([]);
    setError(null);
    setBusy(true);
    (async () => {
      try {
        await waitOnline();
        const d = await bus.request("fs.desktop", null, { net: true });
        if (seqRef.current !== my) return;
        const start = d?.desktop ?? "";
        setHome(start);
        setCurrent(start);
      } catch (e) {
        if (seqRef.current === my) setError(e?.message ?? "获取桌面目录失败");
      } finally {
        if (seqRef.current === my) setBusy(false);
      }
    })();
  }, [open]);

  // current 定了 → 列目录（根层走 listRoots）
  useEffect(() => {
    if (!open || current === undefined) return;
    const my = ++seqRef.current;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        await waitOnline();
        const r = await bus.request("fs.list", { path: current || "" }, { net: true });
        if (seqRef.current !== my) return;
        setItems((r?.items ?? []).filter((i) => i.type === "directory")); // 只需目录
      } catch (e) {
        if (seqRef.current === my) {
          setError(e?.message ?? "读取目录失败");
          setItems([]);
        }
      } finally {
        if (seqRef.current === my) setBusy(false);
      }
    })();
  }, [open, current]);

  const goHome = () => home && setCurrent(home);
  const goUp = () => {
    if (current === undefined) return;
    const parent = upPath(current);
    if (parent !== null) setCurrent(parent);
  };

  const canConfirm = !!current && current !== ""; // 根层不能建
  const headerBtn = {
    size: "small",
    type: "text",
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      width={420}
      footer={
        <Flex justify="space-between" align="center">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            disabled={!canConfirm || busy}
            onClick={() => canConfirm && onPick(current)}
          >
            {okText}
          </Button>
        </Flex>
      }
    >
      {/* 头部：回桌面 / 上一级 + 当前路径 */}
      <div
        style={{
          padding: "4px 0 8px",
          borderBottom: `1px solid ${T.color.hairline}`,
          marginBottom: 4,
        }}
      >
        <Flex align="center" gap={4}>
          <Button {...headerBtn} icon={<HomeOutlined />} disabled={!home || busy} onClick={goHome} />
          <Button
            {...headerBtn}
            icon={<VerticalAlignTopOutlined />}
            disabled={current === undefined || upPath(current) === null || busy}
            onClick={goUp}
          />
        </Flex>
        <div
          style={{
            marginTop: 6,
            fontFamily: T.fontFamily.mono,
            fontSize: T.fontSize.xs,
            color: T.color.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {pathLabel(current)}
        </div>
      </div>

      {/* 目录列表（高约 4 行半，弹窗内滚动） */}
      <div style={{ height: 260, overflow: "auto", padding: "4px 0" }}>
        {busy ? (
          <Flex align="center" justify="center" style={{ height: "100%" }}>
            <Spin size="small" />
          </Flex>
        ) : items.length === 0 && !error ? (
          <Typography.Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 24 }}>
            空目录
          </Typography.Text>
        ) : (
          items.map((it) => (
            <Flex
              key={it.abs_path}
              align="center"
              gap={10}
              onClick={() => setCurrent(it.abs_path)} // 点击即进入
              style={{
                padding: "6px 10px",
                cursor: "pointer",
                fontSize: T.fontSize.sm,
                color: T.color.textPrimary,
                borderRadius: T.radius.sm,
              }}
              className="pc-dirrow"
            >
              <FolderOutlined style={{ fontSize: T.icon.sm, color: T.color.textSecondary }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.name}
              </span>
            </Flex>
          ))
        )}
      </div>

      {error && (
        <Alert type="error" message={error} showIcon banner style={{ borderRadius: 0 }} />
      )}
    </Modal>
  );
}
