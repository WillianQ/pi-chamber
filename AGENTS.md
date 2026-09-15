# pi-chamber — AGENTS.md

> Agent 域（名册 + 对话）已按协议重写定稿：服务端 `agent-service/`、前端 `sessions-store`/`chat-store`。
> **帧名与字段以第 4 章为唯一真相**（旧的 `agent.session.*` 内容流/状态流已全部删除）。

## 1. 项目宗旨

**任何一台设备，随时随地，找到你的 Agent——环境始终是同一份。**

pi-chamber 是一个**远程、跨平台的 agent 监控操作界面**：chamber 常驻在 agent 真正工作的那台机器上，你从任意设备、任意地点接入——**既看它干活，也上手指挥**，环境始终统一：同一批 agent、同一批 Session、同一个工作目录、同一场正在跑的对话。

**核心理念**

- **一个 cwd 目录 = 一个 Agent Space**：目录本身就定义了一个 agent——它的系统提示词（`.pi`）、可用 tool、行为准则、工作资源，全部随目录走。
- **一个 Session = 该 agent 的一次出勤**：有档案（全程可回看）、有运行时（可对话、可指挥）；一份 agent 可同时有多个 Session，"上班/收工"是可控的生命周期。
- **这是「一个人」的控制台**：人只有一双眼睛——同一时刻只有**一个焦点**、面对**一个界面**。所以 **WS 是互斥的**（单连接独占，新连接踢旧）：换设备接入 = **接管**，而不是多端并看。

**平台能做什么**

1. **出勤管理**：列出机器上所有的 agent（及各自的历次 Session），新建 / 打开 / 收工 / 销毁一个 Session；多份出勤并行，随时切换焦点跟着看；
2. **流式对话**：指令下进去、边跑边看——text / thinking / toolCall 分块实时渲染；忙时可插队下一条、可随时停止，模型失败自动重试；
3. **远程文件操作**：在 agent 的工作目录里导航、浏览，新建 / 改名 / 删除 / 移动文件与目录；
4. **远程编辑**：直接在页面上打开文件编辑（语法高亮、多标签），保存即写回 agent 那台机器；agent 正在改的代码，页面实时跟着变；
5. **语音**：按住说话下指令（STT）；点喇叭朗读任意一条回答（TTS）、开"自动朗读"让 agent 边生成边跟读，均可开关。
6. **远程终端**：右侧「终端」活动页（Ctrl+Shift+4）开**真交互**终端（Git Bash / PowerShell / cmd / WSL 可选），可开多个、各连各自的 cwd，彩色/全屏 TUI/方向键全在。PTY 归 `termd`（chamber 的子进程）持有 —— **chamber 重启（dev 天天重启）不杀终端**，刷新页面/换设备回来整屏回放。

## 2. 通用说明

### 2.1 领域术语（务必遵守；不要用 "workspace"）

| 词 | 含义 |
|----|------|
| **Agent / Agent Space** | 一个 **cwd 目录**。目录 = 定义了一个 agent（它的 `.pi`、上下文、技能都随目录走）。列表/查史都以 cwd 为键。 |
| **Session（一次出勤）** | 该 agent 的一次"上班"：一个 JSONL 档案 + 一个运行时 AgentSession。**aggregation root**。 |
| **幽灵出勤** | create 后、出第一条 assistant 消息前**不落盘**的出勤（SDK 惰性持久化）。delete/close 要容忍"无档案"；名册计数靠内存补偿。 |
| **AgentSession** | 出勤的运行时（prompt/订阅/改名都在它身上）。 |
| **SessionManager** | 档案的持久对象，**1:1 绑定一个 jsonl**，不能跨出勤共享；只共享 archive 目录与静态 API。 |
| **Bus** | 共享总线协议机（`@pi-chamber/bus`）：本地双通道 + 网络 transport。进程内单例，WS 只是插在 transport 槽上的网线。 |
| **termd（终端守护）** | chamber 的**子进程**（不是外部服务）：独立进程，**唯一持有 node-pty 的东西**（`packages/termd`）。chamber 只是它的客户端（私线 = `127.0.0.1:3002` + token，见 2.5），**协议不走 bus** —— 它自带一套 40 行线协议。这么分是为了让终端活过 chamber 重启：PTY 子进程挂在谁下面，谁重启就带走谁。 |

### 2.2 对外用词约定

上表的"出勤"等词是**内部域词**（代码注释/日志/本文件），**凡用户看得到的文案一律用 Session**（页面标题、按钮、空态、错误提示、Agent 下拉计数等——"Session 管理""新建 Session""销毁这个 Session？"）。

### 2.3 HTTP（只管鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | `{"password":"***"}` → `{"token":"JWT"}` |
| GET  | `/api/me` | Bearer 检查登录态（前端启动探活用） |

### 2.4 开发命令与工作流

```bash
pnpm install                      # workspace 根一次装完四包（node-linker=hoisted，见 .npmrc）
cp packages/server/.env.example packages/server/.env   # 填 JWT_SECRET + PASSWORD

pnpm dev                          # 同时起后端 3001 + 前端 5173（--stream 前缀区分两包日志）
pnpm test                         # node --test，自起 3996~3999 独立实例，不碰 3000/3001
pnpm smoke                        # 打活体服务全链路体检
pnpm bg start|stop|status|restart  # 后台常驻版（detached 起后端 3000，关终端不死；pid 落 logs/bg.pid）
pnpm dev:server / dev:web         # 只起一端（日常调后端/前端时各开一个终端）
pnpm agent-smoke                  # Agent 域冒烟：名册 sync/patch + open/close/create/delete + 翻页 + 失败路径
pnpm prompt-smoke                 # prompt 全流程：真实模型往返 + 帧语义断言（真写盘，用完即删幽灵）
pnpm web-smoke                    # 前端 store 冒烟：Node 里跑真前端代码消费活体帧（sessions/chat 两 store）
pnpm termd start|stop|status|restart  # 终端守护进程（termd）；chamber 启动时也会自动探测并拉起
pnpm termd-smoke                  # 终端域冒烟（直连 termd）：起/接管/回放/IO/resize/断开不杀/重连回放/名册
pnpm term-smoke                   # 终端域冒烟（走 chamber 全链路）+ 前端 term-store 真代码消费活体帧
```

工作流注意：

- 后端 3001 的 dev 是 `node --watch` 自重启，监听 `packages/server/src/`、`packages/bus/`、`.env`。**不要自己启/杀服务**；验证靠"改代码 → 等服务自动重启 → 冒烟脚本打 3001 → `tail logs/server.log`"。
- **日志策略（位置统一在仓库根 `logs/`）**：
  | 模式 | 文件日志 | stdout | stderr |
  |---|---|---|---|
  | `pnpm dev`（`LOG=1`） | ✅ `logs/server.log`（**全量含内容流帧**，启动即清空） | 终端 | 终端 |
  | `pnpm start` / `pnpm bg`（生产） | ❌ 不写 | 终端 / **丢弃** | 终端 / `logs/server.err.log` |
  为什么生产不写：内容流帧（`agent.chat.delta` / `term.output`）每秒几十条，写下去纯占空间（实测占 84%），而生产没有看日志的场景。临时要：`LOG=1 pnpm start`。
  路径一律**从文件位置算**（`import.meta.url` 往上推），不用 `resolve("logs",…)` —— 那是相对 cwd，从哪启动就落哪（曾在仓库根留过一个十天前的僵尸日志）。
- 冒烟脚本默认 cwd 是 `packages/server` 自身目录——**不是 agent space**；要打真实 agent 目录请传参：`pnpm run agent-smoke -- <cwd>`（`web-smoke` 同理）。
- 终端归 **termd**：`pnpm dev` 的后端自重启（`node --watch`）**不杀终端**（PTY 不在它手里）；想清空终端用 `pnpm termd restart`。反过来，`packages/server/src/*` 改动会让 chamber 重启，前端自动重连并重新接管屏幕（回放断线期间的输出）——这是设计好的，不是 bug。
- 冒烟脚本登录：优先 `.env` 的 `PASSWORD` 打 `/api/login`；没有就临时用 `JWT_SECRET` 自签 token（不阻塞冒烟）。
- 前端无 mock：联调靠起 dev（5173）连活体后端；vite 代理了 `/api` 与 `/ws`，同源无 CORS。

### 2.5 安全提示

- `.env`、`logs/`、`dist/` 已 gitignore。
- JWT 无状态、无撤销：登出 = 前端丢 token；7d TTL 内 token 被偷仍有效（单用户可接受，加黑名单是后话）。
- **登录密码在 `.env` 里存明文**（`PASSWORD`，与 `JWT_SECRET` 同处，gitignored）。不存哈希 —— 单用户自用、`.env` 从不外流，哈希那套（bcrypt + `hash-password` 工具）属于多余工序，已删。同理：`.env` 一旦泄露，密码和签名密钥一起丢，哈希也救不了。
- WS token 走 query string 会进代理访问日志（硬化项：改 Sec-WebSocket-Protocol 头，会动所有冒烟脚本，暂缓）。
- 公网部署：前置 Caddy/nginx TLS（wss://）；若前端独立域名托管，后端需加 `ALLOW_ORIGIN` CORS 白名单（当前同源代理/托管，无 CORS）。
- **termd 不进公网**：它只绑 `127.0.0.1:3002`（端口由 chamber 从自己 `.env` 的 `TERMD_PORT` 读、以 `--port` 传给 termd；**termd 自身不读 env**），三层鉴权全在 `daemon.js` 里：① 非 loopback 拒 ② **带 `Origin` 头（= 浏览器发起的连接）一律拒** ③ token（随机 24 字节，落 `packages/termd/data/token`，gitignored；daemon 退出时删）。第 ② 条是关键：**loopback 不是安全边界** —— 没有它，你随手打开的一个被 XSS 的网页就能连 `ws://127.0.0.1:3002` 在本机开 shell（DNS rebinding 同理）。对外入口仍然只有 chamber 一个 —— 但请记住：拿到 token = 拿到这台机器的 shell。

## 3. 目录结构

```
pi-chamber/
├── package.json               # workspace 根脚本（dev/dev:server/dev:web/test/smoke/agent-smoke/prompt-smoke/web-smoke/termd/term-smoke/termd-smoke，见 2.4）
├── pnpm-workspace.yaml        # packages: ["packages/*"]
├── .npmrc                     # node-linker=hoisted（隔离式 node_modules 会破坏扩展 require 约定，勿改）
├── AGENTS.md  README.md  LICENSE
├── pnpm-lock.yaml
├── tts文档/                    # 语音（STT/TTS）对接文档
├── .pi/                       # 本仓的 agent 定义（不要动）
├── scripts/bg.mjs             # 后台启停控制器：detached 起 `node src/server.js`（端口取自 server/.env，强制注入），
│                              #   pid 落 logs/bg.pid（gitignored）；根目录 bg-start.bat / bg-stop.bat / bg-status.bat 是双击入口
├── logs/                      # ★ 所有运行期日志集中于此（gitignored）：
│                              #   server.log（dev 全量；启动清空）· server.err.log（生产 stderr）
│                              #   termd.log · termd.boot.log（每次拉起 termd 的记录）· bg.pid
└── packages/
    ├── bus/                   # @pi-chamber/bus：共享协议核心，零依赖纯 ESM，平铺 4 文件
    │   ├── core.js            #   createBus 协议机
    │   └── transport-node.js / transport-browser.js / package.json
    │   # markdown-go 已抽成独立 npm 包 @willianqrunning/markdown-go（不在本仓，web 直接依赖）
    ├── termd/                 # @pi-chamber/termd：★ 终端守护进程（独立进程，唯一持有 node-pty）
    │   ├── package.json       #   deps 只有 @lydell/node-pty + ws（★ 不依赖 bus）；exports 只暴露 spawn.js
    │   ├── src/
    │   │   ├── daemon.js      #   入口 `node src/daemon.js`：全装 —— shell 探测 + PTY 表 + WS 服务 + 鉴权 + 线协议
    │   │   ├── sessions.js    #   PTY 表 + 200KB 环形缓冲 + 16ms 合批 + 按字符切片 + **每连接 attach**（纯逻辑，可单测）
    │   │   └── spawn.js       #   「保证 termd 在跑」：探活/拉起/等就绪/请求退出（chamber 与 CLI 共用，零依赖）
    │   ├── scripts/
    │   │   ├── termd.mjs      #   启停控制器 start|stop|status|restart（stop 先 /shutdown 求它自己杀 PTY）
    │   │   └── smoke.mjs      #   直连 termd 的冒烟（23 项：鉴权/回放/每连接 attach/owner/关已退出的不崩）
    │   ├── test/              #   sessions 单测（17 项）
    │   ├── data/token         #   运行期：一行随机 token（gitignored；daemon 退出时删）
    │   └── logs 不再有         #   日志统一在仓库根 logs/（见上）
    ├── server/                # @pi-chamber/server：Express + WS
    │   ├── package.json
    │   ├── .env / .env.example          # .env 从 example 拷贝后填（gitignored）
    │   ├── src/               #   框架件 + 五个 Service 全平铺；Agent 域是唯一的文件夹
    │   │   ├── server.js  app.js  auth.js  config.js  logger.js  bus.js  ws.js   # 框架件
    │   │   ├── agent-service/          # Agent 域（唯一带子目录的：体量最大；各文件职责见文件头注）
    │   │   │   ├── index.js            #   名册表 + 焦点 activeId + 名册目录 cwd + 事件桥 + 生命周期 + prompt/abort + 翻页/补全 + 呆滞清理
    │   │   │   ├── commands.js         #   / 命令域（孤岛：不吃表不读焦点不摸 bus）
    │   │   │   └── messages.js         #   消息投影纯函数（首屏/实时/翻页三个消费者共用一套口径）
    │   │   └── nav-service.js  editor-service.js  stt-service.js  tts-service.js  term-service.js  # 其余五个 Service
    │   │                              # ↑ term-service.js 只做帧桥接（~190 行）：PTY 归 packages/termd，chamber 不碰 node-pty
    │   ├── data/              #   nav-state.json（导航位置现场，运行期产物）
    │   ├── scripts/           #   smoke.js / agent-smoke.mjs / prompt-smoke.mjs / web-smoke.mjs / term-smoke.mjs / tts-smoke.mjs
    │   └── test/              #   bus.test.js + 真服务 e2e：bus-e2e(3998) editor-e2e(3997) fsops-e2e(3996)
    └── web/                   # @pi-chamber/web：React 19 + antd 6 + zustand + Vite
        ├── package.json
        ├── vite.config.js     #   5173，代理 /api /ws → 3001
        ├── index.html
        └── src/
            ├── main.jsx  App.jsx（登录门控）  index.css
            ├── bus.js              # 前端总线单例 + 连接生命周期
            ├── api.js              # login / me
            ├── path-label.js       # 展示层路径归一（dispPath / relLabel）
            ├── lib/                # audio-player.js（朗读播放器：AudioContext 时间线预排，页面级单例）tts-text.js（朗读文本处理：切块 cutBlock + 清洗 cleanForSpeech，纯函数可单测）b64.js（终端流的字节↔base64）
            ├── layout/             # 平台分发 index + DesktopLayout + MobileLayout + ActivityBar
            ├── pages/              # 页面（一页一目录）
            │   ├── login.jsx
            │   ├── sessions/       #   Session 管理面板
            │   ├── chat/           #   消息流 index / MessageList / MessageBlock / InputBox / Palette（输入框补全面板：/ 命令 + @ 文件引用，规矩在 command-match.js / file-match.js）；朗读 UI：MessageList 右下浮钮+自动朗读开关 / MessageBlock 喇叭；按住说话在 InputBox
            │   ├── nav/            #   目录导航活动页（NavPage+行组件+弹窗+底部文件/文件夹搜索框全单文件）
            │   ├── editor/         #   编辑器活动页 index + CodeEditor（CodeMirror，懒加载）
            │   ├── terminal/       #   终端活动页 index（标题条/画布/TabBar）+ TermView（xterm 实例，懒加载）
            │   └── settings/       #   设置活动页（连接/账号/朗读音色·语速）
            ├── stores/             # 一域一 store（订阅在文件尾 bus.on 自挂；Actions 是纯函数对象，不进 hook）
            │   ├── index.js        #   聚合出口
            │   └── auth-store / sessions-store（名册：sync/patch 合并 + 五个上行动作）
            │       / chat-store（对话：chat.sync 字段级替换 + message/delta 草稿机 + notice）
            │       / nav-store / editor-store / ui-store / stt-store / tts-store（朗读调度，见 tts-store.js 头注）
            │       / term-store（终端控制面：名册 + owners + detach；★ 输出不进 store，直通 xterm 实例，见其头注）
            ├── theme/              # tokens.js（★视觉唯一真相）antd.js css.js platform.js terminal.js（xterm 16 色位由原色板派生）
            └── components/         # ConnStatus / MarkdownRenderer / CollapseCard / DirPicker
```

## 4. Bus 使用方法 + 全部通信协议

### 4.1 bus 协议机（`@pi-chamber/bus`）

**形态**：`createBus()` 造协议机（server 与 web 各持**进程内单例**）；transport 是唯一插线槽，WS 只是插在槽上的"网线"。投递只分两种：

- **事件（emit）**：单向通知。**本地永远先投一份**；`{net:true}` 且在线 → 再向网络复制一份。没人订阅就静默丢——发的人不管收没收到。
- **请求（request）**：一问一答。`net:false` 只问本地、`net:true` 只问对面（**单选**，避免双响应）。必须有人答：本地无 handler / 断线 / 超时 → reject。

**两条投递路径（一看就懂）**：

```
【事件：后端 → 前端】后端广播"名册变了"
  后端  bus.emit("agent.sessions.patch", { rows: [{ id, status: "running" }] }, { net: true })
        ├─ 本地：本进程订阅者收一份（没有则丢）
        └─ 网络：WS 发帧 {t:"e", e:"agent.sessions.patch", p:{rows:[…]}}
           前端 feed() 收帧 → 与本地事件走同一条广播 → 所有订阅者收到
```

```
【请求：前端 → 后端】前端问一句（回声/探活）
  前端  bus.request("ping", "hi", { net: true })
        └─ WS 发 {t:"q", e:"ping", p:"hi", id:"ab12cd34"}
           后端 feed() → 找到 ping 的 handler 执行 → 回 {t:"s", id, ok:true, data:{pong:…}}
             前端按 id 兑现 Promise（回执 ok:false / 超时 / 断线 → reject）
```

**真代码对照**（后端注册 / 前端调用，server.js 里现成的 ping）：

```js
// —— 后端（src/server.js）：注册应答方。返回 promise 也行；返回值即回执 data ——
bus.on("ping", async (payload) => ({ pong: Date.now(), you: payload }));

// —— 前端（任意组件/store）：请求，拿回执 ——
const r = await bus.request("ping", "hi", { net: true });
console.log(r);   // { pong: 172…, you: "hi" }

// 事件一对：后端广播（名册行变了）
bus.emit("agent.sessions.patch", { rows: [{ id, status: "running" }] }, { net: true });
// 前端订阅（来路不分本地/网络都收；重连后无需重订阅——订阅挂在 bus 上）
const off = bus.on("agent.sessions.patch", (p) => { /* 按 id 合并进列表 */ });
```

**接线细节**：

- **订阅不分来路**：`on()` 注册一次，本地广播与网络帧都触发同一回调；用 `meta` 可辨来路（`{net, from:"local"|"wire"|"bus", id?}`）。
- **回调形态 `fn(payload, meta, bus?)`**：payload = 业务数据（无则 null）；meta = 来路信息；**bus 由总线第三参注入**——要反手 emit/request 就声明第三参，不需要写 `(p)`/`(p, meta)` 即可（尾部可省）。
- **业务函数层不闭包捕获 bus**：谁需要 bus 就显式收参（如 `attachSession(sm, bus)`），由调用方从第三参拿到后传下去（曾有模块级 `busRef`，已废除）。
- **单连接独占**（WS 层）：新连接踢旧（旧收 close 4001 `"replaced"`）；心跳 60s，与业务无关。
- **系统事件** `$conn.open` / `$conn.close`：transport 插入/拔出广播（仅本地；`$` 前缀业务勿用）。

**线协议与健壮性**（一行 JSON 一帧，坏帧/未知帧型/迟到回执一律静默丢）：

```
{t:"e", e, p}              事件帧（emit net 广播）
{t:"q", e, p, id}          请求帧（request net）
{t:"s", id, ok:true,  data}    回执
{t:"s", id, ok:false, error}   失败回执
```

- **超时**：服务端单例 requestTimeout = 15s；测试/客户端自定 `{timeout}`。
- 拔线时在途 request 全部 reject；`net:true` 但没联网 → emit 静默丢、request reject `offline`。
- 请求 id：8 hex（32bit），`crypto.getRandomValues`（浏览器非安全上下文兼容）。

**前端接入**（web/src/bus.js 已实现）：先 `createBus()` 建单例，WS 四个回调接上即活：

```js
const ws = new WebSocket(`ws://host/ws?token=${token}`);
ws.onopen    = () => bus.attachTransport(browserTransport(ws));
ws.onmessage = (ev) => bus.feed(ev.data);
ws.onclose   = () => bus.detachTransport("ws closed");
```

### 4.2 全部通信协议总表

**读表约定**：`request` = web → server 有回执（失败走回执 throw）；`emit(w→s)` = web → server 单向事件，发完即忘零回执；`emit(s→w)` = server → web 推送，前端订阅消费（"发出参数"列即推送载荷）。事件名裸名无前缀。HTTP 两张（login/me）见 2.3，不入此表。

| 事件 | 类型 | 发出参数 | 返回参数 | 功能说明 |
|-|-|-|-|-|
| `agent.sessions.sync` | emit(s→w) | `{agents, selectedCwd, sessions}` | — | 名册全量：连接 / 换目录。`agents:[{cwd, basename, sessionCount}]`；`sessions:[{id, cwd, name, updateTime, messageCount, status}]`（只含 `selectedCwd` 这一个目录的场次） |
| `agent.sessions.patch` | emit(s→w) | `{agents?, rows?}` | — | 名册增量：其余所有名册变化（**不分焦点**，后台出勤的灯/条数也要动）。`rows` 元素 `{id, cwd, status?, messageCount?, updateTime?, name?, deleted?}`；`agents` 按 cwd 合并 |
| `agent.sessions.list` | emit(w→s) | `{cwd}` | — | 换目录（Agent 下拉）：服务端记下名册目录 `cwd` 并重推 sync；不动焦点，无失败路径 |
| `agent.chat.sync` | emit(s→w) | `activeId / cwd / messages / before / commands / model / thinkingLevel / steers / info / status` 的任意子集 | — | 对话：**字段级替换**（帧里出现的字段就是该字段的完整真值；不出现 = 前端不动它）。带 `activeId` 的整组帧只出现在连接 / open（必带全量，含 messages） |
| `agent.chat.message` | emit(s→w) | `{m, open?}` | — | 整条消息（**裸帧**，只发焦点）。`open:true` = 草稿；省略 = 终稿（整条替换那条草稿） |
| `agent.chat.delta` | emit(s→w) | `{ci, k:"t"\|"h"\|"c", x, name?}` | — | 内容增量（裸帧）：t=text / h=thinking / c=toolCall 参数；服务端攒够 **30 个 delta 事件**打包发一条 |
| `agent.chat.notice` | emit(s→w) | `{sessionId?, type:"error"\|"retry"\|"reload", message, attempt?, maxAttempts?, phase?, success?}` | — | 提示：error → 写 chat.error（不写 messages）；retry → 顶栏重试计数；reload → 写 chat.notice（`/reload` 回执，message = 服务端拼好的整句「重载了什么 + 诊断」，前端不解析）。带 sessionId 时前端据此清该行 pending |
| `agent.session.open` | emit(w→s) | `{sessionId}` | — | 档案 → 活跃运行时（幂等）+ 置焦；回帧 = `patch{rows:[{id,status}]}` + `chat.sync`（全量） |
| `agent.session.close` | emit(w→s) | `{sessionId}` | — | 收工：释放运行时、**保留档案**；命中焦点 → `chat.sync{activeId:null}` |
| `agent.session.create` | emit(w→s) | `{cwd}` | — | 新建幽灵出勤（惰性落盘）+ 置焦；回帧 = patch（插行 + agents 计数）+ chat.sync 全量 |
| `agent.session.delete` | emit(w→s) | `{sessionId}` | — | 销毁：释放运行时 + **删档案 jsonl（永久）**；SDK SessionManager 无删除 API（v0.84.4）→ 自补 `fs.unlink`，白名单只认 `<agentDir>/sessions` 内 .jsonl |
| `agent.session.prompt` | emit(w→s) | `{sessionId, text}` | — | 受理即走：空闲起一轮 / running 时插队（steer）/ 命中内置命令就地执行；**无回执**（输入框发出即清） |
| `agent.session.abort` | emit(w→s) | `{sessionId}` | — | 停止当前轮：clearQueue → abort 到 idle；幂等 |
| `agent.chat.more_messages` | request | `{sessionId, before}` | `{messages, before}` | 向前翻页（一页 20 条）：源 = 档案 `getEntries()`，从 `before` 沿 `parentId` 回溯 |
| `agent.chat.toolResult` | request | `{sessionId, toolCallId}` | `{text}` | 取被裁的 toolResult 全文（档案里按 toolCallId 找） |
| `nav.state` | emit(s→w) | `{current, cwd, items}` | — | 导航现场唯一真相流：$conn.open / nav.open 生效 / focused 联动 / **fs 写侧成功后补推**；items 现拉现给 |
| `nav.update` | emit(s→w) | `{add\|change:{type, name, abs_path}}` 或 `{remove:{abs_path}}` | — | watcher 增量：fs.watch 盯 current（depth 0），一条事件推一条 |
| `nav.open` | request | `{current}`（空 = 此电脑层） | `{ok}` | current 唯一手动改口；非目录/不存在抛错；状态由后续 nav.state 送达 |
| `fs.list` | request | `{path}`（空 = 根层） | `{items}` | 通用原语，无状态现拉现给（DirPicker/手动刷新用） |
| `fs.desktop` | request | — | `{desktop}` | 用户桌面目录（常见名探测，全无回主目录） |
| `fs.search` | request | `{query?, limit?, dirs?}` | `{cwd, items:[{path, name, isDir, description}]}` | 按名字搜「当前 Agent 空间」（焦点 session 的 cwd，无则 throw）：@ 文件引用补全 + 导航页搜索框共用。`dirs:false` 只回文件（默认 false 不传 = 文件+目录，@ 补全与导航页都吃默认）。`path` = cwd 相对 + 正斜杠，前端直接插进 prompt（**不展开文件内容**，与 pi TUI 一致）。零外部二进制：node `fs.glob` + `ignore` 包吃 `.gitignore`；空 query 列浅层全貌，有 query 打分（照抄 pi `scoreEntry`，**子串匹配非模糊**），结果缓存 10s（fs.* 写侧成功后清缓存，否则刚建/删的文件最多 10s 搜不到） |
| `fs.create` | emit(w→s) | `{parent, name, dir}` | — | 新建文件/目录；已存在跳过**不覆盖**；dotfile 名拒 |
| `fs.rename` | emit(w→s) | `{path, newName}` | — | 同目录换名；冲突（大小写不敏感）拒，**纯换大小写放行**；受保护目录拒 |
| `fs.delete` | emit(w→s) | `{path}` | — | **永久删除**（不进回收站），目录连子项递归；盘根/受保护拒 |
| `fs.move` | emit(w→s) | `{path, toDir}` | — | 移入目录；同名冲突/移进自己或子孙/跨盘（EXDEV）拒 |
| `nav.open_file` | request | `{path}` | `{ok, alreadyOpen}` | 浏览入口"打开到编辑器"；>500KB / 二进制拒；新开先推 `file_changed(new)` 再回执 |
| `editor.update` | request | `{path, content}` | `{ok}` | **显式保存（Ctrl+S/按钮）才发**；失败 throw（前端保持 modified） |
| `editor.files` | emit(s→w) | `{files:[{name, path, content}]}` | — | $conn.open 推全量现场（后端无持久化，重启即空 = 前端清场） |
| `editor.file_changed` | emit(s→w) | `{path, type:"new"\|"modify"\|"delete", name?, content?}` | — | new=新开；modify=外部改动（带全量 content）；delete=文件没了 |
| `editor.close_file` | emit(w→s) | `{path}` | — | 前端已本地删 tab，通知后端清理（出列 + unwatch） |
| `stt.audio` | emit(w→s) | `{chunk}`（base64 PCM16 16k mono） | — | 按住期每 ~250ms 一块；首块隐式开 run-task |
| `stt.end` | emit(w→s) | — | — | 放开：残余 flush 后发；后端 finish-task |
| `stt.partial` | emit(s→w) | `{text}` | — | 中间识别（定稿前缀+当前句）；前端只上提示条，不碰输入框 |
| `stt.final` | emit(s→w) | `{text}` | — | task-finished 整轮确认 → 一次性注入光标锚点（空文本跳过） |
| `stt.error` | emit(s→w) | `{message}` | — | 失败：停录 + 提示 |
| `tts.speak` | request | `{text}`；可带 `{rate, voice}`（语速 0.5~2 / 音色名） | `{ok, sampleRate}` | 文本进合成会话：无会话开 run-task、会话中 continue-task 追加；受理即回（流走 audio/end 事件）。拒（回执 throw）：无 key / 空文本 / 会话收尾中（finishing/cancelling） |
| `tts.audio` | emit(s→w) | `{chunk}`（base64 PCM16 单声道） | — | 合成音频流；一块 = 阿里一帧 binary；采样率 = 最近 speak 回执的 sampleRate（后端默认 22050） |
| `tts.finish` | emit(w→s) | — | — | 正常收尾：flush 阿里尾句，audio 照推完 → task-finished → `tts.end{done}`；无会话/已收尾中幂等忽略 |
| `tts.stop` | emit(w→s) | — | — | 打断：立即停推（后续 audio 帧丢弃）+ finish-task(cancel)；3s 阿里未回则兜底强收 → `tts.end{cancelled}` |
| `tts.end` | emit(s→w) | `{reason:"done"\|"cancelled"\|"error", error?}` | — | 会话终结，**必到一次**（会话收束后会话残留清零）；error 前端只记状态、有缓存照常续喂 |
| `tts.break` | request | — | `{ok, alreadyDown?}` | 测试口：断开与阿里的 WS（走真实断网同款 close 路径），会话内触发分层收束 |
| `term.list` | emit(s→w) | `{terms, shells, defaultShell}` | — | 终端名册全量：$conn.open / 每次增·删·退出·改尺寸；`terms:[{termId, cwd, shell, shellLabel, cols, rows, status, exitCode, startedAt}]`（status = running\|exited）；`shells:[{id,label}]` 是本机探测到的可用 shell（前端新建下拉用）。chamber 连 termd 时也拿它当 request 拉一次（回执同构，白送的便利） |
| `term.create` | request | `{cwd?, cols?, rows?, shell?}` | `{termId, cwd, shell, shellLabel, cols, rows}` | 起一个新终端（无上限）。cwd 省略 = chamber 注入「当前 Agent 空间」（nav 域的 cwd）；shell 省略 = termd 默认（Git Bash > PowerShell > cmd > WSL）。尺寸夹在 2~500 × 2~200，非法值走兜底 100×30 |
| `term.attach` | request | `{termId, cols?, rows?}` | `{data(base64), cols, rows, status, exitCode?, cwd, shell, shellLabel, startedAt, bytes, owner}` | 接管/恢复屏幕：回放该终端最近 200KB 原始输出的 base64（前端先 `reset()` 再整份写 = 一屏重画），之后转流式。**attach 是每连接的**：订阅只对这条连接生效，没 attach 就不发 output。`owner:true` = 本连接拿到 resize 权（第一个 attach 的；它断开/退订后移交下一个） |
| `term.detach` | emit(w→s) | `{termId}` | — | 退订：不再给这条连接推这个终端的 output（面板卸载 / 切走活动页时发）。**只是不再收** —— 终端照跑、其他订阅者照收、环形缓冲照存 |
| `term.output` | emit(s→w) | `{termId, data(base64)}` | — | 终端输出流：**只发给 attach 过它的连接**；16ms 合批 / 单帧 ≤ 8000 字符（不切开多字节字符）。base64 理由是 PTY 输出是 UTF-8 **字节**流（与 stt/tts 传 PCM 同套路） |
| `term.input` | emit(w→s) | `{termId, data(base64)}` | — | 键盘/粘贴原样透传（方向键、Ctrl+C 等由 xterm 编成终端字节序列）。**不分 owner**（终端是共享资源，谁都能打字）；已退出 → 静默丢 |
| `term.resize` | emit(w→s) | `{termId, cols, rows}` | — | 容器尺寸变化（FitAddon 量完就发）。**只有 owner 的生效**（PTY 只有一个尺寸，多窗口看同一终端时后到的窗口不该把画面改乱）；尺寸没变不发、已退出不真 resize（仍记下新尺寸）。尺寸真变了会推 `term.list`（前端顶部条读它） |
| `term.close` | emit(w→s) | `{termId}` | — | 关终端：**真杀进程** + 出列（幂等，重复/迟到帧无事）。已退出的终端只出列不 kill（node-pty 在 Windows 上 kill 已退出的 PTY 会异步抛） |
| `term.exit` | emit(s→w) | `{termId, code, signal}` | — | PTY **自己**退出（敲 exit / 崩溃），**必到一次**，广播给所有连接；会话**不删档**（屏幕还在、还能重连），只有 close 才出列。用户主动 close 的不发这条（区分"我关的"与"它自己死的"） |

**载荷形状**（字段只在这里写一次；前端实现见 `web/src/stores/{sessions,chat}-store.js` 文件头注）：

```js
// 行（名册）—— status 五值全可能；chat 只用 idle/pending/running/compacting
type Status  = "offline" | "idle" | "pending" | "running" | "compacting"
type Session = { id, cwd, name, updateTime, messageCount, status }
                 // ★ 无 createTime（服务端从不发）：排序只用 updateTime
                 // name = sessionName || 首条用户消息 || ""（服务端合成）

// 消息（chat.message.m 与 chat.sync.messages[] 同构；read 已删，不再有第二套形状）
type Message = {
  key?            // 前端本地自增（服务端不发 id）：★ 不能用下标派生，翻页前插会让 key 全位移
ts, text          // ISO / 摊平文本（纯文本渲染 + 朗读用）
  open?           // 草稿标记（前端落地）
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom"
      | "compactionSummary" | "branchSummary"
}
// 角色附加：assistant → blocks/stopReason/model/usage/errorMessage；toolResult → toolCallId/toolName/isError
//   bashExecution → command/exitCode/cancelled/truncated；custom → customType/display；*Summary → error:true（压缩失败）
// blocks 元素：{ ci, type: "text"|"thinking"|"toolCall"|未知, text?|args?|raw?, id?, name?, redacted? }

// info（chat.sync.info）
type Info = { input, output, cacheRead, cacheWrite, cost,        // = getSessionStats()
              contextTokens, contextPercent, contextWindow }    // = getContextUsage()；contextTokens 可为 null
```

**表后注**：

- **三条写规则（前端）**：① 本端发上行帧（open/close/delete/prompt/abort）先置 `pending`（写行；create 例外 = creating 按钮 loading），此后一律由帧写真值；**pending 只是本地暂态，任何真值帧都覆盖它**。② status 只由后端推导（`isCompacting→compacting` / `isStreaming→running` / 否则 `idle`；行另有 `offline` = 只有档案、运行时不在册），前端不推导。③ 名册合并：`sync` 整组替换；`patch` 按 id/cwd 合并（缺的字段不动、`deleted` 删行），**插入新行前校验 `row.cwd === selectedCwd`**（patch 是全员广播，不校验就串台）。
- **每条上行帧必须有"结束帧"**：成功靠事件桥（agent_start / settled / queue_update / compaction_*），失败/被拒由 handler 自己补推真值帧（patch，必要时 chat.sync）+ `notice{type:"error"}`。三条路到不了事件桥：SDK 的 `abort()` 在空闲时不发 settled、open 档案不存在没有 sync、prompt 压缩中被拒不上事件桥 —— 不补帧前端就永久卡 pending。
- **status 不许硬编码**：凡"改完状态顺手推一发"处（open handler / 命令 handler / compaction_end / abort 兜底）都现查 `isCompacting / isStreaming`。例：`compaction_end` 那刻 isCompacting 已 false，但自动压缩发生在 run 中间 → isStreaming 仍 true ⇒ 推 `running`（推死 `idle` 会让灯灭、输入框误判空闲、live 朗读被提前收尾）。
- **内容流是裸帧**（`chat.message` / `chat.delta`）：不带 sessionId —— 只发 activeId 那一场（服务端焦点闸），单条 WS 严格有序。前端只认两条规则：**草稿不变式**（同一时刻最多一条草稿、且永远是最后一条）+ **delta 只进最后一条 open 草稿**（没有草稿就丢，绝不去改已完成的消息）。
- **delta 攒批按事件数不按字符数**（中英 token 粒度差太多，按字切会把英文单词拦腰截断）：攒够 30 个 `*_delta` 事件发一条；块 `*_end` 零头照发、`message_end` 残余兜底；`message_start` 作废上一代零头；焦点变（activeId 变）整体清空。SDK 每个 `message_update` 都自带 `partial` 全量快照 → 丢在服务端不上线（流量大头）。
- **草稿的两处补丁**：① 首屏 `chat.sync.messages` 末尾会挂一条 `open:true` 在途草稿（`state.streamingMessage` 不在 `state.messages` 里，不挂就干等 message_end）；② `toolcall_start` 的 name 可能是空串（OpenAI 系在 name 之前就 push 了 start）→ 允许后续 delta 补带。
- **消息投影**（`agent-service/messages.js`，首屏/实时/翻页三个消费者共用一套，口径必须一致）：时间戳统一 ISO；`toolResult.text` 裁到前 50 字 + `truncated:true`（展开时走 `chat.toolResult` 要全文）；assistant 的 `blocks` 带 `ci`（= content[] 下标，实时 delta 按 ci 入格）。角色附加字段：assistant `stopReason/blocks/model/usage/errorMessage`；toolResult `toolCallId/toolName/isError`；bashExecution `command/exitCode/cancelled/truncated`；custom `customType/display`；usage 精简 `{input,output,cacheRead,cacheWrite,total,cost}`。压缩/分支摘要是独立档案 entry（`type:"compaction"/"branch_summary"`，文本在 `entry.summary`）→ 投影成 `compactionSummary`/`branchSummary` 角色。
- **info 口径**：`info` = `getSessionStats()`（`tokens.*` + `cost`，**整场累计含被压缩掉的历史**）+ `getContextUsage()`（`contextTokens/contextPercent/contextWindow`；刚压缩完 tokens 为 `null` → 前端不显示）。
- **prompt 语义**：空闲 = 起一轮（run）；running 期间输入自动走 SDK 插队（steer）—— 立即中断当前生成、等手头 toolCall 收尾再投递，被插的 run 不落定。忙闲唯一判据 = `AgentSession.isStreaming`（SDK 真值，服务端不另存状态）。被拒（压缩中/没模型）会吞掉这条文字 —— 已知并接受。
- **命令分诊**：`promptSession` 最前面拦一道，命中 `BUILTINS`（`/model` `/name` `/level` `/compact` `/reload`）就地执行：**不起 run、不产生用户消息、不进 transcript**；未命中原样下传（扩展命令 / 模板 / skill 由 SDK 内部处理，未知命令当普通文本）。执行完（成功或失败）一律 `refreshFocus` 补推真值 + 命令清单（`/model` `/level` 改的是 SDK 内部状态，不进 `session.subscribe` 桥）；run **可返回 `{notice:{type,message}}`**，由分诊统一推 notice 帧（命令体保持不碰总线，文案自己拼）—— 目前只有 `/reload` 用（成功无独立帧，回执就靠它）。**命令一律不挡忙**（学 pi TUI：命令分支写在 `isStreaming` 之前）—— 忙时 `/compact` 会掐掉当前 run（已生成的那半截不丢，收成一条 `stopReason:"aborted"` 的消息），`/reload` 行为未定义；取舍已知并接受。
- **压缩（B4）**：SDK 不走 message 流，只发 `compaction_*` → 复用「草稿 → 终稿」：start 插 `compactionSummary` 占位（open:true）、end 用 `result.summary` 替换（失败给 `errorMessage` + `error:true`，**不弹 notice**，错误写在那条折叠条里）。成败必到一次 end。顺序：手动 `/compact` = `settled` → `start` → `end`（`compact()` 首行 `await abort()`，其内 `waitForIdle` 卡到 settled 广播完）；自动阈值 = `start` → `end` → `settled`。
- **消息获取（首屏 / 翻页 / 补全）**：都在内存对象上，零 IO。首屏 = `chat.sync{messages}`（`agentSession.messages` 全量投影 + 在途草稿）+ `before` 游标；`before` 算法 = `buildContextEntries()[0].parentId`（★ 不是"getEntries() 里找前一条"：那是文件行序，分叉档案会走到别的分支；压缩后 compaction entry 的 parentId 正好 = 最后一条被压掉的条目）。翻页一页 20 条、沿 parentId 回溯；游标值对前端**不透明**（服务端生成、前端原样回抄）。**接缝取舍已知**：首屏是「压缩摘要 + 保留尾」，往上翻翻到的是摘要之前的原文，两套并存（不做前端缓存、不重排）；翻出来的老消息只增不删，切会话随 sync 一起丢弃。
- **裸帧与广播的边界**：内容帧 + `chat.sync` 不带 sessionId（靠服务端焦点闸 + 单连接有序）；带 sessionId 的只有 `sessions.patch` 的 rows 与 `notice`。**多终端**：服务端 `cwd` 会被任一终端的 `agent.sessions.list` 改写；前端 `selectedCwd` 只在连接时采纳一次，之后是纯前端变量（焦点 `activeId` 服务端唯一）。**行的 `messageCount`/`updateTime` 现算不读盘**，与连接时读盘值有微小差异，接受。
- **旧帧全删**：`agent.list`、`agent.session.list/read/state/focused`、`agent.session.message_start/delta/message_end/busy/settled/queue/renamed/retry/compaction/error/commands` —— 由名册两帧 + 对话四帧取代。
- **fs 写侧零回执**：发完即关弹窗，不做乐观增删；回显 = watcher 增量（rename = 旧名 remove + 新名 add）+ 成功后服务端补一次全量。失败唯一征兆 = 列表没动 + 服务端 `[fs]` 日志。
- **命令清单**（`agent.session.commands`）：四源合并照抄 pi 的 `createBaseAutocompleteProvider` 口径——内置表（有 dispatch 的才进清单）→ 扩展命令（与内置**同名**跳过，比的是 `cmd.name`）→ prompt 模板 → skill（受 `enableSkillCommands` 开关，默认开）。二级参数池随清单全量推：`/model` 走 `scopedModels / modelRuntime.getAvailableSnapshot()`、`/level` 走 `getAvailableThinkingLevels()`、扩展命令走 `getArgumentCompletions("")`（约定空前缀 = 全量，抛错/返空则降级为无二级）。清单在 attach 时懒建缓存（`entry.commandsPromise`，扩展补全要 await），失败不缓存。
- **TTS 会话模型**（语音输出）：一次"会话" = 首个 `tts.speak` 受理起、至 `tts.end` 止；会话中再 speak = 阿里 duplex continue-task 追加（后端自动切段，单次 ≤20000 字符），收尾中拒接。rate/voice 随 speak 携带、run-task 定死——会话中改只对下个会话生效。厂商壳与自愈全在后端：task_id 是会话内锚（迟到旧任务帧丢）、未出声断线自动换 task_id 重连整段重放（仅一次）、已出声则 `end{error}` 不重放；浏览器断线清在途会话。与 STT 各持一条阿里面向 WS（同 socket 只能跑一个在途任务）；实现唯一真相 = tts-service.js 文件头注。
- **朗读两态**（前端 tts-store.js）：manual = 点消息喇叭朗读整条（抢权，正在跟读也停）；live = 开"自动朗读"后、`chat.message{open:true, role:"assistant"}` 到达时真空闲接管，之后 `chat.delta`（k="t"）随流注入、`chat.sync` 里 status 回到 `idle` 收尾（compacting 不算收尾：自动压缩之后正文还没完），任何停止/播完归位 manual（live 不回魂，下条草稿出生 + 开关才可能再接管）。live 只跟当前焦点内容流——内容帧裸帧无 sessionId，靠服务端焦点闸天然只发焦点，不串会话。喂送调度（2s 轮询补水 / 在途块锁 / 句末切块防阿里缓存）见 tts-store.js 头注；**切块与清洗规则**（一趟逐字符扫描计分：中文字/句末标点 4 分、英文字母 1 分；满 400 分遇句末标点就切，满 800 分硬切 → 中英读出来时长齐平；分割符 = 中文句末 / 换行 / 英文句号+空白；块尾必带句末标点，硬切则补；内部顺带洗 markdown 链接与符号）见 lib/tts-text.js。
- **终端域（term.*）**：**chamber 不持有 PTY**。帧实际跑在 chamber 与独立守护进程 `termd` 之间（`packages/termd`），chamber 只做帧桥接（`server/src/term-service.js`，~190 行）。四条关键规矩：
  ① **termd 不用 bus**：它不是 chamber 的模块，是它的**子进程**，自带一套 40 行线协议（`{t:"e",e,p}` / `{t:"q",e,p,id}` / `{t:"s",id,ok,data}`，见 daemon.js 头注）。chamber 侧就是一个 WS 客户端 + 三张白名单（下行 `list/output/exit`、上行 `input/resize/close/detach`、问答 `create/attach`）—— 不碰主 bus 的 transport 槽。
  ② **上行转发必须卡 `meta.from === "wire"`**：bus 的 emit 无论 net 与否都先本地广播一份，不卡就会「自己 emit 的帧被自己的 handler 收回再 emit」，栈爆（真踩过）。
  ③ **attach 是每连接的**：`s.attachedTo` 是订阅者集合，output 只单播给它们；`attach` 时**先把欠账 flush 给老订阅者再把自己加进去**（否则要么老订阅者丢字节、要么新订阅者收到重复）。连接断开必须 `dropConn`（否则 Set 泄漏 + 往死 socket 写）。
  ④ **角色分工**：cwd 由 chamber 注入（显式给的优先 → 否则 nav 域 `navState().cwd` = 焦点 Session 的 Agent 空间 → 再否则 termd 自己的 cwd）；PTY 生死、缓冲、尺寸归 termd。
- **尺寸归 owner**：PTY 只有一个尺寸，而每个前端窗口的 FitAddon 量出的列数不同。第一个 attach 的连接成为 owner，只有它能改 PTY 尺寸（非 owner 的窗口不发 resize，画面可能与该 PTY 尺寸不一致 —— 已知且接受，胜在不会互相改乱）；owner 断开/退订时移交给下一个订阅者。
- **`uncaughtException` 兜底不能省**：守护进程的存活 > 单次操作的完整性 —— 它一死所有 PTY 陪葬。node-pty 在 Windows 上偶有异步抛错（`kill` 一个已退出的 PTY 会让 `_getConsoleProcessList()` 拿到 `undefined` 后 `.forEach` 崩，`try/catch` 抓不住），所以 daemon 里既接住未捕获异常，`killPty` 里也跳过已退出的会话。
- **端口固定 + 单实例闸**：默认 `127.0.0.1:3002`（`TERMD_PORT` 可覆盖）。daemon 启动时 `listen` 撞 `EADDRINUSE` 即放弃退出 —— 比读 pid 文件可靠，且**必须在写 token 文件之前**判定（否则会覆盖活着的 daemon 的 token）。
- **终端为何独立进程**：PTY 子进程挂在“谁起了它”这棵进程树下。Windows 的 ConPTY 不会因父进程被杀而连带收掉子进程（**实测**：强杀 node 后 bash 存活并继续干活）→ 若由 chamber 起 PTY，每次后端重启都攒一批“看不见、关不掉”的孤儿 shell。交给不重启的 termd 之后：chamber 重启 = 断线重连，前端自动重新 `attach` 回放断线期间的输出；termd 退出时**由它自己** kill 全部 PTY（它是直接父进程，这活儿只有它干得干净）—— 所以 `CLI stop` 先打 `HTTP /shutdown` 请它优雅退出，硬杀只当兜底。
- **终端名册与前端**：名册全量 = `term.list`（前端整组替换），chamber 缓存最近一份、在 $conn.open 时直接喂给前端；termd 断线时 chamber 推**空名册**（诚实：现在够不着）。前端 `term-store` 是**控制面**：输出**不进 store**（模块级 `sinks: Map<termId, xterm>`，`term.output` 直通 `write()`，零 React 重渲染，同 audio-player 单例思路）；`epoch`（$conn.open 自增）驱动 TermView 重新 attach。前端重连/刷新 = reset + 整份回放（**原始字节重放**，不做服务端终端模拟），200KB 缓冲按 onData 整块丢最老的 → 重放打头**可能**是半条转义序列（已知且接受）。
- **demo 协议**（server.js 顶部示例，非业务）：`echo`/`echo.reply`、`ping`（request 探活）、`whoami`（抛错示例）、`conn.welcome`。

