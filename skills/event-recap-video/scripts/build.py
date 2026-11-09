"""Render the event recap from edit.json.

    python build.py              # renders both versions
    python build.py horizontal   # only output/recap.mp4
    python build.py vertical     # only output/recap-vertical.mp4

Everything you'd want to tweak lives in edit.json:
  title / subtitle / closing / closing_sub   card text
  music                                      path to an audio file (or null for no music)
  music_volume / duck_volume                 music level normally / under clips marked "speech": true
  horizontal / vertical                      the segment lists (clip id from work/media.json, start, dur)

Each segment is rendered once to work/seg/ and cached by its settings, so re-renders after small edits are fast.
"""
from fonts import font, ff_font
import hashlib, json, subprocess, sys, textwrap
from pathlib import Path
from PIL import Image, ImageFilter, ImageEnhance, ImageOps
import pillow_heif
pillow_heif.register_heif_opener()

ROOT = Path(__file__).resolve().parent
WORK, OUT = ROOT / "work", ROOT / "output"
SEG, PREP = WORK / "seg", WORK / "prep"
FPS, XF = 30, 0.5  # frame rate, crossfade seconds
FONT_TITLE = ff_font("serif_bold")
FONT_TEXT = ff_font("serif")
FONT_TITLE_PIL = font("serif_bold")
FORMATS = {"horizontal": (1920, 1080, "recap.mp4"),
           "vertical": (1080, 1920, "recap-vertical.mp4"),
           "vertical-full": (1080, 1920, "recap-vertical-full.mp4")}  # same edit as horizontal, 9:16

import os
EDIT_FILE = ROOT / os.environ.get("EDIT", "edit.json")
edit = json.loads(EDIT_FILE.read_text(encoding="utf-8"))
media = {m["id"]: m for m in json.loads((WORK / "media.json").read_text())}


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        print(" ".join(map(str, cmd))[:2000]); print(r.stderr[-3000:]); sys.exit(1)
    return r


def key(*parts):
    return hashlib.md5(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:10]


def esc(p):  # path for use inside an ffmpeg filter argument
    return str(p).replace("\\", "/").replace(":", "\\:")


AUDIO_OUT = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
VIDEO_OUT = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS)]


def compose_still(src, W, H, out, darken=1.0, blur_only=False):
    """Photo -> canvas at 2x size: sharp photo fitted on a blurred, dimmed copy of itself (no black bars)."""
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    CW, CH = W * 2, H * 2
    bg = ImageOps.fit(im, (CW, CH), Image.LANCZOS)
    a_img, a_can = im.width / im.height, CW / CH
    if blur_only:
        bg = bg.resize((CW // 8, CH // 8)).filter(ImageFilter.GaussianBlur(6)).resize((CW, CH), Image.LANCZOS)
        bg = ImageEnhance.Brightness(bg).enhance(darken)
    elif 0.85 < a_img / a_can < 1.2:  # close enough in shape: just fill the frame
        bg = ImageEnhance.Brightness(bg).enhance(darken)
    else:
        bg = bg.resize((CW // 8, CH // 8)).filter(ImageFilter.GaussianBlur(6)).resize((CW, CH), Image.LANCZOS)
        bg = ImageEnhance.Brightness(bg).enhance(0.55)
        fg = ImageOps.contain(im, (CW, CH), Image.LANCZOS)
        bg.paste(fg, ((CW - fg.width) // 2, (CH - fg.height) // 2))
    bg.save(out, quality=92)


def drawtext(textfile, font, size, y, alpha_expr="1", color="white"):
    return (f"drawtext=fontfile='{font}':textfile='{esc(textfile)}':fontsize={size}:fontcolor={color}:"
            f"x=(w-text_w)/2:y={y}:shadowcolor=black@0.6:shadowx=2:shadowy=2:alpha='{alpha_expr}'")


def text_lines(name, text, width_chars):
    lines = []
    for para in str(text).split("\n"):
        lines += textwrap.wrap(para, width_chars) or [""]
    files = []
    for i, ln in enumerate(lines):
        f = WORK / "text" / f"{name}_{i}.txt"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(ln, encoding="utf-8")
        files.append(f)
    return files


def render_card(fmt, kind, dur):
    W, H, _ = FORMATS[fmt]
    title, sub = (edit["title"], edit["subtitle"]) if kind == "title" else (edit["closing"], edit.get("closing_sub", ""))
    bg_id = edit.get(f"{kind}_bg")
    k = key(fmt, kind, dur, title, sub, bg_id, edit.get(f"{kind}_bg_at"), "v4")
    out = SEG / f"{fmt}_{kind}_{k}.mp4"
    if out.exists():
        return out
    still = PREP / f"{fmt}_{kind}_bg.jpg"
    if bg_id:
        src = ROOT / media[bg_id]["file"]
        if media[bg_id]["type"] == "video":  # use a frame from the clip
            frame = PREP / f"{kind}_{bg_id}_frame.jpg"
            at = float(edit.get(f"{kind}_bg_at", 0.5)) * media[bg_id]["duration"]
            run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(frame)])
            src = frame
        compose_still(src, W, H, still, darken=0.35, blur_only=True)
    else:
        Image.new("RGB", (W * 2, H * 2), (18, 16, 28)).save(still)
    big = int(min(W, H) * (0.085 if kind == "title" else (0.06 if len(title) < 40 else 0.048)))
    small = int(min(W, H) * 0.045)
    chars = 22 if W < H else 34
    tl = text_lines(f"{fmt}_{kind}_t", title, chars)
    sl = text_lines(f"{fmt}_{kind}_s", sub, chars + 10) if sub else []
    gap_t, gap_s = int(big * 1.25), int(small * 1.4)
    block = len(tl) * gap_t + (int(small * 0.8) + len(sl) * gap_s if sl else 0)
    y0 = (H - block) // 2
    fade = f"if(lt(t,0.4),0,if(lt(t,1.2),(t-0.4)/0.8,if(gt(t,{dur - 0.8}),max(0,({dur} - t)/0.8),1)))"
    nf = int(dur * FPS)
    filters = [f"scale={W * 2}:{H * 2}",
               f"zoompan=z='1+0.04*on/{nf}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={nf}:s={W}x{H}:fps={FPS}"]
    for i, f in enumerate(tl):
        filters.append(drawtext(f, FONT_TITLE, big, y0 + i * gap_t, fade))
    ys = y0 + len(tl) * gap_t + int(small * 0.8)
    for i, f in enumerate(sl):
        filters.append(drawtext(f, FONT_TEXT, small, ys + i * gap_s, fade, color="0xF2D9A0"))
    filters += ["setsar=1", "format=yuv420p"]
    run(["ffmpeg", "-y", "-v", "error", "-i", str(still), "-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo",
         "-filter_complex", f"[0:v]{','.join(filters)}[v]", "-map", "[v]", "-map", "1:a", "-t", str(dur),
         *VIDEO_OUT, *AUDIO_OUT, str(out)])
    return out


def label_filter(fmt, seg, dur):
    if not seg.get("label"):
        return ""
    W, H, _ = FORMATS[fmt]
    f = text_lines(f"lbl_{key(seg['label'])}", seg["label"], 60)[0]
    size = int(min(W, H) * 0.04)
    a = f"if(lt(t,0.5),0,if(lt(t,1.0),(t-0.5)/0.5,if(gt(t,{dur - 0.8}),max(0,({dur - 0.3}-t)/0.5),1)))"
    x, y = (int(W * 0.05), int(H * 0.85)) if W > H else ("(w-text_w)/2", int(H * 0.80))
    return (f",drawtext=fontfile='{FONT_TITLE}':textfile='{esc(f)}':fontsize={size}:fontcolor=white:x={x}:y={y}:"
            f"shadowcolor=black@0.7:shadowx=2:shadowy=2:alpha='{a}'")


def render_segment(fmt, i, seg, has_music):
    W, H, _ = FORMATS[fmt]
    m = media[seg["id"]]
    src = ROOT / m["file"]
    speech = bool(seg.get("speech"))
    # clip audio level: speaking/singing clips stay at full level; other clips are quieter ambience under music
    clip_vol = 1.0 if (speech or not has_music) else float(edit.get("ambient_volume", 0.25))
    if m["type"] == "photo":
        dur = float(seg.get("dur", edit.get("photo_seconds", 3.0)))
        k = key(fmt, seg, clip_vol, "p3")
        out = SEG / f"{fmt}_{i:03d}_{k}.mp4"
        if out.exists():
            return out, dur, False
        still = PREP / f"{fmt}_{seg['id']}.jpg"
        compose_still(src, W, H, still)
        n = int(round(dur * FPS))
        z0, z1 = (1.0, 1.10) if i % 2 == 0 else (1.10, 1.0)  # alternate zoom in / zoom out
        pan = [("iw/2-iw/zoom/2", "ih/2-ih/zoom/2"), ("(iw-iw/zoom)*on/{n}", "ih/2-ih/zoom/2"),
               ("(iw-iw/zoom)*(1-on/{n})", "ih/2-ih/zoom/2"), ("iw/2-iw/zoom/2", "(ih-ih/zoom)*on/{n}")][i % 4]
        zx, zy = (p.format(n=n) for p in pan)
        vf = (f"scale={W * 2}:{H * 2},zoompan=z='{z0}+({z1 - z0})*on/{n}':x='{zx}':y='{zy}':d={n}:s={W}x{H}:fps={FPS},"
              f"setsar=1,format=yuv420p" + label_filter(fmt, seg, dur))
        run(["ffmpeg", "-y", "-v", "error", "-i", str(still), "-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo",
             "-filter_complex", f"[0:v]{vf}[v]", "-map", "[v]", "-map", "1:a", "-t", str(dur), *VIDEO_OUT, *AUDIO_OUT, str(out)])
        return out, dur, False
    dur = float(seg.get("dur", 5))
    if "at" in seg:  # "at": 0..1 = centre of the cut as a fraction of the clip's length
        start = float(seg["at"]) * m["duration"] - dur / 2
    else:
        start = float(seg.get("start", 0))
    start = max(0.0, min(start, m["duration"] - dur - 0.05))
    dur = min(dur, max(1.0, m["duration"] - start - 0.05))
    k = key(fmt, seg, clip_vol, "v3")
    out = SEG / f"{fmt}_{i:03d}_{k}.mp4"
    if out.exists():
        return out, dur, speech
    a_src, a_can = m["w"] / m["h"], W / H
    if 0.9 < a_src / a_can < 1.15:
        vf = f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
    else:  # blur-fill instead of black bars
        vf = (f"[0:v]split[a][b];[a]scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
              f"gblur=sigma=12,eq=brightness=-0.12,scale={W}:{H}[bg];"
              f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2")
    vf += f",fps={FPS},setsar=1,format=yuv420p" + label_filter(fmt, seg, dur) + "[v]"
    inputs = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    if m.get("has_audio"):
        af = (f";[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={clip_vol},"
              f"afade=t=in:d=0.15,afade=t=out:st={max(0, dur - 0.2):.3f}:d=0.2[a]")
        amap = "[a]"
    else:
        inputs += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        af, amap = "", "1:a"
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", vf + af, "-map", "[v]", "-map", amap,
         "-t", f"{dur:.3f}", *VIDEO_OUT, *AUDIO_OUT, str(out)])
    return out, dur, speech


def assemble(fmt):
    W, H, name = FORMATS[fmt]
    plan = "horizontal" if fmt == "vertical-full" else fmt  # which segment lists to use
    music = edit.get(f"{plan}_music", edit.get("music"))
    if isinstance(music, str):
        music = [music]
    music = [t for t in (music or []) if (ROOT / t).exists() or print(f"music file {t} not found, skipping")]
    has_music = bool(music)
    if len(music) > 1:  # chain several tracks with a 3 s crossfade into one bed
        mix = WORK / f"music_{key(music)}.wav"
        if not mix.exists():
            ins = sum((["-i", str(ROOT / t)] for t in music), [])
            g = "".join(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[m{i}];" for i in range(len(music)))
            prev = "[m0]"
            for i in range(1, len(music)):
                g += f"{prev}[m{i}]acrossfade=d=3:c1=qsin:c2=qsin[x{i}];"
                prev = f"[x{i}]"
            run(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex", g.rstrip(";"), "-map", prev, str(mix)])
        music_file = mix
    elif music:
        music_file = ROOT / music[0]
    card = 2.5 if fmt == "vertical" else 4.0
    hook = edit.get(f"{plan}_hook", [])
    hook_xf = float(edit.get("hook_xf", 0.1))  # near-hard cuts in the cold open
    parts = []  # (file, duration, speech, transition-into-this-part)
    for i, seg in enumerate(hook):
        print(f"  [{fmt}] hook {i + 1}/{len(hook)}", end="\r")
        p, d, sp = render_segment(fmt, 900 + i, seg, has_music)
        parts.append((p, d, sp, hook_xf))
    parts.append((render_card(fmt, "title", card), card, False, XF))
    for i, seg in enumerate(edit[plan]):
        print(f"  [{fmt}] segment {i + 1}/{len(edit[plan])}", end="\r")
        p, d, sp = render_segment(fmt, i, seg, has_music)
        parts.append((p, d, sp, float(seg.get("xf", XF))))
    cdur = float(edit.get("closing_seconds", 5.5 if fmt == "vertical" else 7.0))
    parts.append((render_card(fmt, "closing", cdur), cdur, False, XF))
    print()
    inputs, vchain, achain = [], "", ""
    speech_ranges = []
    for p, *_ in parts:
        inputs += ["-i", str(p)]
    t = 0.0  # running start time of each part in the final timeline
    starts = []
    for j, (p, d, sp, xf) in enumerate(parts):
        if j:
            t -= xf  # this part overlaps the previous one by its transition length
        starts.append(t)
        if sp:
            speech_ranges.append((t, t + d))
        t += d
    total = t
    prev_v, prev_a = "[0:v]", "[0:a]"
    for j in range(1, len(parts)):
        off, xf = starts[j], parts[j][3]
        vchain += f"{prev_v}[{j}:v]xfade=transition=fade:duration={xf}:offset={off:.3f}[v{j}];"
        achain += f"{prev_a}[{j}:a]acrossfade=d={xf}:c1=tri:c2=tri[a{j}];"
        prev_v, prev_a = f"[v{j}]", f"[a{j}]"
    graph = vchain + achain
    n = len(parts)
    if has_music:
        inputs += ["-stream_loop", "-1", "-i", str(music_file)]
        base, duck = float(edit.get("music_volume", 0.35)), float(edit.get("duck_volume", 0.08))
        dips = [f"clip((t-{a - 0.6:.2f})/0.6,0,1)*clip(({b + 0.6:.2f}-t)/0.6,0,1)" for a, b in speech_ranges] or ["0"]
        dip = dips[0]
        for d in dips[1:]:
            dip = f"max({dip},{d})"
        graph += (f"[{n}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
                  f"volume='{base}-({base - duck})*{dip}':eval=frame,"
                  f"afade=t=in:d=2,afade=t=out:st={total - 3.5:.3f}:d=3.5[mus];"
                  f"{prev_a}[mus]amix=inputs=2:normalize=0:duration=first[mix];")
        prev_a = "[mix]"
    graph += f"{prev_a}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]"
    out = OUT / (name.replace(".mp4", os.environ.get("OUT_SUFFIX", "") + ".mp4"))
    OUT.mkdir(exist_ok=True)
    gf = WORK / f"{fmt}_graph.txt"
    gf.write_text(graph)
    print(f"  [{fmt}] assembling {n} parts, {total:.1f}s")
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-/filter_complex", str(gf), "-map", prev_v, "-map", "[aout]",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(out)])
    print(f"  wrote {out} ({total:.1f}s)")


if __name__ == "__main__":
    SEG.mkdir(parents=True, exist_ok=True); PREP.mkdir(parents=True, exist_ok=True)
    for fmt in (sys.argv[1:] or ["horizontal", "vertical"]):
        assemble(fmt)
