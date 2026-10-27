"""Fixed benign cancellation probe, never a general command runner. Inert import."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


def private_root(value):
    path=Path(value)
    if not path.is_absolute() or path.resolve()!=path:raise ValueError('canonical fixture task required')
    item=path.lstat()
    if not stat.S_ISDIR(item.st_mode) or item.st_uid!=os.getuid() or stat.S_IMODE(item.st_mode)!=0o700:
        raise ValueError('owned private fixture task required')
    return path


def record(root,kind):
    pid=os.getpid();fields=(Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
    value={'pid':pid,'startTick':fields[19],'kind':kind,'exe':str((Path('/proc')/str(pid)/'exe').resolve()),
           'cwd':str(Path.cwd()),'scriptSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    fd=os.open(root/(kind+'-'+str(pid)+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w')as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
    return value


def heartbeat(root):
    record(root,'heartbeat');end=time.monotonic()+30
    fd=os.open(root/'heartbeat.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        while time.monotonic()<end:
            os.write(fd,(json.dumps({'pid':os.getpid(),'tick':time.monotonic_ns()})+'\n').encode())
            os.fsync(fd);time.sleep(.1)
    finally:os.close(fd)


def main():
    if len(sys.argv)==3 and sys.argv[1]=='--heartbeat':
        heartbeat(private_root(sys.argv[2]));return
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task-dir',required=True);parser.add_argument('--timeout-s',required=True,type=int)
    parser.add_argument('--max-output-bytes',required=True,type=int)
    args=parser.parse_args();root=private_root(args.task_dir)
    if not 1<=args.timeout_s<=30 or not 1024<=args.max_output_bytes<=131072:raise ValueError('fixed finite fixture limits required')
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536:raise ValueError('request bound')
    request=json.loads(raw)
    if (set(request)!={'version','name','args','max_output_chars'} or request['version']!=1 or
            request['name']!='run_tests' or request['args']!={} or type(request['max_output_chars'])is not int or
            not 500<=request['max_output_chars']<=20000):raise ValueError('fixed heartbeat tool only')
    record(root,'runner')
    child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--heartbeat',str(root)],
                           cwd=root,env={'PATH':os.defpath,'LANG':'C.UTF-8'},close_fds=True)
    # Intentionally remain the real bounded runner while its real descendant
    # writes. Normal TaskManager cancellation must settle the entire group.
    try:child.wait(timeout=args.timeout_s)
    except subprocess.TimeoutExpired:
        child.kill();child.wait(timeout=2)
        raise RuntimeError('probe timed out before authorized cancellation')
    raise RuntimeError('probe exited without the required cancellation')


if __name__=='__main__':main()
