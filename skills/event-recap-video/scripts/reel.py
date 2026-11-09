"""Beat-synced 9:16 reel for Instagram Reels / TikTok / Facebook Reels.

    python reel.py            -> output/reel.mp4

Edit reel.json: "music", "bpm" (tempo of the track), "music_start" (null = auto: loudest part, snapped to a beat),
and "clips": each {id, at|start, beats, text?, flash?, speech?}. Cuts land exactly on the beat grid.
Clip ids come from work/media.json (see output/shortlist.jpg and work/vsheets/).
"""
from fonts import font, ff_font
import json, subprocess, sys
from pathlib import Path
import numpy as np
import build  # reuses segment rendering (blur-fill, trims) and helpers
from build import ROOT, WORK, OUT, SEG, PREP, FPS, run, esc, text_lines

W, H = 1080, 1920
build.FORMATS["reel"] = (W, H, "reel.mp4")
R = json.loads((ROOT / "reel.json").read_text(encoding="utf-8"))
FONT = ff_font("black")


def beat_grid(track, bpm_hint):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(track), "-ac", "1", "-ar", "11025", "-f", "s16le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    hop = 55; fps = 11025 / hop; n = len(x) // hop
    e = np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(1))
    on = np.maximum(np.diff(np.log(e + 1e-4)), 0)
    best = (0, bpm_hint, 0)
    for bpm in np.arange(bpm_hint - 1.0, bpm_hint + 1.0, 0.05):
        p = 60 / bpm * fps
        for ph in np.arange(0, p, 1):
            idx = (ph + np.arange(0, (len(on) - ph) / p - 1) * p).astype(int)
            s = on[idx].mean()
            if s > best[0]:
                best = (s, bpm, ph / fps)
    _, bpm, phase = best
    return 60 / bpm, phase, e, fps, len(x) / 11025


def main():
    track = ROOT / R["music"]
    beat, phase, env, efps, mdur = beat_grid(track, float(R.get("bpm", 120)))
    clips = R["clips"]
    total_beats = sum(c["beats"] for c in clips)
    total = total_beats * beat
    if R.get("music_start") is None:  # loudest stretch of the song, starting on a bar (4 beats)
        Wn = int(total * efps); cs = np.cumsum(np.r_[0, env])
        st = float(np.argmax(cs[Wn:] - cs[:-Wn])) / efps
        mstart = phase + round((st - phase) / (4 * beat)) * 4 * beat
    else:
        mstart = float(R["music_start"])
    print(f"beat {beat:.4f}s ({60 / beat:.1f} bpm), music from {mstart:.2f}s, reel {total:.2f}s")

    # cut times on the beat grid, rounded to whole frames so nothing drifts
    cuts = np.round(np.cumsum([0] + [c["beats"] * beat for c in clips]) * FPS) / FPS
    parts, speech, texts = [], [], []
    for i, c in enumerate(clips):
        d = float(cuts[i + 1] - cuts[i])
        seg = {k: v for k, v in c.items() if k in ("id", "at", "start", "speech")}
        seg["dur"] = d + 0.25  # a little spare; trimmed exactly in the graph
        p, got, sp = build.render_segment("reel", 500 + i, seg, True)
        if got < d - 0.02:
            sys.exit(f"clip {c['id']} too short for {c['beats']} beats ({got:.2f}s < {d:.2f}s)")
        parts.append((p, d, c))
        if c.get("speech"):
            speech.append((cuts[i], cuts[i + 1]))
        if c.get("text"):
            texts.append((cuts[i], min(cuts[i + 1], cuts[i] + c.get("text_beats", c["beats"]) * beat), c["text"]))

    ins, g = [], ""
    for i, (p, d, c) in enumerate(parts):
        ins += ["-i", str(p)]
        z = float(c.get("zoom", 0.07))  # slow push-in on every clip
        fx = (f"[{i}:v]trim=0:{d:.4f},setpts=PTS-STARTPTS,"
              f"scale=w='trunc({W}*(1+{z}*t/{d:.3f})/2)*2':h=-2:eval=frame,crop={W}:{H},setsar=1")
        if c.get("flash"):
            fx += ",fade=t=in:st=0:d=0.18:color=white"
        g += fx + f"[v{i}];[{i}:a]atrim=0:{d:.4f},asetpts=PTS-STARTPTS[a{i}];"
    n = len(parts)
    g += "".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vc][ac];"

    # text overlays: bold, outlined, upper-middle (clear of TikTok/IG buttons at the bottom and right)
    vprev = "[vc]"
    for j, (a, b, txt) in enumerate(texts):
        lines = text_lines(f"reel_{j}", txt, 16)
        size = 92 if len(lines) <= 2 else 80
        y0 = int(H * 0.24)
        for li, f in enumerate(lines):
            y = y0 + li * int(size * 1.15)
            alpha = f"if(lt(t,{a:.3f}+0.15),(t-{a:.3f})/0.15,if(gt(t,{b:.3f}-0.12),({b:.3f}-t)/0.12,1))"
            ypos = f"{y}+18*max(0,1-(t-{a:.3f})/0.15)"
            g += (f"{vprev}drawtext=fontfile='{FONT}':textfile='{esc(f)}':fontsize={size}:fontcolor=white:"
                  f"borderw=7:bordercolor=black@0.85:x=(w-text_w)/2:y='{ypos}':alpha='{alpha}':"
                  f"enable='between(t,{a:.3f},{b:.3f})'[t{j}_{li}];")
            vprev = f"[t{j}_{li}]"

    base, duck = float(R.get("music_volume", 0.9)), float(R.get("duck_volume", 0.35))
    dips = [f"clip((t-{a - 0.3:.2f})/0.3,0,1)*clip(({b + 0.3:.2f}-t)/0.3,0,1)" for a, b in speech] or ["0"]
    dip = dips[0]
    for d_ in dips[1:]:
        dip = f"max({dip},{d_})"
    ins += ["-ss", f"{mstart:.3f}", "-i", str(track)]
    g += (f"[{n}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
          f"volume='{base}-({base - duck})*{dip}':eval=frame,afade=t=in:d=0.05,afade=t=out:st={total - 1.2:.3f}:d=1.2[mus];"
          f"[ac]volume={R.get('clip_volume', 1.0)}[acv];[acv][mus]amix=inputs=2:normalize=0:duration=first,"
          f"loudnorm=I=-14:TP=-1.0:LRA=9,aresample=48000[aout]")
    gf = WORK / "reel_graph.txt"; gf.write_text(g)
    out = OUT / "reel.mp4"
    run(["ffmpeg", "-y", "-v", "error", *ins, "-/filter_complex", str(gf), "-map", vprev, "-map", "[aout]",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", f"{total:.3f}", str(out)])
    print(f"wrote {out} ({total:.1f}s)")


if __name__ == "__main__":
    SEG.mkdir(parents=True, exist_ok=True); PREP.mkdir(parents=True, exist_ok=True)
    main()
