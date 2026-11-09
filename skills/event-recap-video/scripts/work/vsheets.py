import sys as _s; from pathlib import Path as _P; _s.path.insert(0, str(_P(__file__).resolve().parent.parent))
from fonts import font, ff_font
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parent.parent; T=ROOT/'work/thumbs'; OUT=ROOT/'work/vsheets'; OUT.mkdir(exist_ok=True)
m=[r for r in json.load(open(ROOT/'work/media.json')) if r['type']=='video']
font=ImageFont.truetype(font('sans_bold'),16)
CW,CH=150,200; SW=CW*3+6; cols,rows=4,7
for s in range(0,len(m),cols*rows):
    chunk=m[s:s+cols*rows]; R=(len(chunk)+cols-1)//cols
    sh=Image.new('RGB',(cols*SW,R*(CH+22)),(15,15,15)); d=ImageDraw.Draw(sh)
    for i,r in enumerate(chunk):
        x,y=(i%cols)*SW,(i//cols)*(CH+22)
        for k in range(3):
            p=T/f"{r['id']}_{k}.jpg"
            if p.exists():
                im=Image.open(p); im.thumbnail((CW-2,CH-2)); sh.paste(im,(x+k*CW+(CW-im.width)//2,y+22+(CH-im.height)//2))
        v=r.get('volume'); txt=f"{r['id']} {r['time'][5:10]} {r['time'][11:16]} {r['duration']:.0f}s {'' if v is None else f'{v:.0f}dB'} {','.join(f[:3] for f in r['flags'])}"
        d.text((x+3,y+3),txt,fill=(255,230,0),font=font)
    sh.save(OUT/f"v{s//(cols*rows):02d}.jpg",quality=80)
print(len(m))
