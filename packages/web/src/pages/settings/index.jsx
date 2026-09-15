import { Alert, Button, Flex, Select, Slider } from "antd";
import { LogoutOutlined, SettingOutlined } from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { useAuthStore, useTTSStore } from "../../stores/index.js";
import { SHORTCUTS, SHORTCUT_GROUPS } from "../../shortcuts.js";
import ConnStatus from "../../components/ConnStatus.jsx";

// 音色快捷项（qwen-audio-3.0-tts-flash 系统音色，常见中文向）；可自由输入任意音色参数
const VOICE_OPTIONS = [
  { value: "longanlingxi", label: "longanlingxi · 龙安灵希（甜美女声）" },
  { value: "longanhuan_v3.6", label: "longanhuan_v3.6 · 龙安欢（清亮女声）" },
  { value: "longanfengyue", label: "longanfengyue · 龙安风悦（自然亲切）" },
  { value: "longanyuanfei", label: "longanyuanfei · 龙安元妃" },
  { value: "longanxiaoxin", label: "longanxiaoxin · 龙安小昕（活泼）" },
  { value: "longjielidou_v3.6", label: "longjielidou_v3.6 · 龙杰力豆（男童）" },
  { value: "longpaopao_v3.6", label: "longpaopao_v3.6 · 龙泡泡（软糯童音）" },
  { value: "longhuohuo_v3.6", label: "longhuohuo_v3.6 · 龙火火（少年）" },
  { value: "longchuanshu_v3.6", label: "longchuanshu_v3.6 · 龙川叔（男声）" },
];

// 三级层级（之前是反的：块标题 12 灰、块内正文 14 白 → 标题看着像注释）：
//   块标题 = sm 加粗白（全页最醒目）→ 行/正文 = xs 白 → 说明 = xs 更弱的灰。
// 间距同步放宽：块内首行 10、说明 6、块之间靠分隔线 24 撑开。
const sectionStyle = {
  fontSize: T.fontSize.sm,
  fontWeight: 600,
  color: T.color.textPrimary,
  lineHeight: T.lineHeight.sm,
};
const rowStyle = {
  fontSize: T.fontSize.xs,
  color: T.color.textPrimary,
  lineHeight: T.lineHeight.xs,
};
const faintStyle = { fontSize: T.fontSize.xs, color: T.color.textMuted, lineHeight: T.lineHeight.xs };

/** 块标题：一级 */
function Section({ children }) {
  return <div style={sectionStyle}>{children}</div>;
}

/** 行标签：二级（正文档之下的标签档，白字） */
function Row({ children, style }) {
  return <div style={{ ...rowStyle, ...style }}>{children}</div>;
}

/** 说明：三级（灰，弱于正文） */
function Hint({ children }) {
  return <div style={{ ...faintStyle, marginTop: 6 }}>{children}</div>;
}

/** 块分隔：靠大留白 + 发丝线，块与块之间不再"贴脸" */
function Gap() {
  return <div style={{ height: 1, background: T.color.hairline, margin: "24px 0" }} />;
}

/** 键位胶囊（mono + 发丝边框，与正文灰白拉开） */
function Kbd({ children }) {
  return (
    <span
      style={{
        flexShrink: 0,
        fontFamily: T.fontFamily.mono,
        fontSize: T.fontSize.xs,
        color: T.color.textPrimary,
        background: T.color.pageBg,
        border: `1px solid ${T.color.hairline}`,
        borderRadius: 4,
        padding: "2px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// 快捷键说明：不手写文案，直接渲染 src/shortcuts.js 那张表（与真实行为同一份数据，不会漂移）
function Shortcuts() {
  return (
    <>
      <Section>快捷键</Section>
      {SHORTCUT_GROUPS.map((g, gi) => (
        <div key={g.id} style={{ marginTop: gi === 0 ? 12 : 16 }}>
          <Row style={{ color: T.color.textMuted }}>{g.title}</Row>
          {SHORTCUTS.filter((s) => s.group === g.id).map((s) => (
            <Flex
              key={s.keys}
              align="center"
              justify="space-between"
              gap={10}
              style={{ marginTop: 8 }}
            >
              <span style={{ ...faintStyle, flex: 1, minWidth: 0 }}>{s.label}</span>
              <Kbd>{s.keys}</Kbd>
            </Flex>
          ))}
        </div>
      ))}
      <Hint>
        一律用 Ctrl（Mac 上也按 Ctrl，不认 Cmd）；「面板」类全局生效，「编辑器」类仅在编辑器面板展开时生效。
        右面板循环（Ctrl+Q）只在导航 / 编辑器之间转，设置面板用 Ctrl+. 单独开关；
        编辑器内的 Ctrl+S 保存、Ctrl+/ 注释沿用编辑器自身行为
      </Hint>
    </>
  );
}

// 设置活动页：由最右 bar 底部的"设置"唤起。全局杂项住这（连接/账号/朗读）。
export default function SettingsPage() {
  const logout = useAuthStore((s) => s.logout);
  const ttsRate = useTTSStore((s) => s.rate);
  const setRate = useTTSStore((s) => s.setRate);
  const ttsVoice = useTTSStore((s) => s.voice);
  const setVoice = useTTSStore((s) => s.setVoice);

  return (
    <Flex vertical style={{ height: "100%", background: T.color.panelBg }}>
      {/* 页眉 */}
      <Flex
        align="center"
        gap={6}
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${T.color.hairline}`,
          flexShrink: 0,
        }}
      >
        <SettingOutlined style={{ color: T.color.textSecondary }} />
        <span style={{ ...sectionStyle }}>设置</span>
      </Flex>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
        {/* 连接 */}
        <Section>连接</Section>
        <Flex align="center" justify="space-between" style={{ marginTop: 10 }}>
          <Row>与服务器的连接</Row>
          <ConnStatus />
        </Flex>

        <Gap />

        {/* 朗读 */}
        <Section>朗读</Section>
        <Row style={{ marginTop: 10 }}>音色</Row>
        <Select
          style={{ width: "100%", marginTop: 6 }}
          value={ttsVoice}
          onChange={setVoice}
          options={
            VOICE_OPTIONS.some((o) => o.value === ttsVoice)
              ? VOICE_OPTIONS
              : [{ value: ttsVoice, label: `${ttsVoice}（自定义）` }, ...VOICE_OPTIONS]
          }
        />
        <Hint>下一条朗读生效；若在朗读会自动停止。想用别的音色 → 往后端 .env 的 TTS_VOICE 填后重启（页面选不到时）</Hint>

        <Flex align="center" justify="space-between" style={{ marginTop: 20 }}>
          <Row>语速 {ttsRate.toFixed(1)}×</Row>
          <span style={faintStyle}>0.5 – 2.0（下一条朗读生效）</span>
        </Flex>
        <Slider min={0.5} max={2} step={0.1} value={ttsRate} onChange={setRate} style={{ margin: "8px 6px 0" }} />
        <Hint>音色/语速调整时若正在朗读会先停止，重新朗读即生效</Hint>

        <Gap />

        {/* 账号 */}
        <Section>账号</Section>
        <Button block danger icon={<LogoutOutlined />} style={{ marginTop: 10 }} onClick={logout}>
          登出
        </Button>
        <Alert type="info" showIcon message="JWT 7 天内有效；登出仅清除本机登录态" style={{ marginTop: 10 }} />

        <Gap />

        {/* 快捷键（数据源 = shortcuts.js，与真实按键行为同一份） */}
        <Shortcuts />
      </div>
    </Flex>
  );
}
