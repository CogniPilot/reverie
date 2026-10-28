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
            path.write_bytes(b'\x7fELFcontrolled-test-input');path.chmod(0o555)
        for entry in (old_entry, current_entry):
            entry.write_text('# synthetic immutable broker\n');entry.chmod(0o444)
            dependency=entry.with_name('helper.py')
            dependency.write_text('# synthetic immutable dependency\n');dependency.chmod(0o444)
        (old_entry.parents[2]/'website.js').write_text('old website')
        (current_entry.parents[2]/'website.js').write_text('new website')
        wrapper.write_text('#!'+str(f.store)+'/bash/bin/bash\n'
            'set -o errexit\nset -o nounset\nset -o pipefail\n\n'
            'export PATH="'+str(python.parent)+':$PATH"\n\n'
            'exec '+str(python)+' -I -B '+str(old_entry)+' broker "$@"\n')
        wrapper.chmod(0o555)
        check.write_text('#!/bin/sh\nexit 0\n');check.chmod(0o555)
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
                 'REVERIE_WORKER_SERVICE_ENTRY':str(f.target)}
            with patch.dict(os.environ,env),patch.object(M,'immutable',side_effect=lambda p,_:Path(p)),\
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


if __name__=='__main__':unittest.main()
