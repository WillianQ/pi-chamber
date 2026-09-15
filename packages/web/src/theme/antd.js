// tokens → antd v6 ConfigProvider theme（JS token 模型，不需要 less/modifyVars）。
// 全站统一深色：antd 走 darkAlgorithm，底座色（布局/容器/浮层/文本/边框）从本仓 palette 显式喂入，
// 不依赖 antd 默认 #141414 深灰——这样 antd 组件与自研渲染（聊天流/面板）同源同族。
// 深色聊天区本身是自研渲染（STYLES 走 var(--pc-*)），不受算法影响，只与页面共用底色。
import { theme } from "antd";
import { T, palette } from "./tokens.js";

export const antdTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    fontFamily: T.fontFamily.sans,
    fontSize: T.fontSize.sm, // 全局基准字号 = 正文档 14：改这里，所有 antd 组件比例联动
    borderRadius: T.radius.base,
    colorPrimary: palette.primary, // 主色 = one-dark 蓝（换主色去 tokens.js 改 palette.primary）
    colorInfo: palette.primary,
    colorLink: palette.primary,
    colorSuccess: palette.green,
    colorWarning: palette.yellow,
    colorError: palette.red, // Alert/危险按钮红 = 消息流同款 one-dark 红

    // 表面层：与自研 palette 同源（画布最底 → 容器抬升 → 浮层最高）
    colorBgLayout: palette.bgDeep, // 页面底（Layout/登录背景）
    colorBgContainer: palette.surface1, // Card/Input/Select 等"面板层"
    colorBgElevated: palette.surface3, // 下拉/弹窗/气泡等浮层
    colorBgSpotlight: palette.surface3, // Tooltip

    // 文本四档：与深色流同表（亮→暗）
    colorText: palette.ink,
    colorTextSecondary: palette.parchment,
    colorTextTertiary: palette.slate,
    colorTextQuaternary: palette.faint,
    colorTextPlaceholder: palette.gray,

    // 线
    colorBorder: palette.controlLine, // 控件描边
    colorBorderSecondary: palette.hairline, // 弱分隔
    colorSplit: palette.hairline,
  },
  // 组件级微调也从这里出口，别在业务组件里写死
  components: {
    Layout: {
      headerBg: palette.surface1, // 顶栏与 Sider 同面板层（DesktopLayout 自设 style，此处保底）
      headerHeight: 48,
      headerPadding: "0 16px",
      siderBg: palette.surface1,
    },
    Button: {
      fontWeight: 500, // #61afef 底较亮：字重加到 500 保可读
      primaryColor: "#0e1a26", // 主按钮字用深海军蓝（白字在 #61afef 上对比不足，深字成"蓝章"风格）
      dangerColor: "#2a0d0d", // 危险按钮同理
    },
  },
};
