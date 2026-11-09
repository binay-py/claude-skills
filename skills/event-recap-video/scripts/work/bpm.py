import sys,subprocess,numpy as np
for f in sys.argv[1:]:
    raw=subprocess.run(['ffmpeg','-v','error','-i',f,'-ac','1','-ar','8000','-f','s16le','-'],capture_output=True).stdout
    x=np.frombuffer(raw,np.int16).astype(np.float32)/32768
    dur=len(x)/8000; hop=80
    e=np.sqrt(np.convolve(x**2,np.ones(hop)/hop,'same')[::hop]); on=np.maximum(np.diff(e),0); on=on-on.mean()
    seg=on[2000:8000]; ac=np.correlate(seg,seg,'full')[len(seg)-1:]
    lags=np.arange(1,len(ac)); bpm_l=60*100/lags; m=(bpm_l>70)&(bpm_l<170)
    bpm=bpm_l[m][np.argmax(ac[1:][m])]
    print(f"{bpm:5.0f}bpm {dur/60:4.1f}min rms={20*np.log10(np.sqrt((x**2).mean())+1e-9):5.1f}dB  {f}")
