"""Real PTY/tmux rehearsal with a synthetic process, never the container engine.

This checks attachment lifetime only. Real provider conversation reconnection is
an explicit activation prerequisite and cannot be proved by a sleep surrogate.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

from tests import test_worker as fixture
from reverie.worker import Broker, receive_frame, send_frame
from reverie.worker_resources import policy_digest


@unittest.skipUnless(shutil.which('tmux'), 'tmux is needed for the native transport rehearsal')
class BrokerTransportLifetimeTests(unittest.TestCase):
    def setUp(self):
        fixture.WorkerTests.setUp(self)
        self.config.update(uid=os.getuid(),budgetMode='admission',memoryMiB=4096)
        self.sid=fixture.SID
        self.tmux=shutil.which('tmux');self.tmux_socket=self.root/'tmux.sock'
        self.addCleanup(lambda:subprocess.run([self.tmux,'-S',str(self.tmux_socket),'kill-server'],capture_output=True))
        subprocess.run([self.tmux,'-S',str(self.tmux_socket),'-f','/dev/null','new-session','-d','-s','office','sleep 120'],check=True,capture_output=True)
        self.pid=subprocess.check_output([self.tmux,'-S',str(self.tmux_socket),'display-message','-p','-t','office','#{pane_pid}'],text=True).strip()
        self.start=self.process_start()
        home=Path(self.config['stateRoot'])/self.sid/'home'
        for directory in (home.parent.parent, home.parent, home, home/'.reverie-launch'):
            directory.mkdir(mode=0o700)
        (home.parent/'runtime.json').write_text(json.dumps({'exit':'synthetic.exit'}))
        self.engine=self.root/'synthetic-engine'
        self.engine.write_text('#!'+sys.executable+'\nimport os,sys\na=sys.argv[1:];i=a.index("/bin/tmux");tail=a[i+1:];assert tail[:3]==["-u","-L","reverie-laptop"];os.execv('+repr(self.tmux)+',["tmux","-u","-S",'+repr(str(self.tmux_socket))+']+tail[3:])\n')
        self.engine.chmod(0o700)
        self.calls=[]

    def attach(self):
        broker=Broker(self.config);broker.engine=str(self.engine);broker.office=lambda sid:None
        def engine(args,optional=False):
            self.calls.append(args)
            if args[0]=='inspect':
                value=[{'Config':{'Labels':{'reverie.worker':self.config['deployment'],'reverie.session':self.sid,'reverie.worker-policy':policy_digest(self.config,self.sid)}},'State':{'Running':True}}]
                return subprocess.CompletedProcess(args,0,json.dumps(value),'')
            if args[0]=='exec': return subprocess.CompletedProcess(args,0,'0','')
            raise AssertionError('Unexpected container mutation: '+args[0])
        broker.run_engine=engine
        server,client=socket.socketpair();self.addCleanup(client.close)
        broker.connections.acquire()
        thread=threading.Thread(target=broker.handle,args=(server,));thread.start()
        request=dict(sessionId=self.sid,cwd='/workspace',command='must-never-run',env={},cols=80,rows=24,attachOnly=True)
        send_frame(client,b'J',json.dumps(request).encode());client.settimeout(5)
        kind,payload=receive_frame(client)
        self.assertEqual(kind,b'O',payload)
        return broker,thread,client

    def assert_same_synthetic_process(self):
        self.assertEqual(self.process_start(),self.start)
        self.assertEqual(subprocess.check_output([self.tmux,'-S',str(self.tmux_socket),'display-message','-p','-t','office','#{pane_dead}'],text=True).strip(),'0')

    def process_start(self):
        # comm may contain whitespace; fields after its closing ')' start at 3.
        return Path('/proc',self.pid,'stat').read_text().rsplit(')',1)[1].split()[19]

    def test_eof_and_broker_shutdown_leave_tmux_process_for_attach_only(self):
        broker,thread,client=self.attach();client.close();thread.join(5)
        self.assertFalse(thread.is_alive());self.assert_same_synthetic_process()
        broker,thread,client=self.attach();broker.stopping.set();thread.join(5)
        self.assertFalse(thread.is_alive());client.close();self.assert_same_synthetic_process()
        self.assertTrue(self.calls);self.assertFalse(any(c[0] in ('create','stop','kill','rm','start') for c in self.calls))

    def test_reattach_with_cleanup_enabled_never_enters_cold_wipe(self):
        self.config['coldTemporaryCleanup'] = {'version': 1, 'enabled': True, 'hostLeaseDirectories': []}
        with patch('reverie.worker.clear_cold_temporary', side_effect=AssertionError('reattach must not wipe')) as clear:
            broker, thread, client = self.attach()
            client.close(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assert_same_synthetic_process()
            clear.assert_not_called()
        self.assertFalse(any(c[0] in ('create', 'stop', 'kill', 'rm', 'start') for c in self.calls))

    def test_reattach_with_retention_policy_never_rotates_or_commits(self):
        self.config['coldTemporaryCleanup'] = {'version': 1, 'enabled': True,
            'hostLeaseDirectories': [], 'strategy': 'retain-and-replace'}
        with patch('reverie.worker.prepare_retained', side_effect=AssertionError('reattach must not rotate')) as prepare, \
             patch('reverie.worker.finish_retained', side_effect=AssertionError('reattach must not commit')) as finish:
            broker, thread, client = self.attach()
            client.close(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assert_same_synthetic_process()
            prepare.assert_not_called(); finish.assert_not_called()
        self.assertFalse(any(c[0] in ('create', 'stop', 'kill', 'rm', 'start') for c in self.calls))
