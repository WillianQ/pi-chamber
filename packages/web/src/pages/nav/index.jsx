// 导航活动页（原 components/DirBrowser.jsx 整体收编于此，导航域前端单文件）。
// 数据源 = nav store：状态由服务器 nav.state/nav.update 推送驱动，本页只展示 + 发 nav.open/fs.*。
// 布局与聊天页对齐：顶部细条=当前目录相对路径（高度同 chat 顶栏）；底部动作行=新建文件/新建文件夹/
// 回到 Agent 目录/上一级。
// 搜索：底栏上方一个搜索框，在 **cwd 全空间**里搜文件名（复用服务端 fs.search），结果替换上方列表；
//   点文件 = 开进编辑器，点文件夹 = 跳进去；↑↓ 选、Enter 开、Esc 退出。只搜名字，不搜内容。
//   纯前端临时态，不落 store。
//
// 文件操作（新建/重命名/移动/删除）= 五个 fs.* 事件，纯 emit 无回执：发完即完，
// 列表变化由服务端 watcher + pushState 补推收敛（失败的唯一征兆 = 列表没动 + 服务端日志）。
// 每行的操作弹窗"对象自治"：状态住在 DirItem 自己身上（同文件内函数组件），页面层零锚点 state；
// 页面唯一 state = creating（新建钮住底栏，是页面的对象，不归任何行）。
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Breadcrumb,
  Button,
  Flex,
  Input,
  Modal,
  Popconfirm,
  Spin,
  Typography,
} from "antd";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOutlined,
  HomeOutlined,
  SearchOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { T } from "../../theme/tokens.js";
import { bus } from "../../bus.js";
import { useNavStore, upPath } from "../../stores/nav-store.js";
import { useEditorStore } from "../../stores/index.js";
import DirPicker from "../../components/DirPicker.jsx";
import { dispPath, crumbChain } from "../../path-label.js";

// 本地拼路径（仅前端发 fs.create 用；分隔符跟随 parent 原生风格，不碰 store 原始值）
const joinPath = (parent, name) =>
  parent.replace(/[\\/]+$/, "") + (parent.includes("\\") ? "\\" : "/") + name;

// 名字合法性（与服务端闸口同款前置，只为即时反馈；真闸口在服务端）
const badName = (n) => !n || /[\\/]/.test(n) || n === "." || n === "..";

export default function NavPage() {
  const { current, cwd, items, busy, error } = useNavStore();
  const navigate = useNavStore((s) => s.navigate);
  const goUp = useNavStore((s) => s.goUp);
  const toAgentCwd = useNavStore((s) => s.toAgentCwd);

  // 文件单击 → 打开进编辑器（目录单击仍是进入）；打开失败留在导航页，err 由本面板底部横幅提示
  const openFile = useEditorStore((s) => s.openFile);
  const editorError = useEditorStore((s) => s.error);
  const clearEditorError = useEditorStore((s) => s.clearError);

  const [creating, setCreating] = useState(null); // null | "file" | "dir"（新建是底栏的对象）
  const [query, setQuery] = useState(""); // 搜索关键字（空 = 正常浏览；非空 = 结果替换上方列表）
  const search = useFileSearch(query, cwd);
  const searching = query.trim().length > 0;
  const selIdx = search.hits.length ? Math.min(search.sel, search.hits.length - 1) : 0;

  // 结果打开：文件夹 → 跳进去（清搜索，看目录内容）；文件 → 开进编辑器（留搜索态，方便连开多个）
  const openHit = (hit) => {
    if (!hit) return;
    const abs = absFromRel(cwd, hit.path);
    if (hit.isDir) {
      setQuery("");
      navigate(abs);
    } else {
      openFile(abs);
    }
  };

  // 搜索框键盘：Esc 清空退出；↑↓ 选；Enter 打开当前选中（默认首条）
  const onSearchKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      return;
    }
    if (!search.hits.length) return;
    const n = search.hits.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      search.setSel((selIdx + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      search.setSel((selIdx - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openHit(search.hits[selIdx]);
    }
  };

  const canUp = upPath(current) !== null;
  const locked = !current; // 此电脑层（盘符列表）：行不摆操作钮
  const cwdKey = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase();
  const isCwdIt = (it) => it.type === "directory" && cwd && cwdKey(it.abs_path) === cwdKey(cwd);
  const onEnter = (it) => (it.type === "directory" ? navigate(it.abs_path) : openFile(it.abs_path));
  // 同名探测（弹窗即时反馈用；大小写不敏感，排除自身原名）
  const clashing = (name, except) =>
    items.some((x) => x.name !== except && x.name.toLowerCase() === name.toLowerCase());

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: T.color.panelBg,
      }}
    >
      {/* header：当前目录路径（相对），高度与 chat 顶栏对齐 */}
      <Flex
        align="center"
        style={{
          minHeight: 32,
          flexShrink: 0,
          paddingInline: 12,
          borderBottom: `1px solid ${T.color.hairline}`,
        }}
      >
        <Crumbs current={current} cwd={cwd} onJump={navigate} />
      </Flex>

      {/* body：条目列表（行高/字号/图标与 Session 列表同风格；每行对象自治，见 DirItem） */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0" }}>
        {searching ? (
          search.hits.length ? (
            search.hits.map((hit, i) => (
              <SearchRow
                key={hit.path}
                hit={hit}
                q={query.trim()}
                active={i === selIdx}
                onOpen={() => openHit(hit)}
              />
            ))
          ) : search.pending ? (
            <Flex align="center" justify="center" style={{ height: "100%" }}>
              <Spin size="small" />
            </Flex>
          ) : (
            <Typography.Text
              type={search.error ? "danger" : "secondary"}
              style={{ display: "block", textAlign: "center", marginTop: 28 }}
            >
              {search.error ?? "没有匹配的文件/文件夹"}
            </Typography.Text>
          )
        ) : busy ? (
          <Flex align="center" justify="center" style={{ height: "100%" }}>
            <Spin size="small" />
          </Flex>
        ) : items.length === 0 ? (
          <Typography.Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 28 }}>
            {current ? "空目录" : "没有可访问的磁盘"}
          </Typography.Text>
        ) : (
          items.map((it) => (
            <DirItem key={it.abs_path} item={it} locked={locked || isCwdIt(it)} onEnter={onEnter} clashing={clashing} />
          ))
        )}
      </div>

      {/* 错误提示（导航现场不动，仅告知；editor 的打开失败也在这露脸——失败时人还在导航页） */}
      {editorError && (
        <Alert
          type="error"
          message={editorError}
          showIcon
          banner
          style={{ borderRadius: 0 }}
          closable
          onClose={clearEditorError}
        />
      )}
      {error && (
        <Alert type="error" message={error} showIcon banner style={{ borderRadius: 0 }} closable={false} />
      )}

      {/* 搜索行：cwd 全空间找文件名（结果替换上方列表；✕ / Esc 退出回列表） */}
      <Flex align="center" gap={8} style={{ flexShrink: 0, padding: "8px 10px 0" }}>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: T.color.textMuted }} />}
          placeholder={cwd ? "搜索文件 / 文件夹名（整个 Agent 空间）" : "先打开一个 Session"}
          disabled={!cwd}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
      </Flex>

      {/* footer：两排默认尺寸按钮（上排新建双钮 / 下排导航双钮），高度与 chat 输入区动作行对齐节奏 */}
      <Flex vertical gap={8} style={{ flexShrink: 0, borderTop: `1px solid ${T.color.hairline}`, padding: 10 }}>
        <Flex gap={8}>
          <span style={{ flex: 1 }}>
            <Button block icon={<FileAddOutlined />} disabled={locked} onClick={() => setCreating("file")}>
              新建文件
            </Button>
          </span>
          <span style={{ flex: 1 }}>
            <Button block icon={<FolderAddOutlined />} disabled={locked} onClick={() => setCreating("dir")}>
              新建文件夹
            </Button>
          </span>
        </Flex>
        <Flex gap={8}>
          <span style={{ flex: 1 }}>
            <Button block icon={<HomeOutlined />} onClick={toAgentCwd}>
              回到cwd
            </Button>
          </span>
          <span style={{ flex: 1 }}>
            <Button block icon={<ArrowLeftOutlined />} disabled={!canUp} onClick={goUp}>
              上一级
            </Button>
          </span>
        </Flex>
      </Flex>

      {creating && (
        <CreateModal kind={creating} current={current} clashing={clashing} onClose={() => setCreating(null)} />
      )}
    </div>
  );
}

// 面包屑（header 路径段可点跳转）= antd Breadcrumb items API：段自带 onClick，
// 中间折叠段用 items[].menu（组件内置 dropdown，不再手挂 Dropdown）。
// 超 MAX_CRUMBS 掐中间保头尾：首段 + 末两截直显，其余进 menu。
// 跳转用段回拼 "/" 风格路径：服务端 path.resolve 归一后与原生写法等价（已拍板：
// 同盘两种写法共存，比对全走 lowercase+归一键；editor 寻址按 openFile 时的原始 abs_path，不受影响）。
const MAX_CRUMBS = 4;

function buildCrumbs(current, cwd) {
  const chain = crumbChain(current);
  if (!cwd || chain.length === 0) return chain;
  const ck = dispPath(cwd).replace(/\/+$/, "").toLowerCase();
  const idx = chain.findIndex((s) => s.abs.replace(/\/+$/, "").toLowerCase() === ck);
  if (idx < 0) return chain; // 越出 cwd：相对前缀不成立，全绝对展示（首截=盘符/根）
  return [{ label: ".", abs: cwd }, ...chain.slice(idx + 1)]; // cwd 及以上整压成一截（显 "."，分隔符归 Breadcrumb 自画，不出 ".//"）
}

// ── 文件搜索（只搜文件名，cwd 全空间） ────────────────────────────────────────

const SEARCH_LIMIT = 50; // 服务端封顶 200；面板窄，50 条足够翻
const SEARCH_DEBOUNCE = 120; // 敲键别一字符一往返（与 chat 的 @ 补全同节奏）

/**
 * cwd 全空间搜文件/文件夹（request，有回执）。纯前端临时态，不进 nav store（铁律：store 只镜像服务端推送）。
 *  - alive 旗丢陈旧响应：bus.request 不可取消，慢响应后到会盖掉新结果
 *  - 换 Agent 空间（cwd 变）自动重搜；没开 Session 时服务端 throw → error 落到列表区
 */
function useFileSearch(query, cwd) {
  const [hits, setHits] = useState([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(0);
  const q = query.trim();

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (!q) {
      setHits([]);
      setPending(false);
      setError(null);
      return;
    }
    let alive = true;
    setPending(true);
    const timer = setTimeout(async () => {
      try {
        const r = await bus.request("fs.search", { query: q, limit: SEARCH_LIMIT }, { net: true });
        if (!alive) return;
        setHits(r?.items ?? []);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setHits([]);
        setError(e?.message ?? "搜索失败");
      } finally {
        if (alive) setPending(false);
      }
    }, SEARCH_DEBOUNCE);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, cwd]);

  return { hits, pending, error, sel, setSel };
}

/** cwd 相对路径（服务端口径：正斜杠）→ 原生绝对路径（openFile / navigate 用） */
function absFromRel(cwd, rel) {
  if (!cwd) return String(rel ?? "");
  return joinPath(cwd, String(rel).replace(/\//g, cwd.includes("\\") ? "\\" : "/"));
}

/** 名字里命中子串上色（服务端子串匹配，非模糊，所以命中处只有一段） */
function NameHit({ text, q }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ color: T.color.primary }}>{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

/** 搜索结果行：主行 = 名字（命中上色），次行 = 所在目录（cwd 相对）；点文件夹 = 跳进去，点文件 = 开进编辑器 */
function SearchRow({ hit, q, active, onOpen }) {
  const isDir = !!hit.isDir;
  const Icon = isDir ? FolderOutlined : FileOutlined;
  return (
    <Flex
      align="center"
      gap={10}
      className="pc-dirrow"
      onClick={onOpen}
      style={{
        cursor: "pointer",
        padding: "6px 12px",
        borderRadius: T.radius.sm,
        fontSize: T.fontSize.sm,
        background: active ? T.color.activeRowBg : undefined,
      }}
    >
      <Icon style={{ fontSize: T.icon.sm, color: isDir ? T.color.textPrimary : T.color.textMuted, flexShrink: 0 }} />
      <Flex vertical style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isDir ? T.color.textPrimary : T.color.textMuted,
          }}
        >
          <NameHit text={hit.name} q={q} />
        </span>
        <span
          style={{
            fontSize: T.fontSize.xs,
            color: T.color.textFaint,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {hit.description || "."}
        </span>
      </Flex>
    </Flex>
  );
}

function Crumbs({ current, cwd, onJump }) {
  const jump = (abs) => onJump(abs === "/" ? "" : abs); // POSIX 根 = 此电脑层（nav.open 空串）
  let items;
  if (!current) {
    items = [{ title: "此电脑" }]; // 根层无路径可跳，单段文本（Breadcrumb 末段自动深色态正合适）
  } else {
    const crumbs = buildCrumbs(current, cwd);
    const crumbItem = (c) => ({
      title: c.label,
      onClick: () => jump(c.abs),
    });
    const tailKeep = MAX_CRUMBS - 2;
    items =
      crumbs.length > MAX_CRUMBS
        ? [
            crumbItem(crumbs[0]),
            {
              title: "…",
              menu: {
                items: crumbs.slice(1, crumbs.length - tailKeep).map((h) => ({ key: h.abs, label: dispPath(h.abs) })),
                onClick: ({ key }) => jump(key),
              },
            },
            ...crumbs.slice(crumbs.length - tailKeep).map(crumbItem),
          ]
        : crumbs.map(crumbItem);
  }
  return (
    <Breadcrumb
      items={items}
      separator="/"
      styles={{
        root: {
          minWidth: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
          fontFamily: T.fontFamily.mono,
          fontSize: T.fontSize.xs,
          lineHeight: "20px", // 压回顶栏 minHeight 32 的节奏
        },
        separator: { color: T.color.textMuted },
      }}
    />
  );
}

// 目录条目行（对象自治）：hover 钮显隐 = 纯 CSS（.pc-dirrow :hover → .pc-acts）；
// 重命名/移动弹窗状态住本组件；删除 = Popconfirm 自带无控。全部只有两个布尔。
function DirItem({ item, locked, onEnter, clashing }) {
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false); // DirPicker 懒挂载：任意时刻全页至多一个实例

  const isDir = item.type === "directory";
  const Icon = isDir ? FolderOutlined : FileOutlined; // 同族线形图标：形状区分类型，颜色随行文字

  return (
    <>
      <Flex
        align="center"
        gap={10}
        className="pc-dirrow"
        onClick={() => onEnter(item)}
        style={{
          position: "relative",
          padding: "6px 12px",
          cursor: "pointer",
          fontSize: T.fontSize.sm, // 名字 = 正文档；与 Session 主行同档
          color: isDir ? T.color.textPrimary : T.color.textMuted,
          borderRadius: T.radius.sm,
        }}
      >
        <Icon style={{ fontSize: T.icon.sm, color: "inherit" }} />
        <span className="pc-dirname">{item.name}</span>

        {!locked && (
          <Flex gap={2} className="pc-acts" onClick={(e) => e.stopPropagation()}>
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRenaming(true)} />
            <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => setMoving(true)} />
            <Popconfirm
              title={`「${item.name}」将被永久删除${isDir ? "（含全部子项）" : ""}`}
              okText="删除"
              okButtonProps={{ danger: true }}
              onConfirm={() => bus.emit("fs.delete", { path: item.abs_path }, { net: true })}
            >
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Flex>
        )}
      </Flex>

      {renaming && <RenameModal item={item} clashing={clashing} onClose={() => setRenaming(false)} />}
      {moving && (
        <DirPicker
          open
          title="移动到…"
          okText="移入此目录"
          onClose={() => setMoving(false)}
          onPick={(dir) => {
            setMoving(false);
            bus.emit("fs.move", { path: item.abs_path, toDir: dir }, { net: true });
          }}
        />
      )}
    </>
  );
}

// 重命名弹窗：只在打开时挂载（关即卸，无残状态）；预聚焦只选词干（扩展名不是要改的东西）
function RenameModal({ item, clashing, onClose }) {
  const [name, setName] = useState(item.name);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.input;
    if (!el) return;
    el.focus();
    const dot = item.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : item.name.length);
  }, []);

  const clash = !badName(name) && clashing(name.trim(), item.name);
  const bad = badName(name) || name.startsWith(".") || clash;
  const submit = () => {
    if (bad) return;
    onClose();
    bus.emit("fs.rename", { path: item.abs_path, newName: name.trim() }, { net: true });
  };
  return (
    <Modal open title={`重命名「${item.name}」`} okText="重命名" okButtonProps={{ disabled: bad }} onOk={submit} onCancel={onClose}>
      <Input ref={ref} value={name} onChange={(e) => setName(e.target.value)} onPressEnter={submit} status={bad && name ? "error" : undefined} />
      {name.startsWith(".") ? (
        <Typography.Text type="danger" style={{ fontSize: T.fontSize.xs }}>不能以 . 开头（列表隐身）</Typography.Text>
      ) : clash ? (
        <Typography.Text type="danger" style={{ fontSize: T.fontSize.xs }}>本目录已同名</Typography.Text>
      ) : null}
    </Modal>
  );
}

// 新建弹窗（文件/目录共用，只差 dir 一个字段）；新建文件确认后顺手开进编辑器（即建即编）
function CreateModal({ kind, current, clashing, onClose }) {
  const [name, setName] = useState("");
  const ref = useRef(null);
  useEffect(() => ref.current?.input?.focus(), []);

  const clash = !badName(name) && clashing(name.trim());
  const bad = badName(name) || name.startsWith(".") || clash;
  const submit = () => {
    if (bad || !current) return;
    onClose();
    const path = joinPath(current, name.trim());
    bus.emit("fs.create", { parent: current, name: name.trim(), dir: kind === "dir" }, { net: true });
    if (kind === "file") useEditorStore.getState().openFile(path); // 不 await：即建即编，打开失败自弹 editor 横幅
  };
  return (
    <Modal open title={kind === "dir" ? "新建文件夹" : "新建文件"} okText="新建" okButtonProps={{ disabled: bad }} onOk={submit} onCancel={onClose}>
      <Input
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onPressEnter={submit}
        placeholder={kind === "dir" ? "文件夹名" : "name.ext"}
        status={bad && name ? "error" : undefined}
      />
      {name.startsWith(".") ? (
        <Typography.Text type="danger" style={{ fontSize: T.fontSize.xs }}>不能以 . 开头（列表隐身）</Typography.Text>
      ) : clash ? (
        <Typography.Text type="danger" style={{ fontSize: T.fontSize.xs }}>本目录已同名</Typography.Text>
      ) : null}
    </Modal>
  );
}
