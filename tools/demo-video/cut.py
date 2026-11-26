import json, subprocess, glob, sys
M={m['name']:m['t'] for m in json.load(open('rec/marks.json'))}
SRC=glob.glob('rec/*.webm')[0]
VF="scale=1920:1080:flags=lanczos,format=yuv420p"
def enc_main():
    subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',str(M['title']-0.3),'-to',str(M['done']),'-i',SRC,
      '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-shortest',
      '-vf',VF+",fade=t=in:st=0:d=0.6",'-c:v','libx264','-preset','slow','-crf','22','-r','25',
      '-c:a','aac','-b:a','64k','-movflags','+faststart','out/drapr-walkthrough.mp4'],check=True)
def enc_cut(name, segs):
    parts=[]
    for i,(a,b) in enumerate(segs):
        d=b-a; f=f'out/_{name}_{i}.mp4'
        subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',f'{a:.2f}','-t',f'{d:.2f}','-i',SRC,
          '-vf',VF+f",fade=t=in:st=0:d=0.25,fade=t=out:st={d-0.25:.2f}:d=0.25",'-an','-c:v','libx264','-preset','slow','-crf','22','-r','25',f],check=True)
        parts.append(f)
    open(f'out/_{name}.txt','w').write(''.join(f"file '{p.split('/')[-1]}'\n" for p in parts))
    subprocess.run(['ffmpeg','-loglevel','error','-y','-f','concat','-safe','0','-i',f'out/_{name}.txt',
      '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-shortest','-c:v','copy','-c:a','aac','-b:a','64k','-movflags','+faststart',f'out/{name}.mp4'],check=True)
m=M
cut60=[(m['title']+0.2,m['title']+3.8),(m['enquiry']+2.8,m['enquiry']+6.8),(m['priced'],m['priced']+5.5),(m['send']+0.5,m['send']+4.5),
       (m['accept-tap']+1.5,m['accepted']+2),(m['takedown']-4.5,m['takedown']),(m['takedown']+1.5,m['takedown']+7),(m['photos']-1.5,m['photos']+4.5),
       (m['ticks'],m['ticks']+5),(m['runsheet']+3,m['runsheet']+7),(m['review']-0.5,m['review']+4),(m['end']+0.3,m['end']+4.3)]
cut25=[(m['title']+0.5,m['title']+3),(m['priced'],m['priced']+4),(m['accepted']-2.5,m['accepted']+2),(m['takedown']+2,m['takedown']+6),
       (m['photos'],m['photos']+3.5),(m['ticks']+0.5,m['ticks']+4),(m['end']+0.5,m['end']+3.5)]
print('60s total', round(sum(b-a for a,b in cut60),1), '25s total', round(sum(b-a for a,b in cut25),1))
if 'main' in sys.argv: enc_main()
enc_cut('drapr-60s',cut60); enc_cut('drapr-25s',cut25)
