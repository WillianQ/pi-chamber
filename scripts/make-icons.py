#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重生成前端图标（packages/web/public/*）。

用法：  python scripts/make-icons.py

源图：  pic/logo_512.png —— 白底 + 黑色 "Pi" 字形，字形占画布约 70%。
产物：  favicon.ico / icon-192.png / icon-512.png / apple-touch-icon.png / icon-maskable-512.png

★ 字形比例（GLYPH_RATIO）是唯一需要调的旋钮，各产物为什么是这个值：
  - any（favicon / 192 / 512 / apple-touch）：0.70 —— 和浏览器标签、桌面安装图标一致，别动。
  - maskable：0.45 —— 手机主屏专用，故意留大边距。原因见下面注释，改之前先读。

★ 为什么 maskable 要留那么大边距（0.45 而不是 0.70）：
  Chrome/安卓给「加到主屏」（非 WebAPK，例如 http://192.168.x.x 这种局域网地址）
  装图标时，会把这个图当成安卓 adaptive icon 的**前景层**去渲染 ——
  前景层画布是 108dp，而主屏只显示中间 72dp，等于把整张图**放大约 1.3~1.5 倍**再裁一刀。
  所以画布里 0.45 的字形，到手机上看着是画布的 0.6~0.67，正好。
  若这里改成 0.70，手机上会变成 0.9+，也就是"顶天立地"。
  参考：Chromium issue 500385598（非 WebAPK 的 maskable 图标被裁过头）、1494844。
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pic" / "logo_512.png"
OUT = ROOT / "packages" / "web" / "public"

# (文件名, 画布边长, 字形占画布比例, 底板形状)
TARGETS = [
    ("icon-192.png", 192, 0.70, "rounded"),
    ("icon-512.png", 512, 0.70, "rounded"),
    ("apple-touch-icon.png", 180, 0.70, "rounded"),
    ("icon-maskable-512.png", 512, 0.45, "square"),
]
CORNER_RADIUS = 0.215  # 圆角半径 / 边长（≈ iOS squircle）


def artwork_bbox(im):
    """源图里黑色字形的包围盒（源图是白底 + 纯黑字形）。"""
    px = im.convert("RGB").load()
    w, h = im.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r + g + b < 600:  # 非白
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    if maxx < 0:
        raise SystemExit("源图里找不到字形（是不是整张全白？）")
    return (minx, miny, maxx + 1, maxy + 1)


def rounded_mask(size, radius_ratio=CORNER_RADIUS, ss=4):
    """圆角矩形的 alpha 蒙版（4 倍超采样，边缘平滑）。"""
    big = size * ss
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=255
    )
    return m.resize((size, size), Image.LANCZOS)


def build(glyph, size, ratio, shape):
    """白底板 + 居中字形。shape=rounded 时四角透明（iOS 自己还会加圆角，保留原样）。"""
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    g = int(round(size * ratio))
    art = glyph.resize((g, g), Image.LANCZOS)
    off = (size - g) // 2
    canvas.paste(art, (off, off))
    if shape == "rounded":
        canvas.putalpha(rounded_mask(size))
    return canvas


def main():
    if not SRC.exists():
        sys.exit(f"源图不存在：{SRC}")
    src = Image.open(SRC).convert("RGB")
    glyph = src.crop(artwork_bbox(src))
    print(f"源图 {SRC.name} 字形 {glyph.size[0]}x{glyph.size[1]}")

    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, ratio, shape in TARGETS:
        img = build(glyph, size, ratio, shape)
        img.save(OUT / name)
        print(f"  {name:24} {size}x{size}  字形 {int(size * ratio)}px ({ratio:.0%})")

    # favicon：多尺寸 ico（16/32/48），源用 512 那一版缩下来
    fav = build(glyph, 512, 0.70, "rounded")
    fav.save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("  favicon.ico              16/32/48")


if __name__ == "__main__":
    main()
