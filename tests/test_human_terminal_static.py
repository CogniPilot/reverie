"""Real owned PTY/source-monitor controls; never an installed employee terminal.

The test-only build points the fixed shell/home macros at harmless owned fixture
inputs. The production Nix output has literal image-root paths, is statically
linked, and separately checks both ELF programs for INTERP/NEEDED absence.
"""
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import signal
import struct
import subprocess
import tempfile
import time
import unittest


def start(pid):
    try:
        raw=Path('/proc',str(pid),'stat').read_text()
        return int(raw.rsplit(')',1)[1].split()[19])
    except FileNotFoundError:
        return None


class StaticMonitorSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        cls.root=Path(cls.temp.name).resolve();cls.binary=cls.root/'monitor'
        shell=shutil.which('bash');compiler=shutil.which(os.environ.get('CC','cc'))
        if not shell or not compiler:
            cls.temp.cleanup();raise unittest.SkipTest('Native-flake C compiler and Bash required for owned source control')
        source=Path(__file__).resolve().parents[1]/'python/reverie/human_terminal_static.c'
        cls.compiler,cls.source=compiler,source
        result=subprocess.run([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',
            '-DHUMAN_SHELL='+json.dumps(str(Path(shell).resolve())),'-DHUMAN_HOME='+json.dumps(str(cls.root)),
            str(source),'-o',str(cls.binary)],capture_output=True,text=True,timeout=30)
        if result.returncode:
            cls.temp.cleanup();raise AssertionError(result.stderr)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        self.sentinels=list(os.pipe())
        self.socket_pair=socket.socketpair()
        self.sentinels.extend(sock.fileno() for sock in self.socket_pair)
        self.sentinel_links={os.readlink('/proc/self/fd/'+str(fd)) for fd in self.sentinels}
        self.addCleanup(lambda: [sock.close() for sock in self.socket_pair])
        self.addCleanup(lambda: [os.close(fd) for fd in self.sentinels[:2]])
        self.process=subprocess.Popen([str(self.binary)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,env={},start_new_session=True,pass_fds=self.sentinels)
        self.control_links={os.readlink('/proc/self/fd/'+str(stream.fileno()))
                            for stream in (self.process.stdin,self.process.stdout,self.process.stderr)}
        self.buffer=bytearray();self.nonce='a'*64;self.ready=None
        self.addCleanup(self.finish)
        self.process.stdin.write(b'H1'+self.nonce.encode()+struct.pack('!QHH',int(time.time()*1000)+10000,80,24))
        self.process.stdin.flush()
        kind,value=self.frame()
        self.assertEqual(kind,b'P');self.prepared=json.loads(value)
        self.assertEqual(self.prepared['nonce'],self.nonce)
        self.assertEqual(self.prepared['monitorPid'],self.process.pid)
        self.assertEqual(self.prepared['monitorStart'],start(self.process.pid))
        if self._testMethodName=='test_no_child_without_exact_private_go':return
        self.send(b'G',self.nonce.encode())
        kind,value=self.frame()
        self.assertEqual(kind,b'A');self.ready=json.loads(value)
        self.assertEqual(self.ready['nonce'],self.nonce)
        self.assertEqual(self.ready['monitorPid'],self.process.pid)
        self.assertEqual(self.ready['monitorStart'],start(self.process.pid))
        self.assertEqual(self.ready['childStart'],start(self.ready['childPid']))

    def test_failed_proc_directory_read_is_unknown_never_empty(self):
        # Exercise the exact static inventory() with a failing directory port.
        # It must not infer an empty tree from a failed readdir. No actor/PTY is
        # started by this tiny additional executable.
        source=self.root/'inventory-eio.c';binary=self.root/'inventory-eio'
        source.write_text('#define _GNU_SOURCE\n#include <dirent.h>\n#include <errno.h>\n'
            'static struct dirent *failed_read(DIR *d){(void)d;errno=EIO;return 0;}\n'
            '#define readdir failed_read\n#define main real_monitor_main\n'
            '#include '+json.dumps(str(self.source))+'\n#undef main\n'
            'int main(void){return inventory()==-1?0:97;}\n')
        built=subprocess.run([self.compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',
            str(source),'-o',str(binary)],capture_output=True,text=True,timeout=30)
        self.assertEqual(built.returncode,0,built.stderr)
        self.assertEqual(subprocess.run([str(binary)],env={},timeout=2).returncode,0)

    def test_no_child_without_exact_private_go(self):
        children=[]
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():continue
            try:
                fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
                if int(fields[1])==self.process.pid:children.append(int(entry.name))
            except FileNotFoundError:pass
        self.assertEqual(children,[])
        self.send(b'G',b'b'*64)
        self.assertEqual(self.process.wait(timeout=2),125)

    def finish(self):
        if self.process.poll() is None:
            try:self.send(b'Q')
            except (OSError,ValueError):pass
            try:self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                # This exact Popen child is ours. Killing the monitor alone is
                # not a positive child-settlement oracle; a timeout fails.
                self.process.kill();self.process.wait(timeout=2)
                raise AssertionError('owned monitor cleanup timed out; retain failure evidence')
        for stream in (self.process.stdin,self.process.stdout,self.process.stderr):stream.close()

    def send(self,kind,payload=b''):
        self.process.stdin.write(kind+struct.pack('!I',len(payload))+payload);self.process.stdin.flush()

    def frame(self,seconds=4):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if len(self.buffer)>=5:
                size=struct.unpack('!I',self.buffer[1:5])[0];self.assertLessEqual(size,4096)
                if len(self.buffer)>=size+5:
                    kind=bytes(self.buffer[:1]);value=bytes(self.buffer[5:size+5]);del self.buffer[:size+5];return kind,value
            if select.select([self.process.stdout],[],[],max(0,end-time.monotonic()))[0]:
                data=os.read(self.process.stdout.fileno(),65536)
                self.assertTrue(data,'owned monitor ended without required control frame');self.buffer.extend(data)
        raise AssertionError('owned control frame timeout')

    def closed(self):
        for _ in range(64):
            kind,value=self.frame()
            if kind==b'X':
                result=json.loads(value);self.assertEqual(result,{'nonce':self.nonce,'settled':True,'failureClass':None});break
            self.assertEqual(kind,b'O')
        else:self.fail('no bounded settlement frame')
        self.assertEqual(self.process.wait(timeout=3),0)
        self.assertNotEqual(start(self.ready['childPid']),self.ready['childStart'])
        self.assertNotEqual(start(self.ready['monitorPid']),self.ready['monitorStart'])

    def test_monitor_private_and_shell_inherits_only_pty_descriptors(self):
        with self.assertRaises(PermissionError):os.open('/proc/'+str(self.process.pid)+'/fd/0',os.O_RDONLY|os.O_NONBLOCK)
        links=[]
        for fd in Path('/proc',str(self.ready['childPid']),'fd').iterdir():
            try:links.append(os.readlink(fd))
            except FileNotFoundError:pass
        # The dynamically linked *test* Bash may open a new NSS socket after
        # exec. Verify inheritance, rather than misclassifying that new socket
        # as a monitor/control FD. Production uses separately checked static Bash.
        for number in range(3):
            self.assertTrue(os.readlink('/proc/'+str(self.ready['childPid'])+'/fd/'+str(number)).startswith('/dev/pts/'))
        self.assertTrue(links)
        self.assertTrue(self.sentinel_links.isdisjoint(links),links)
        self.assertTrue(self.control_links.isdisjoint(links),links)
        self.send(b'Q');self.closed()

    def test_pty_text_cannot_be_a_cleanup_receipt(self):
        self.send(b'I',b"printf 'X\\000\\000\\000\\002{}\\n'\n")
        found=False
        for _ in range(16):
            kind,value=self.frame();self.assertEqual(kind,b'O')
            if b'X\x00\x00\x00\x02{}'in value:found=True;break
        self.assertTrue(found)
        self.assertIsNone(self.process.poll())
        self.send(b'Q');self.closed()

    def test_real_owned_background_child_is_gone_before_settlement(self):
        self.send(b'I',b"(trap '' HUP TERM; while :; do :; done) & printf 'OWN_CHILD:%s\\n' \"$!\"\n")
        text=bytearray();pid=None
        for _ in range(16):
            kind,value=self.frame();self.assertEqual(kind,b'O');text.extend(value)
            match=re.search(rb'OWN_CHILD:([0-9]+)',text)
            if match:pid=int(match[1]);break
        self.assertIsNotNone(pid);original=start(pid);self.assertIsNotNone(original)
        self.send(b'Q');self.closed();self.assertNotEqual(start(pid),original)

    def test_eof_and_signal_use_the_same_settlement_oracle(self):
        self.process.stdin.close();self.closed()

    def test_sigterm_uses_the_same_settlement_oracle(self):
        self.process.send_signal(signal.SIGTERM);self.closed()


if __name__=='__main__':unittest.main()
