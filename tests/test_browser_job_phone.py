"""Actual OfficeAPI handler in-memory: no server/socket/engine/browser is started."""
import ast,http.server,io,json,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from email.message import Message
from urllib.parse import urlsplit
from reverie import worker
from reverie.browser_job_requests import decode_command,BrowserJobRefused

SID='00000000-0000-4000-8000-000000000001'
MID='00000000-0000-4000-8000-000000000002'

class BrowserPhone(unittest.TestCase):
    def call(self,body,callback=None,headers=None,path='/api/browser-jobs',method='POST'):
        tree=ast.parse(Path(worker.__file__).read_text());office=next(x for x in tree.body if isinstance(x,ast.ClassDef)and x.name=='OfficeAPI');constructor=next(x for x in office.body if isinstance(x,ast.FunctionDef)and x.name=='__init__');handler=next(x for x in constructor.body if isinstance(x,ast.ClassDef)and x.name=='Handler')
        api=SimpleNamespace(closing=threading.Event(),rate_lock=threading.Lock(),tokens=40.,updated=time.monotonic(),upstreams={},requests={})
        namespace=dict(worker.__dict__);namespace.update(api=api,session_id=SID,browser_jobs=callback,ops=None,host_actions=None,command_telemetry=None)
        exec(compile(ast.Module(body=[handler],type_ignores=[]),'<actual OfficeAPI Handler>','exec'),namespace)
        instance=object.__new__(namespace['Handler']);instance.command=method;instance.path=path;instance.connection=object();instance.rfile=io.BytesIO(body);instance.wfile=io.BytesIO();instance.headers=Message()
        for k,v in [('Content-Length',str(len(body))),('Content-Type','application/json'),*((headers or{}).items())]:instance.headers.add_header(k,v)
        result={};instance.send_error=lambda code,*args:result.update(status=code);instance.send_response=lambda code:result.update(status=code);instance.send_header=lambda *args:None;instance.end_headers=lambda:None
        instance.request();return result,instance.wfile.getvalue()
    def test_reserved_route_absent_is503_and_never_forwards_or_reads_credentials(self):
        result,_=self.call(json.dumps({'action':'submit','requestMessageId':MID}).encode());self.assertEqual(result['status'],503)
    def test_actual_handler_uses_only_host_captured_sid_not_forged_headers(self):
        calls=[]
        def callback(sid,value):calls.append((sid,value));return {'jobId':'own','state':'ACCEPTED_NOT_SCIENTIFIC_SUCCESS'}
        body={'action':'submit','requestMessageId':MID};result,raw=self.call(json.dumps(body).encode(),callback,{'Authorization':'forged','Cookie':'forged-owner','X-Reverie-Service-Token':'forged','X-Reverie-Parent-Session':'foreign','X-Reverie-Hook-Secret':'forged','Origin':'https://foreign.invalid'})
        self.assertEqual(result['status'],200);self.assertEqual(calls,[(SID,body)]);self.assertNotIn(b'forged',raw)
    def test_actor_owner_url_script_and_command_fields_are_refused(self):
        calls=[]
        for key in ['sessionId','employeeId','owner','ownerTrue','url','script','command']:
            body={'action':'submit','requestMessageId':MID,key:'forged'};result,_=self.call(json.dumps(body).encode(),lambda *args:calls.append(args));self.assertEqual(result['status'],403)
        self.assertEqual(calls,[])
    def test_fixed_method_query_and_length_contract_precedes_dispatch(self):
        calls=[];callback=lambda *args:calls.append(args);body=json.dumps({'action':'submit','requestMessageId':MID}).encode()
        for kwargs in [{'path':'/api/browser-jobs?url=remote'},{'method':'GET'},{'path':'/api/browser-jobs/arbitrary'}]:
            result,_=self.call(body,callback,**kwargs);self.assertEqual(result['status'],400)
        self.assertEqual(calls,[])
    def test_duplicate_json_keys_cannot_select_another_action(self):
        with self.assertRaises(BrowserJobRefused):decode_command(('{'+'"action":"submit","action":"cancel","requestMessageId":"'+MID+'"}').encode())
if __name__=='__main__':unittest.main()
