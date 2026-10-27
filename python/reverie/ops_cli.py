"""Structured OPS through this laptop's fixed office phone. Never selects actor or host transport."""
import argparse,http.client,os,sys,uuid
from urllib.parse import urlsplit
from .ops_common import *
def call(value):
 address=urlsplit(os.environ.get('REVERIE_API_URL',''));require(address.scheme=='http' and address.hostname in ('127.0.0.1','localhost') and not address.username and not address.password and not address.query and address.path in ('','/'),'not-installed')
 body=canonical(command(value));connection=http.client.HTTPConnection(address.hostname,address.port or 80,timeout=8)
 try:
  connection.request('POST','/api/ops',body,{'Content-Type':'application/json'});response=connection.getresponse();raw=response.read(65537);require(len(raw)<=65536,'audit-unavailable');result=strict_json(raw);require(isinstance(result,dict),'audit-unavailable');return result
 finally:connection.close()
def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);sub=parser.add_subparsers(dest='action',required=True)
 for name in ('status','inspect'):
  p=sub.add_parser(name);p.add_argument('resource')
  if name=='inspect':p.add_argument('operation')
 sub.add_parser('submit',help='Read one exact OPS effect command from stdin; never infer authority.');args=parser.parse_args(argv)
 try:
  if args.action=='submit':
   data=sys.stdin.buffer.read(16385);require(len(data)<=16384);value=strict_json(data);require(value.get('action') in EFFECTS)
  else:
   value={'kind':'reverie.ops.command','version':1,'requestId':'req-'+uuid.uuid4().hex,'resourceId':args.resource,'action':ACTIONS[0] if args.action=='status' else ACTIONS[1]}
   if args.action=='inspect':value['operationId']=args.operation
  result=call(value);print(canonical(result).decode());return 0 if result.get('success') else 3
 except (Refusal,OSError,ValueError,http.client.HTTPException):print(canonical({'success':False,'reason':'adapter-unavailable'}).decode());return 3
if __name__=='__main__':raise SystemExit(main())
