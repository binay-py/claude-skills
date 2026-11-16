"""Cross-platform font lookup for the recap scripts.

Override any font with an env var, e.g. FONT_BLACK=/path/to/Inter-Black.ttf
Kinds: serif, serif_bold, sans_bold, black, emoji, devanagari
"""
import functools, os, re, subprocess, tempfile
from pathlib import Path

_CANDIDATES = {
    "serif": ["C:/Windows/Fonts/georgia.ttf", "/System/Library/Fonts/Supplemental/Georgia.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/TTF/DejaVuSerif.ttf"],
    "serif_bold": ["C:/Windows/Fonts/georgiab.ttf", "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf"],
    "sans_bold": ["C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    "black": ["C:/Windows/Fonts/seguibl.ttf", "/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/usr/share/fonts/truetype/msttcorefonts/Arial_Black.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    "emoji": ["C:/Windows/Fonts/seguiemj.ttf", "/System/Library/Fonts/Apple Color Emoji.ttc",
              "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/noto/NotoColorEmoji.ttf"],
    # Nepali / Hindi titles and labels: Georgia, Arial and Segoe UI have no Devanagari and draw boxes
    "devanagari": ["C:/Windows/Fonts/mangalb.ttf", "C:/Windows/Fonts/Nirmala.ttc", "/System/Library/Fonts/Kohinoor.ttc",
                   "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc",
                   "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf", "/usr/share/fonts/opentype/noto/NotoSansDevanagari-Bold.ttf",
                   "/usr/share/fonts/noto/NotoSansDevanagari-Bold.ttf", "/usr/share/fonts/truetype/lohit-devanagari/Lohit-Devanagari.ttf"],
}


def font(kind: str) -> str:
    """Absolute path of a font file of this kind (for PIL)."""
    env = os.environ.get("FONT_" + kind.upper())
    if env:
        return env
    for p in _CANDIDATES[kind]:
        if Path(p).exists():
            return p
    raise FileNotFoundError(f"No '{kind}' font found. Set FONT_{kind.upper()}=/path/to/font.ttf")


def ff_font(kind: str) -> str:
    """Same path, escaped for an ffmpeg drawtext fontfile= argument."""
    return font(kind).replace("\\", "/").replace(":", "\\:")



# ---------------------------------------------------------------- Devanagari shaping
# Pillow without raqm can't shape Devanagari (conjuncts, the short-i matra before its consonant), and ffmpeg's
# drawtext shapes a whole line in the script of its first letter ("Day 1 दिन" breaks). So such text is shaped by
# drawtext one word at a time and composed in Pillow: motion.py stickers and shortlist labels, and (as PNGs that
# ffmpeg overlays) build.py cards and labels and reel.py text.
DEVA = re.compile("[\u0900-\u097F]")


@functools.lru_cache(None)
def harfbuzz():
    try:
        return "libharfbuzz" in subprocess.run(["ffmpeg", "-hide_banner", "-buildconf"], capture_output=True, text=True).stdout
    except OSError:
        return False


@functools.lru_cache(None)
def _ffmpeg_shapes():
    from PIL import features
    return not features.check("raqm") and harfbuzz()


def needs_shaping(text):
    return bool(DEVA.search(str(text))) and _ffmpeg_shapes()


@functools.lru_cache(None)
def shaped(text, path, size, stroke=0):
    """ffmpeg-shaped text as coverage masks: (fill, fill + outline, crop offset from the ink's left edge and from the
    baseline, ink width)."""
    from PIL import Image, ImageChops, ImageFont
    words = text.split()
    if len(words) > 1:  # drawtext shapes a whole line in its first letter's script: shape word by word, then join
        sp, x, parts = ImageFont.truetype(path, size).getlength(" "), 0, []
        for w in words:
            parts.append((x, shaped(w, path, size, stroke)))
            x += parts[-1][1][4] + sp
        L, T = min(x0 + p[2] for x0, p in parts), min(p[3] for _, p in parts)
        size_ = (round(max(x0 + p[2] + p[0].width for x0, p in parts) - L), max(p[3] + p[0].height for _, p in parts) - T)
        masks = []
        for k in (0, 1) if stroke else (0,):
            m = Image.new("L", size_, 0)
            for x0, p in parts:
                one = Image.new("L", size_, 0)
                one.paste(p[k], (round(x0 + p[2] - L), p[3] - T))
                m = ImageChops.lighter(m, one)
            masks.append(m)
        return (masks[0], masks[1] if stroke else None, L, T, x - sp)
    pad = size + stroke
    W, H, base = int(len(text) * size * 1.2) + 4 * pad, 3 * pad + size, 2 * pad
    with tempfile.TemporaryDirectory() as td:
        tf, out = Path(td, "t.txt"), Path(td, "t.png")
        tf.write_text(text, encoding="utf-8")
        esc = lambda q: str(q).replace("\\", "/").replace(":", "\\:")  # noqa: E731
        dt = lambda x, b: (f"drawtext=fontfile='{esc(path)}':textfile='{esc(tf)}':fontsize={size}:fontcolor=white:"  # noqa: E731
                           f"borderw={b}:bordercolor=white:x={x}:y={base}:y_align=baseline")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s={2 * W}x{H}", "-vf",
                        f"{dt(pad, 0)},{dt(W + pad, stroke)},format=gray", "-frames:v", "1", str(out)], check=True, capture_output=True)
        im = Image.open(out)
        im.load()
    fill, line = im.crop((0, 0, W, H)), im.crop((W, 0, 2 * W, H))
    fb = fill.getbbox()
    box = line.getbbox() if stroke else fb
    return fill.crop(box), line.crop(box) if stroke else None, box[0] - fb[0], box[1] - base, fb[2] - fb[0]


def paste_shaped(im, x, y, sh, fill, line=None):
    """Composites shaped() text onto an RGB or RGBA image with its ink starting at x and its baseline at y."""
    from PIL import Image, ImageColor
    for mask, color in ((sh[1], line), (sh[0], fill)):
        if mask is None or color is None:
            continue
        c = ImageColor.getcolor(color, "RGBA") if isinstance(color, str) else tuple(color) + (255,) * (4 - len(color))
        a = Image.new("L", im.size, 0)
        a.paste(mask.point(lambda v: v * c[3] // 255), (round(x + sh[2]), round(y + sh[3])))
        if im.mode == "RGBA":
            layer = Image.new("RGBA", im.size, c[:3] + (0,))
            layer.putalpha(a)
            im.alpha_composite(layer)
        else:
            im.paste(Image.new(im.mode, im.size, c[:3]), (0, 0), a)


def text_png(text, path, size, out, fill="white", border=0, line=None, shadow=None):
    """One line shaped word by word, saved as an RGBA PNG for ffmpeg's overlay (outline: border px in `line` color,
    shadow: (dx, dy, color)). Returns the ink's left and top edge inside the PNG and the ink width."""
    from PIL import Image
    sh = shaped(text, path, size, border)
    dx, dy, sc = shadow or (0, 0, None)
    m = border + 2
    im = Image.new("RGBA", (sh[0].width + dx + 2 * m, sh[0].height + dy + 2 * m), (0, 0, 0, 0))
    x, y = m - sh[2], m - sh[3]  # pen origin: the ink's left edge, on the baseline
    if sc:
        paste_shaped(im, x + dx, y + dy, sh, sc, sc if border else None)
    paste_shaped(im, x, y, sh, fill, line)
    im.save(out)
    b = sh[0].getbbox()
    return m + b[0], m + b[1], sh[4]
