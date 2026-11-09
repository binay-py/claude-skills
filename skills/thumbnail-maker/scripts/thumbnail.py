#!/usr/bin/env python3
"""thumbnail.py - bright, bold YouTube / social thumbnails with Pillow.

  python thumbnail.py --title "I built *this* in 1 day" --photo me.jpg --style pop --out thumb.png
  python thumbnail.py --title "Stop wasting *money*" --subtitle "5 simple fixes" --emoji "💸" --style green --out t.png
  python thumbnail.py --title "Python in 10 minutes" --style tech --size 1080x1920 --out short.png

Writes <out> and <out-stem>.preview.png (full size next to the 168x94 YouTube search size) and prints a readability check.
Requires: pip install pillow
"""
import argparse
import itertools
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fonts import font as find_font  # noqa: E402

PRESETS = {
    #        background gradient        glow        text fill  stroke     keyword box / text        subtitle pill bg / text
    "pop":   dict(bg=("#FFE600", "#FF8A00"), glow="#FFF7A8", fill="#FFFFFF", stroke="#111111", hl_bg="#E10600", hl_fg="#FFFFFF", pill_bg="#111111", pill_fg="#FFE600"),
    "tech":  dict(bg=("#00D9FF", "#1E3BFF"), glow="#9BF6FF", fill="#FFFFFF", stroke="#0A1A4A", hl_bg="#0A1A4A", hl_fg="#3CF4FF", pill_bg="#0A1A4A", pill_fg="#3CF4FF"),
    "red":   dict(bg=("#FF4436", "#B0001A"), glow="#FF9C8F", fill="#FFFFFF", stroke="#3A0008", hl_bg="#FFE600", hl_fg="#111111", pill_bg="#FFFFFF", pill_fg="#C8001E"),
    "green": dict(bg=("#43F59A", "#00994A"), glow="#C8FFE0", fill="#FFFFFF", stroke="#063D1F", hl_bg="#FFE600", hl_fg="#063D1F", pill_bg="#063D1F", pill_fg="#5CFFA6"),
}


def rgb(c):
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def lum(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = c[:3]
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


# ---------------------------------------------------------------- background
def background(W, H, P, bg_path=None):
    c1, c2 = Image.new("RGB", (W, H), rgb(P["bg"][0])), Image.new("RGB", (W, H), rgb(P["bg"][1]))
    # diagonal gradient: top-left = color 1, bottom-right = color 2
    vert = Image.linear_gradient("L").resize((W, H), Image.BICUBIC)
    horiz = Image.linear_gradient("L").rotate(90).transpose(Image.FLIP_LEFT_RIGHT).resize((W, H), Image.BICUBIC)
    grad = Image.blend(vert, horiz, 0.5)
    img = Image.composite(c2, c1, grad)
    if bg_path:
        photo = ImageOps.fit(Image.open(bg_path).convert("RGB"), (W, H), Image.LANCZOS)
        photo = ImageEnhance.Color(photo.filter(ImageFilter.GaussianBlur(max(W, H) / 110))).enhance(1.7)
        photo = ImageEnhance.Brightness(photo).enhance(1.05)
        img = Image.blend(photo, img, 0.45)
    # soft light spot behind the text side
    glow = Image.radial_gradient("L").resize((int(W * 1.1), int(H * 1.4)))
    glow = glow.point(lambda v: int(150 * max(0.0, 1 - v / 230) ** 1.6))  # fades to 0 well before the edge
    layer = Image.new("RGB", (W, H), rgb(P["glow"]))
    mask = Image.new("L", (W, H), 0)
    mask.paste(glow, (int(-W * 0.25), int(-H * 0.35)))
    return Image.composite(layer, img, mask)


def rays(img, cx, cy, n=18, alpha=46):
    W, H = img.size
    R = int(math.hypot(W, H))
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    for i in range(n):
        a0 = 2 * math.pi * i / n
        a1 = a0 + math.pi / n
        d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)), (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=alpha)
    layer = layer.filter(ImageFilter.GaussianBlur(3))
    img.paste(Image.new("RGB", (W, H), (255, 255, 255)), (0, 0), layer)


# ---------------------------------------------------------------- stickers (photo, emoji)
def outlined(rgba, stroke, shadow=True):
    """Thick white outline that follows the alpha shape, plus a drop shadow. Returns a bigger RGBA."""
    pad = stroke * 3
    w, h = rgba.size
    a = Image.new("L", (w + 2 * pad, h + 2 * pad), 0)
    a.paste(rgba.getchannel("A"), (pad, pad))
    grown = a.filter(ImageFilter.GaussianBlur(stroke * 0.6)).point(lambda v: 255 if v > 6 else 0).filter(ImageFilter.GaussianBlur(1.2))
    out = Image.new("RGBA", a.size, (0, 0, 0, 0))
    if shadow:
        sh = grown.filter(ImageFilter.GaussianBlur(stroke * 1.2)).point(lambda v: int(v * 0.55))
        out.paste(Image.new("RGBA", a.size, (0, 0, 0, 255)), (int(stroke * 0.5), int(stroke * 0.9)), sh)
    out.paste(Image.new("RGBA", a.size, (255, 255, 255, 255)), (0, 0), grown)
    out.alpha_composite(Image.new("RGBA", a.size, (0, 0, 0, 0)))
    tmp = Image.new("RGBA", a.size, (0, 0, 0, 0))
    tmp.paste(rgba, (pad, pad))
    out.alpha_composite(tmp)
    return out


def has_transparency(im):
    if im.mode not in ("RGBA", "LA", "PA") and not (im.mode == "P" and "transparency" in im.info):
        return False
    a = im.convert("RGBA").getchannel("A")
    hist = a.histogram()
    return sum(hist[:200]) > 0.02 * a.size[0] * a.size[1]


def photo_card(path, w, h, shape, border):
    """Rect (rounded) or circle crop with a white border and soft shadow. Returns RGBA with margin for the shadow."""
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    if shape == "circle":
        w = h = min(w, h)
    inner = ImageOps.fit(src, (w - 2 * border, h - 2 * border), Image.LANCZOS, centering=(0.5, 0.35))
    m = border * 4
    card = Image.new("RGBA", (w + 2 * m, h + 2 * m), (0, 0, 0, 0))
    mask = Image.new("L", card.size, 0)
    md = ImageDraw.Draw(mask)
    r = int(min(w, h) * 0.07)
    box = (m, m, m + w, m + h)
    if shape == "circle":
        md.ellipse(box, fill=255)
    else:
        md.rounded_rectangle(box, r, fill=255)
    sh = mask.filter(ImageFilter.GaussianBlur(border * 1.4)).point(lambda v: int(v * 0.5))
    card.paste(Image.new("RGBA", card.size, (0, 0, 0, 255)), (int(border * .6), int(border * 1.2)), sh)
    card.paste(Image.new("RGBA", card.size, (255, 255, 255, 255)), (0, 0), mask)
    imask = Image.new("L", inner.size, 0)
    idr = ImageDraw.Draw(imask)
    if shape == "circle":
        idr.ellipse((0, 0, inner.size[0] - 1, inner.size[1] - 1), fill=255)
    else:
        idr.rounded_rectangle((0, 0, inner.size[0] - 1, inner.size[1] - 1), max(1, r - border), fill=255)
    card.paste(inner, (m + border, m + border), imask)
    return card, m


def emoji_image(ch, size):
    try:
        path = find_font("emoji")
    except FileNotFoundError:
        return None
    target, f = size, None
    # scalable color fonts (Segoe UI Emoji) take any size; bitmap ones (Noto 109 px, Apple 160 px) only their own
    for s in (size, 109, 160, 137, 96, 64):
        try:
            f = ImageFont.truetype(path, s)
            size = s
            break
        except OSError:
            continue
    if f is None:
        return None
    canvas = Image.new("RGBA", (size * 3, size * 3), (0, 0, 0, 0))
    try:
        ImageDraw.Draw(canvas).text((size, size), ch, font=f, embedded_color=True)
    except Exception:
        return None
    bbox = canvas.getbbox()
    if not bbox:
        return None
    em = canvas.crop(bbox)
    if size != target:
        em = em.resize((round(em.width * target / size), round(em.height * target / size)), Image.LANCZOS)
    # reject fonts without color and missing glyphs (a mono "tofu" box): need a share of saturated opaque pixels
    small = em.resize((48, max(1, round(48 * em.height / em.width))))
    opaque = [px for px in (small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata()) if px[3] > 128]
    colorful = [px for px in opaque if max(px[:3]) - min(px[:3]) > 60]
    if not opaque or len(colorful) < 0.1 * len(opaque):
        return None
    return em


# ---------------------------------------------------------------- title fitting
def parse_title(title, upper):
    """'*word*' marks the highlighted keyword(s). Highlighted phrases stay on one line."""
    toks = []
    for part in re.split(r"(\*[^*]+\*)", title):
        if not part:
            continue
        if part.startswith("*") and part.endswith("*"):
            toks.append((part[1:-1].strip(), True))
        else:
            toks += [(w, False) for w in part.split()]
    return [((t.upper() if upper else t), hl) for t, hl in toks if t]


class Metrics:
    def __init__(self, path, size, hl_mode):
        self.f = ImageFont.truetype(path, size)
        self.size = size
        self.cap = -self.f.getbbox("H", anchor="ls")[1]
        self.desc = max(0, self.f.getbbox("gjpqy", anchor="ls")[3])
        self.stroke = max(3, round(size * 0.075))
        self.shadow = max(3, round(size * 0.055))
        self.space = self.f.getlength(" ") * 1.05
        self.padx = round(self.cap * 0.16) if hl_mode == "box" else 0
        self.pady = round(self.cap * 0.14) if hl_mode == "box" else 0
        self.gap = max(round(self.cap * 0.2), 2 * self.pady + round(self.stroke * 1.2))

    def tok_w(self, t, hl):
        return self.f.getlength(t) + (2 * self.padx if hl and self.padx else 2 * self.stroke)

    def line_w(self, line):
        return sum(self.tok_w(t, hl) for t, hl in line) + self.space * (len(line) - 1) + self.shadow

    def block_h(self, n, lower):
        d = self.desc if lower else 0
        return n * (self.cap + d) + (n - 1) * self.gap + 2 * max(self.stroke, self.pady) + self.shadow


def splits(tokens, k):
    n = len(tokens)
    for cut in itertools.combinations(range(1, n), k - 1):
        b = (0,) + cut + (n,)
        yield [tokens[b[i]:b[i + 1]] for i in range(k)]


def fit_title(tokens, path, box_w, box_h, hl_mode, max_cap, lower):
    best = None
    for k in range(1, min(3, len(tokens)) + 1):
        for lines in splits(tokens, k):
            lo, hi = 8, 900
            while lo < hi:
                mid = (lo + hi + 1) // 2
                m = Metrics(path, mid, hl_mode)
                ok = m.cap <= max_cap and max(m.line_w(l) for l in lines) <= box_w and m.block_h(k, lower) <= box_h
                lo, hi = (mid, hi) if ok else (lo, mid - 1)
            # prefer bigger text; on near ties prefer evenly filled lines
            m = Metrics(path, lo, hl_mode)
            widths = [m.line_w(l) for l in lines]
            balance = min(widths) / max(widths)
            score = lo * (1 + 0.04 * balance) - (0.5 if k > 1 and len(lines[-1]) == 1 and len(tokens) > 3 else 0)
            if best is None or score > best[0]:
                best = (score, lo, lines)
    return best[1], best[2]


def draw_title(img, tokens_lines, m, x0, y0, box_w, align, P, hl_mode):
    """Draws the title block with its top-left at (x0, y0). Returns its bounding box."""
    W, H = img.size
    stroke_c, fill_c = rgb(P["stroke"]), rgb(P["fill"])
    hl_bg, hl_fg = rgb(P["hl_bg"]), rgb(P["hl_fg"])
    shadow_c = tuple(int(c * 0.6) for c in stroke_c)
    # positions
    placed = []
    y = y0 + max(m.stroke, m.pady) + m.cap
    for line in tokens_lines:
        lw = m.line_w(line) - m.shadow
        x = x0 + (box_w - lw) / 2 if align == "center" else x0
        for t, hl in line:
            tw = m.tok_w(t, hl)
            placed.append((x, y, t, hl, tw))
            x += tw + m.space
        y += m.cap + m.desc_used + m.gap
    # soft shadow
    soft = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(soft)
    for x, y, t, hl, tw in placed:
        if hl and hl_mode == "box":
            sd.rounded_rectangle((x, y - m.cap - m.pady, x + tw, y + m.pady + m.desc_used), radius=m.pady, fill=255)
        else:
            sd.text((x + m.stroke, y), t, font=m.f, anchor="ls", fill=255, stroke_width=m.stroke, stroke_fill=255)
    soft = soft.filter(ImageFilter.GaussianBlur(m.size * 0.07)).point(lambda v: int(v * 0.45))
    img.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, round(m.size * 0.04)), soft)
    d = ImageDraw.Draw(img)
    o = m.shadow
    # hard offset shadow, then the text
    for x, y, t, hl, tw in placed:
        if hl and hl_mode == "box":
            d.rounded_rectangle((x + o, y - m.cap - m.pady + o, x + tw + o, y + m.pady + m.desc_used + o), radius=m.pady, fill=shadow_c)
        else:
            d.text((x + m.stroke + o, y + o), t, font=m.f, anchor="ls", fill=shadow_c, stroke_width=m.stroke, stroke_fill=shadow_c)
    for x, y, t, hl, tw in placed:
        if hl and hl_mode == "box":
            d.rounded_rectangle((x, y - m.cap - m.pady, x + tw, y + m.pady + m.desc_used), radius=m.pady, fill=hl_bg)
            d.text((x + m.padx, y), t, font=m.f, anchor="ls", fill=hl_fg)
        else:
            c = hl_bg if hl else fill_c
            d.text((x + m.stroke, y), t, font=m.f, anchor="ls", fill=c, stroke_width=m.stroke, stroke_fill=stroke_c)
    xs = [p[0] for p in placed]
    return (min(xs), y0, max(p[0] + p[4] for p in placed) + o, y0 + m.block_h(len(tokens_lines), m.desc_used > 0))


def pill(img, text, x, y, max_w, size, P, align, box_w, font_path):
    d = ImageDraw.Draw(img)
    while True:
        f = ImageFont.truetype(font_path, size)
        tw = f.getlength(text)
        padx, pady = size * 0.6, size * 0.32
        if tw + 2 * padx <= max_w or size <= 12:
            break
        size -= 2
    asc = -f.getbbox("Hg", anchor="ls")[1]
    desc = f.getbbox("Hg", anchor="ls")[3]
    w, h = tw + 2 * padx, asc + desc + 2 * pady
    if align == "center":
        x = x + (box_w - w) / 2
    o = max(3, round(size * 0.12))
    d.rounded_rectangle((x + o, y + o, x + w + o, y + h + o), radius=h / 2, fill=tuple(int(c * 0.35) for c in rgb(P["stroke"])))
    d.rounded_rectangle((x, y, x + w, y + h), radius=h / 2, fill=rgb(P["pill_bg"]))
    d.text((x + padx, y + pady + asc), text, font=f, anchor="ls", fill=rgb(P["pill_fg"]))
    return (x, y, x + w, y + h), asc


# ---------------------------------------------------------------- main build
def build(a):
    W, H = (int(v) for v in a.size.lower().split("x"))
    P = dict(PRESETS[a.style])
    if a.accent:
        P["hl_bg"] = a.accent
        if a.highlight == "box":
            P["hl_fg"] = "#111111" if lum(rgb(a.accent)) > 0.35 else "#FFFFFF"
    hl_mode = a.highlight
    portrait = H > W
    img = background(W, H, P, a.bg)
    notes = []

    photo = None
    if a.photo:
        src = Image.open(a.photo)
        photo = ("cutout" if has_transparency(src) else a.photo_shape)
    emoji = None
    if a.emoji:
        emoji = emoji_image(a.emoji, int(min(W, H) * (0.22 if photo else 0.42)))
        if emoji is None:
            notes.append("emoji skipped: no color emoji font found (or this emoji is not in it)")

    # regions
    side = photo or emoji
    if portrait:
        text_box = (0.06 * W, 0.05 * H, 0.94 * W, (0.44 if side else 0.80) * H)
        align = "center"
    elif side:
        text_box = (0.05 * W, 0.08 * H, 0.59 * W, 0.92 * H)
        align = "left"
    else:
        text_box = (0.06 * W, 0.08 * H, 0.94 * W, 0.92 * H)
        align = "center"
    if a.align:
        align = a.align

    # side art
    if photo == "cutout":
        cut = Image.open(a.photo).convert("RGBA")
        cut = cut.crop(cut.getbbox())
        th = int(H * (0.52 if portrait else 0.97))
        tw = int(cut.width * th / cut.height)
        max_w = int(W * (0.85 if portrait else 0.42))
        if tw > max_w:
            th, tw = int(th * max_w / tw), max_w
        cut = cut.resize((tw, th), Image.LANCZOS)
        st = max(8, round(min(W, H) * 0.016))
        sticker = outlined(cut, st)
        cx = W * (0.5 if portrait else 0.79)
        rays(img, int(cx), int(H * (0.75 if portrait else 0.45)))
        pad = st * 3
        img.paste(sticker, (int(cx - sticker.width / 2), H - th - pad + int(st * 1.5)), sticker)
    elif photo:
        border = max(8, round(min(W, H) * 0.016))
        if portrait:
            cw, ch = int(W * 0.78), int(H * 0.50)
            cx, top = W * 0.5, H * 0.50
        else:
            cw, ch = int(W * 0.36), int(H * 0.90)
            cx, top = W * 0.79, H * 0.11
        if a.photo_shape == "circle":
            d0 = int(min(W * (0.7 if portrait else 0.36), H * (0.42 if portrait else 0.74)))
            cw = ch = d0
            top = H * (0.52 if portrait else 0.5) - d0 / 2
        rays(img, int(cx), int(top + ch / 2))
        card, m = photo_card(a.photo, cw, ch, a.photo_shape, border)
        if a.photo_shape != "circle":
            card = card.rotate(a.tilt, resample=Image.BICUBIC, expand=True)
        img.paste(card, (int(cx - card.width / 2), int(top + ch / 2 - card.height / 2)), card)
    if emoji is not None:
        st = max(6, round(min(W, H) * 0.012))
        em = outlined(emoji, st).rotate(-8 if not photo else 10, resample=Image.BICUBIC, expand=True)
        if photo:
            if portrait:
                pos = (int(W * 0.08), int(H * 0.47))
            else:
                pos = (int(W * 0.58), int(H * 0.06))
        else:
            if portrait:
                pos = (int(W / 2 - em.width / 2), int(H * 0.60))
            else:
                rays(img, int(W * 0.78), int(H * 0.5))
                pos = (int(W * 0.78 - em.width / 2), int(H * 0.5 - em.height / 2))
        img.paste(em, pos, em)

    clean = img.copy()  # everything except text, for the contrast check

    # title + subtitle
    tokens = parse_title(a.title, not a.keep_case)
    if not tokens:
        sys.exit("empty title")
    lower = a.keep_case
    tf = a.font or find_font("title")
    bx0, by0, bx1, by1 = text_box
    box_w, box_h = bx1 - bx0, by1 - by0
    sub_h = 0
    if a.subtitle:
        sub_h = min(W, H) * 0.115 + min(W, H) * 0.04
    max_cap = min(W, H) * 0.3
    size, lines = fit_title(tokens, tf, box_w, box_h - sub_h, hl_mode, max_cap, lower)
    m = Metrics(tf, size, hl_mode)
    m.desc_used = m.desc if lower else 0
    tb_h = m.block_h(len(lines), lower)
    group_h = tb_h + sub_h
    gy = by0 + (box_h - group_h) / 2
    tbox = draw_title(img, lines, m, bx0, gy, box_w, align, P, hl_mode)
    sub_info = None
    if a.subtitle:
        sub_size = int(min(W, H) * 0.058)
        sub_info = pill(img, a.subtitle, bx0, gy + tb_h + min(W, H) * 0.04, box_w, sub_size, P, align, box_w, find_font("bold"))

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() in (".jpg", ".jpeg"):
        img.save(out, quality=92, optimize=True)
    else:
        img.save(out, optimize=True)

    # ---------------- readability check
    scale = 168 / max(W, H)
    small = img.resize((max(1, round(W * scale)), max(1, round(H * scale))), Image.LANCZOS)
    region = clean.crop(tuple(int(v) for v in tbox)).resize((32, 32), Image.BOX)
    pixels = list(region.get_flattened_data() if hasattr(region, 'get_flattened_data') else region.getdata())
    bg_avg = tuple(sum(p[i] for p in pixels) // len(pixels) for i in range(3))
    # worst-case background: the 20% of pixels closest in luminance to the text fill
    fill = rgb(P["fill"])
    worst_bg = sorted(pixels, key=lambda p: contrast(p, fill))[len(pixels) // 5]
    c_fill_bg = contrast(fill, worst_bg)
    c_stroke_bg = contrast(rgb(P["stroke"]), worst_bg)
    c_fill_stroke = contrast(fill, rgb(P["stroke"]))
    stroke_small = m.stroke * scale
    # a thick outline that contrasts with the fill separates the text from any background
    outline_ok = stroke_small >= 0.6 and c_fill_stroke >= 4.5
    effective = max(c_fill_bg, min(c_fill_stroke, 21) if outline_ok else 0)
    cap_small = m.cap * scale
    warns = []
    if len(tokens) > 6:
        warns.append(f"{len(tokens)} words: thumbnails read best with 2-6")
    if cap_small < 8:
        warns.append(f"title letters are {cap_small:.1f}px tall at 168px wide (want >= 8): shorten the title")
    if effective < 3:
        warns.append(f"low text contrast ({effective:.1f}:1): try another --style or --bg")
    if any(hl for t, hl in tokens):
        hb, hf = rgb(P["hl_bg"]), rgb(P["hl_fg"])
        if hl_mode == "box":
            if contrast(hb, bg_avg) < 1.25:
                warns.append(f"keyword box color blends into the background ({contrast(hb, bg_avg):.1f}:1): pick another --accent")
            if contrast(hf, hb) < 3:
                warns.append(f"keyword text vs its box is only {contrast(hf, hb):.1f}:1")
        elif contrast(hb, rgb(P["stroke"])) < 3:
            warns.append(f"keyword color vs outline is only {contrast(hb, rgb(P['stroke'])):.1f}:1: pick a lighter --accent")
    if a.subtitle and sub_info and sub_info[1] * scale < 5:
        notes.append(f"subtitle is {sub_info[1] * scale:.1f}px tall in search results: fine as a secondary line, unreadable there")
    report = [
        f"{out}  {W}x{H}  style={a.style}  photo={photo or 'none'}",
        f"title: {len(lines)} line(s) {' / '.join(' '.join(t for t, _ in l) for l in lines)}",
        f"title size {size}px font, letters {m.cap}px tall; at 168px wide: {cap_small:.1f}px",
        f"contrast: fill vs background {c_fill_bg:.1f}:1, outline vs fill {c_fill_stroke:.1f}:1 (outline {stroke_small:.1f}px small) -> effective {effective:.1f}:1",
    ]
    for n in notes:
        report.append("note: " + n)
    for w in warns:
        report.append("WARNING: " + w)
    if not warns:
        report.append("readability: OK")
    print("\n".join(report))
    preview(img, small, report, out.with_name(out.stem + ".preview.png"))
    return 1 if warns else 0


def preview(img, small, report, path):
    W, H = img.size
    fw = 900 if W >= H else 420
    full = img.resize((fw, round(H * fw / W)), Image.LANCZOS)
    big = small.resize((small.width * 2, small.height * 2), Image.LANCZOS)
    pad = 28
    side_w = 520
    sh = max(full.height, 560) + 2 * pad + 40
    sheet = Image.new("RGB", (fw + side_w + 3 * pad, sh), (249, 249, 249))
    d = ImageDraw.Draw(sheet)
    fb = ImageFont.truetype(find_font("bold"), 18)
    fr = ImageFont.truetype(find_font("bold"), 14)
    d.text((pad, pad - 6), "Full size", font=fb, fill=(30, 30, 30))
    sheet.paste(full, (pad, pad + 24))
    x = fw + 2 * pad
    y = pad - 6
    d.text((x, y), "YouTube search size (168 px)", font=fb, fill=(30, 30, 30))
    y += 30
    sheet.paste(small, (x, y))
    # fake result row next to it
    tx = x + small.width + 14
    d.rounded_rectangle((tx, y + 2, tx + 300, y + 16), 4, fill=(60, 60, 60))
    d.rounded_rectangle((tx, y + 22, tx + 220, y + 36), 4, fill=(60, 60, 60))
    d.rounded_rectangle((tx, y + 48, tx + 160, y + 58), 4, fill=(190, 190, 190))
    y += small.height + 24
    d.text((x, y), "Same, 2x (phone screen)", font=fb, fill=(30, 30, 30))
    y += 30
    sheet.paste(big, (x, y))
    y += big.height + 20
    for line in report[1:]:
        col = (190, 20, 40) if line.startswith("WARNING") else (70, 70, 70)
        words, cur = line.split(" "), ""
        for wd in words:
            if d.textlength(cur + " " + wd, font=fr) > side_w - 10:
                d.text((x, y), cur, font=fr, fill=col)
                y += 20
                cur = wd
            else:
                cur = (cur + " " + wd).strip()
        d.text((x, y), cur, font=fr, fill=col)
        y += 22
    if y + pad > sheet.height:
        s2 = Image.new("RGB", (sheet.width, y + pad), (249, 249, 249))
        s2.paste(sheet, (0, 0))
        sheet = s2
    sheet.save(path, optimize=True)


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    p = argparse.ArgumentParser(description="Bright, bold YouTube/social thumbnails.")
    p.add_argument("--title", required=True, help='2-6 words; wrap the keyword in *stars* to highlight it')
    p.add_argument("--subtitle", help="short second line shown in a pill")
    p.add_argument("--photo", help="person/face photo; PNG with transparency gets a cut-out sticker outline")
    p.add_argument("--photo-shape", choices=["rect", "circle"], default="rect")
    p.add_argument("--tilt", type=float, default=3, help="degrees to rotate a rect photo card (default 3)")
    p.add_argument("--emoji", help="one emoji, drawn as a sticker (needs a color emoji font)")
    p.add_argument("--style", choices=sorted(PRESETS), default="pop")
    p.add_argument("--accent", help="hex color for the highlighted keyword (box or text)")
    p.add_argument("--highlight", choices=["box", "color"], default="box", help="keyword in a colored box, or just colored text")
    p.add_argument("--bg", help="background image (blurred, saturated, tinted with the style)")
    p.add_argument("--align", choices=["left", "center"])
    p.add_argument("--keep-case", action="store_true", help="do not uppercase the title")
    p.add_argument("--font", help="title font file (default: Impact or the best heavy condensed font found)")
    p.add_argument("--size", default="1280x720", help="1280x720 (YouTube), 1080x1920 (Shorts/Reels), 1200x630 (link preview)")
    p.add_argument("--out", required=True)
    sys.exit(build(p.parse_args()))


if __name__ == "__main__":
    main()
