import sys as _s; from pathlib import Path as _P; _s.path.insert(0, str(_P(__file__).resolve().parent.parent))
from fonts import font, ff_font
import json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
import pillow_heif; pillow_heif.register_heif_opener()
R=Path(__file__).resolve().parent.parent
e=json.load(open(R/'edit.json',encoding='utf-8')); m={r['id']:r for r in json.load(open(R/'work/media.json'))}
segs=[('HOOK',s) for s in e['horizontal_hook']]+[('',s) for s in e['horizontal']]
font=ImageFont.truetype(font('sans_bold'),15)
cw,ch,cols=160,200,12; rows=(len(segs)+cols-1)//cols
sh=Image.new('RGB',(cols*cw,rows*(ch+20)),(12,12,12)); d=ImageDraw.Draw(sh)
for i,(tag,s) in enumerate(segs):
    r=m[s['id']]; x,y=(i%cols)*cw,(i//cols)*(ch+20)
    tmp=R/'work/qc/_f.jpg'
    if r['type']=='video':
        dur=s.get('dur',5); st=s['at']*r['duration']-dur/2 if 'at' in s else s.get('start',0); st=max(0,st)
        subprocess.run(['ffmpeg','-v','error','-y','-ss',f'{st+dur/2:.2f}','-i',r['file'],'-frames:v','1','-vf','scale=320:-2',str(tmp)])
        im=Image.open(tmp)
    else:
        im=ImageOps.exif_transpose(Image.open(r['file']))
    im.thumbnail((cw-4,ch-4)); sh.paste(im,(x+(cw-im.width)//2,y+20+(ch-im.height)//2))
    lab=(tag or s.get('label','').split('·')[0].strip() or '')
    txt=f"{r['time'][5:10]} {'V' if r['type']=='video' else 'P'} {s.get('dur',2.5)}s {lab}"
    d.text((x+3,y+2),txt,fill=(255,90,90) if tag else ((120,220,255) if s.get('label') else (255,230,0)),font=font)
sh.save(R/'output/shortlist.jpg',quality=85); print(len(segs),'cuts')
