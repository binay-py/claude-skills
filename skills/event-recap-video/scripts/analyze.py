"""Scan ./raw, sort everything by capture time, score quality, and build contact sheets.

Outputs:
  work/media.json        one record per file (time, type, size, rotation, duration, blur, brightness, flags)
  work/thumbs/<id>.jpg   thumbnail(s) per item
  work/sheets/*.jpg      contact sheets per day with item ids printed on them

Usage: python analyze.py
"""
from fonts import font, ff_font
import json, os, re, subprocess, sys, datetime as dt
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
import pillow_heif
pillow_heif.register_heif_opener()

ROOT = Path(__file__).resolve().parent
RAW, WORK = ROOT / "raw", ROOT / "work"
THUMBS, SHEETS = WORK / "thumbs", WORK / "sheets"
LOCAL_TZ = dt.timezone(dt.timedelta(hours=5, minutes=45))  # Nepal time, used for video UTC timestamps
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".3gp", ".mkv", ".webm"}


def probe(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)],
                       capture_output=True, text=True)
    return json.loads(r.stdout or "{}")


def rotation_of(vs):
    rot = 0
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(round(float(sd["rotation"])))
    if "rotate" in vs.get("tags", {}):
        rot = -int(vs["tags"]["rotate"])
    return rot % 360


def time_from_name(name):
    m = re.search(r"(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})", name)
    if m:
        return dt.datetime(*map(int, m.groups()))
    return None


def frame_metrics(img):
    g = np.asarray(img.convert("L").resize((320, int(320 * img.height / img.width) or 1)), dtype=np.float32)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    small = np.asarray(img.convert("L").resize((9, 8)), dtype=np.int16)
    dhash = int("".join("1" if b else "0" for b in (small[:, 1:] > small[:, :-1]).flatten()), 2)
    return float(lap.var()), float(g.mean()), dhash


def grab_frame(p, t, out):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(p), "-frames:v", "1",
                    "-vf", "scale=480:-2", "-q:v", "4", str(out)], capture_output=True)
    return out.exists()


def volume_of(p):
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(p), "-vn", "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"mean_volume: (-?[\d.]+)", r.stderr)
    return float(m.group(1)) if m else None


def analyze(p, idx):
    rec = {"id": f"{idx:04d}", "file": str(p.relative_to(ROOT)).replace("\\", "/"), "name": p.name}
    ext = p.suffix.lower()
    rec["type"] = "video" if ext in VIDEO_EXT else "photo"
    info = probe(p)
    vs = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    rec["has_audio"] = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    w, h = vs.get("width", 0), vs.get("height", 0)
    t = None
    if rec["type"] == "photo":
        try:
            im = Image.open(p)
            ex = im.getexif()
            sub = ex.get_ifd(0x8769)
            s = sub.get(36867) or ex.get(306)
            if s:
                t = dt.datetime.strptime(s.strip("\x00")[:19], "%Y:%m:%d %H:%M:%S")
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            rec["blur"], rec["bright"], rec["dhash"] = frame_metrics(im)
            im.thumbnail((480, 480)); im.convert("RGB").save(THUMBS / f"{rec['id']}.jpg", quality=80)
        except Exception as e:  # e.g. HEIC without plugin: fall back to ffmpeg
            rec["err"] = str(e)
            if grab_frame(p, 0, THUMBS / f"{rec['id']}.jpg"):
                im = Image.open(THUMBS / f"{rec['id']}.jpg")
                rec["blur"], rec["bright"], rec["dhash"] = frame_metrics(im)
        rec["rotation"] = 0
    else:
        rec["rotation"] = rotation_of(vs)
        if rec["rotation"] in (90, 270):
            w, h = h, w
        dur = float(info.get("format", {}).get("duration", 0) or 0)
        rec["duration"] = dur
        ct = info.get("format", {}).get("tags", {}).get("creation_time") or vs.get("tags", {}).get("creation_time")
        if ct:
            try:
                t = dt.datetime.fromisoformat(ct.replace("Z", "+00:00")).astimezone(LOCAL_TZ).replace(tzinfo=None)
                if t.year < 2000:
                    t = None
            except ValueError:
                t = None
        blurs, brights = [], []
        for k, frac in enumerate((0.15, 0.5, 0.85)):
            out = THUMBS / f"{rec['id']}_{k}.jpg"
            if dur > 0 and grab_frame(p, dur * frac, out):
                b, br, dh = frame_metrics(Image.open(out))
                blurs.append(b); brights.append(br)
                if k == 1:
                    rec["dhash"] = dh
        rec["blur"] = float(np.median(blurs)) if blurs else 0
        rec["bright"] = float(np.median(brights)) if brights else 0
        rec["volume"] = volume_of(p) if rec["has_audio"] else None
    t = t or time_from_name(p.name) or dt.datetime.fromtimestamp(p.stat().st_mtime)
    rec["time"] = t.isoformat(timespec="seconds")
    rec["w"], rec["h"] = w, h
    rec["orient"] = "portrait" if h > w else "landscape"
    flags = []
    if rec["type"] == "video" and rec.get("duration", 0) < 1.0:
        flags.append("too_short")
    if rec.get("bright", 100) < 28:
        flags.append("dark")
    if rec.get("blur", 999) < 25:
        flags.append("blurry")
    rec["flags"] = flags
    return rec


def mark_duplicates(recs):
    photos = [r for r in recs if r["type"] == "photo" and "dhash" in r]
    for a, b in zip(photos, photos[1:]):
        gap = abs((dt.datetime.fromisoformat(b["time"]) - dt.datetime.fromisoformat(a["time"])).total_seconds())
        if gap < 30 and bin(a["dhash"] ^ b["dhash"]).count("1") <= 8:
            worse = a if a.get("blur", 0) < b.get("blur", 0) else b
            if "duplicate" not in worse["flags"]:
                worse["flags"].append("duplicate")


def contact_sheets(recs):
    font = ImageFont.truetype(font("sans_bold"), 18)
    days = {}
    for r in recs:
        days.setdefault(r["time"][:10], []).append(r)
    for day, items in days.items():
        cols, cw, ch = 8, 240, 240
        for part in range(0, len(items), 64):
            chunk = items[part:part + 64]
            rows = (len(chunk) + cols - 1) // cols
            sheet = Image.new("RGB", (cols * cw, rows * ch), (20, 20, 20))
            d = ImageDraw.Draw(sheet)
            for i, r in enumerate(chunk):
                x, y = (i % cols) * cw, (i // cols) * ch
                tp = THUMBS / (f"{r['id']}.jpg" if r["type"] == "photo" else f"{r['id']}_1.jpg")
                if tp.exists():
                    im = Image.open(tp); im.thumbnail((cw - 6, ch - 6))
                    sheet.paste(im, (x + (cw - im.width) // 2, y + (ch - im.height) // 2))
                label = r["id"] + (f" V{r.get('duration', 0):.0f}s" if r["type"] == "video" else "")
                if r["flags"]:
                    label += " " + ",".join(f[:3] for f in r["flags"])
                d.rectangle([x, y, x + cw, y + 24], fill=(0, 0, 0))
                d.text((x + 4, y + 2), label, fill=(255, 80, 80) if r["flags"] else (255, 255, 255), font=font)
                d.text((x + 4, y + ch - 22), r["time"][11:16], fill=(255, 255, 0), font=font)
            sheet.save(SHEETS / f"{day}_{part // 64}.jpg", quality=82)


def main():
    THUMBS.mkdir(parents=True, exist_ok=True); SHEETS.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in RAW.rglob("*") if p.is_file() and p.suffix.lower() in PHOTO_EXT | VIDEO_EXT)
    print(f"{len(files)} media files")
    with ThreadPoolExecutor(max_workers=8) as ex:
        recs = list(ex.map(lambda a: analyze(*a), [(p, i) for i, p in enumerate(files)]))
    recs.sort(key=lambda r: r["time"])
    mark_duplicates(recs)
    (WORK / "media.json").write_text(json.dumps(recs, indent=1))
    contact_sheets(recs)
    from collections import Counter
    print(Counter(r["time"][:10] for r in recs))
    print(Counter(f for r in recs for f in r["flags"]))


if __name__ == "__main__":
    main()
