"""Genera los íconos PNG de la app (ejecutar: python tools/make_icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (16, 16, 20, 255)
AMBER = (245, 165, 36, 255)
DARK = (29, 19, 0, 255)


def draw(size: int, maskable: bool) -> Image.Image:
    s = size * 4  # dibujar grande y reducir = bordes suaves
    img = Image.new("RGBA", (s, s), BG if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not maskable:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)
    scale = 0.62 if maskable else 0.78  # zona segura de íconos adaptativos
    r = s * scale / 2
    cx = cy = s / 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=AMBER)
    # nota musical (corchea) centrada en el círculo
    u = r / 10
    head_w, head_h = 4.2 * u, 3.3 * u
    hx, hy = cx - 1.6 * u, cy + 3.0 * u
    d.ellipse((hx - head_w / 2, hy - head_h / 2, hx + head_w / 2, hy + head_h / 2), fill=DARK)
    stem_x = hx + head_w / 2 - 0.9 * u
    top = cy - 5.2 * u
    d.rectangle((stem_x, top, stem_x + 0.9 * u, hy), fill=DARK)
    d.polygon([(stem_x, top), (stem_x + 4.0 * u, top + 1.8 * u), (stem_x + 4.0 * u, top + 3.6 * u), (stem_x + 0.9 * u, top + 2.2 * u)], fill=DARK)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
draw(192, False).save(OUT / "icon-192.png")
draw(512, False).save(OUT / "icon-512.png")
draw(512, True).save(OUT / "maskable-512.png")
print("Íconos generados en", OUT)
