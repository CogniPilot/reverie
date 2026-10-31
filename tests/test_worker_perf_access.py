"""Actual owned R/flocks/private CAS; closed synthetic native ports, no engine."""
import ast
import copy
from contextlib import contextmanager
import hashlib
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

from reverie import worker_perf_access as A, worker_perf as P, worker_docker as D
from reverie import worker_resource_reservations as R
from reverie.worker import Broker,send_frame,receive_frame
from reverie.worker_resources import policy_digest
from tests import test_worker_resource_reservations as F


class PerfAccess(unittest.TestCase):
    company=F.Reservations.company
    kernel=F.Reservations.kernel

    def setUp(self):
        patch.object(Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')).start()
        self.addCleanup(patch.stopall)
        F.Reservations.setUp(self)
        self.broker=self.native; self.broker.resource_reservations=self.gate
        original_engine = self.native.run_engine
        def formatted_engine(args, optional=False, *, deadline=None):
            result = original_engine(args, optional, deadline=deadline)
            if args[0] == 'inspect' and '--format' in args:
                # Model Docker's actual requested projection, rather than hand
                # the consumer every field in this fixture's engine record.
                template = args[args.index('--format') + 1]
                keys = re.findall(r'\{\{json \.State\.([A-Za-z]+)\}\}', template)
                rows = [json.loads(line) for line in result.stdout.splitlines()]
                for row in rows:
                    state = row['State']
                    row['State'] = {key: state.get(key) for key in keys}
                result = subprocess.CompletedProcess(args, result.returncode,
                    '\n'.join(json.dumps(row) for row in rows), result.stderr)
            return result
        self.native.run_engine = formatted_engine
        self.path=self.root/'broker.json';self.broker.config_file=self.path
        self.base={'defaultAction':'SCMP_ACT_ERRNO','syscalls':[]}
        self.base_raw=json.dumps(self.base).encode();self.selected_raw=json.dumps(P.derivative(self.base)).encode()
        self.fixed={'version':1,'purpose':'worker-task-perf-profile-v1','system':'x86_64-linux',
            'baseProfile':'/nix/store/fixed-base','baseSHA256':hashlib.sha256(self.base_raw).hexdigest(),
            'profile':'/nix/store/fixed-perf','profileSHA256':hashlib.sha256(self.selected_raw).hexdigest()}
        self.config['rootlessDocker']={'enabled':True,'seccompProfile':self.fixed['baseProfile'],'seccompSha256':self.fixed['baseSHA256']}
        # Construct this owned fixture's initial protected domain with rootless
        # enabled. This is not an installed-domain activation or production port.
        self.gate.binding['configurationDigest']=R.domain_digest(self.config)
        R.marker(self.config).write_text(json.dumps(self.gate.binding))
        self.native.rows[0]['Config']['Labels']['reverie.worker-policy']=policy_digest(self.config,F.SID)
        self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)
        Path(self.config['companyFile']).chmod(0o600)
        base_file=self.root/'base.json';base_file.write_bytes(self.base_raw);base_file.chmod(0o444)
        class Location:
            def __init__(self,value):self.value=str(value)
            def __str__(self):return self.value
            def is_absolute(self):return self.value.startswith('/')
            def resolve(self,strict=False):return self
            def __eq__(self,other):return str(self)==str(other)
            def stat(self):return base_file.stat()
            def read_bytes(self):return base_file.read_bytes()
        patch.object(D,'Path',Location).start()
        patch.object(P,'artifact',return_value=copy.deepcopy(self.fixed)).start()
        patch.object(A,'_kernel',return_value={'bootId':'11111111-1111-4111-8111-111111111111','paranoid':1}).start()
        patch.object(A,'_installed_consumers',return_value=False).start()

    def command(self,enabled=True):
        status=A.status(self.broker,F.EID);current=status['current']
        return {'action':'perf-policy-request','employeeId':F.EID,'enabled':enabled,
                'expected':{k:current[k] for k in ('sessionId','sessionGeneration','bindingDigest')}|{'revision':status['revision']}}

    def stop(self):
        self.native.rows[0]['State']={'Running':False,'Pid':0,'Status':'exited','Paused':False,'Restarting':False,'Dead':False,'StartedAt':'owned-old-birth'}

    def ready(self):
        A.request(self.broker,self.command());self.stop()
        return A.preview(self.broker,F.EID)

    def test_normal_native_projection_reaches_cold_preview(self):
        A.request(self.broker, self.command())
        self.stop()
        rows = self.gate.native.inventory()
        selected = next(row for row in rows if row['Id'] == self.native.rows[0]['Id'])
        self.assertEqual(selected['State'], {'Running': False, 'Pid': 0})
        self.assertIs(type(self.gate.native), R.NativeObserver)
        preview = A.preview(self.broker, F.EID)
        self.assertEqual(preview['state'], 'READY_COLD')
        self.assertEqual(preview['plan']['stoppedNative'],
                         {'Id': selected['Id'], 'State': self.native.rows[0]['State']})

    def test_changed_stopped_birth_invalidates_preview_without_pending(self):
        ready = self.ready()
        before = self.path.read_bytes()
        self.native.rows[0]['State']['StartedAt'] = 'new-cold-birth'
        with self.assertRaisesRegex(ValueError, 'PREVIEW_CHANGED'):
            A.apply(self.broker, F.EID, ready['planDigest'])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_missing_stopped_fields_never_default_to_cold(self):
        A.request(self.broker, self.command())
        self.stop()
        state = copy.deepcopy(self.native.rows[0]['State'])
        before = self.path.read_bytes()
        for key in ('Status', 'StartedAt', 'Paused', 'Restarting', 'Dead'):
            self.native.rows[0]['State'] = {k: v for k, v in state.items() if k != key}
            with self.subTest(key=key), self.assertRaises(ValueError):
                A.preview(self.broker, F.EID)
            self.assertFalse(os.path.lexists(R.pending(self.config)))
        self.assertEqual(self.path.read_bytes(), before)

    def test_stopped_flags_and_unknown_status_still_refuse(self):
        A.request(self.broker, self.command())
        self.stop()
        state = copy.deepcopy(self.native.rows[0]['State'])
        for key, value in [('Paused', True), ('Restarting', True), ('Dead', True),
                           ('Status', 'dead'), ('StartedAt', '')]:
            self.native.rows[0]['State'] = {**state, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'STOPPED_NATIVE_UNKNOWN'):
                A.preview(self.broker, F.EID)
            self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_selected_stopped_inspect_cannot_substitute_another_identity(self):
        A.request(self.broker, self.command())
        self.stop()
        original = self.native.run_engine
        def wrong_identity(args, optional=False, *, deadline=None):
            result = original(args, optional, deadline=deadline)
            if len(args) > 2 and args[2] == R.STOPPED_ENGINE_FORMAT:
                row = json.loads(result.stdout)
                row['Id'] = 'f' * 64
                return subprocess.CompletedProcess(args, 0, json.dumps(row), '')
            return result
        with patch.object(self.native, 'run_engine', side_effect=wrong_identity), \
             self.assertRaisesRegex(ValueError, 'STOPPED_IDENTITY_CHANGED'):
            A.preview(self.broker, F.EID)
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_stopped_producer_does_not_renew_or_exceed_original_deadline(self):
        self.stop()
        row = next(r for r in self.gate.native.inventory() if r['Id'] == self.native.rows[0]['Id'])
        start = time.monotonic()
        deadlines = []
        original = self.native.run_engine
        def engine(args, optional=False, *, deadline=None):
            deadlines.append(deadline)
            return original(args, optional, deadline=deadline)
        with patch.object(self.native, 'run_engine', side_effect=engine), \
             patch.object(R.time, 'monotonic', side_effect=[start, start + 1]), \
             self.assertRaisesRegex(ValueError, 'OBSERVATION_DEADLINE'):
            self.gate.native.stopped_state(row, deadline=start + 0.5)
        self.assertEqual(deadlines, [start + 0.5])

    def test_stopped_birth_drift_after_admission_finalizer_retains_pending(self):
        ready = self.ready()
        original = A._kernel
        changed = []
        def kernel():
            result = original()
            if getattr(self.gate._local, 'depth', 0) == 0 and os.path.lexists(R.pending(self.config)) and not changed:
                self.native.rows[0]['State']['StartedAt'] = 'late-new-cold-birth'
                changed.append(True)
            return result
        with patch.object(A, '_kernel', side_effect=kernel), \
             self.assertRaisesRegex(RuntimeError, 'RECONCILIATION'):
            A.apply(self.broker, F.EID, ready['planDigest'])
        self.assertEqual(changed, [True])
        self.assertTrue(os.path.lexists(R.pending(self.config)))

    def test_running_request_only_queues_never_changes_policy_or_starts(self):
        before=self.path.read_bytes();marker=R.marker(self.config).read_bytes();rows=copy.deepcopy(self.native.rows)
        status=A.request(self.broker,self.command())
        self.assertEqual(status['state'],'pending');self.assertFalse(status['applied']['enabled'])
        self.assertEqual(status['active'],{'known':False,'running':True,'enabled':None})
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(R.marker(self.config).read_bytes(),marker);self.assertEqual(self.native.rows,rows)
        with self.assertRaisesRegex(ValueError,'SELECTED_MUST_BE_STOPPED'):A.preview(self.broker,F.EID)
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_real_cold_preview_apply_preserves_all_stores_and_gate_reconstructs(self):
        ready=self.ready();before=copy.deepcopy(self.config)
        protected={p:p.read_bytes() for p in (self.control/'operations/operations.json',self.control/'profiles/profiles.json')}
        company=Path(self.config['companyFile']).read_bytes();rows=copy.deepcopy(self.native.rows)
        result=A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(result['state'],'CONFIGURED_COLD_RECREATE_REQUIRED');self.assertFalse(result['nativeStarted']);self.assertFalse(result['perfTested'])
        self.assertEqual(self.broker.config['employeePerfPolicies'],{F.EID:P.POLICY})
        self.assertEqual({k:v for k,v in before.items() if k!='employeePerfPolicies'},
                         {k:v for k,v in self.broker.config.items() if k!='employeePerfPolicies'})
        self.assertEqual({p:p.read_bytes() for p in protected},protected)
        self.assertEqual(company,Path(self.config['companyFile']).read_bytes());self.assertEqual(rows,self.native.rows)
        self.assertFalse(os.path.lexists(R.pending(self.config)))
        rebuilt=R.ReservationGate(self.broker)
        with rebuilt.admission():rebuilt.check_headroom()
        self.assertTrue(A.status(self.broker,F.EID)['applied']['enabled'])
        self.assertTrue(all(c[0] in ('ps','inspect') for c in self.native.calls))
        self.assertEqual(len(list((self.control/'operations').glob('task-perf-attempt-*.json'))),2)

    def test_noop_and_replay_do_not_create_another_effect(self):
        ready=self.ready();A.apply(self.broker,F.EID,ready['planDigest']);before=self.path.read_bytes()
        with self.assertRaises(ValueError):A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(before,self.path.read_bytes())
        A.request(self.broker,self.command(True))
        with self.assertRaisesRegex(ValueError,'ALREADY_APPLIED'):A.preview(self.broker,F.EID)

    def test_other_current_employee_native_policy_caps_and_account_bytes_preserved(self):
        other='ffffffff-ffff-4fff-8fff-ffffffffffff';sid=F.TARGET
        company=json.loads(Path(self.config['companyFile']).read_bytes())
        company['employees'].append({'id':other,'owner':'fixture-owner','sessionId':sid,'sessionGeneration':2,
             'desiredRunning':True,'onVacation':False,'runtimeRecipe':{'mode':'codex','customModelId':'fixture-account'}})
        Path(self.config['companyFile']).write_text(json.dumps(company))
        row=self.native.row('3'*64,self.config['deployment']+'-agent-'+sid,125,1024,
              {'reverie.worker':self.config['deployment'],'reverie.session':sid,'reverie.employee':other,
               'reverie.worker-policy':policy_digest(self.config,sid)})
        self.native.rows.append(row);self.kernel(row)
        before=copy.deepcopy(row);policy=policy_digest(self.config,sid)
        ready=self.ready();A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(self.native.rows[-1],before);self.assertEqual(policy_digest(self.broker.config,sid),policy)
        self.assertEqual(json.loads(Path(self.config['companyFile']).read_bytes()),company)

    def test_revoke_is_separate_cold_transition_preserving_prior_history(self):
        ready=self.ready();A.apply(self.broker,F.EID,ready['planDigest'])
        records={p:p.read_bytes() for p in (self.control/'operations').glob('task-perf-attempt-*.json')}
        A.request(self.broker,self.command(False));preview=A.preview(self.broker,F.EID)
        A.apply(self.broker,F.EID,preview['planDigest'])
        self.assertFalse(A.status(self.broker,F.EID)['applied']['enabled'])
        self.assertEqual({p:p.read_bytes() for p in records},records)

    def test_explicit_OFF_permission_maintenance_preserves_OFF_and_never_starts(self):
        self.employee['desiredRunning']=False;self.company();self.stop()
        company=Path(self.config['companyFile']).read_bytes()
        A.request(self.broker,self.command());ready=A.preview(self.broker,F.EID)
        result=A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertFalse(result['nativeStarted']);self.assertEqual(Path(self.config['companyFile']).read_bytes(),company)
        self.assertFalse(self.native.rows[0]['State']['Running'])

    def test_stale_scope_owner_sid_generation_recipe_and_off_change_refuse_apply(self):
        for change in ({'owner':'other-owner'},{'sessionGeneration':2},{'sessionId':F.TARGET},
                       {'runtimeRecipe':{'mode':'other'}},{'desiredRunning':False},{'onVacation':True}):
            with self.subTest(change=change):
                # A fresh exact preview for each mutation; no lifecycle effect.
                self.employee.update(owner='fixture-owner',sessionId=F.SID,sessionGeneration=1,desiredRunning=True,onVacation=False)
                self.employee.pop('runtimeRecipe',None);self.company();Path(self.config['companyFile']).chmod(0o600)
                if not (self.control/'operations'/A.NAME).exists():A.request(self.broker,self.command())
                self.stop();ready=A.preview(self.broker,F.EID);before=self.path.read_bytes()
                self.employee.update(change);self.company()
                with self.assertRaises(ValueError):A.apply(self.broker,F.EID,ready['planDigest'])
                self.assertEqual(self.path.read_bytes(),before);self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_unsupported_consumers_unknown_history_and_retained_operations_refuse(self):
        ready=self.ready();before=self.path.read_bytes()
        with patch.object(A,'_installed_consumers',return_value=True),self.assertRaisesRegex(ValueError,'INSTALLED_CONSUMERS'):A.preview(self.broker,F.EID)
        with patch.object(self.gate,'_document',return_value={'operations':{'unknown':{}}}),self.assertRaises(ValueError):A.preview(self.broker,F.EID)
        unknown=self.control/'operations/unknown.json';unknown.write_text('{}');unknown.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'UNKNOWN_HISTORY'):A.preview(self.broker,F.EID)
        self.assertEqual(self.path.read_bytes(),before);self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_broker_config_exposure_refuses_even_when_journal_is_not_exposed(self):
        self.ready();before=self.path.read_bytes()
        self.native.rows[0]['Mounts'].append({'Type':'bind','Source':str(self.path),'Destination':'/foreign-config','RW':True})
        with self.assertRaisesRegex(ValueError,'CONTROL_EXPOSED'):A.preview(self.broker,F.EID)
        self.assertEqual(self.path.read_bytes(),before);self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_late_owner_change_during_attempt_fsync_retains_pending_without_overwrite(self):
        ready=self.ready();before=self.path.read_bytes();original=R._write_exclusive
        def changed(path,value):
            result=original(path,value)
            if Path(path).name.startswith('task-perf-attempt-'):
                self.employee['desiredRunning']=False;self.company()
            return result
        with patch.object(R,'_write_exclusive',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(self.path.read_bytes(),before);self.assertTrue(os.path.lexists(R.pending(self.config)))
        with self.assertRaises(ValueError):R.ReservationGate(self.broker)

    def test_partial_marker_CAS_and_admission_finalizer_failures_keep_real_fence(self):
        ready=self.ready();original=os.replace
        def changed(source,destination):
            if Path(destination)==R.marker(self.config):raise OSError('owned CAS fault')
            return original(source,destination)
        with patch.object(A.os,'replace',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertTrue(os.path.lexists(R.pending(self.config)))
        with self.assertRaises(ValueError):R.ReservationGate(self.broker)

    def test_staged_configuration_fsync_owner_drift_refuses_before_config_CAS(self):
        ready=self.ready();before=self.path.read_bytes();original=R._write_exclusive
        def changed(path,value):
            result=original(path,value)
            if Path(path).name.startswith('broker.json.perf-'):
                self.employee['desiredRunning']=False;self.company()
            return result
        with patch.object(R,'_write_exclusive',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(self.path.read_bytes(),before);self.assertTrue(os.path.lexists(R.pending(self.config)))

    def test_late_new_unknown_history_during_commit_fsync_retains_fence(self):
        ready=self.ready();original=R._write_exclusive
        def changed(path,value):
            result=original(path,value)
            if Path(path).name.endswith('-committed.json'):
                unknown=self.control/'operations/unknown-late.json';unknown.write_text('{}');unknown.chmod(0o600)
            return result
        with patch.object(R,'_write_exclusive',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertTrue(os.path.lexists(R.pending(self.config)));self.assertTrue((self.control/'operations/unknown-late.json').exists())

    def test_foreign_pending_replacement_in_last_leaf_is_preserved(self):
        ready=self.ready();original=A._stamp;foreign=[]
        def changed(path):
            result=original(path)
            if Path(path).name.endswith('-committed.json') and getattr(self.gate._local,'depth',0)==0 and not foreign:
                pending=R.pending(self.config);temp=self.root/'foreign-pending';temp.write_text('{}');temp.chmod(0o600)
                os.replace(temp,pending);foreign.append(original(pending))
            return result
        with patch.object(A,'_stamp',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(original(R.pending(self.config)),foreign[0])

    def test_finalizer_owner_drift_and_foreign_pending_are_never_cleared(self):
        ready=self.ready();original=self.gate.admission
        @contextmanager
        def changed(*args,**kwargs):
            with original(*args,**kwargs):yield
            if os.path.lexists(R.pending(self.config)):
                self.employee['desiredRunning']=False;self.company()
        with patch.object(self.gate,'admission',changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertTrue(os.path.lexists(R.pending(self.config)))
        self.assertFalse(json.loads(Path(self.config['companyFile']).read_bytes())['employees'][0]['desiredRunning'])

    def test_profile_finalizer_drift_keeps_pending_and_original_history(self):
        ready=self.ready();original=self.gate.admission;path=self.control/'profiles/profiles.json'
        @contextmanager
        def changed(*args,**kwargs):
            with original(*args,**kwargs):yield
            if os.path.lexists(R.pending(self.config)):path.write_bytes(path.read_bytes()+b' ')
        with patch.object(self.gate,'admission',changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertTrue(os.path.lexists(R.pending(self.config)));self.assertTrue(path.read_bytes().endswith(b' '))

    def test_final_kernel_reader_cannot_clear_pending_after_selected_native_revives(self):
        ready=self.ready();original=A._kernel;changed=[]
        def kernel():
            value=original()
            if getattr(self.gate._local,'depth',0)==0 and os.path.lexists(R.pending(self.config)) and not changed:
                self.native.rows[0]['State'].update(Running=True,Pid=123,Status='running');changed.append(True)
            return value
        with patch.object(A,'_kernel',side_effect=kernel),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertEqual(changed,[True]);self.assertTrue(self.native.rows[0]['State']['Running'])
        self.assertTrue(os.path.lexists(R.pending(self.config)))
        with self.assertRaises(ValueError):R.ReservationGate(self.broker)

    def test_late_complete_fsync_configuration_tamper_retains_pending(self):
        ready=self.ready();original=R._write_exclusive
        def changed(path,value):
            result=original(path,value)
            if Path(path).name.endswith('-committed.json'):
                config=json.loads(self.path.read_bytes());config['memoryMiB']+=1;self.path.write_text(json.dumps(config))
            return result
        with patch.object(R,'_write_exclusive',side_effect=changed),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            A.apply(self.broker,F.EID,ready['planDigest'])
        self.assertTrue(os.path.lexists(R.pending(self.config)))

    def test_closed_commands_do_not_spend_GPU_approvals_or_forward_OfficeAPI(self):
        from reverie import worker_gpu_access as G
        with patch.object(G,'request',side_effect=AssertionError('GPU_APPROVAL_FORBIDDEN')):
            self.assertEqual(A.request(self.broker,self.command())['state'],'pending')
        for extra in ({'owner':True},{'deviceUuid':'all'},{'command':'anything'},{'enabled':1}):
            with self.subTest(extra=extra),self.assertRaises(ValueError):A.dispatch(self.broker,self.command()|extra)
        with self.assertRaises(ValueError):A.decode(b'{"action":1,"action":2}')
        # The existing OfficeAPI class contains no new C or perf forwarding seam.
        source=Path(__file__).resolve().parents[1]/'python/reverie/worker.py'
        node=next(n for n in ast.parse(source.read_bytes()).body if isinstance(n,ast.ClassDef) and n.name=='OfficeAPI')
        # Approved OfficeAPI body-drain snapshot, fixed so Nix needs no .git.
        # The enabled ops path and absence of C/perf forwarding stay exact.
        self.assertEqual(hashlib.sha256(ast.dump(node).encode()).hexdigest(),'440ac6a9261e670d863f9a87bcaf2223d0d66f43df25ed3e4a234fd951920b6e')

    def test_actual_host_C_socket_and_foreign_namespace_rejection(self):
        self.broker.handlers={};self.broker.stopping=threading.Event();self.broker.cleanup_uncertain=set()
        def exchange(command):
            self.broker.connections=threading.BoundedSemaphore(1);self.broker.connections.acquire()
            host,client=socket.socketpair();client.settimeout(10)
            thread=threading.Thread(target=Broker.handle,args=(self.broker,host));thread.start()
            send_frame(client,b'C',json.dumps(command).encode())
            try:return receive_frame(client)
            finally:client.close();thread.join(10);self.assertFalse(thread.is_alive())
        command={'action':'perf-policy-status','employeeId':F.EID}
        kind,raw=exchange(command);self.assertEqual(kind,b'J');self.assertEqual(json.loads(raw)['employeeId'],F.EID)
        with patch('reverie.worker_resume_peer.host_peer',side_effect=ValueError('foreign namespace')):
            kind,raw=exchange(command);self.assertEqual(kind,b'E');self.assertIn(b'foreign namespace',raw)
        self.assertFalse(os.path.lexists(self.control/'operations'/A.NAME))
