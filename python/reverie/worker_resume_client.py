"""Packaged owner-local finite host resume caller; never accepts a recipe/command."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import struct
import time

if __package__ in (None, ''):
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]));__package__='reverie'

from .worker import load_config, send_frame
from .worker_service import WorkerService
from .resource_actor_refresh import RegisteredTransport
from .worker_resume_peer import host_peer
from .human_terminal_protocol import decode


def take(connection,count,deadline):
    data=bytearray()
    while len(data)<count:
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Native recovery deadline expired')
        connection.settimeout(remaining)
        value=connection.recv(count-len(data))
        if not value:raise EOFError
        data.extend(value)
    return bytes(data)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('action',choices=('describe','prepare','apply','status'))
    parser.add_argument('--operation')
    parser.add_argument('--deployment',type=Path)
    parser.add_argument('--snapshot-sha256')
    parser.add_argument('--plan-sha256')
    parser.add_argument('--employee',action='append',metavar='UUID',
                        help='prepare only: select a current eligible employee; repeat for a bounded batch (default: all eligible)')
    args=parser.parse_args(argv);os.umask(0o077)
    expected={
        'describe':(False,False,False,False),'prepare':(True,True,True,False),
        'apply':(True,False,False,True),'status':(True,False,False,False),
    }
    if tuple(x is not None for x in (args.operation,args.deployment,args.snapshot_sha256,args.plan_sha256))!=expected[args.action]:
        parser.error('Select only the fixed fields required for this action')
    if args.employee is not None:
        if (args.action!='prepare' or len(args.employee)>16 or
                any(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',eid) is None for eid in args.employee) or
                len(set(args.employee))!=len(args.employee)):
            parser.error('Select distinct canonical employee UUIDs only for prepare (at most 16)')
    request={'action':{'describe':'worker-resume-describe','prepare':'prepare-worker-resume',
                      'apply':'apply-worker-resume','status':'worker-resume-status'}[args.action]}
    if args.operation is not None:request['operationId']=args.operation
    if args.deployment is not None:request['deploymentPath']=str(args.deployment)
    if args.snapshot_sha256 is not None:request['expectedSnapshotDigest']=args.snapshot_sha256
    if args.plan_sha256 is not None:request['planDigest']=args.plan_sha256
    if args.employee is not None:request['employeeIds']=sorted(args.employee)
    proof=None
    try:
        config=load_config(args.config);proof=RegisteredTransport(WorkerService(args.config),config)
        host_peer(proof.credentials,config['uid']);proof.guard()
        connection=proof.socket;deadline=time.monotonic()+650;connection.settimeout(650)
        send_frame(connection,b'C',b'{"action":"worker-resume-channel"}')
        greeting=take(connection,len(b'HOST_RESUME_OWNER_READY\n'),deadline)
        if greeting!=b'HOST_RESUME_OWNER_READY\n':raise ValueError('Native host recovery channel unavailable')
        send_frame(connection,b'C',json.dumps(request,separators=(',',':')).encode())
        header=take(connection,5,deadline);kind=header[:1];length=struct.unpack('!I',header[1:])[0]
        if kind!=b'J' or not 0<length<=8192:raise ValueError('Native recovery is unconfirmed; inspect its retained operation')
        raw=take(connection,length,deadline)
        result=decode(raw)
        if type(result)is not dict or result.get('version')!=1 or result.get('purpose')!='host-worker-resume-v1':
            raise ValueError('Native host recovery reply unavailable')
        proof.finalize();proof=None
        print(json.dumps(result,separators=(',',':')));return 0
    except (OSError,ValueError,RuntimeError,EOFError):
        print('Native host recovery unconfirmed; retain operation and inspect status without resending apply.',file=sys.stderr)
        return 1
    finally:
        if proof is not None:proof.close()


if __name__=='__main__':raise SystemExit(main())
