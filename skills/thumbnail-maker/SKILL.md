---
name: thumbnail-maker
description: Make bright, bold YouTube and social thumbnails (1280x720, plus 1080x1920 Shorts/Reels and 1200x630 link previews) with Pillow - huge auto-fitted title with a thick outline and shadow, one highlighted keyword, a person photo or cut-out with a white sticker outline, optional emoji sticker and blurred background image, in preset color styles. Includes a readability check at YouTube search size (168x94) and a preview sheet. Use when the user asks for a thumbnail, cover image, video title card or Fiverr/gig image in a loud YouTube style.
---

# thumbnail-maker

`scripts/thumbnail.py` (with `scripts/fonts.py` next to it). Python 3.9+ and `pip install pillow`.

```
python thumbnail.py --title "I built *this* in 1 day" --subtitle "No code needed" --photo me.jpg --style pop --out thumb.png
python thumbnail.py --title "Python in *10 minutes*" --photo me-cutout.png --style tech --out t.png
python thumbnail.py --title "Stop wasting *money*" --subtitle "5 simple fixes" --emoji "💸" --style green --out t.jpg
python thumbnail.py --title "A day as a *dev*" --photo me.jpg --style red --size 1080x1920 --out short.png
```

| Option | What it does |
|---|---|
| `--title` | 2-6 words works best. `*word*` (or `*two words*`) is the highlighted keyword, kept on one line. Uppercased unless `--keep-case`. |
| `--subtitle` | Short second line in a pill under the title. |
| `--photo` | Person/face photo. JPG/opaque PNG becomes a card with a thick white border, rounded corners, drop shadow and a slight tilt (`--tilt 0` to keep it straight, `--photo-shape circle` for a round crop; crop is centered slightly above the middle where faces usually are). A PNG with transparency (a cut-out) gets a white outline that follows its shape. |
| `--emoji` | One emoji drawn as a sticker. Skipped with a note if there is no color emoji font. |
| `--style` | `pop` yellow/orange + red keyword box, `tech` cyan/blue + navy box, `red` YouTube red + yellow box, `green` money green + yellow box. |
| `--accent "#hex"` | Keyword color. `--highlight color` colors the word instead of boxing it. |
| `--bg` | Background image, blurred, saturated and tinted with the style colors. |
| `--size` | `1280x720` (default), `1080x1920`, `1200x630`, or any WxH. |
| `--align left/center`, `--font path.ttf` | Override layout alignment or the title font. |

Layout: with a photo or emoji, title on the left ~55 %, art on the right (portrait sizes: title on top, art below). Without either, the title is centered. The title is fitted as large as possible over every 1-3 line split of the words; ties go to evenly filled lines.

## Outputs
- `--out` file (PNG, or JPG when the name ends in .jpg).
- `<name>.preview.png`: full size next to the 168 px search-result size and a 2x version, with the check results. LOOK at it.
- Terminal: chosen line split, letter height at full and at 168 px wide, contrast numbers, warnings. Exit code 1 if there is any warning.

## Readability check
- Title letters under 8 px tall at 168 px wide -> warning (shorten the title). In tests, 2-5 word titles landed at 14-28 px; a 12-word title got 5 px.
- Contrast: text fill vs the background behind it, and fill vs its outline. White text with a thick dark outline reads on anything, so it passes even on a yellow background; the warning fires when the outline gets too thin at small size (long titles) and the fill alone does not stand out.
- Keyword box that blends into the background (e.g. `--accent` yellow on the `pop` style) or keyword text that does not contrast with its box/outline -> warning.
- More than 6 words -> warning. The subtitle is reported as a note: it is unreadable at search size by design and should not carry the message.

## Limits
- No background removal. For the "cut-out person" look, pass a PNG that is already cut out (remove.bg, Photoshop, macOS "Copy Subject").
- Fonts: Impact for titles (Windows/macOS; Linux needs `ttf-mscorefonts` or set `FONT_TITLE=/path/Anton-Regular.ttf`, else falls back to DejaVu Sans Condensed Bold, which looks plainer). Override any font with `FONT_TITLE`, `FONT_BOLD`, `FONT_EMOJI`.
- Emoji: single-codepoint emoji only (Pillow without libraqm cannot join ZWJ sequences or skin tones). Segoe UI Emoji on Windows renders flat-color emoji; Bitmap emoji fonts (Noto Color Emoji, Apple) are loaded at their fixed size and scaled, so they may look softer (only tested with Segoe UI Emoji).
- Max 3 title lines; very long titles get small and trigger the warning rather than wrapping further.
- Designs are template-based: four styles, fixed layouts. Faces are never detected, so a photo with the face near the edge may be cropped; crop the photo first.
