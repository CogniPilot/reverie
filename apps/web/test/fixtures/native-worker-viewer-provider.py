"""Deterministic native TUI stand-in; no vendor CLI, credentials or network."""
import hashlib,json,os,select,sys,termios,time,tty
from pathlib import Path
r=Path(sys.argv[1]);tty.setraw(0);buf="";esc="";idle=False;unready=False;seq=0
def paint():
 s="› "+buf+"\nGPT-6.1-Sol high · /fixture\n? for shortcuts" if idle else "Connecting…" if unready else "• Working (esc to interrupt)"
 os.write(1,("\x1b[2J\x1b[H"+s.replace("\n","\r\n")).encode())
paint()
while True:
 if not idle and (r/"unready-control").exists() and not unready:unready=True;paint()
 if not idle and (r/"idle-control").exists():idle=True;unready=False;paint()
 ready,_,_=select.select([0],[],[],.04)
 if not ready:continue
 data=os.read(0,4096)
 if not data:break
 for c in data.decode(errors="replace"):
  if esc:
   esc+=c
   if esc in ["\x1b[200~","\x1b[201~"]:esc=""
   elif len(esc)>8:esc=""
   continue
  if c=="\x1b":esc=c;continue
  if c in "\r\n":
   seq+=1
   item={"seq":seq,"pid":os.getpid(),"text":buf,"sha256":hashlib.sha256(buf.encode()).hexdigest()}
   with(r/"provider-input.jsonl").open("a")as f:f.write(json.dumps(item)+"\n");f.flush();os.fsync(f.fileno())
   buf="";idle=True;paint()
  elif c in "\x7f\b":buf=buf[:-1];paint()
  elif ord(c)>=32:buf+=c;paint()
