"""Fixed profile/projection controls; no perf syscall or engine effects."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reverie import worker_perf as P, worker_docker as D
from reverie.worker import create_args, validate_config
from reverie.worker_resources import effective_config, policy_digest, validate_resource_reload
from reverie.worker_resource_reservations import domain_digest
from tests import test_worker_gpu as G

ROOT = Path(__file__).resolve().parents[1]


class WorkerPerfTests(unittest.TestCase):
    def setUp(self):
        fixture = G.EmployeeGPUTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        self.fixture = fixture; self.root = fixture.root; self.config = fixture.config
        self.base_path = '/nix/store/fixed-base-profile'
        self.profile_path = '/nix/store/fixed-task-profile'
        self.base = {'defaultAction': 'SCMP_ACT_ERRNO', 'archMap': [], 'syscalls': [
            {'names': ['read'], 'action': 'SCMP_ACT_ALLOW'},
            {'names': ['perf_event_open'], 'action': 'SCMP_ACT_ALLOW', 'includes': {'caps': ['CAP_PERFMON']}}]}
        self.base_bytes = (json.dumps(self.base)+'\n').encode()
        self.selected_bytes = (json.dumps(P.derivative(self.base))+'\n').encode()
        self.fixed = {'version': 1, 'purpose': 'worker-task-perf-profile-v1', 'system': 'x86_64-linux',
                      'baseProfile': self.base_path, 'baseSHA256': hashlib.sha256(self.base_bytes).hexdigest(),
                      'profile': self.profile_path, 'profileSHA256': hashlib.sha256(self.selected_bytes).hexdigest()}
        self.config['rootlessDocker'] = {'enabled': True, 'seccompProfile': self.base_path,
                                        'seccompSha256': self.fixed['baseSHA256']}
        self.config['cgroupParent'] = 'reverie-workers.slice'
        self.selected = dict(self.config, employeePerfPolicies={fixture.employee: P.POLICY})
        self.files = {self.base_path: self.root/'base.json', self.profile_path: self.root/'selected.json'}
        self.files[self.base_path].write_bytes(self.base_bytes); self.files[self.profile_path].write_bytes(self.selected_bytes)
        for p in self.files.values(): p.chmod(0o444)
        files = self.files
        class Location:
            def __init__(self, value): self.value = str(value)
            def __str__(self): return self.value
            def is_absolute(self): return self.value.startswith('/')
            def resolve(self, strict=False): return self
            def __eq__(self, other): return str(self)==str(other)
            def stat(self): return files[self.value].stat()
            def read_bytes(self): return files[self.value].read_bytes()
        self.locations = Location

    def port(self):
        return patch.object(P, 'artifact', return_value=copy.deepcopy(self.fixed))

    def test_derivative_preserves_every_existing_rule_and_adds_only_task_cpu_filter(self):
        before = copy.deepcopy(self.base); after = P.derivative(before)
        self.assertEqual(before, self.base)
        self.assertEqual(after['syscalls'][:-1], before['syscalls'])
        self.assertEqual({k:v for k,v in after.items() if k!='syscalls'}, {k:v for k,v in before.items() if k!='syscalls'})
        self.assertEqual(after['syscalls'][-1], P.RULE)
        with self.assertRaises(ValueError): P.derivative(after)
        with self.assertRaises(ValueError): P.derivative(dict(before, defaultAction='SCMP_ACT_ALLOW'))

    def test_signed_cpu_native_compat_and_upper_bits_match_kernel_int_minus_one_only(self):
        arg = P.RULE['args'][0]; self.assertEqual(arg['index'], 2)
        self.assertEqual(arg['op'], 'SCMP_CMP_MASKED_EQ')
        for value in (0xffffffff, 0xffffffffffffffff, 0x12345678ffffffff):
            self.assertEqual(value & arg['value'], arg['valueTwo'])
            self.assertEqual(value & 0xffffffff, 0xffffffff)
        for value in (0, 1, 0x7fffffff, 0xfffffffe, 0x100000000, 0xffffffff00000001):
            self.assertNotEqual(value & arg['value'], arg['valueTwo'])

    def test_default_empty_and_other_employee_args_and_labels_are_exact(self):
        f = self.fixture
        with patch.object(D, 'Path', self.locations), self.port():
            before = create_args(self.config, f.other, self.root/'other-home')
            digest = policy_digest(self.config, f.other)
            self.assertEqual(create_args(self.selected, f.other, self.root/'other-home'), before)
            self.assertEqual(policy_digest(self.selected, f.other), digest)
            self.assertEqual(effective_config(dict(self.config, employeePerfPolicies={}), f.session), self.config)
            self.assertEqual(P.project({}, f.session), {})

    def test_selected_only_fixed_profile_changes_no_capabilities_or_other_arguments(self):
        f = self.fixture
        with patch.object(D, 'Path', self.locations), self.port(), patch.object(P, '_read', return_value=self.selected_bytes):
            _, _, before = create_args(self.config, f.session, self.root/'home')
            _, _, after = create_args(self.selected, f.session, self.root/'home')
            replaced = [x.replace('seccomp='+self.profile_path, 'seccomp='+self.base_path) for x in after]
            # The launch-policy label must change; all other create arguments are identical.
            pairs = lambda args: [args[i+1] for i,v in enumerate(args[:-1]) if v=='--label']
            labels_before = pairs(before); labels_after = pairs(replaced)
            changed = [(a,b) for a,b in zip(labels_before,labels_after) if a!=b]
            self.assertEqual({a.split('=')[0] for a,b in changed},{'reverie.worker-config','reverie.worker-policy'})
            label = lambda x:x.startswith(('reverie.worker-config=','reverie.worker-policy='))
            self.assertEqual([x for x in before if not label(x)], [x for x in replaced if not label(x)])
            self.assertEqual([after[i+1] for i,v in enumerate(after[:-1]) if v=='--cap-add'], ['SETUID','SETGID'])
            self.assertNotIn('CAP_PERFMON',after); self.assertNotIn('SYS_ADMIN',after); self.assertIn('--read-only',after)

    def test_closed_map_and_canonical_schema_refuse_flags_sid_names_and_internal_marker(self):
        for value in ([],None,True,{'employee':P.POLICY},{self.fixture.employee:True},{self.fixture.employee:'unconfined'}):
            with self.subTest(value=value), self.assertRaises(ValueError): P.validate(dict(self.config, employeePerfPolicies=value))
        with self.assertRaises(ValueError): P.validate({'employeePerfPolicies':{self.fixture.employee:P.POLICY}})
        with self.assertRaises(ValueError): validate_config(dict(self.config, **{P.MARKER:P.POLICY}))
        with patch.object(D,'Path',self.locations): self.assertEqual(validate_config(self.selected),self.selected)

    def test_retired_sid_missing_generation_and_binding_drift_never_project(self):
        f = self.fixture
        with self.port():
            self.assertIn(P.MARKER, P.project(self.selected,f.session))
            f.company['employees'][0]['sessionId']=f.next_session; f.company['employees'][0]['sessionGeneration']=2; f.save()
            journal=Path(self.config['companyFile']).with_name('plan-moves.json')
            journal.write_text(json.dumps([{'employeeId':f.employee,'owner':'fixture-owner','oldSession':f.session,'newSession':f.next_session,'phase':'completed'}]));journal.chmod(0o600)
            self.assertNotIn(P.MARKER,P.project(self.selected,f.session))
            self.assertIn(P.MARKER,P.project(self.selected,f.next_session))
            f.company['employees'][0].pop('sessionGeneration'); f.save()
            with self.assertRaises(ValueError): P.project(self.selected,f.next_session)

    def test_off_vacation_gate_is_independent_of_syscall_permission(self):
        from reverie.worker_storage import storage_paths, storage_start_allowed
        f = self.fixture
        for field in ('desiredRunning','onVacation'):
            f.company['employees'][0].update(desiredRunning=True,onVacation=False)
            f.company['employees'][0][field]=field=='onVacation'; f.save()
            with self.port(): self.assertIn(P.MARKER,P.project(self.selected,f.session))
            self.assertFalse(storage_start_allowed(self.selected,storage_paths(self.selected,f.session)))

    def test_owner_or_generation_change_during_artifact_read_refuses_projection(self):
        f = self.fixture
        for change in ({'owner':'other-owner'},{'sessionGeneration':2}):
            f.company['employees'][0].update(owner='fixture-owner',sessionGeneration=1);f.save()
            def changed():
                f.company['employees'][0].update(change);f.save()
                return self.fixed
            with self.subTest(change=change),patch.object(P,'artifact',side_effect=changed),self.assertRaises(ValueError):
                P.project(self.selected,f.session)

    def test_fixed_artifact_default_deny_arch_hash_and_full_derivative_validation(self):
        original = P.__file__; manifest = Path(original).with_name('worker-perf-profile.json')
        def data(path):
            if str(path)==str(manifest): return json.dumps(self.fixed).encode()
            return self.base_bytes if str(path)==self.base_path else self.selected_bytes
        with patch.object(P,'_read',side_effect=data),patch.object(P.platform,'system',return_value='Linux'),patch.object(P.platform,'machine',return_value='x86_64'):
            self.assertEqual(P.artifact(),self.fixed)
            self.fixed['system']='aarch64-linux'
            with self.assertRaises(ValueError): P.artifact()
            with patch.object(P.platform,'machine',return_value='aarch64'): self.assertEqual(P.artifact(),self.fixed)
            with patch.object(P.platform,'machine',return_value='ppc64le'),self.assertRaises(ValueError):P.artifact()
            self.fixed['system']='x86_64-linux';self.fixed['profileSHA256']='0'*64
            with self.assertRaises(ValueError):P.artifact()
        with self.assertRaises(ValueError): P._json(b'{"version":1,"version":1}')
        with self.assertRaises(ValueError): P._read(self.root/'selected.json')

    def test_forged_marker_profile_or_extra_perf_rule_never_relaxes_rootless_guards(self):
        chosen = dict(self.config, rootlessDocker=dict(self.config['rootlessDocker'],seccompProfile=self.profile_path,seccompSha256=self.fixed['profileSHA256']))
        with patch.object(D,'Path',self.locations):
            with self.assertRaises(ValueError):D.enabled(chosen)
            with self.port(), patch.object(P,'_read',return_value=self.selected_bytes):
                self.assertTrue(D.enabled(dict(chosen,**{P.MARKER:P.POLICY})))
                with self.assertRaises(ValueError):D.enabled(dict(self.config,**{P.MARKER:P.POLICY}))
                self.files[self.profile_path].chmod(0o600)
                altered=P.derivative(self.base);altered['syscalls'].append({'names':['bpf'],'action':'SCMP_ACT_ALLOW'})
                raw=json.dumps(altered).encode();self.files[self.profile_path].write_bytes(raw);self.files[self.profile_path].chmod(0o444)
                forged=dict(chosen,rootlessDocker=dict(chosen['rootlessDocker'],seccompSha256=hashlib.sha256(raw).hexdigest()),**{P.MARKER:P.POLICY})
                with self.assertRaises(ValueError):D.enabled(forged)

    def test_new_authority_changes_R_domain_and_resource_reload_cannot_adopt_it(self):
        self.assertNotEqual(domain_digest(self.selected),domain_digest(self.config))
        with self.assertRaises(ValueError):validate_resource_reload(self.config,self.selected)
        self.assertNotEqual(policy_digest(self.config,self.fixture.session), self._selected_digest())

    def _selected_digest(self):
        with self.port():return policy_digest(self.selected,self.fixture.session)

    def test_flat_legacy_two_file_bundle_absent_empty_stays_usable(self):
        # This is a compatibility boundary: no perf module is needed until opt-in.
        with tempfile.TemporaryDirectory() as name:
            target=Path(name)
            for leaf in ('worker_resources.py','worker_storage.py'):
                (target/leaf).write_bytes((ROOT/'python/reverie'/leaf).read_bytes())
            spec=importlib.util.spec_from_file_location('flat_perf_default',target/'worker_resources.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            self.assertEqual(module.resource_config(self.config,self.fixture.session),self.config)
            self.assertEqual(module.resource_config(dict(self.config,employeePerfPolicies={}),self.fixture.session),self.config)
            with self.assertRaises((FileNotFoundError,ImportError)):module.resource_config(self.selected,self.fixture.session)
