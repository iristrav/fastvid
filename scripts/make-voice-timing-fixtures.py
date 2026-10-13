import subprocess, json, sys, os, wave, struct
# Build voice-over fixtures from espeak-ng with KNOWN sentence boundaries:
# each sentence is synthesised alone (its own leading/trailing silence trimmed), then joined with a chosen pause.
def synth(text, voice, speed, out):
    subprocess.run(["espeak-ng","-v",voice,"-s",str(speed),"-w",out,text],check=True)
    # trim leading/trailing silence with ffmpeg silenceremove, 16 kHz mono
    trimmed=out.replace(".wav","_t.wav")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",out,"-af","silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse","-ar","16000","-ac","1",trimmed],check=True)
    d=float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",trimmed]).decode().strip())
    return trimmed,d
def build(name, sentences, voice, speed, pauses, lead=0.3, tail=0.4, comma_pause=None):
    # sentences: list of text; pauses: list of n-1 inter-sentence pause seconds
    parts=[]; truth=[]; t=lead
    inputs=[]; filt=[]
    idx=0
    segs=[]
    for i,s in enumerate(sentences):
        if comma_pause and "," in s:
            # split at commas and insert an intra-sentence pause of comma_pause
            pieces=[p.strip() for p in s.split(",")]
        else:
            pieces=[s]
        start=t
        for j,pc in enumerate(pieces):
            f,d=synth(pc,voice,speed,f"{name}_{i}_{j}.wav")
            segs.append((f,t)); t+=d
            if j<len(pieces)-1: t+=comma_pause
        truth.append({"text":s,"start":round(start,3),"end":round(t,3)})
        if i<len(sentences)-1: t+=pauses[i]
    total=t+tail
    # assemble with adelay on a silent base
    cmd=["ffmpeg","-y","-loglevel","error","-f","lavfi","-i",f"anullsrc=r=16000:cl=mono:d={total:.3f}"]
    for f,_ in segs: cmd+=["-i",f]
    fc=""
    for k,(f,st) in enumerate(segs):
        fc+=f"[{k+1}:a]adelay={int(st*1000)}|{int(st*1000)}[d{k}];"
    fc+="".join(f"[d{k}]" for k in range(len(segs)))+f"[0:a]amix=inputs={len(segs)+1}:normalize=0[out]"
    cmd+=["-filter_complex",fc,"-map","[out]","-c:a","aac","-b:a","48k",f"{name}.m4a"]
    subprocess.run(cmd,check=True)
    json.dump({"sentences":truth,"totalSec":round(total,3),"pauses":pauses,"voice":voice,"speed":speed,"commaPause":comma_pause},open(f"{name}.json","w"),indent=1)
    print(name, "total", round(total,2), [ (s["start"],s["end"]) for s in truth])
EN=["The first sentence is spoken here.","Then a second sentence, with a comma, of similar length.","And a shorter third.","Finally the narrator closes the scene with a slightly longer sentence than before."]
NL=["In 1912 vertrok de Titanic uit Southampton.","Aan boord waren meer dan tweeduizend mensen, onder wie veel emigranten.","Vier dagen later raakte het schip een ijsberg.","Binnen drie uur zonk het.","Slechts zevenhonderd mensen overleefden de ramp."]
build("en4", EN, "en-us", 165, [0.55,0.5,0.6], comma_pause=0.25)
build("nl5", NL, "nl", 150, [0.5,0.45,0.6,0.5], comma_pause=0.3)
build("one", ["Only one sentence is spoken in this scene, nothing else."], "en-gb", 160, [], comma_pause=0.3)
# adversarial: a comma pause LONGER than the sentence pauses (wrong cut if trusted blindly)
build("trap4", EN, "en-us", 165, [0.45,0.45,0.45], comma_pause=0.8)
# short pauses: sentence pauses just at the detector's floor
build("tight3", EN[:3], "en-us", 175, [0.3,0.28], comma_pause=0.12)
