"""Real owned UDS/private service files; manager/program selection are controlled.

No service, engine or employee is contacted. A successful proof only holds an
existing peer without sending a frame; it is not a resize/owner capability.
"""
from contextlib import contextmanager
import copy
import os
from pathlib import Path
import socket
import sys
import threading
import hashlib
import time
import json
import subprocess
import selectors
import unittest
from unittest.mock import patch

from reverie import resource_actor_refresh as M
from tests import test_worker_service as F
from tests.test_worker_service_upgrade import TEMPLATE


class RegisteredTransportTests(unittest.TestCase):
    def registered_generation(self, f):
        """Real immutable-shaped owned inputs; fixed Nix custody is controlled."""
        from reverie.worker_service import UNIT
        old = f.store/'old-unit/share/systemd/user'/UNIT
        wrapper = f.store/'old-code/bin/reverie-worker-broker'
        check = f.store/'old-check/bin/reverie-worker-service-check'
        python = f.store/'old-python/bin/python3'
        current_python = f.store/'new-python/bin/python3'
        old_entry = f.store/'old-source/python/reverie/worker.py'
        current_entry = f.store/'new-source/python/reverie/worker.py'
        for path in (old, wrapper, check, python, current_python, old_entry, current_entry):
            path.parent.mkdir(parents=True, exist_ok=True)
        for path in (python, current_python):
            if path.exists():path.chmod(0o755)
            path.write_bytes(b'\x7fELFcontrolled-test-input');path.chmod(0o555)
        for entry in (old_entry, current_entry):
            if entry.exists():entry.chmod(0o644)
            entry.write_text('# synthetic immutable broker\n');entry.chmod(0o444)
            dependency=entry.with_name('helper.py')
            if dependency.exists():dependency.chmod(0o644)
            dependency.write_text('# synthetic immutable dependency\n');dependency.chmod(0o444)
        (old_entry.parents[2]/'website.js').write_text('old website')
        (current_entry.parents[2]/'website.js').write_text('new website')
        if wrapper.exists():wrapper.chmod(0o755)
        wrapper.write_text('#!'+str(f.store)+'/bash/bin/bash\n'
            'set -o errexit\nset -o nounset\nset -o pipefail\n\n'
            'export PATH="'+str(python.parent)+':$PATH"\n\n'
            'exec '+str(python)+' -I -B '+str(old_entry)+' broker "$@"\n')
        wrapper.chmod(0o555)
        if check.exists():check.chmod(0o755)
        check.write_text('#!/bin/sh\nexit 0\n');check.chmod(0o555)
        if old.exists():old.chmod(0o644)
        old.write_text(TEMPLATE.format(check=check,broker=wrapper));old.chmod(0o444)
        f.service.unit.unlink();f.service.unit.symlink_to(old)
        f.service.gcroot.unlink();f.service.gcroot.symlink_to(f.service.store_root(old))
        def controlled(path,maximum):
            path=Path(path);info=path.stat()
            if (not (path.is_relative_to(f.store) or path == Path(sys.executable).resolve())
                    or path.resolve()!=path or not path.is_file() or info.st_mode&0o222):
                raise ValueError('Controlled immutable input refused')
            self.assertLessEqual(info.st_size,maximum)
            return path
        return old,wrapper,python,old_entry,current_python,current_entry,controlled

    @contextmanager
    def fixture(self):
        f=F.WorkerServiceTests(); f.setUp()
        listener=None;thread=None;stop=threading.Event();received=[];errors=[]
        try:
            control=f.root/'refresh-control';control.mkdir(mode=0o700)
            f.config['socket']=str(control/'broker.sock');f.write_config();f.service.install()
            _,_,declared,entry,_,_,controlled=self.registered_generation(f)
            props={'MainPID':str(os.getpid()),'FragmentPath':str(f.service.unit),
                   'DropInPaths':'','ActiveState':'active','SubState':'running'}
            manager=f.service.manager
            def selected(*args,**kwargs):
                if args[0]=='show':
                    return type('Result',(),{'stdout':'\n'.join(k+'='+v for k,v in props.items())})()
                return manager(*args,**kwargs)
            f.service.manager=selected
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            listener.bind(f.config['socket']);Path(f.config['socket']).chmod(0o600)
            listener.listen(1);listener.settimeout(.1)
            def serve():
                try:
                    while not stop.is_set():
                        try:connection,_=listener.accept();break
                        except TimeoutError:continue
                    else:return
                    with connection:
                        connection.settimeout(3);received.append(connection.recv(1))
                except BaseException as error:errors.append(type(error).__name__)
            thread=threading.Thread(target=serve);thread.start()
            env={'REVERIE_WORKER_SERVICE_PYTHON':sys.executable,
                 'REVERIE_WORKER_SERVICE_ENTRY':str(entry)}
            def interpreter_file(path,**kwargs):
                path=controlled(Path(path).resolve(),2*1024**2);info=path.stat()
                from reverie.worker_service_transport_upgrade import _signature
                return {'canonical':str(path),'signature':_signature(path),'identity':[info.st_dev,info.st_ino],
                        'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            def observe(_observer,path):
                fact=interpreter_file(path);actual=Path(sys.executable).resolve();info=actual.stat()
                return {'declared':str(path),'invocation':fact['canonical'],'sha256':fact['sha256'],
                    'identity':fact['identity'],'identitySignature':fact['signature'],
                    'executable':str(actual),'exeIdentity':[info.st_dev,info.st_ino],'argv0':str(path)}
            # These fixtures model immutable-file custody/program facts only.
            # Actual emitted-wrapper/kernel/UDS coverage is a separate control.
            with patch.dict(os.environ,env),patch.object(M,'immutable',side_effect=controlled),\
                 patch.object(M,'interpreter_file',side_effect=interpreter_file),\
                 patch.object(M.IsolatedInterpreterObserver,'observe',new=observe),\
                 patch.object(M.Program,'matches')as program:
                yield f,props,program,received
        finally:
            stop.set()
            if thread:thread.join(4)
            if listener:listener.close()
            if thread:self.assertFalse(thread.is_alive())
            self.assertEqual(errors,[]);f.doCleanups()

    def test_holds_actual_owner_kernel_peer_without_sending_a_frame(self):
        with self.fixture()as(f,props,program,received):
            proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
            try:
                self.assertEqual(proof.credentials,(os.getpid(),os.getuid(),os.getgid()))
                proof.guard();self.assertGreaterEqual(program.call_count,3)
                proof.finalize();self.assertIsNone(proof.socket)
            finally:proof.close()
        self.assertEqual(received,[b''])

    def test_unregistered_pid_does_not_match_actual_socket_peer(self):
        with self.fixture()as(f,props,_program,received):
            # A sandbox parent can be PID 1, which is refused before connecting.
            # Program selection is already controlled; preserve the actual UDS
            # kernel peer and select a different, admissible registered PID.
            selected=os.getpid()+1;props['MainPID']=str(selected)
            with patch.object(M,'read_proc',return_value={'pid':selected}),self.assertRaisesRegex(ValueError,'kernel peer differs'):
                M.RegisteredTransport(f.service,f.config)
        self.assertEqual(received,[b''])

    def test_current_dropin_config_and_service_state_drift_refuse(self):
        for change in ('dropin','configuration','state','selection'):
            with self.subTest(change=change),self.fixture()as(f,props,_program,_received):
                proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
                try:
                    if change=='dropin':props['DropInPaths']='/owned-test/foreign.conf'
                    elif change=='state':props['SubState']='stopping'
                    elif change=='configuration':
                        f.config['pidsLimit']+=1;f.write_config()
                    else:f.service.environment.write_text('REVERIE_WORKER_CONFIG=/different/owned-selection\n')
                    with self.assertRaises(ValueError):proof.guard()
                finally:proof.close()

    def test_transport_requires_canonical_private_socket_and_unchanged_input_config(self):
        for change in ('socket-permission','configuration'):
            with self.subTest(change=change),self.fixture()as(f,_props,_program,_received):
                selected=copy.deepcopy(f.config)
                if change=='socket-permission':Path(f.config['socket']).chmod(0o666)
                else:selected['pidsLimit']+=1
                with self.assertRaises(ValueError):M.RegisteredTransport(f.service,selected)

    def test_website_only_source_change_keeps_exact_existing_registered_program(self):
        with self.fixture()as(f,_props,program,_received):
            old,_,python,entry,new_python,new_entry,controlled=self.registered_generation(f)
            with patch.object(M,'immutable',side_effect=controlled),patch.dict(os.environ,{
                'REVERIE_WORKER_SERVICE_PYTHON':sys.executable,'REVERIE_WORKER_SERVICE_ENTRY':str(new_entry)}):
                proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
                try:
                    self.assertEqual(proof.target,old)
                    self.assertEqual(proof.program.argv,(str(python),'-I','-B',str(entry),'broker','--config',str(f.service.config_path)))
                    proof.guard();self.assertGreater(program.call_count,0)
                    # Registration replacement is still a new incarnation.
                    f.service.gcroot.unlink();f.service.gcroot.symlink_to(f.service.store_root(f.target))
                    with self.assertRaisesRegex(ValueError,'generation root'):proof.guard()
                finally:proof.close()

    def test_changed_registered_python_dependency_requires_coordinated_upgrade(self):
        with self.fixture()as(f,_props,_program,_received):
            _,_,_,entry,python,current,controlled=self.registered_generation(f)
            dependency=entry.with_name('helper.py');dependency.chmod(0o644)
            dependency.write_text('# changed old dependency\n');dependency.chmod(0o444)
            with patch.object(M,'immutable',side_effect=controlled),self.assertRaisesRegex(ValueError,'Python inputs differ'):
                M._registered_program(f.service,python,current)

    def test_registered_wrapper_rejects_ambient_or_additional_execution(self):
        for change in ('isolation','extra-command','path'):
            with self.subTest(change=change),self.fixture()as(f,_props,_program,_received):
                _,wrapper,_,_,python,current,controlled=self.registered_generation(f)
                text=wrapper.read_text()
                if change=='isolation':text=text.replace(' -I -B ',' ')
                elif change=='extra-command':text=text.replace('\nexec ','\nfalse\nexec ')
                else:text=text.replace('export PATH="','export PATH="/unreviewed:')
                wrapper.chmod(0o755);wrapper.write_text(text);wrapper.chmod(0o555)
                with patch.object(M,'immutable',side_effect=controlled),self.assertRaisesRegex(ValueError,'registered broker'):
                    M._registered_program(f.service,python,current)

    def test_registered_python_graph_rejects_symlink_dependency(self):
        with self.fixture()as(f,_props,_program,_received):
            _,_,_,entry,python,current,controlled=self.registered_generation(f)
            entry.with_name('helper.py').unlink()
            entry.with_name('helper.py').symlink_to(current.with_name('helper.py'))
            with patch.object(M,'immutable',side_effect=controlled),self.assertRaisesRegex(ValueError,'regular registered Python'):
                M._registered_program(f.service,python,current)

    def test_registered_source_data_drift_also_requires_upgrade(self):
        with self.fixture()as(f,_props,_program,_received):
            _,_,_,entry,python,current,controlled=self.registered_generation(f)
            for path,text in ((entry.with_name('defaults.json'),'{}'),(current.with_name('defaults.json'),'{"changed":true}')):
                path.write_text(text);path.chmod(0o444)
            with patch.object(M,'immutable',side_effect=controlled),self.assertRaisesRegex(ValueError,'Python inputs differ'):
                M._registered_program(f.service,python,current)

    def test_same_target_still_uses_the_actual_unit_declared_interpreter(self):
        with self.fixture()as(f,_props,_program,_received):
            installed=f.service.unit.resolve();entry=f.store/'old-source/python/reverie/worker.py'
            with patch.object(f.service,'target_unit',return_value=installed):
                proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
                try:
                    self.assertEqual(proof.program.argv[0],str(f.store/'old-python/bin/python3'))
                    self.assertEqual(proof.program.argv[3],str(entry))
                    self.assertEqual(proof.program.executable,str(Path(sys.executable).resolve()))
                    proof.guard()
                finally:proof.close()

    def test_declared_interpreter_change_after_admission_refuses(self):
        with self.fixture()as(f,_props,_program,_received):
            proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
            try:
                declared=Path(proof.interpreter['declared']);declared.chmod(0o755)
                declared.write_bytes(b'\x7fELFchanged-controlled-file');declared.chmod(0o555)
                with self.assertRaisesRegex(ValueError,'declared interpreter changed'):proof.guard()
            finally:proof.close()

    def test_different_interpreter_elf_is_not_authorized_by_an_immutable_name(self):
        with self.fixture()as(f,_props,_program,_received):
            original=M.IsolatedInterpreterObserver.observe
            def wrong(observer,path):
                fact=original(observer,path)
                if str(path).endswith('/old-python/bin/python3'):fact={**fact,'exeIdentity':[0,1]}
                return fact
            with patch.object(M.IsolatedInterpreterObserver,'observe',side_effect=wrong,autospec=True),\
                 self.assertRaisesRegex(ValueError,'interpreter ABI differs'):
                M.RegisteredTransport(f.service,copy.deepcopy(f.config))


class InterpreterObservation(unittest.TestCase):
    def setUp(self):
        # Native admission is not run inside a Nix builder. Model only the
        # namespace-mapped owner of these two fixed read-only code artifacts;
        # every inode/mode/hash and actual probe PID/argv/ELF remains real.
        mapped=Path('/').stat().st_uid
        if os.environ.get('NIX_BUILD_TOP') and mapped==65534:
            original=Path.stat
            files={Path(sys.executable).resolve(),Path('/proc/self/exe').resolve()}
            def selected(path,*args,**kwargs):
                value=original(path,*args,**kwargs)
                if path in files and value.st_uid==mapped:
                    fields=list(value);fields[4]=0;return os.stat_result(fields)
                return value
            self.enterContext(patch.object(Path,'stat',selected))

    def test_fixed_observer_qualifies_actual_python_and_settles_its_child(self):
        observer=M.IsolatedInterpreterObserver(time.monotonic()+10)
        actual=observer.observe(Path(sys.executable))
        self.assertEqual(actual['executable'],str(Path('/proc/self/exe').resolve()))
        self.assertEqual(actual['argv0'],str(Path(sys.executable)))
        self.assertIsNone(observer._probe_child)
        self.assertNotIn(observer,observer._unsettled)

    def test_observer_refuses_expired_nonfinite_and_bool_deadlines(self):
        for deadline in (time.monotonic()-1,float('inf'),float('nan'),True):
            with self.subTest(deadline=deadline),self.assertRaises(ValueError):M.IsolatedInterpreterObserver(deadline)


@unittest.skipUnless(os.environ.get('NIX_REVERIE_TEST_REFRESH_FIXTURE'),
                     'Pinned public emitted-wrapper/UDS fixture required')
class PackagedRefreshTransport(unittest.TestCase):
    """Real immutable wrapper, actual ELF/argv/SO_PEERCRED; manager metadata only is controlled."""
    def check_generation(self, *, compatible_source):
        from reverie import worker_service as S
        facts=json.loads(Path(os.environ['NIX_REVERIE_TEST_REFRESH_FIXTURE']).read_bytes())
        selected=facts['fixtures'][0 if compatible_source else 1];current=facts['fixtures'][1]
        for item in facts['fixtures']:
            for key in ('entry','wrapper','unit'):
                self.assertEqual(hashlib.sha256(Path(item[key]).read_bytes()).hexdigest(),item[key+'SHA256'])
        original=Path(facts['originalWrapper']['path']).read_text()
        self.assertEqual(Path(selected['wrapper']).read_text(),original.replace(
            facts['originalSourceLiteral'],selected['entry']))
        f=F.WorkerServiceTests();f.setUp();child=None;proof=None
        try:
            control=f.root/'refresh-peer';control.mkdir(mode=0o700)
            f.config['socket']=str(control/'broker.sock');f.write_config()
            f.service.unit.parent.mkdir(parents=True,exist_ok=True)
            f.service.unit.symlink_to(selected['unit'])
            f.service.environment.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            f.service.environment.write_text(S.environment_selection(f.path));f.service.environment.chmod(0o600)
            f.service.gcroot.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            f.service.gcroot.symlink_to(str(Path(selected['unit']).parents[3]))
            child=subprocess.Popen([selected['wrapper'],'--config',str(f.path)],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                env={'LANG':'C.UTF-8','PATH':'/nonexistent'})
            with selectors.DefaultSelector()as ready:
                ready.register(child.stdout,selectors.EVENT_READ)
                self.assertTrue(ready.select(5),'Owned inert UDS READY unavailable')
                self.assertEqual(child.stdout.readline(),b'REFRESH_ABI_READY\n')
            props={'MainPID':str(child.pid),'FragmentPath':str(f.service.unit),
                   'DropInPaths':'','ActiveState':'active','SubState':'running'}
            def manager(*args,**kwargs):
                self.assertEqual(args[:2],('show',S.UNIT))
                return subprocess.CompletedProcess(args,0,'\n'.join(k+'='+v for k,v in props.items()),'')
            env={'REVERIE_WORKER_SERVICE_PYTHON':facts['expectedInterpreter'],
                 'REVERIE_WORKER_SERVICE_ENTRY':current['entry']}
            with patch.object(S,'STORE_ROOT',Path('/nix/store')),\
                 patch.object(f.service,'target_unit',return_value=Path(current['unit'])),\
                 patch.object(f.service,'manager',side_effect=manager),patch.dict(os.environ,env):
                proof=M.RegisteredTransport(f.service,copy.deepcopy(f.config))
                self.assertEqual(proof.credentials,(child.pid,os.getuid(),os.getgid()))
                self.assertEqual(proof.program.executable,str((Path('/proc')/str(child.pid)/'exe').resolve()))
                self.assertEqual(proof.program.argv,(facts['declaredInterpreter'],'-I','-B',selected['entry'],
                                                   'broker','--config',str(f.path)))
                self.assertNotEqual(Path(facts['declaredInterpreter']).resolve(),Path(proof.program.executable))
                actual=(Path('/proc')/str(child.pid)/'cmdline').read_bytes()
                self.assertEqual(actual,b'\0'.join(word.encode()for word in proof.program.argv)+b'\0')
                proof.guard();proof.finalize();self.assertIsNone(proof.socket)
            self.assertEqual(child.wait(timeout=5),0)
            self.assertEqual(child.stdout.read(),b'REFRESH_PEER_CLOSED_WITHOUT_FRAME\n')
            self.assertEqual(child.stderr.read(),b'')
            self.assertFalse(any(call[0]=='docker'for call in f.calls))
        finally:
            if proof:proof.close()
            if child is not None:
                if child.poll() is None:
                    try:child.stdin.write(b'x');child.stdin.flush()
                    except BrokenPipeError:pass
                    try:child.wait(timeout=5)
                    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
                for stream in (child.stdin,child.stdout,child.stderr):stream.close()
                self.assertIsNotNone(child.poll())
            f.doCleanups()

    def test_actual_emitted_same_target_wrapper_and_kernel_peer_are_qualified(self):
        self.check_generation(compatible_source=False)

    def test_actual_emitted_compatible_registered_source_and_kernel_peer_are_qualified(self):
        self.check_generation(compatible_source=True)


if __name__=='__main__':unittest.main()
