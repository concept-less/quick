#!/usr/bin/env python3
"""Generate the app icon (icon.png / icon.icns) and the macOS menu-bar template icon. Requires Pillow.

    python3 scripts/make-icons.py
"""
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "assets")
os.makedirs(ASSETS, exist_ok=True)

# Lightning bolt in a 100x100 box.
BOLT = [(58, 6), (22, 56), (46, 56), (38, 94), (78, 40), (53, 40), (62, 6)]


def bolt(size, box, color):
    x0, y0, s = box
    return [(x0 + px * s / 100, y0 + py * s / 100) for px, py in BOLT]


def app_icon(n=1024):
    ss = 4  # supersample
    N = n * ss
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(N * 0.09)
    # vertical gradient rounded square (indigo → violet)
    grad = Image.new("RGBA", (N, N))
    gd = ImageDraw.Draw(grad)
    top, bot = (79, 109, 245), (139, 92, 246)
    for y in range(N):
        t = y / N
        gd.line([(0, y), (N, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, N - pad, N - pad], radius=int(N * 0.2), fill=255)
    img.paste(grad, (0, 0), mask)
    s = N - 2 * pad
    inner = s * 0.72
    off = pad + (s - inner) / 2
    d.polygon(bolt(N, (off + inner * 0.02, off, inner), None), fill=(255, 255, 255, 255))
    return img.resize((n, n), Image.LANCZOS)


def tray_icon(n):
    ss = 8
    N = n * ss
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(img).polygon(bolt(N, (N * 0.02, 0, N), None), fill=(0, 0, 0, 255))
    return img.resize((n, n), Image.LANCZOS)


icon = app_icon(1024)
icon.save(os.path.join(ASSETS, "icon.png"))
tray_icon(16).save(os.path.join(ASSETS, "trayTemplate.png"))
tray_icon(32).save(os.path.join(ASSETS, "trayTemplate@2x.png"))

if shutil.which("iconutil"):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for s in (16, 32, 128, 256, 512):
            icon.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
            icon.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ASSETS, "icon.icns")], check=True)
print("icons written to", os.path.abspath(ASSETS))
