// ───────────────────── pages/chat / attachments.js ─────────────────────
// 图片附件：挑选 → 压缩 → 线帧形状（**纯函数 + 浏览器 API**，不碰 store、不碰总线）。
//
// ── 为什么在**前端**压 ──
//   图一旦进了 user 消息就必然落盘 jsonl（pi 的架构：消息档案 = 上下文，躲不掉）。
//   前端压一遍，档案与线帧一起瘦一个数量级（手机原图 4000×3000/4MB → 1280px/JPEG ~150KB）。
//   ★ 服务端**不做二次压缩**：那是 SDK 的 photon WASM，打成 exe 后有加载不到的风险
//     （静默失败 → 图被丢），所以压缩只在前端这一道，服务端只做硬校验。
//
// ── 压缩口径（在这里定义一次，InputBox 只管调）──
//   · 长边 > MAX_EDGE 就缩到 MAX_EDGE（**只缩不放**）
//   · 一律转 JPEG 0.8 —— **除 GIF**（动图压成静态帧就废了，原样传，大小交给服务端那道闸）
//   · EXIF 旋转靠 createImageBitmap 的 imageOrientation:"from-image"
//     —— 手机竖拍（orientation=6）不处理就会躺倒
//   · 透明通道填白（JPEG 无 alpha，不填会变黑）
//
// ── 入口三条（都是浏览器原生，零依赖）──
//   粘贴 onPaste / 拖拽 onDrop / 选文件 <input type="file" accept="image/*">
//   ★ 手机上 accept="image/*" 会自动弹「拍照 / 相册 / 浏览」，**不需要 getUserMedia**
//     （那个要 HTTPS 或 localhost，chamber 内网 http 用不了）。
//   ★ 故意**不加** capture 属性：加了就只剩相机，相册入口没了。

export const MAX_IMAGES = 5; // 单条消息最多几张（与服务端 normalizeImages 同口径）
export const MAX_EDGE = 1280; // 长边上限（px）
export const JPEG_QUALITY = 0.8;
export const MAX_SEND_CHARS = 2 * 1024 * 1024; // 单张 base64 字符上限（服务端也会查；这里先拦，免得白传）

const OK_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** 从一堆 File 里挑出能用的图片：类型白名单 + 数量截断。
 *  @returns { files, rejected } rejected = 给用户看的一句话（没问题则 null） */
export function pickImages(files, room = MAX_IMAGES) {
  const list = [...(files ?? [])];
  if (!list.length) return { files: [], rejected: null };
  const ok = list.filter((f) => OK_MIMES.has(f.type));
  const bad = list.length - ok.length;
  const notes = [];
  if (bad) notes.push(`已忽略 ${bad} 个非图片文件`);
  if (ok.length > room) notes.push(`最多再放 ${room} 张，多出的已忽略`);
  return { files: ok.slice(0, Math.max(0, room)), rejected: notes.length ? notes.join("；") : null };
}

/** 长边缩到 max（只缩不放） */
function fit(w, h, max) {
  if (w <= max && h <= max) return { w, h };
  const k = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** File → 位图（EXIF 旋转在解码时就应用）。ImageBitmap 优先，<img> 兜底。 */
async function toBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* 老浏览器不认 options → 落到 <img> 兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("图片解码失败"));
      el.src = url;
    });
    return img;
  } finally {
    // 解码已完成，位图在内存里，URL 可以放掉
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** blob → 纯 base64（剥掉 data: 前缀） */
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => rej(new Error("读取图片失败"));
    fr.readAsDataURL(blob);
  });
}

/**
 * 一张图 → 线帧形状 { type:"image", mimeType, data }。
 * @returns 图片块 | { error: "一句话" }（失败的那张丢掉，不拖累其它张）
 */
export async function compressImage(file) {
  // GIF：压成静态帧就废了 → 原样传
  if (file.type === "image/gif") {
    const data = await blobToBase64(file);
    if (data.length > MAX_SEND_CHARS) return { error: "GIF 太大（限 2MB）" };
    return { type: "image", mimeType: "image/gif", data };
  }

  let bmp;
  try {
    bmp = await toBitmap(file);
  } catch {
    return { error: "图片读不了" };
  }
  const srcW = bmp.naturalWidth || bmp.width || 0; // <img> 看 natural，ImageBitmap 看 width
  const srcH = bmp.naturalHeight || bmp.height || 0;
  if (!srcW || !srcH) return { error: "图片尺寸异常" };

  const { w, h } = fit(srcW, srcH, MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { error: "浏览器不支持图片压缩" };
  ctx.fillStyle = "#fff"; // 透明区填白（JPEG 无 alpha）
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.(); // ImageBitmap 要显式释放；<img> 没有 close，?. 兜住

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  if (!blob) return { error: "图片压缩失败" };
  const data = await blobToBase64(blob);
  if (data.length > MAX_SEND_CHARS) return { error: "图片太大（限 2MB）" };
  return { type: "image", mimeType: "image/jpeg", data };
}

/** 批量压缩（逐张串行，保序）：失败的那张丢掉并计数，其余照发 */
export async function compressAll(files) {
  const images = [];
  let failed = 0;
  for (const f of files) {
    try {
      const r = await compressImage(f);
      if (r?.error) failed++;
      else images.push(r);
    } catch {
      failed++;
    }
  }
  return { images, failed };
}

/** 线帧图片块 → <img src> 用的 data URL */
export function dataUrl(img) {
  return `data:${img?.mimeType || "image/png"};base64,${img?.data ?? ""}`;
}

/** 从剪贴板 / 拖拽的 DataTransfer 里捞图片文件（捞不到返回 [] = 让默认行为继续，如纯文本粘贴） */
export function imageFilesFrom(transfer) {
  if (!transfer) return [];
  const out = [];
  for (const it of transfer.items ?? []) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile?.();
      if (f) out.push(f);
    }
  }
  if (out.length) return out;
  return [...(transfer.files ?? [])].filter((f) => f.type.startsWith("image/"));
}
