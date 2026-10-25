"""Optional chat statistics must not replace strict coding admission or deadlines."""
import http.server
import io
import json
import signal
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
from coding_model_client import ModelClient, ModelDeadline

class ChatTokenizerTimeoutTests(unittest.TestCase):
    def fixture(self, *, delay=0, tokens=1, status=200):
        events=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):self.respond()
            def do_POST(self):self.respond()
            def respond(self):
                events.append(self.path)
                size=int(self.headers.get('Content-Length','0'))
                if size:self.rfile.read(size)
                if self.path=='/props':
                    time.sleep(delay)
                    body={'default_generation_settings':{'n_ctx':64},'total_slots':1}
                    code=status
                elif self.path=='/apply-template':body={'prompt':'a fixed template'};code=200
                elif self.path=='/tokenize':body={'tokens':[1]*tokens};code=200
                elif self.path=='/v1/chat/completions':
                    body={'choices':[{'message':{'content':'DIAGNOSTIC_OK'},'finish_reason':'stop'}]};code=200
                else:raise AssertionError('unexpected path')
                raw=json.dumps(body).encode()
                try:
                    self.send_response(code);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(2)))
        base='http://127.0.0.1:'+str(server.server_port)
        return base,events
    def client(self,base,*,optional=False,timeout=2):
        return ModelClient(base+'/v1',timeout_s=timeout,token_meter={'base_url':base,'context_ceiling':64,'margin':0,'timeout_s':.03},token_meter_optional=optional)
    def payload(self):return {'model':'fixture','messages':[{'role':'user','content':'test'}],'max_tokens':2,'stream':False}
    def test_real_delayed_tokenizer_plain_chat_completes_once_with_unknown_counts(self):
        base,events=self.fixture(delay=.15)
        result=self.client(base,optional=True)(self.payload(),2)
        self.assertEqual(result['content'],'DIAGNOSTIC_OK')
        self.assertEqual(result['_token_meter_status'],'unavailable')
        self.assertNotIn('_context_stats',result)
        self.assertEqual(events.count('/v1/chat/completions'),1)
    def test_same_delayed_tokenizer_default_strict_coding_never_sends_completion(self):
        base,events=self.fixture(delay=.15)
        with self.assertRaises((TimeoutError,urllib.error.URLError)):self.client(base)(self.payload(),2)
        self.assertNotIn('/v1/chat/completions',events)
    def test_measured_context_overflow_still_refuses_even_for_optional_chat_meter(self):
        base,events=self.fixture(tokens=63)
        result=self.client(base,optional=True)(self.payload(),2)
        self.assertTrue(result['_context_overflow']);self.assertFalse(result['_context_stats']['admitted'])
        self.assertNotIn('/v1/chat/completions',events)
    def test_authentication_error_is_not_an_optional_timeout(self):
        base,events=self.fixture(status=401)
        with self.assertRaises(urllib.error.HTTPError):self.client(base,optional=True)(self.payload(),2)
        self.assertNotIn('/v1/chat/completions',events)
    def test_malformed_meter_result_still_refuses(self):
        base,events=self.fixture()
        client=self.client(base,optional=True);client.token_meter.measure=Mock(side_effect=ValueError('invalid context'))
        with self.assertRaises(ValueError):client(self.payload(),2)
        self.assertNotIn('/v1/chat/completions',events)
    def test_direct_and_wrapped_whole_request_deadlines_never_fall_back(self):
        for error in (ModelDeadline('model deadline'),urllib.error.URLError(ModelDeadline('model deadline'))):
            with self.subTest(wrapper=type(error).__name__):
                client=ModelClient('http://127.0.0.1:9/v1',token_meter_optional=True)
                client.token_meter=SimpleNamespace(measure=Mock(side_effect=error));client.opener=Mock()
                with self.assertRaises((ModelDeadline,urllib.error.URLError)):client(self.payload(),2)
                client.opener.open.assert_not_called()
    def test_real_whole_request_timer_is_preserved(self):
        client=ModelClient('http://127.0.0.1:9/v1',timeout_s=.02,token_meter_optional=True)
        client.token_meter=SimpleNamespace(measure=lambda payload:time.sleep(.2));client.opener=Mock()
        with self.assertRaises(ModelDeadline):client(self.payload(),2)
        client.opener.open.assert_not_called()
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
