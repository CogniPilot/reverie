"""Benign fixture program: fixed terminal signal, then silent idle. No network or shell."""
import hashlib,json,os,sys,time
from pathlib import Path

root=Path(sys.argv[1]).resolve(strict=True)
assert root.is_dir() and root.stat().st_uid==os.getuid()
record=root/'programs';assert record.is_dir()
pid=os.getpid();start=(Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()[19]
value={'pid':pid,'startTick':start,'cwd':str(Path.cwd()),'exe':str((Path('/proc')/str(pid)/'exe').resolve()),
       'scriptSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
       'model':os.environ.get('SB_MODEL'),'endpoint':os.environ.get('SB_BASE_URL')}
fd=os.open(record/(str(pid)+'-'+start+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w')as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
lifetime=int(os.environ['SB_LIFETIME']);assert 0<lifetime<=240
deadline=time.monotonic()+lifetime
phase=None
while time.monotonic()<deadline:
    requested=json.loads((root/'control.json').read_text())['phase']
    assert requested in ('active','idle','stop')
    if requested=='stop':break
    if requested!=phase:
        phase=requested
        temp=root/('phase-'+str(pid)+'.tmp')
        temp.write_text(json.dumps({'pid':pid,'startTick':start,'phase':phase,'observedAtEpoch':time.time()}))
        os.replace(temp,root/('phase-'+str(pid)+'.json'))
    if phase=='active':print('SB_ACTIVE',flush=True)
    time.sleep(0.25)
