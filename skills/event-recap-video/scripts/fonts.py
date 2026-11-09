"""Cross-platform font lookup for the recap scripts.

Override any font with an env var, e.g. FONT_BLACK=/path/to/Inter-Black.ttf
Kinds: serif, serif_bold, sans_bold, black, emoji
"""
import os
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
