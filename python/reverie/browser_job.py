"""One fixed browser job through this laptop's existing office phone.

First post the exact command as a normal agent-chat reply to the selected owner
cue. This client sends that canonical message reference only; it never selects
an actor, URL, script, tool, account, grant or host transport.
"""
import argparse,http.client,json,os,re,sys
from urllib.parse import urlsplit
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',re.I)
def request(action,message):
    if action not in('submit','inspect','cancel')or not isinstance(message,str)or not UUID.fullmatch(message):raise ValueError('fixed reference required')
    address=urlsplit(os.environ.get('REVERIE_API_URL',''))
    if address.scheme!='http'or address.hostname not in('127.0.0.1','localhost')or address.username or address.password or address.query or address.fragment or address.path not in('','/'):raise ValueError('office unavailable')
    connection=http.client.HTTPConnection(address.hostname,address.port or 80,timeout=15)
    try:
        body=json.dumps({'action':action,'requestMessageId':message},separators=(',',':')).encode();connection.request('POST','/api/browser-jobs',body,{'Content-Type':'application/json'})
        response=connection.getresponse();raw=response.read(16385)
        if len(raw)>16384 or response.status not in(200,403,503,502):raise ValueError('response unavailable')
        value=json.loads(raw)
        if value.get('success')is not True:return {'success':False,'errorCode':value.get('errorCode')if value.get('errorCode')in('BROWSER_JOB_REFUSED','BROWSER_JOB_UNCONFIRMED_INSPECT_BEFORE_RETRY')else'BROWSER_JOB_UNAVAILABLE'}
        data=value.get('data')
        if type(data)is not dict or set(data)-{'jobId','state','requestMessageId','artifacts'}or data.get('requestMessageId')!=message:raise ValueError('response unavailable')
        return {'success':True,'data':data}
    finally:connection.close()
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);p.add_argument('action',choices=('submit','inspect','cancel'));p.add_argument('request_message_id');args=p.parse_args(argv)
    try:
        result=request(args.action,args.request_message_id);print(json.dumps(result,separators=(',',':')));return 0 if result.get('success')else 3
    except (ValueError,OSError,http.client.HTTPException):print('{"success":false,"errorCode":"BROWSER_JOB_UNAVAILABLE"}');return 3
if __name__=='__main__':raise SystemExit(main())
