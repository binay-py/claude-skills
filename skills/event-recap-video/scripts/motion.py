"""Beat-synced, motion-heavy recap with meme stickers, speed ramps, freeze gags and sound effects.

    python motion.py                 # both: output/recap-motion.mp4 (16:9) and output/recap-motion-vertical.mp4 (9:16)
    python motion.py horizontal      # or: vertical

The whole edit is motion.json. Clip fields:
  id            clip id from work/media.json (see output/shortlist.jpg, work/vsheets/)
  at | start    where to cut: fraction 0..1 of the clip (centre) or seconds from the start
  beats         length on the music grid (1 beat = 60/bpm s)
  speed         0.5 = slow-mo, 2 = fast-forward (clip audio pitches with it, on purpose)
  freeze        last N beats freeze on a frame; the music tape-stops and goes silent (meme freeze)
  cap           sticker caption (emoji welcome); pos: "top" | "bottom"; cap_at: seconds into the clip
  day           big slam-in day title with a whoosh
  title         [line1, line2] big title sticker;  verse: [text, reference] fade-in verse card
  flash, shake, punch, speech   white flash in / camera shake / zoom punch on the cut / keep clip sound loud
"""
from fonts import font, ff_font
import hashlib, json, subprocess, sys, wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import pillow_heif

pillow_heif.register_heif_opener()
ROOT = Path(__file__).resolve().parent
WORK, OUT = ROOT / "work", ROOT / "output"
MS = WORK / "motion"
import os
PLAN = json.loads((ROOT / os.environ.get("PLAN", "motion.json")).read_text(encoding="utf-8"))
MEDIA = {m["id"]: m for m in json.loads((WORK / "media.json").read_text())}
FPS, SR = 30, 48000
FMT = {"horizontal": (1920, 1080, "recap-motion.mp4"), "vertical": (1080, 1920, "recap-motion-vertical.mp4")}
F_BLACK, F_EMOJI, F_SERIF = font("black"), font("emoji"), font("serif_bold")


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        print(" ".join(map(str, cmd))[:1500]); print(r.stderr[-2500:]); sys.exit(1)
    return r


def h(*a):
    return hashlib.md5(json.dumps(a, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:10]


# ---------------------------------------------------------------- stickers (PIL)
def is_emoji(ch):
    o = ord(ch)
    return o >= 0x1F000 or 0x2600 <= o <= 0x27BF or o in (0xFE0F, 0x200D, 0x2B50, 0x2764)


def runs(text):
    out = []
    for ch in text:
        e = is_emoji(ch)
        if out and out[-1][0] == e:
            out[-1][1] += ch
        else:
            out.append([e, ch])
    return out


def draw_line(text, size, fill, stroke=0, stroke_fill="black"):
    ft, fe = ImageFont.truetype(F_BLACK, size), ImageFont.truetype(F_EMOJI, int(size * 0.92))
    parts = runs(text)
    w = sum((fe if e else ft).getlength(s) for e, s in parts) + 2 * stroke + 8
    im = Image.new("RGBA", (int(w), int(size * 1.45) + 2 * stroke), (0, 0, 0, 0))
    d, x = ImageDraw.Draw(im), stroke + 4
    for e, s in parts:
        if e:
            d.text((x, stroke + size * 0.12), s, font=fe, embedded_color=True)
            x += fe.getlength(s)
        else:
            d.text((x, stroke), s, font=ft, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
            x += ft.getlength(s)
    return im


def wrap(text, n):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        if len(cur) + len(w_) + 1 > n and cur:
            lines.append(cur); cur = w_
        else:
            cur = (cur + " " + w_).strip()
    return lines + ([cur] if cur else [])


def sticker(kind, payload, fmt):
    W, H, _ = FMT[fmt]
    out = MS / f"st_{fmt}_{h(kind, payload)}.png"
    if out.exists():
        return out
    u = min(W, H)
    tilt = (int(h(payload), 16) % 7) - 3  # -3..3 degrees, stable per caption
    if kind == "cap":
        colors = [(255, 221, 51), (255, 255, 255), (255, 120, 190), (120, 230, 255)]
        bg = colors[int(h(payload), 16) % len(colors)]
        lines = [draw_line(l, int(u * (0.085 if W > H else 0.072)), (15, 15, 15)) for l in wrap(payload, 20 if W > H else 16)]
        pad = int(u * 0.022)
        bw, bh = max(l.width for l in lines) + 2 * pad, sum(int(l.height * 0.86) for l in lines) + 2 * pad
        im = Image.new("RGBA", (bw + 40, bh + 40), (0, 0, 0, 0))
        sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([24, 26, 24 + bw, 26 + bh], 28, fill=(0, 0, 0, 150))
        im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(6)))
        ImageDraw.Draw(im).rounded_rectangle([16, 16, 16 + bw, 16 + bh], 28, fill=bg + (255,))
        y = 16 + pad - int(u * 0.008)
        for l in lines:
            im.alpha_composite(l, (16 + (bw - l.width) // 2, y)); y += int(l.height * 0.86)
    elif kind == "day":
        a = draw_line(payload, int(u * 0.16), (255, 255, 255), stroke=int(u * 0.012))
        im = Image.new("RGBA", (a.width + 60, a.height + 60), (0, 0, 0, 0))
        bar = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(bar).rectangle([20, int(im.height * 0.62), im.width - 20, int(im.height * 0.86)], fill=(255, 205, 40, 255))
        im.alpha_composite(bar); im.alpha_composite(a, (30, 20)); tilt = -4
    elif kind == "title":
        a = draw_line(payload[0], int(u * 0.15), (255, 255, 255), stroke=int(u * 0.012))
        b = sticker_box(payload[1], int(u * 0.055))
        im = Image.new("RGBA", (max(a.width, b.width) + 40, a.height + b.height + 30), (0, 0, 0, 0))
        im.alpha_composite(a, ((im.width - a.width) // 2, 0)); im.alpha_composite(b, ((im.width - b.width) // 2, a.height + 10))
        tilt = -2
    elif kind == "verse":
        fs = ImageFont.truetype(F_SERIF, int(u * 0.05)); fr = ImageFont.truetype(F_BLACK, int(u * 0.04))
        lines = wrap(payload[0], 34 if W > H else 22)
        lh = int(u * 0.068)
        im = Image.new("RGBA", (int(W * 0.9), lh * len(lines) + int(u * 0.12)), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for i, l in enumerate(lines):
            d.text((im.width / 2, i * lh), l, font=fs, fill="white", anchor="ma", stroke_width=3, stroke_fill=(0, 0, 0, 160))
        d.text((im.width / 2, len(lines) * lh + int(u * 0.03)), payload[1].upper(), font=fr, fill=(255, 205, 40), anchor="ma",
               stroke_width=3, stroke_fill=(0, 0, 0, 160))
        tilt = 0
    if tilt:
        im = im.rotate(tilt, resample=Image.BICUBIC, expand=True)
    maxw = int(W * (0.8 if kind == "cap" else 0.92))
    if im.width > maxw:  # keep every sticker inside the frame
        im = im.resize((maxw, int(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(out)
    return out


def sticker_box(text, size):
    l = draw_line(text, size, (15, 15, 15))
    im = Image.new("RGBA", (l.width + 40, int(l.height * 0.95) + 10), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, im.width - 1, im.height - 1], 18, fill=(255, 205, 40, 255))
    im.alpha_composite(l, (20, -int(size * 0.05)))
    return im


# ---------------------------------------------------------------- per-clip render
POP = "if(lt(U,0),0.02,if(lt(U,0.12),0.3+U/0.12*0.9,1+0.18*exp(-(U-0.12)*10)*cos((U-0.12)*28)))"
SLAM = "if(lt(U,0),0.02,if(lt(U,0.14),2.4-U/0.14*1.4,1+0.07*exp(-(U-0.14)*12)*cos((U-0.14)*30)))"


def render_clip(fmt, i, c, nframes, beat):
    W, H, _ = FMT[fmt]
    m = MEDIA[c["id"]]
    D = nframes / FPS
    k = h(fmt, c, nframes, round(beat, 5), "m6")
    vout, aout = MS / f"{fmt}_{i:03d}_{k}.mp4", MS / f"{fmt}_{i:03d}_{k}.wav"
    events = []  # (time-in-clip, sfx)
    speed = float(c.get("speed", 1))
    fb = float(c.get("freeze", 0)) * beat
    play = max(0.2, D - fb)
    src_len = play * speed
    dur = m.get("duration", 0)
    if m["type"] == "video":
        st = c["at"] * dur - src_len / 2 if "at" in c else float(c.get("start", 0))
        st = max(0.0, min(st, dur - src_len - 0.05))
    cap_t = float(c.get("cap_at", play if fb else 0.12))
    if c.get("cap"):
        events.append((cap_t, "pop"))
    if c.get("day") or c.get("title"):
        events.append((0.0, "whoosh"))
    if fb:
        events.append((play, "stop"))
    if vout.exists() and aout.exists():
        return vout, aout, events
    a_src, a_can = (m["w"] / m["h"]), W / H
    inputs = (["-ss", f"{st:.3f}", "-t", f"{src_len + 0.3:.3f}", "-i", str(ROOT / m["file"])] if m["type"] == "video"
              else ["-loop", "1", "-framerate", str(FPS), "-t", f"{D + 0.3:.3f}", "-i", str(ROOT / m["file"])])
    g = f"[0:v]setpts=(PTS-STARTPTS)/{speed},fps={FPS},"
    if 0.9 < a_src / a_can < 1.15:
        g += f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}[base];"
    else:
        g += (f"split[x][y];[x]scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
              f"gblur=sigma=10,eq=brightness=-0.15:saturation=1.2,scale={W}:{H}[bg];"
              f"[y]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base];")
    z = float(c.get("zoom", 0.08)); A = float(c.get("shake", 0)); p = 0.12 if c.get("punch") else 0.0
    marg = 2.4 * A / min(W, H)
    pad = f",tpad=stop_mode=clone:stop_duration={fb + 0.5:.3f}" if fb else f",tpad=stop_mode=clone:stop_duration=0.5"
    g += (f"[base]setsar=1{pad},scale=w='trunc({W}*(1+{marg:.4f}+{z}*t/{D:.3f}+{p}*exp(-t*9))/2)*2':h=-2:eval=frame,"
          f"crop={W}:{H}:x='(iw-{W})/2+{A}*sin(t*43)':y='(ih-{H})/2+{A}*cos(t*31)'")
    if fb:  # freeze: punch in harder and desaturate a bit for the meme look
        g += f",eq=saturation='if(gte(t,{play:.3f}),0.75,1)':eval=frame"
    if c.get("flash") or c.get("day") or c.get("title"):
        g += ",fade=t=in:st=0:d=0.2:color=white"
    if c.get("verse"):
        g += ",eq=brightness=-0.12"
    g += "[v0];"
    vlast, n_in = "[v0]", 1
    stickers = []
    if c.get("title"):
        stickers.append(("title", c["title"], 0.0, SLAM, "c"))
    if c.get("day"):
        stickers.append(("day", c["day"], 0.0, SLAM, "c"))
    if c.get("cap"):
        stickers.append(("cap", c["cap"], cap_t, POP, c.get("pos", "top")))
    if c.get("verse"):
        stickers.append(("verse", c["verse"], 0.6, "fade", "c"))
    for j, (kind, payload, t0, anim, pos) in enumerate(stickers):
        png = sticker(kind, payload, fmt)
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{D + 0.3:.3f}", "-i", str(png)]
        yc = {"c": 0.47, "top": 0.13 if W > H else 0.25, "bottom": 0.83 if W > H else 0.64}[pos] * H
        if kind == "day":
            yc = 0.47 * H
        if anim == "fade":
            g += (f"[{n_in}:v]format=rgba,fade=t=in:st={t0}:d=0.8:alpha=1[s{j}];"
                  f"{vlast}[s{j}]overlay=x=(W-w)/2:y={yc:.0f}-h/2[v{j + 1}];")
        else:
            S = anim.replace("U", f"(t-{t0:.3f})")
            g += (f"[{n_in}:v]format=rgba,scale=w='max(4,trunc(iw*{S}/2)*2)':h=-2:eval=frame[s{j}];"
                  f"{vlast}[s{j}]overlay=x='(W-w)/2':y='{yc:.0f}-h/2':enable='gte(t,{t0:.3f})':eval=frame[v{j + 1}];")
        vlast, n_in = f"[v{j + 1}]", n_in + 1
    g += f"{vlast}format=yuv420p[vout]"
    # audio: speed-shifted on purpose (chipmunk / deep slow-mo), freeze = silence
    loud = bool(c.get("speech"))
    vol = 1.0 if loud else float(PLAN.get("ambient_volume", 0.3))
    if m["type"] == "video" and m.get("has_audio"):
        at = f"atempo={speed}," if speed != 1 else ""
        g += (f";[0:a]asetpts=PTS-STARTPTS,{at}aresample={SR},aformat=channel_layouts=stereo,atrim=0:{play:.4f},"
              f"volume={vol},afade=t=in:d=0.03,afade=t=out:st={max(0, play - 0.06):.4f}:d=0.06,apad=whole_dur={D:.4f}[aout]")
    else:
        g += f";anullsrc=r={SR}:cl=stereo,atrim=0:{D:.4f}[aout]"
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", g,
         "-map", "[vout]", "-frames:v", str(nframes), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
         "-g", "60", "-pix_fmt", "yuv420p", "-r", str(FPS), "-video_track_timescale", "15360", str(vout),
         "-map", "[aout]", "-t", f"{D:.4f}", "-c:a", "pcm_s16le", "-ar", str(SR), str(aout)])
    return vout, aout, events


# ---------------------------------------------------------------- audio helpers (numpy)
def read_wav(p):
    with wave.open(str(p)) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2).astype(np.float32) / 32768
    return a


def decode(p):
    raw = run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]).stdout
    return None


def decode_audio(p):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(r.stdout, np.float32).reshape(-1, 2).copy()


def sfx(kind):
    rng = np.random.default_rng(7)
    if kind == "pop":
        n = int(0.09 * SR); t = np.arange(n) / SR
        f = 380 + 1500 * t / t[-1]
        s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 45) * 0.55
        return np.stack([s, s], 1)
    if kind == "whoosh":
        n = int(0.6 * SR); t = np.arange(n) / n
        x = rng.standard_normal(n).astype(np.float32)
        y = np.zeros(n, np.float32); a = 0.02 + 0.35 * np.sin(np.pi * t) ** 2; acc = 0.0
        for i in range(n):
            acc += a[i] * (x[i] - acc); y[i] = acc
        env = np.sin(np.pi * np.minimum(1, t / 0.75)) ** 2 * (t < 1)
        y = y / (np.abs(y).max() + 1e-6) * env * 0.5
        return np.stack([y * (1 - t), y * t], 1) * 1.6
    raise ValueError(kind)


def tape_stop(music, at, length=0.45):
    n = int(length * SR); i0 = int(at * SR)
    tt = np.arange(n) / SR
    pos = tt - tt ** 2 / (2 * length)  # decelerate to zero
    src = i0 + (pos * SR)
    idx = np.clip(src.astype(int), 0, len(music) - 2); fr = (src - idx)[:, None]
    seg = music[idx] * (1 - fr) + music[idx + 1] * fr
    return seg * np.linspace(1, 0, n)[:, None] ** 0.5


def beat_grid(track, bpm):
    x = decode_audio(track).mean(1)[::4]; sr = SR / 4; hop = 110; fps = sr / hop; n = len(x) // hop
    e = np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(1)); on = np.maximum(np.diff(np.log(e + 1e-4)), 0)
    best = (0, bpm, 0)
    for b in np.arange(bpm - 0.6, bpm + 0.6, 0.05):
        p = 60 / b * fps
        for ph in np.arange(0, p, 1):
            idx = (ph + np.arange(0, (len(on) - ph) / p - 1) * p).astype(int)
            s = on[idx].mean()
            if s > best[0]:
                best = (s, b, ph / fps)
    return 60 / best[1], best[2]


# ---------------------------------------------------------------- assemble
def build(fmt):
    W, H, name = FMT[fmt]
    MS.mkdir(parents=True, exist_ok=True)
    track = ROOT / PLAN["music"]
    gk = MS / f"grid_{h(PLAN['music'], PLAN['bpm'])}.json"
    if gk.exists():
        beat, phase = json.loads(gk.read_text())
    else:
        beat, phase = beat_grid(track, float(PLAN["bpm"])); gk.write_text(json.dumps([beat, phase]))
    clips = PLAN["clips"]
    cum = np.cumsum([0] + [c["beats"] for c in clips]) * beat
    frames = np.round(cum * FPS).astype(int)
    total = frames[-1] / FPS
    ms_target = float(PLAN.get("music_start", 8.0))
    mstart = phase + round((ms_target - phase) / beat) * beat
    print(f"[{fmt}] {len(clips)} clips, {total:.1f}s, beat {beat:.4f}s ({60 / beat:.1f} bpm), music from {mstart:.2f}s")

    def job(i):
        return render_clip(fmt, i, clips[i], int(frames[i + 1] - frames[i]), beat)
    with ThreadPoolExecutor(max_workers=int(PLAN.get("workers", 3))) as ex:
        res = list(ex.map(job, range(len(clips))))

    # video: hard cuts, stream copy
    lst = MS / f"{fmt}_list.txt"
    lst.write_text("".join(f"file '{v.as_posix()}'\n" for v, _, _ in res))
    vcat = MS / f"{fmt}_video.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(vcat)])

    # audio: clip sound + music bed (ducked under speech, tape-stop + silence on freezes) + sfx
    N = frames[-1] * SR // FPS
    clip_a = np.zeros((N, 2), np.float32)
    for i, (_, a, _) in enumerate(res):
        s = frames[i] * SR // FPS; x = read_wav(a)[: N - s]; clip_a[s:s + len(x)] += x
    music = decode_audio(track)
    mus = music[int(mstart * SR): int(mstart * SR) + N]
    mus = np.pad(mus, ((0, N - len(mus)), (0, 0)))
    gain = np.full(N, float(PLAN.get("music_volume", 0.8)), np.float32)
    duck = float(PLAN.get("duck_volume", 0.25))
    ramp = int(0.25 * SR)
    fx = np.zeros((N, 2), np.float32)
    for i, c in enumerate(clips):
        s, e = frames[i] * SR // FPS, frames[i + 1] * SR // FPS
        if c.get("speech"):
            gain[s:e] = np.minimum(gain[s:e], duck)
        if c.get("verse"):
            gain[s:e] = np.minimum(gain[s:e], float(PLAN.get("music_volume", 0.8)) * 0.8)
        for t0, kind in res[i][2]:
            p = s + int(t0 * SR)
            if kind == "stop":
                ts = tape_stop(music, mstart + p / SR) * float(PLAN.get("music_volume", 0.8))
                fx[p:p + len(ts)] += ts[: N - p]; gain[p:e] = 0
            else:
                sx = sfx(kind) * float(PLAN.get("sfx_volume", 0.5)); fx[p:p + len(sx)] += sx[: N - p]
    cs = np.cumsum(np.r_[np.full(ramp // 2, gain[0]), gain, np.full(ramp - ramp // 2, gain[-1])])  # fast moving average
    gain = ((cs[ramp:] - cs[:-ramp]) / ramp)[:N].astype(np.float32)  # smooth all level changes
    fade = int(float(PLAN.get("fade_out", 4)) * SR); gain[-fade:] *= np.linspace(1, 0, fade)
    mix = clip_a + mus * gain[:, None] + fx
    wav = MS / f"{fmt}_mix.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())
    out = OUT / name
    run(["ffmpeg", "-y", "-v", "error", "-i", str(vcat), "-i", str(wav), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
         "-af", "loudnorm=I=-14:TP=-1.0:LRA=11,aresample=48000", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", "-shortest", str(out)])
    print(f"[{fmt}] wrote {out}")


if __name__ == "__main__":
    for f in (sys.argv[1:] or ["horizontal", "vertical"]):
        build(f)
