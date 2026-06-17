#!/usr/bin/env python3
"""Generate IOU "locked O" app icons (PWA + Android) from code.

Draws the keyhole mark with Pillow at 4x supersample, then downsamples with
LANCZOS for clean anti-aliasing. No SVG rasterizer needed. Geometry mirrors
src/features/ui/Logo.tsx / public/favicon.svg (64-unit grid: ring center
(32,30) r14 stroke5, bore (32,26.5) r3.3, slot keyhole flare).

Run: python scripts/gen-icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MINT = (95, 227, 179, 255)   # #5FE3B3
TILE = (17, 38, 31, 255)     # #11261F  (brand tile / android adaptive bg)
SS = 4                        # supersample factor


def emblem(d, cx, cy, k):
    """Draw ring + keyhole. (cx,cy) is the ring center; k = px per grid unit."""
    G = lambda gx, gy: (cx + (gx - 32) * k, cy + (gy - 30) * k)
    R = 14 * k
    stroke = max(1, int(round(5 * k)))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=MINT, width=stroke)
    bcx, bcy = G(32, 26.5)
    br = 3.3 * k
    d.ellipse([bcx - br, bcy - br, bcx + br, bcy + br], fill=MINT)
    d.polygon([G(30, 29), G(28.5, 37), G(35.5, 37), G(34, 29)], fill=MINT)


def render(size, kind):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == "tile_rounded":          # pwa "any", android legacy square
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=15 / 64 * S, fill=TILE)
        emblem(d, S / 2, 30 / 64 * S, S / 64)
    elif kind == "square":              # apple-touch (opaque, iOS masks corners)
        d.rectangle([0, 0, S, S], fill=TILE)
        emblem(d, S / 2, 30 / 64 * S, S / 64)
    elif kind == "circle":              # android legacy round
        d.ellipse([0, 0, S - 1, S - 1], fill=TILE)
        emblem(d, S / 2, 30 / 64 * S, S / 64)
    elif kind == "maskable":            # pwa maskable: full bleed, emblem in safe zone
        d.rectangle([0, 0, S, S], fill=TILE)
        emblem(d, S / 2, S / 2, (0.18 * S) / 14)
    elif kind == "foreground":          # android adaptive foreground: transparent + emblem
        emblem(d, S / 2, S / 2, (0.165 * S) / 14)
    else:
        raise ValueError(kind)
    return img.resize((size, size), Image.LANCZOS)


def out(path, size, kind):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    render(size, kind).save(full)
    print(f"  {path}  ({size}px, {kind})")


print("PWA icons:")
out("public/pwa-192x192.png", 192, "tile_rounded")
out("public/pwa-512x512.png", 512, "tile_rounded")
out("public/pwa-maskable-512x512.png", 512, "maskable")
out("public/apple-touch-icon.png", 180, "square")

print("Android adaptive foreground (108dp):")
for dens, sz in {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
    out(f"android/app/src/main/res/mipmap-{dens}/ic_launcher_foreground.png", sz, "foreground")

print("Android legacy launcher (square + round):")
for dens, sz in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    out(f"android/app/src/main/res/mipmap-{dens}/ic_launcher.png", sz, "tile_rounded")
    out(f"android/app/src/main/res/mipmap-{dens}/ic_launcher_round.png", sz, "circle")

print("done.")
