// 终端会话表（纯逻辑：不碰 ws / node-pty / 文件 —— spawn 由调用方注入，故可单测）。
//
// 一个会话 = 一个真 PTY + 一份环形缓冲 + 一份待发批次 + 一组订阅者。四条纪律：
//
// ① **attach 是"每连接"的**（不是每会话）：s.attachedTo 是本会话的订阅者集合。
//    输出只发给订阅者；没人订阅就只进环形缓冲（省内存，语义上也对）。
//    ★ 旧实现用会话级布尔 attached + 广播输出 —— 多连接下是坏的：没 attach 过的连接照样收输出，
//      且第二个 attach 会把第一个的待发批次清空（丢数据）。这里按连接算，两个毛病一起没。
// ② **attach 时先把欠账 flush 给老订阅者，再把自己加进去** —— 否则要么老订阅者丢那几个字节，
//    要么新订阅者收到「回放里已有 + 流式再来一遍」的重复。
// ③ **回放 = 原始字节重放**（不做服务端终端模拟）：前端先 reset() 再整份写入 = 一屏重画。
//    缓冲按 onData 的整块丢最老的，重放打头**可能**是半条转义序列（已知且接受）。
// ④ **退出不删档**：PTY 退出后会话留在表里（status=exited + exitCode），屏幕还能看、还能重连；
//    只有 close 才真出列（杀进程 + 从名册消失）。
//
// 尺寸（resize）归 **owner**：PTY 只有一个尺寸，而每个前端窗口的 FitAddon 量出的列数不同。
// 第一个 attach 的连接成为 owner，只有它能改 PTY 尺寸（否则两个窗口会把画面互相改乱）。
// owner 断开 / detach 时移交给下一个订阅者。

export const LIMITS = {
  // 每终端保留的原始输出（断线重连整屏重放用；超了从**最老的整块**开始丢）。
  // 丢的粒度是 onData 的整块，不从块中间切 —— 重放打头**可能**是半条转义序列（已知且接受）。
  ringBytes: 200 * 1024,
  // 输出合批：攒够 flushMs 或攒够 frameChars 就发一帧（敲键回显感知不到，make 也不刷爆）
  flushMs: 16,
  // 单帧字符数上限：一个字符最多 4 字节 → 单帧 ≤ 32KB 字节、base64 后 ≤ 43KB
  frameChars: 8000,
  // 尺寸兜底（前端量出来之前先用它；mount 后会立刻 term.resize 纠正）
  defaultCols: 100,
  defaultRows: 30,
  // 上限：两者都夹在 [2, 500]，防前端传 0/负数把 PTY 搞坏
  minCols: 2,
  maxCols: 500,
  minRows: 2,
  maxRows: 200,
};

/** 环形缓冲：按整块丢最老的，字节数封顶 */
export function createRing(limitBytes) {
  let chunks = [];
  let bytes = 0;
  return {
    push(text) {
      const b = Buffer.byteLength(text, "utf8");
      chunks.push(text);
      bytes += b;
      while (bytes > limitBytes && chunks.length > 1) {
        bytes -= Buffer.byteLength(chunks[0], "utf8");
        chunks.shift();
      }
    },
    read() {
      return chunks.join("");
    },
    get bytes() {
      return bytes;
    },
  };
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
};

/**
 * @param {object} o
 * @param {(shell, {cwd, cols, rows}) => {onData, onExit, write, resize, kill}} o.spawn
 * @param {(conn, termId, base64) => void} o.onOutput  一帧输出（已合批、已切片、已 base64）—— 按连接单播
 * @param {(termId, info) => void}         o.onExit    PTY 退出（必到一次）—— 广播给所有连接
 * @param {() => void}                     o.onChange  名册变了（增/删/退出都要推）
 * @param {(msg) => void}                 [o.onLog]
 */
export function createSessions({
  spawn,
  onOutput,
  onExit,
  onChange,
  onLog = () => {},
  limits = LIMITS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let seq = 0;

  /** 把待发批次发给**当前订阅者**（调用方负责保证 s.pending 已就绪） */
  function flush(s) {
    s.timer = null;
    if (!s.attachedTo.size || !s.pending) return;
    let text = s.pending;
    s.pending = "";
    // 单帧字符数封顶：一个字符最多 4 字节 → 单帧字节数可控（切片按字符，绝不切开多字节字符）
    while (text) {
      const piece = text.length > limits.frameChars ? text.slice(0, limits.frameChars) : text;
      text = text.slice(piece.length);
      const b64 = Buffer.from(piece, "utf8").toString("base64");
      for (const conn of s.attachedTo) onOutput(conn, s.termId, b64);
    }
  }

  function schedule(s) {
    if (s.timer) return;
    s.timer = setTimer(() => flush(s), limits.flushMs);
  }

  /** 起一发终端。shell = 调用方解析好的候选项实体 */
  function create({ shell, cwd, cols, rows }) {
    const c = clamp(cols, limits.minCols, limits.maxCols, limits.defaultCols);
    const r = clamp(rows, limits.minRows, limits.maxRows, limits.defaultRows);
    const termId = `t${++seq}`;
    const pty = spawn(shell, { cwd, cols: c, rows: r });
    const s = {
      termId,
      pty,
      ring: createRing(limits.ringBytes),
      pending: "",
      timer: null,
      attachedTo: new Set(), // 订阅者（连接对象）—— 输出只发给它们
      owner: null, // 唯一有权改 PTY 尺寸的连接
      closing: false, // 用户主动 close：onExit 里看见就不发 term.exit
      cols: c,
      rows: r,
      cwd,
      shellId: shell.id,
      shellLabel: shell.label,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: now(),
    };
    sessions.set(termId, s);

    pty.onData((text) => {
      if (typeof text !== "string" || !text) return;
      s.ring.push(text); // 缓冲**永远**吃全（重放要用）
      if (!s.attachedTo.size) return; // 没人接着：只进缓冲，不攒待发
      s.pending += text;
      if (s.pending.length >= limits.frameChars) flush(s); // 大块立即切着发，不等 16ms
      else schedule(s);
    });

    pty.onExit(({ exitCode, signal }) => {
      if (s.timer) {
        clearTimer(s.timer);
        flush(s); // 退出前把残余发完（flush 会清 timer）
        if (s.timer) {
          clearTimer(s.timer);
          s.timer = null;
        }
      }
      s.status = "exited";
      s.exitCode = exitCode ?? null;
      s.signal = signal ?? null;
      onLog(`[termd] ${termId} 退出 code=${exitCode} signal=${signal ?? "-"}`);
      if (s.closing) return; // 用户主动关的，不算"自己死的"，不发 term.exit
      onExit(termId, { code: s.exitCode, signal: s.signal });
      onChange();
    });

    onLog(`[termd] ${termId} 起 ${shell.label} cwd=${cwd} ${c}x${r}`);
    onChange();
    return { termId, cwd, shell: shell.id, shellLabel: shell.label, cols: c, rows: r };
  }

  function get(termId) {
    const s = sessions.get(termId);
    if (!s) throw new Error(`终端不存在: ${termId}`);
    return s;
  }

  function input(termId, base64) {
    const s = get(termId);
    if (s.status !== "running") return; // 已退出：写进去也是丢，静默
    const buf = Buffer.from(String(base64 ?? ""), "base64");
    if (buf.length) s.pty.write(buf.toString("utf8"));
  }

  /** 改 PTY 尺寸。**只有 owner 的请求生效**（非 owner 静默忽略：PTY 只有一个尺寸，多窗口会互相改乱） */
  function resize(conn, termId, cols, rows) {
    const s = get(termId);
    if (conn && s.owner && conn !== s.owner) return;
    const c = clamp(cols, limits.minCols, limits.maxCols, s.cols);
    const r = clamp(rows, limits.minRows, limits.maxRows, s.rows);
    if (c === s.cols && r === s.rows) return; // 尺寸没变：不 resize、不推名册（前端拖窗口时这条挡掉绝大部分）
    s.cols = c;
    s.rows = r;
    if (s.status === "running") {
      try {
        s.pty.resize(c, r);
      } catch (err) {
        onLog(`[termd] ${termId} resize 失败: ${err?.message ?? err}`);
      }
    }
    onChange(); // 名册里的 cols/rows 是前端顶部条的数据源，得跟着走
  }

  /**
   * 接管/恢复（**每连接**）：先把欠账 flush 给老订阅者（不丢）→ 再把自己加进来（回放里已含那些字节，
   * 所以不重复）→ 回放整份缓冲 → 之后转流式。
   * 第一个订阅者成为 owner（resize 权）。
   */
  function attach(conn, termId, cols, rows) {
    const s = get(termId);
    if (s.timer) {
      clearTimer(s.timer);
      flush(s); // ① 老订阅者的欠账先还清
    }
    s.attachedTo.add(conn); // ② 再加入自己
    if (!s.owner) s.owner = conn;
    if (cols || rows) resize(conn, termId, cols, rows);
    return {
      data: Buffer.from(s.ring.read(), "utf8").toString("base64"),
      cols: s.cols,
      rows: s.rows,
      status: s.status,
      exitCode: s.exitCode,
      cwd: s.cwd,
      shell: s.shellId,
      shellLabel: s.shellLabel,
      startedAt: s.startedAt,
      bytes: s.ring.bytes,
      owner: s.owner === conn, // 前端据此决定要不要发 term.resize
    };
  }

  /** 退订（前端切走 tab / 卸载面板）：只是不再收输出，**不清待发批次**（别的订阅者还要） */
  function detach(conn, termId) {
    const s = sessions.get(termId);
    if (!s) return;
    s.attachedTo.delete(conn);
    if (s.owner === conn) s.owner = s.attachedTo.values().next().value ?? null; // 移交
  }

  /** 连接断开：从所有会话的订阅者里摘掉（否则 Set 泄漏 + 往死 socket 写） */
  function dropConn(conn) {
    for (const s of sessions.values()) {
      s.attachedTo.delete(conn);
      if (s.owner === conn) s.owner = s.attachedTo.values().next().value ?? null;
    }
  }

  /** 关闭：真杀进程 + 出列（前端点 ✕ 走这条） */
  function close(termId) {
    const s = sessions.get(termId);
    if (!s) return; // 幂等：重复关闭 / 迟到帧一律无事
    s.closing = true; // kill 触发的 onExit 不该再发 term.exit（它是"我关的"，不是"它自己死的"）
    sessions.delete(termId);
    if (s.timer) {
      clearTimer(s.timer);
      s.timer = null;
    }
    killPty(s);
    onLog(`[termd] ${termId} 已关闭`);
    onChange();
  }

  /**
   * 杀 PTY。**已退出的不碰** —— node-pty 的 Windows 实现（windowsPtyAgent.kill）会在
   * `_getConsoleProcessList()` 拿到 undefined 后 `.forEach` 崩，而且是异步抛（try/catch 抓不住），
   * 一次就把整个守护进程带走、所有终端陪葬。进程本来就死了，没什么可杀的。
   */
  function killPty(s) {
    if (s.status !== "running") return;
    try {
      s.pty.kill();
    } catch (err) {
      onLog(`[termd] ${s.termId} kill 失败: ${err?.message ?? err}`);
    }
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      termId: s.termId,
      cwd: s.cwd,
      shell: s.shellId,
      shellLabel: s.shellLabel,
      cols: s.cols,
      rows: s.rows,
      status: s.status,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
    }));
  }

  /** 全部杀掉（守护进程退出前调用 —— 它是 PTY 的直接父进程，这活儿只有它干得干净） */
  function closeAll() {
    for (const s of sessions.values()) killPty(s);
    sessions.clear();
  }

  return {
    create,
    attach,
    detach,
    dropConn,
    input,
    resize,
    close,
    list,
    closeAll,
    get count() {
      return sessions.size;
    },
  };
}
