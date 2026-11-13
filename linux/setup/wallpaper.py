#!/usr/bin/env python3
"""Génère le fond d'écran violet / blanc / noir (2560x1440, net en 1080p)."""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

W, H = 2560, 1440
random.seed(42)
out = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Images/zecross-violet.png")

# 1. fond noir légèrement violacé
img = Image.new("RGB", (W, H), (6, 4, 12))

# 2. halos violets flous
glow = Image.new("RGB", (W, H), (0, 0, 0))
g = ImageDraw.Draw(glow)
for cx, cy, r, col in [
    (0.78, 0.30, 720, (120, 60, 220)),
    (0.18, 0.85, 620, (90, 30, 170)),
    (0.55, 0.65, 420, (170, 110, 255)),
]:
    x, y = cx * W, cy * H
    g.ellipse([x - r, y - r, x + r, y + r], fill=col)
glow = glow.filter(ImageFilter.GaussianBlur(260))
img = Image.blend(img, glow, 0.42)

# 3. vagues de lignes blanches/violettes
lines = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(lines)
for i in range(46):
    t = i / 45
    amp = 120 + 160 * math.sin(t * math.pi)
    base = H * (0.42 + 0.30 * t)
    phase = t * 2.4
    pts = []
    for x in range(-20, W + 21, 8):
        u = x / W
        y = base + amp * math.sin(u * math.pi * 2.2 + phase) * (0.6 + 0.4 * math.cos(u * 3 + t * 4))
        y -= 260 * u * (1 - t)
        pts.append((x, y))
    mix = 0.5 + 0.5 * math.sin(t * math.pi)
    col = (int(185 + 70 * mix), int(140 + 115 * mix), 255, int(30 + 90 * mix))
    d.line(pts, fill=col, width=2)
soft = lines.filter(ImageFilter.GaussianBlur(6))
img = Image.alpha_composite(img.convert("RGBA"), soft)
img = Image.alpha_composite(img, lines)

# 4. petites étoiles
stars = ImageDraw.Draw(img)
for _ in range(260):
    x, y = random.randrange(W), random.randrange(H)
    a = random.randint(60, 220)
    s = random.choice([1, 1, 1, 2])
    stars.ellipse([x, y, x + s, y + s], fill=(255, 255, 255, a))

# 5. vignettage
vig = Image.new("L", (W, H), 0)
ImageDraw.Draw(vig).ellipse([-W * 0.25, -H * 0.35, W * 1.25, H * 1.35], fill=255)
vig = vig.filter(ImageFilter.GaussianBlur(220))
black = Image.new("RGBA", (W, H), (0, 0, 0, 255))
img = Image.composite(img, black, vig)

out.parent.mkdir(parents=True, exist_ok=True)
img.convert("RGB").save(out, quality=95)
print(out)
