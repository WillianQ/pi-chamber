// 设置活动页：由最右 bar 底部的"设置"唤起。四行竖排 ——
//   ① 页眉「设置」 ② 内容插槽（随下面选择切换） ③ 分页选择器 ④ 登出（常驻）
// 选择器放底部：手机上是拇指可达区；桌面端也不挡内容。
//
// 分页（默认第一页 = 朗读）：
//   语音.朗读 / 语音.识别 / 服务 / 账号 / 快捷键
//
// 数据来源：setting-store（setting.sync 推来的服务端真值）。改 = emit setting.update，
// **不做本地乐观更新** —— 等服务端 sync 回来才是真值（失败会自动回滚 + setting.notice 提示）。
import { useState } from "react";
import { Alert, Button, Flex, Input, InputNumber, Select, Slider, Switch } from "antd";
import { LogoutOutlined, SettingOutlined } from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import {
  useAuthStore,
  useTTSStore,
  useSettingStore,
  settingActions,
} from "../../stores/index.js";
import { SHORTCUTS, SHORTCUT_GROUPS } from "../../shortcuts.js";

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

// 三级层级（块标题 = sm 加粗白 → 行/正文 = xs 白 → 说明 = xs 更弱的灰）
const sectionStyle = {
  fontSize: T.fontSize.sm,
  fontWeight: 600,
  color: T.color.textPrimary,
  lineHeight: T.lineHeight.sm,
};
const rowStyle = { fontSize: T.fontSize.xs, color: T.color.textPrimary, lineHeight: T.lineHeight.xs };
const faintStyle = { fontSize: T.fontSize.xs, color: T.color.textMuted, lineHeight: T.lineHeight.xs };

/** 块标题：一级 */
function Section({ children }) {
  return <div style={sectionStyle}>{children}</div>;
}
/** 行标签：二级 */
function Row({ children, style }) {
  return <div style={{ ...rowStyle, ...style }}>{children}</div>;
}
/** 说明：三级（灰） */
function Hint({ children }) {
  return <div style={{ ...faintStyle, marginTop: 6 }}>{children}</div>;
}
/** 带控件的行：左标签 + 右控件（开关类） */
function ToggleRow({ label, hint, checked, onChange, disabled }) {
  return (
    <>
      <Flex align="center" justify="space-between" gap={10} style={{ marginTop: 10 }}>
        <Row>{label}</Row>
        <Switch size="small" checked={checked} onChange={onChange} disabled={disabled} />
      </Flex>
      {hint ? <Hint>{hint}</Hint> : null}
    </>
  );
}
/** 字段：标签 + 控件（+ 可选保存钮） */
function Field({ label, children, hint, action }) {
  return (
    <div style={{ marginTop: 18 }}>
      <Row>{label}</Row>
      <Flex gap={8} style={{ marginTop: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        {action}
      </Flex>
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
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

// ───────────────────────── 分页内容 ─────────────────────────

/** 朗读（TTS）—— 默认页 */
function TtsPage({ tts }) {
  const [keyDraft, setKeyDraft] = useState("");
  const dirtyKey = keyDraft.trim().length > 0;

  const saveKey = () => {
    settingActions.update({ tts: { dashscopeApiKey: keyDraft.trim() } });
    setKeyDraft("");
  };

  // 语速/音色是 run-task 参数（会话中途改不了）→ 改了先把在念的停掉，下条朗读用新值
  const stopIfSpeaking = () => {
    const cur = useTTSStore.getState();
    if (cur.phase !== "idle") cur.stop();
  };

  return (
    <>
      <Section>朗读</Section>
      <ToggleRow
        label="启用朗读"
        checked={tts.enabled}
        onChange={(v) => settingActions.update({ tts: { enabled: v } })}
        hint="关掉后消息上的喇叭与「自动朗读」都会隐藏，正在念的立即停止"
      />

      <Field
        label="百炼 API Key"
        hint="阿里云百炼（DashScope）控制台获取；只存在本机，不会外发"
        action={
          <Button size="small" type="primary" disabled={!dirtyKey} onClick={saveKey}>
            保存
          </Button>
        }
      >
        <Input.Password
          size="small"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder={tts.dashscopeApiKey ? "已配置（输入新值可覆盖）" : "sk-..."}
          disabled={!tts.enabled}
        />
      </Field>

      <Field label="音色" hint="下一条朗读生效；若正在朗读会先停止">
        <Select
          size="small"
          style={{ width: "100%" }}
          value={tts.voice}
          disabled={!tts.enabled}
          onChange={(v) => {
            stopIfSpeaking();
            settingActions.update({ tts: { voice: v } });
          }}
          options={
            VOICE_OPTIONS.some((o) => o.value === tts.voice)
              ? VOICE_OPTIONS
              : [{ value: tts.voice, label: `${tts.voice}（自定义）` }, ...VOICE_OPTIONS]
          }
        />
      </Field>

      <Field label={`语速 ${Number(tts.rate).toFixed(1)}×`} hint="0.5 – 2.0；下一条朗读生效">
        <Slider
          min={0.5}
          max={2}
          step={0.1}
          value={Number(tts.rate)}
          disabled={!tts.enabled}
          onChangeComplete={(v) => {
            stopIfSpeaking();
            settingActions.update({ tts: { rate: v } });
          }}
          style={{ margin: "2px 6px 0" }}
        />
      </Field>
    </>
  );
}

/** 识别（STT） */
function SttPage({ stt }) {
  const [keyDraft, setKeyDraft] = useState("");
  const dirtyKey = keyDraft.trim().length > 0;

  return (
    <>
      <Section>识别</Section>
      <ToggleRow
        label="启用识别"
        checked={stt.enabled}
        onChange={(v) => settingActions.update({ stt: { enabled: v } })}
        hint="关掉后输入框的「按住说话」按钮会隐藏，正在录的立即取消"
      />

      <Field
        label="百炼 API Key"
        hint="与朗读各自独立配置（同一把 key 也可以，填两遍即可）"
        action={
          <Button
            size="small"
            type="primary"
            disabled={!dirtyKey}
            onClick={() => {
              settingActions.update({ stt: { dashscopeApiKey: keyDraft.trim() } });
              setKeyDraft("");
            }}
          >
            保存
          </Button>
        }
      >
        <Input.Password
          size="small"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder={stt.dashscopeApiKey ? "已配置（输入新值可覆盖）" : "sk-..."}
          disabled={!stt.enabled}
        />
      </Field>
    </>
  );
}

/** 服务（端口） */
function ServicePage({ setting }) {
  const [port, setPort] = useState(setting.port);
  const [termdPort, setTermdPort] = useState(setting.termdPort);
  const dirty = port !== setting.port || termdPort !== setting.termdPort;

  return (
    <>
      <Section>服务</Section>
      <Field label="服务端口" hint="控制台与接口的监听端口">
        <InputNumber
          size="small"
          style={{ width: "100%" }}
          min={1}
          max={65535}
          value={port}
          onChange={(v) => setPort(v ?? setting.port)}
        />
      </Field>
      <Field label="终端守护端口" hint="termd 的本地端口（仅 127.0.0.1）">
        <InputNumber
          size="small"
          style={{ width: "100%" }}
          min={1}
          max={65535}
          value={termdPort}
          onChange={(v) => setTermdPort(v ?? setting.termdPort)}
        />
      </Field>
      <Flex style={{ marginTop: 18 }}>
        <Button
          block
          type="primary"
          disabled={!dirty}
          onClick={() => settingActions.update({ port, termdPort })}
        >
          保存
        </Button>
      </Flex>
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 12 }}
        message="端口改动需重启后端才生效"
        description="保存后请手动重启 pi-chamber（或重新运行 bg-start.bat）"
      />
    </>
  );
}

/** 账号（改密码） */
function AccountPage() {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [localErr, setLocalErr] = useState(null);

  const submit = () => {
    setLocalErr(null);
    if (!pw1.trim()) return setLocalErr("新密码不能为空");
    if (pw1 !== pw2) return setLocalErr("两次输入不一致");
    settingActions.update({ password: pw1 });
    setPw1("");
    setPw2("");
  };

  return (
    <>
      <Section>账号</Section>
      <Field label="新密码">
        <Input.Password size="small" value={pw1} onChange={(e) => setPw1(e.target.value)} />
      </Field>
      <Field label="再输一次">
        <Input.Password size="small" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </Field>
      <Flex style={{ marginTop: 18 }}>
        <Button block type="primary" onClick={submit}>
          保存
        </Button>
      </Flex>
      {localErr ? (
        <Alert type="error" showIcon style={{ marginTop: 12 }} message={localErr} />
      ) : (
        <Hint>改完立即生效；本机已登录的会话不受影响（旧 token 7 天内仍有效）</Hint>
      )}
    </>
  );
}

/** 快捷键（数据源 = shortcuts.js，与真实按键行为同一份） */
function ShortcutsPage() {
  return (
    <>
      <Section>快捷键</Section>
      {SHORTCUT_GROUPS.map((g, gi) => (
        <div key={g.id} style={{ marginTop: gi === 0 ? 12 : 16 }}>
          <Row style={{ color: T.color.textMuted }}>{g.title}</Row>
          {SHORTCUTS.filter((s) => s.group === g.id).map((s) => (
            <Flex key={s.keys} align="center" justify="space-between" gap={10} style={{ marginTop: 8 }}>
              <span style={{ ...faintStyle, flex: 1, minWidth: 0 }}>{s.label}</span>
              <Kbd>{s.keys}</Kbd>
            </Flex>
          ))}
        </div>
      ))}
      <Hint>
        一律用 Ctrl（Mac 上也按 Ctrl，不认 Cmd）；「面板」类全局生效，「编辑器」类仅在编辑器面板展开时生效。
        右面板循环（Ctrl+Q）只在导航 / 编辑器 / 终端之间转，设置面板用 Ctrl+. 单独开关；
        编辑器内的 Ctrl+S 保存、Ctrl+/ 注释沿用编辑器自身行为
      </Hint>
    </>
  );
}

const PAGES = [
  { id: "tts", label: "语音.朗读", render: (ctx) => <TtsPage tts={ctx.tts} /> },
  { id: "stt", label: "语音.识别", render: (ctx) => <SttPage stt={ctx.stt} /> },
  { id: "service", label: "服务", render: (ctx) => <ServicePage setting={ctx.setting} /> },
  { id: "account", label: "账号", render: () => <AccountPage /> },
  { id: "shortcuts", label: "快捷键", render: () => <ShortcutsPage /> },
];

// 未连上时用的保守兜底（形状与 setting.js 的 defaults 一致）
const FALLBACK = {
  port: 3000,
  termdPort: 3002,
  tts: { enabled: false, dashscopeApiKey: null, voice: "longanhuan_v3.6", rate: 1 },
  stt: { enabled: false, dashscopeApiKey: null },
};

export default function SettingsPage() {
  const logout = useAuthStore((s) => s.logout);
  const setting = useSettingStore((s) => s.setting);
  const notice = useSettingStore((s) => s.notice);
  const [tab, setTab] = useState("tts"); // 默认第一页 = 朗读

  const s = setting ?? FALLBACK;
  const page = PAGES.find((p) => p.id === tab) ?? PAGES[0];

  return (
    <Flex vertical style={{ height: "100%", background: T.color.panelBg }}>
      {/* ① 页眉 */}
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
        <span style={sectionStyle}>设置</span>
      </Flex>

      {/* ② 内容插槽 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
        {notice ? (
          <Alert
            type="error"
            showIcon
            closable
            style={{ marginBottom: 16 }}
            message={notice.message}
            onClose={() => settingActions.clearNotice()}
          />
        ) : null}
        {page.render({ setting: s, tts: s.tts, stt: s.stt })}
      </div>

      {/* ③ 分页选择器（默认尺寸，与 sessions 页底部 Agent 选择器同高） */}
      <div style={{ padding: "10px 12px", borderTop: `1px solid ${T.color.hairline}`, flexShrink: 0 }}>
        <Select
          style={{ width: "100%" }}
          value={tab}
          onChange={setTab}
          options={PAGES.map((p) => ({ value: p.id, label: p.label }))}
        />
      </div>

      {/* ④ 登出（常驻：与"当前在看哪一页"无关） */}
      <div style={{ padding: "0 12px 12px", flexShrink: 0 }}>
        <Button block danger icon={<LogoutOutlined />} onClick={logout}>
          登出
        </Button>
      </div>
    </Flex>
  );
}
