"""Cross-platform font lookup for thumbnail.py.

Override any kind with an env var, e.g. FONT_TITLE=/path/to/Anton-Regular.ttf
Kinds: title (tall condensed heavy), black (wide heavy), bold (subtitle), emoji (color emoji)
"""
import os
from pathlib import Path

_CANDIDATES = {
    "title": ["C:/Windows/Fonts/impact.ttf", "/System/Library/Fonts/Supplemental/Impact.ttf", "/Library/Fonts/Impact.ttf",
              "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf", "/usr/share/fonts/truetype/msttcorefonts/impact.ttf",
              "/usr/share/fonts/truetype/anton/Anton-Regular.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSansCondensed-Bold.ttf"],
    "black": ["C:/Windows/Fonts/seguibl.ttf", "C:/Windows/Fonts/ariblk.ttf", "/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/usr/share/fonts/truetype/msttcorefonts/Arial_Black.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    "bold": ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    "emoji": ["C:/Windows/Fonts/seguiemj.ttf", "/System/Library/Fonts/Apple Color Emoji.ttc",
              "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/noto/NotoColorEmoji.ttf"],
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
