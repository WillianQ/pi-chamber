# pi-chamber

> **任何一台设备，随时随地，找到你的 Agent —— 环境始终是同一份。**

pi-chamber 是 pi 编码 agent（`@earendil-works/pi-coding-agent`）的**远程监控操作台**。chamber 常驻在 agent 真正工作的那台机器上，你从任意浏览器接入 —— **既看它干活，也上手指挥**：同一批 agent、同一批 Session、同一个工作目录、同一场正在跑的对话。

<p align="center">
  <img src="./pic/pic_pc.png" alt="桌面端：Session 列表 · 流式对话 · 文件预览" width="100%">
</p>
<p align="center"><em>桌面端 —— Session 列表 · 流式对话（thinking / toolCall 可折叠）· 文件预览</em></p>

<p align="center">
  <img src="./pic/pic_mobile_0.png" alt="手机端：Session 列表" width="24%">
  <img src="./pic/pic_mobile_1.png" alt="手机端：对话" width="24%">
  <img src="./pic/pic_mobile_2.png" alt="手机端：文件导航" width="24%">
</p>
<p align="center"><em>手机端 —— Session 列表 · 流式对话 · 文件导航（同一份环境，换设备接入 = 接管）</em></p>

## 核心理念

- **一个 cwd 目录 = 一个 Agent Space**：目录本身就定义了一个 agent —— 它的系统提示词（`.pi`）、可用工具、行为准则、工作资源，全部随目录走。
- **一个 Session = 该 agent 的一次出勤**：有档案（全程可回看）、有运行时（可对话、可指挥）；一份 agent 可同时有多个 Session，开 / 收 / 销是可控的生命周期。
- **这是「一个人」的控制台**：人只有一双眼睛 —— 同一时刻只有**一个焦点**、面对**一个界面**。所以 WS 是**互斥**的（单连接独占，新连接踢旧）：换设备接入 = **接管**，而不是多端并看。

## 功能

| 能力 | 说明 |
|------|------|
| **Session 管理** | 列出机器上所有 agent 及各自的历次 Session；新建 / 打开 / 收工 / 销毁；多份出勤并行，随时切换焦点跟着看 |
| **流式对话** | text / thinking / toolCall 分块实时渲染；忙时可插队下一条、可随时停止；模型失败自动重试 |
| **远程文件操作** | 在 agent 的工作目录里导航、浏览，新建 / 改名 / 删除 / 移动文件与目录 |
| **远程编辑** | 页面上直接编辑（CodeMirror 语法高亮、多标签），保存即写回 agent 那台机器；文件被外部改动时页面实时跟随 |
| **语音** | 按住说话下指令（STT）；点喇叭朗读任意一条回答（TTS），可开「自动朗读」边生成边跟读 |
| **远程终端** | 真交互终端（Git Bash / PowerShell / cmd / WSL 可选），可开多个、各连各自 cwd；PTY 归 `termd` 持有 —— **chamber 重启不杀终端**，刷新页面 / 换设备回来整屏回放 |

## 快速开始

```bash
pnpm install
cp packages/server/.env.example packages/server/.env   # 填 JWT_SECRET + PASSWORD

pnpm dev        # 后端 3001（node --watch 自重启）+ 前端 5173（vite HMR）
```

浏览器打开 <http://localhost:5173> → 密码登录 → 选 Agent / 新建 Session → 右侧对话。

生产运行：

```bash
pnpm build      # 产出前端 packages/web/dist
pnpm start      # 后端 3000，托管前端页面
```

> 单用户、仅密码登录（JWT，默认 7 天）。

## 特殊说明

### 1. 语音（STT / TTS）需要阿里百炼的 key

按住说话（语音输入）与朗读（语音输出）都走**阿里云百炼（DashScope）**的实时语音服务，需要一把 `DASHSCOPE_API_KEY`：

- 写在 `packages/server/.env`（见 `.env.example`）
- **不配** → 语音按钮点了**没反应**（后端日志：`[stt] 未配置 DASHSCOPE_API_KEY`）
- STT 默认模型 `fun-asr-realtime`；TTS 默认 `qwen-audio-3.0-tts-flash`
- key 在 [百炼控制台](https://bailian.console.aliyun.com/) 申请（有免费额度）

### 2. 公网部署必须配 HTTPS，否则语音输入不可用

浏览器取**麦克风**（`getUserMedia`）只在**安全上下文**下可用 —— 即 `https://` 或 `localhost`。因此：

- 局域网用 `http://192.168.x.x:3000` 访问 → 聊天 / 终端 / 编辑都正常，**但「按住说话」点了没反应**
- 要语音输入 → 前置 Caddy / nginx 配 TLS（页面 `https://` + WS `wss://`）

> 朗读（TTS）不受此限 —— 它只播放音频，不碰麦克风。

## 包结构

Monorepo（pnpm workspaces，`node-linker=hoisted`）：

| 包 | 技术 | 职责 |
|----|------|------|
| `packages/bus` | 零依赖纯 ESM | `createBus` 协议机 + node/browser transport。前后端共享的**唯一协议真相**，不复制 |
| `packages/server` | Express 5 + ws | HTTP 只做 login/me；Agent 域（名册 + 对话）、导航、编辑、语音、终端帧桥接 |
| `packages/web` | React 19 + antd 6 + zustand + Vite | 桌面控制台：Session 面板 / 聊天 / 导航 / 编辑器 / 终端 / 设置 |
| `packages/termd` | node-pty + ws | **终端守护进程**：独立进程，唯一持有 PTY（见下） |

> Markdown 渲染**不在本仓** —— 已抽成独立 npm 包 [`@willianqrunning/markdown-go`](https://www.npmjs.com/package/@willianqrunning/markdown-go)（插件式：代码高亮 / KaTeX / ECharts），`packages/web` 直接依赖它。

## 架构要点

### 1. Bus —— 一条协议，两种投递

`createBus()` 是进程内单例（server / web 各一），**transport 是唯一插线槽**，WebSocket 只是插在槽上的「网线」。投递只分两种：

- **事件（emit）**：单向通知，本地永远先投一份，`{net:true}` 且在线再向网络复制一份；没人订阅就静默丢。
- **请求（request）**：一问一答，`net:false` 只问本地、`net:true` 只问对面；无 handler / 断线 / 超时 → reject。

线协议一行 JSON 一帧：

```
{t:"e", e, p}                 事件帧
{t:"q", e, p, id}             请求帧
{t:"s", id, ok:true,  data}   成功回执
{t:"s", id, ok:false, error}  失败回执
```

### 2. termd —— 终端为何独立进程

PTY 子进程挂在「谁起了它」的进程树下。若由 chamber 起 PTY，每次后端重启（dev 天天重启）都会攒一批看不见、关不掉的孤儿 shell。交给**不重启的独立进程 termd** 之后：

- chamber 重启 = 断线重连，前端自动重新 `attach`，回放断线期间的输出；
- termd 退出时**由它自己** kill 全部 PTY（它是直接父进程，这活儿只有它干得干净）。

termd 只绑 `127.0.0.1:3002`，自带一套 40 行线协议（**不走 bus**），三层鉴权见下文安全节。

### 3. 插件机制 —— 能力由目录决定，开关能热更

chamber 内置的能力（目前是 **subagent**：让 agent 把一件自足的任务派给一份新的独立 Session）不是写死的，而是**按 cwd 配置启用** —— 这跟「一个 cwd 目录 = 一个 Agent Space」是同一条原则：**agent 的能力，应该由目录自己说了算**。

配置写在 `<cwd>/.pi/pi-chamber.json`：

```json
{
  "subagent": {
    "enabled": true,
    "model": "ds/deepseek-flash",
    "maxConcurrent": 4,
    "timeoutMs": 360000
  }
}
```

**缺省 `enabled = false`** —— 不写配置就没有这个能力。两个理由：派单是要花钱的，得你点头；以及零迁移成本（已有目录一个都不用动）。

几个关键取舍：

- **独立文件，不塞进 pi 的 `.pi/settings.json`** —— 那是 global + project 两层深合并、而且 pi 自己会回写它，chamber 往里塞自定义键有被冲掉的风险。
- **「注册」和「激活」拆成两件事** —— 注册（这个工具存不存在）只在建场那一刻定；激活（它现在活不活）每次都能重算。所以插件工具**恒注册**，`enabled` 只决定激活 → **`/reload` 就能热更开关，不用重开会话**（系统提示词也跟着重建）。
  > 唯一改不了的：配置从「没这个键」变成「有这个键」—— 注册表里还没有它，得重开一次 Session。之后开关都是热的。
- **工具名归 chamber 管** —— 配置里一旦出现某个插件的键，它占用的工具名就归 chamber 管（盖掉 agent 目录里的同名扩展）。否则装个同名扩展就能绕过插件自己的闸（subagent 的递归闸就靠这个兜住）。

加新插件 = 写一个 `plugins/xxx.js` + 在插件表里加一行：

```js
export const key = "xxx";          // 配置键名（= pi-chamber.json 里那一段的名字）
export const toolNames = ["xxx"];  // 本插件占用的工具名
export function create(ctx) { … }  // → ToolDefinition | null（null = 本次不注入，如深度到顶）
```

> 完整的契约、`ctx` 字段与所有取舍，见 [`AGENTS.md`](./AGENTS.md) 第 4 章。

## 协议速览

HTTP：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | `{password}` → `{token}` |
| GET | `/api/me` | Bearer 检查登录态（前端启动探活用） |

WS `/ws?token=JWT`（单连接独占，新连接踢旧，心跳 60s）。主要帧：

- **名册**：`agent.sessions.sync`（全量）/ `agent.sessions.patch`（增量）/ `agent.sessions.list`（换目录）
- **对话**：`agent.chat.sync`（字段级替换）/ `agent.chat.message` / `agent.chat.delta` / `agent.chat.notice`
- **生命周期**：`agent.session.{open,close,create,delete,prompt,abort}`
- **翻页 / 取全文**：`agent.chat.more_messages` · `agent.chat.toolResult`（request）
- **导航 / 文件**：`nav.state` · `nav.update` · `nav.open` · `fs.{list,desktop,search,create,rename,delete,move}`
- **编辑器**：`nav.open_file` · `editor.{update,files,file_changed,close_file}`
- **语音**：`stt.{audio,end,partial,final,error}` · `tts.{speak,audio,finish,stop,end,break}`
- **终端**：`term.{list,create,attach,detach,output,input,resize,close,exit}`

> 每个帧的完整字段、语义与取舍，见 [`AGENTS.md`](./AGENTS.md) 第 4 章 —— 那是协议的**唯一真相**。

## 开发命令

```bash
pnpm dev            # 后端 3001 + 前端 5173
pnpm dev:server     # 只起后端 / pnpm dev:web 只起前端
pnpm build          # 前端生产产物
pnpm start          # 生产后端（3000）

pnpm test           # node --test（自起 3996~3999 独立实例，不碰 3000/3001）
pnpm smoke          # 活体服务全链路体检
pnpm agent-smoke    # Agent 域名册 / 生命周期冒烟
pnpm prompt-smoke   # prompt 全流程（真实模型往返 + 帧语义断言）
pnpm subagent-smoke # subagent 域（真调模型：默认关 / 全链路 / /reload 热更）
pnpm web-smoke      # 前端 store 冒烟（Node 里跑真前端代码消费活体帧）
pnpm termd-smoke    # 终端域冒烟（直连 termd）
pnpm term-smoke     # 终端域冒烟（走 chamber 全链路）

pnpm termd start|stop|status|restart   # 终端守护进程
pnpm bg start|stop|status|restart      # 后台常驻版（detached 起后端 3000）
```

日志统一在仓库根 `logs/`（`dev` 全量写 `server.log`，生产不写以免内容流帧占满磁盘）。

## 安全提示

- 单用户自用：登录密码在 `.env` 里**存明文**（`PASSWORD`，与 `JWT_SECRET` 同处，gitignored）。
- JWT 无状态、无撤销：登出 = 前端丢 token；7 天 TTL 内 token 被偷仍有效（单用户可接受）。
- 公网部署：前置 Caddy / nginx 做 TLS（`wss://`）—— 顺带满足语音输入的 HTTPS 前提（见「特殊说明」）。
- **termd 不进公网**：只绑 `127.0.0.1:3002`，三层鉴权 —— ① 非 loopback 拒；② **带 `Origin` 头（浏览器发起）一律拒**；③ token（随机 24 字节，落 `packages/termd/data/token`）。拿到 token = 拿到这台机器的 shell。

## 一些背景

作者**并非专业开发人员**，在**金融行业**工作。开发本项目,除了满足自己的需求外,也是学习的一部分.

现在的 Codex / Claude Code / pi 等，主要面向 **coder 的工作方式 —— 面对 PC 的**。但大部分 office 人员可能并不面向 PC，他们的工作界面完全不同。在金融场景里，很多时候有**外勤工作**：需要的是**随时随地找到自己的 agent**，并且**对它的运作机制充分了解** —— 建立信任，才敢用。

这个项目的取舍，大多来自这个前提。

### 为什么不用 opencode / openchamber？

两个都是好东西，2026 年 2 月我认真试过 opencode + openchamber 这套组合，卡在两点：

- **opencode 的系统提示词不可控** —— 而 agent 的行为几乎全由系统提示词决定，这等于把最核心的东西交出去了；
- **openchamber 代码太复杂** —— 想按自己的需求改，改不动。

### 为什么不用 Codex / Claude Code / WorkBuddy / 豆包办公？

其实都挺好，生态也丰富。但它们是**黑箱**：

- 系统提示词怎么拼、上下文怎么裁、工具怎么调度 —— 全不可控；
- 订阅制付费，**无法衡量真实成本**（一次任务到底烧了多少 token？不知道）。

**生态太好也有代价**：插件、skill 装多了，agent 的选择太多，行为反而变得不可预测 —— 一连串问题都从这儿来。pi 正好相反：系统提示词、可用工具、模型、成本，全是明面上的。

### 为什么不是「龙虾」？

它的内部机制过于复杂，以至于使用者会感到**「失控」**。

通过即时通讯软件与 agent 交互也是困难的：没有 streaming，你不知道它在干什么、干到哪一步了。

streaming 虽然大部分时候你并不会盯着看，但它给了用户一种**可控感** —— 你知道 agent 正在 running；瞥一眼发现 thinking 不对劲，可以**立刻终止**。毕竟 LLM 目前还达不到「让人完全放心撒手」的状态。

### 为什么要有 Session 管理？

pi 本身不带多 Session 并发管理。但实际工作里，**多个任务并行是刚需** —— 这也是造这个控制台最直接的动机。

诚实说：**目前我还做不到「不看 Session」**，多份出勤并行时人还是得盯着。

曾想过「**大管家模式**」：只跟 1 个 main agent 说话，其余全部降级为 subagent。真做的时候才发现 —— 当前 LLM 的调度能力、以及 agent 之间的调用机制，都还撑不起这个模式。所以先做成「多 Session + 单焦点」，是务实的中间态。

### 远景

- **定时任务管理** —— 用户可以直接用 pi 生态的插件实现，chamber 只负责管理界面；
- **远程通知** —— 要做到「agent 干完活主动推到你手机」，得**app 化**才行，纯 Web 做不到。

## 许可

[MIT](./LICENSE)
