import json,subprocess,re,sys
m={r['id']:r for r in json.load(open('work/media.json'))}
for spec in sys.argv[1:]:
    cid,win=spec.split(':'); win=int(win); r=m[cid]
    out=subprocess.run(['ffmpeg','-v','error','-i',r['file'],'-vn','-af','aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-'],capture_output=True,text=True).stdout
    lv=[float(x) if x!='-inf' else -90 for x in re.findall(r'RMS_level=(\S+)',out)]
    best=max(range(max(1,len(lv)-win+1)),key=lambda s:sum(lv[s:s+win]))
    print(cid,f"dur={r['duration']:.0f}","best_start",best,"avg_dB",round(sum(lv[best:best+win])/win,1),"profile"," ".join(str(int(x)) for x in lv))
