"""Actual WebsiteStage/owned checkpoint+OFD+Node qualifier; controlled H/engine ports.

No native installation, Docker operation, provider or website is exercised.
The existing stage fixture is a module alias, not imported TestCases duplicated
by unittest discovery.
"""
from copy import deepcopy
import fcntl
import hashlib
import json
import io
import contextlib
import uuid
import os
from pathlib import Path
import shutil
import http.server
import socketserver
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests import test_website_update as W
from reverie import owner_terminal_lifecycle as L
from reverie import owner_terminal_website as H


class TerminalWebsiteStageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = W.WebsiteStageTests(methodName='runTest')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.events = []; self.phase_failure = None; self.after_created = lambda row: None
        self.root = f.root
        control = self.root / 'h-control'; ledger = self.root / 'h-ledger'; boot = self.root / 'h-bootstrap'
        for path in (control, ledger, boot):path.mkdir(mode=0o700)
        initial = L.InitialInstallation.__new__(L.InitialInstallation)
        initial.path = control / 'installation.json'
        self.company = f.console / 'company.json'
        self.employee = {'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                         'sessionId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'sessionGeneration': 2,
                         'owner': 'owner-fixture', 'desiredRunning': True, 'onVacation': False}
        self.company.write_bytes(H.encoded({'employees': [self.employee]}))
        config = self.root / 'worker.json'
        config.write_bytes(H.encoded({'uid': os.getuid(), 'gid': os.getgid(), 'companyFile': str(self.company), 'serverContainer': 'reverie'}));config.chmod(0o600)
        initial.value = {'workerConfig': str(config)}
        initial.path.write_bytes(H.encoded(initial.value));initial.path.chmod(0o600)
        initial.identity = L.private_document(initial.path)[1]
        initial.roots = {'controlBase': control, 'ledgerBase': ledger, 'bootstrapRoot': boot}
        initial.root_ids = {name: L._directory_identity(path) for name, path in initial.roots.items()}
        initial.deployment_path = f.deployment
        initial.lock_path = f.deployment.parent / 'runtime/update-state/update.lock'
        def guard():
            initial.worker_selection = L.private_bytes(config)
            return json.loads(initial.worker_selection[0])
        initial.guard = guard
        runtime = L.RuntimeManifest.__new__(L.RuntimeManifest)
        runtime.value = {'profile': 'terminal', 'imageProvenance': {'path': '/nix/store/controlled/provenance', 'sha256': 'd' * 64}}
        runtime.pair = {'path': '/nix/store/controlled/runtime', 'sha256': 'e' * 64}
        initial.runtime = runtime
        initial.program = {'nodeInvocation': shutil.which('node')}
        self.initial = initial
        target = f.engine.images[W.NEW_IMAGE]
        target['Config']['Cmd'] = ['/nix/store/controlled-h-only/libexec/reverie', 'web', '--host', '0.0.0.0', '--port', '3000']
        target['Created'] = '2026-01-01T00:00:00Z'
        self.provenance = {'archiveConfigSHA256': W.NEW_IMAGE[7:],
                           'imageSpec': {k: deepcopy(target[k]) for k in ('Config', 'RootFS', 'Architecture', 'Os', 'Created')}}
        class Engine:
            def get(inner, route):
                if route in ('/containers/' + W.OLD + '/json', '/containers/' + W.NEW + '/json'):
                    return deepcopy(f.engine.containers[route[12:-5]])
                self.assertEqual(route, '/images/' + W.NEW_IMAGE + '/json')
                return deepcopy(f.engine.images[W.NEW_IMAGE])
        initial.engine = Engine()
        old = f.engine.containers[W.OLD]
        old['Config'].update(Tty=False, OpenStdin=False, StdinOnce=False, ExposedPorts={'3000/tcp': {}})
        old['HostConfig'].update(Memory=8 * 1024**3, MemorySwap=8 * 1024**3, PidsLimit=512,
                                 Privileged=False, CapAdd=None, CapDrop=None, Devices=[],
                                 Init=True, PidMode='', IpcMode='private', MaskedPaths=[], ReadonlyPaths=[],
                                 LogConfig={'Type': 'json-file', 'Config': {}})
        self.links = ledger / 'links.json'
        self.write_links([])
        deployment = json.loads(f.deployment.read_bytes())
        deployment.update(websiteRuntime='terminal', protectedWebsite=True, ownerTerminalConfig=str(initial.path))
        f.deployment.write_bytes(H.encoded(deployment))
        # Kernel/engine-only H ports are controlled. Each executes the real
        # inherited flock validator and checks actual owned spec bytes.
        def phase(name):
            def run(fd, *args):
                with initial.maintenance(fd):
                    self.events.append((name, os.fstat(fd).st_ino))
                    if name in ('preflight-created', 'prepare-created'):
                        cid, path, sha = args
                        self.assertEqual(cid, W.NEW)
                        self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), sha)
                        accepted = json.loads(Path(path).read_bytes())
                        self.assertEqual(accepted['Image'], W.NEW_IMAGE)
                        self.assertEqual(accepted['Hostname'], W.NEW[:12])
                    if self.phase_failure == name:raise OSError('controlled H phase finalizer failure')
                    if name == 'await-ready':self.assertTrue(f.engine.containers[W.NEW]['State']['Running'])
                return {'state': name, 'workerEffects': False}
            return run
        initial.settle = phase('settle');initial.preflight_created = phase('preflight-created')
        initial.prepare_created = phase('prepare-created');initial.start_listener = phase('start-listener')
        initial.await_ready = phase('await-ready')
        original = f.engine.__call__
        def engine(method, path, data=None):
            result = original(method, path, data)
            if method == 'POST':
                if path.startswith('/containers/' + W.OLD + '/stop'):
                    f.engine.containers[W.OLD]['State']['Pid'] = 0
                if path == '/containers/' + W.NEW + '/start':
                    f.engine.containers[W.NEW]['State']['Pid'] = 420
                self.events.append((path, None))
                if path.startswith('/containers/create?'):
                    row = f.engine.containers[W.NEW]
                    row['Config']['Hostname'] = W.NEW[:12]
                    row['Mounts'] = [{'Type': m['Type'], 'Source': m['Source'], 'Destination': m['Target'],
                                      'RW': not m.get('ReadOnly', False),
                                      'Propagation': m.get('BindOptions', {}).get('Propagation', 'rprivate')}
                                     for m in data['HostConfig']['Mounts']]
                    for destination in ('/tmp', '/run'):
                        row['Mounts'].append({'Type': 'tmpfs', 'Source': '', 'Destination': destination, 'RW': True, 'Propagation': ''})
                    self.after_created(row)
            return result
        self.engine = engine
        self.rebuild()

    def write_links(self, links):
        self.links.write_bytes(H.encoded({'version': 1, 'purpose': H.LINK_PURPOSE, 'links': links}))
        self.links.chmod(0o600)

    def rebuild(self):
        if hasattr(self, 'profile'):self.profile.close()
        with patch('reverie.resource_actor_install.artifact', return_value=deepcopy(self.provenance)):
            self.profile = H.TerminalWebsiteProfile(self.initial, self.links)
        self.addCleanup(self.profile.close)
        f = self.fixture
        self.stage = W.website.WebsiteStage(self.engine, f.state, f.deployment, f.policy,
                                           guard=f.guard, ready=lambda cid, spec: self.ready(cid), terminal=self.profile)

    def ready(self, cid):
        self.events.append(('http-ready', None));self.assertEqual(cid, W.NEW);return True

    def approve(self):
        f = self.fixture
        draft = self.stage.plan('reverie', W.NEW_IMAGE, W.OLD, W.OLD_IMAGE)
        review = json.loads(f.policy.read_bytes());review['approvedSpecDigest'] = draft['specPin']
        f.policy.write_bytes(H.encoded(review))
        return self.stage.plan('reverie', W.NEW_IMAGE, W.OLD, W.OLD_IMAGE)

    def select_service_auth(self, *, nested=False):
        f = self.fixture
        self.auth = '/run/private-services/service-auth.json'
        parent = self.root
        if nested:
            parent = self.root / 'auth-parent'; parent.mkdir(mode=0o700)
        self.auth_root = parent / 'auth'; self.auth_root.mkdir(mode=0o700)
        (self.auth_root / 'service-auth.json').write_text('{"version":1,"principals":[]}')
        (self.auth_root / 'service-auth.json').chmod(0o600)
        self.auth_tail = ['--service-auth-config', self.auth]
        f.engine.images[W.OLD_IMAGE]['Config']['Cmd'] = ['reverie', 'web', '--host', '0.0.0.0', '--port', '3000']
        f.engine.containers[W.OLD]['Config']['Cmd'] = ['reverie', 'web', '--host', '0.0.0.0', '--port', '3000', *self.auth_tail]
        self.auth_mount = {'Type': 'bind', 'Source': str(self.auth_root),
                           'Destination': '/run/private-services', 'RW': False, 'Propagation': 'rprivate'}
        f.engine.containers[W.OLD]['Mounts'].append(deepcopy(self.auth_mount))
        target = f.engine.images[W.NEW_IMAGE]['Config']
        target['Cmd'] += self.auth_tail
        self.provenance['imageSpec']['Config'] = deepcopy(target)
        node = shutil.which('node')
        self.initial.program = {'nodeInvocation': node,
            'nodeWrapper': '/nix/store/console/lib/reverie/scripts/owner-terminal-start.mjs',
            'applicationEntry': '/nix/store/console/lib/reverie/dist/index.js',
            'argvPrefix': [node,
                '/nix/store/console/lib/reverie/scripts/owner-terminal-start.mjs', *target['Cmd'][1:]],
            'startupPython': {'invocation': '/nix/store/python/bin/python',
                'entry': target['Cmd'][0],
                'argvPrefix': ['/nix/store/python/bin/python', '-I', *target['Cmd']]}}
        (self.initial.roots['ledgerBase'] / 'website-selection.json').write_bytes(
            H.encoded({'oldId': W.OLD}))
        (self.initial.roots['ledgerBase'] / 'website-selection.json').chmod(0o600)
        review = json.loads(f.policy.read_bytes())
        review['backupScopes'].append({'containerPath': self.auth, 'exclude': []})
        f.policy.write_bytes(H.encoded(review))
        self.auth_guest_mount = os.open(self.auth_root, os.O_PATH | os.O_DIRECTORY)
        self.auth_guest_leaf = os.open(self.auth_root / 'service-auth.json', os.O_PATH | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.auth_guest_mount); self.addCleanup(os.close, self.auth_guest_leaf)
        self.auth_new_guest = [self.auth_guest_mount, self.auth_guest_leaf]
        self.auth_guest_roots = {}
        self.auth_births = {410: 1234, 420: 5678}
        self.auth_namespaces = {pid: (pid, pid + 1, pid + 2) for pid in (410, 420)}
        for pid in (410, 420):
            path = self.root / ('guest-root-' + str(pid));path.mkdir()
            self.auth_guest_roots[pid] = path
        f.engine.containers[W.OLD]['State']['Pid'] = 410
        def process(pid):
            cid = W.OLD if pid == 410 else W.NEW
            if not f.engine.containers.get(cid, {}).get('State', {}).get('Running'):
                raise FileNotFoundError('owned fixture process absent')
            return {'pid': pid, 'start': self.auth_births[pid], 'parent': 1, 'argv': 'a' * 64,
                    'exe': (1, 2), 'namespaces': self.auth_namespaces[pid]}
        def root(pid):return os.open(self.auth_guest_roots[pid], os.O_PATH | os.O_DIRECTORY)
        def guest(fd, path, *, path_link=False):
            self.assertTrue(path_link)
            info = os.fstat(fd)
            old_root = self.auth_guest_roots[410].stat()
            old = (info.st_dev, info.st_ino) == (old_root.st_dev, old_root.st_ino)
            selected = next(m for m in f.engine.containers[W.OLD]['Mounts']
                            if m['Destination'] in (self.auth_mount['Destination'], self.auth))
            pair = [self.auth_guest_mount, self.auth_guest_leaf] if old else self.auth_new_guest
            if path == self.auth:return os.dup(pair[1])
            self.assertEqual(path, selected['Destination']);return os.dup(pair[0])
        self.enterContext(patch.object(H, '_auth_process', side_effect=process))
        self.enterContext(patch.object(H, '_auth_birth', side_effect=lambda pid: process(pid)['start']))
        self.enterContext(patch.object(H, '_auth_root', side_effect=root))
        self.enterContext(patch.object(H, 'open_in_root', side_effect=guest))
        self.rebuild()

    def rotate_auth_inspects(self, mutation=None):
        original=self.initial.engine.get;calls=[0]
        def get(route):
            value=original(route)
            if route=='/containers/'+W.OLD+'/json':
                calls[0]+=1
                value['Mounts']=value['Mounts'][calls[0]%len(value['Mounts']):]+value['Mounts'][:calls[0]%len(value['Mounts'])]
                other=min((m for m in value['Mounts'] if m['Destination']!=self.auth_mount['Destination']),key=lambda m:m['Destination'])
                other['Future']={'ordered':[1,2]}
                if mutation and calls[0]%2==0:
                    if mutation=='inner':other['Future']['ordered'].reverse()
                    elif mutation=='duplicate':value['Mounts'].append(deepcopy(other))
                    else:other['Future']['extra']='changed'
            return value
        self.initial.engine.get=get
        return calls

    def test_auth_held_descriptors_survive_outer_mount_permutations(self):
        self.select_service_auth();calls=self.rotate_auth_inspects();self.rebuild()
        held=list(self.profile.auth_fds)
        self.profile.input_binding()
        self.assertGreaterEqual(calls[0],4)
        self.assertTrue(all(os.fstat(fd)for fd in held))
        self.profile.close()
        for fd in held:
            with self.assertRaises(OSError):os.fstat(fd)
        self.assertFalse(self.fixture.engine.mutations())

    def test_auth_full_unknown_fields_inner_arrays_and_duplicates_still_refuse(self):
        self.select_service_auth();original=self.initial.engine.get
        for mutation in ('unknown','inner','duplicate'):
            self.initial.engine.get=original;self.rotate_auth_inspects(mutation)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.rebuild()
            self.assertFalse(self.fixture.engine.mutations())
        self.initial.engine.get=original

    def test_link_description_already_canonicalizes_outer_mount_order(self):
        self.select_service_auth();self.rotate_auth_inspects()
        result=H.describe_link_facts(self.initial,W.website._link_codec(),W.OLD)
        self.assertEqual(result['purpose'],H.LINK_PURPOSE)
        self.assertFalse(self.fixture.engine.mutations())

    def test_selected_service_auth_survives_real_stage_and_readonly_mount(self):
        self.select_service_auth()
        plan = self.approve()
        self.assertEqual(plan['spec']['Cmd'], self.fixture.engine.images[W.NEW_IMAGE]['Config']['Cmd'])
        self.assertEqual(plan['spec']['Cmd'][-2:], self.auth_tail)
        selected = [m for m in plan['spec']['HostConfig']['Mounts']
                    if m['Target'] == self.auth_mount['Destination']]
        self.assertEqual(len(selected), 1); self.assertTrue(selected[0]['ReadOnly'])
        self.assertEqual(selected[0]['Source'], str(self.auth_root))
        held = list(self.profile.auth_fds);listener = self.initial.start_listener
        def retained_after_stop(fd):
            self.assertFalse(self.fixture.engine.containers[W.OLD]['State']['Running'])
            for proof_fd in held:os.fstat(proof_fd)
            return listener(fd)
        self.initial.start_listener = retained_after_stop
        result = self.stage.apply(plan, W.website.digest(plan))
        self.assertEqual(result['state'], 'adopted')
        self.fixture.assert_no_old_restore()
        all_proofs = list(self.profile.auth_fds);self.profile.close()
        self.assertGreaterEqual(len(all_proofs), 6)
        for proof_fd in all_proofs:
            with self.assertRaises(OSError):os.fstat(proof_fd)

    def test_service_auth_refuses_wrong_or_extra_old_commands_before_effects(self):
        self.select_service_auth(); old = self.fixture.engine.containers[W.OLD]
        original = deepcopy(old['Config']['Cmd'])
        for command in (original[:-2], [*original, '--unknown'], [*original, *self.auth_tail],
                        [*original[:-1], '/run/private-services/other.json'],
                        ['/private/wrapper', *original[1:]]):
            with self.subTest(command=command):
                old['Config']['Cmd'] = command
                with self.assertRaisesRegex(ValueError, 'EXPLICIT_OLD_COMMAND'):self.approve()
                self.assertFalse(self.fixture.engine.mutations())
        old['Config']['Cmd'] = original

    def test_service_auth_refuses_missing_writable_or_masked_mount(self):
        self.select_service_auth(); old = self.fixture.engine.containers[W.OLD]
        original = deepcopy(old['Mounts'])
        variants = ([m for m in original if m['Destination'] != self.auth_mount['Destination']],
                    [{**m, 'RW': True} if m['Destination'] == self.auth_mount['Destination'] else m for m in original],
                    [*original, {**self.auth_mount, 'Destination': self.auth}])
        for mounts in variants:
            with self.subTest(mounts=mounts):
                old['Mounts'] = mounts
                with self.assertRaisesRegex(ValueError, 'SERVICE_AUTH'):self.approve()
                self.assertFalse(self.fixture.engine.mutations())
        old['Mounts'] = original

    def test_service_auth_changed_leaf_or_mount_source_invalidates_prepared_plan(self):
        self.select_service_auth(); plan = self.approve()
        leaf = self.auth_root / 'service-auth.json'
        staged = self.auth_root / 'replacement'; staged.write_text('{}'); staged.chmod(0o600)
        staged.replace(leaf)
        with self.assertRaisesRegex(ValueError, 'AUTH_.*CHANGED'):
            self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.mutations())

    def test_service_auth_unselected_and_manifest_disagreement_refuse(self):
        self.select_service_auth()
        self.initial.program['argvPrefix'][-1] = '/different/auth.json'
        with self.assertRaisesRegex(ValueError, 'SERVICE_AUTH'):self.rebuild()
        self.initial.program['argvPrefix'][-1] = self.auth
        target = self.fixture.engine.images[W.NEW_IMAGE]['Config']
        target['Cmd'] = target['Cmd'][:-2]
        self.provenance['imageSpec']['Config'] = deepcopy(target);self.rebuild()
        with self.assertRaisesRegex(ValueError, 'EXPLICIT_OLD_COMMAND'):self.approve()
        self.assertFalse(self.fixture.engine.mutations())

    def test_service_auth_alias_or_rebound_mount_source_refuses(self):
        self.select_service_auth(); old = self.fixture.engine.containers[W.OLD]
        selected = next(m for m in old['Mounts'] if m['Destination'] == self.auth_mount['Destination'])
        alias = self.root / 'auth-alias'; alias.symlink_to(self.auth_root, target_is_directory=True)
        selected['Source'] = str(alias)
        with self.assertRaisesRegex(ValueError, 'SERVICE_AUTH_SOURCE'):self.approve()
        other = self.root / 'other-auth'; other.mkdir(mode=0o700)
        (other / 'service-auth.json').write_text('{"version":1,"principals":[]}')
        (other / 'service-auth.json').chmod(0o600);selected['Source'] = str(other)
        with self.assertRaisesRegex(ValueError, 'AUTH_.*CHANGED'):self.approve()
        self.assertFalse(self.fixture.engine.mutations())

    def test_old_init_birth_namespace_or_root_drift_refuses_before_effects(self):
        for change in ('birth', 'namespace', 'root'):
            with self.subTest(change=change):
                case = TerminalWebsiteStageTests(methodName='runTest');case.setUp()
                try:
                    case.select_service_auth();plan = case.approve()
                    if change == 'birth':case.auth_births[410] += 1
                    elif change == 'namespace':case.auth_namespaces[410] = (91, 92, 93)
                    else:
                        other = case.root / 'changed-init-root';other.mkdir()
                        case.auth_guest_roots[410] = other
                    with self.assertRaisesRegex(ValueError, 'AUTH_INIT_CHANGED'):
                        case.stage.apply(plan, W.website.digest(plan))
                    self.assertFalse(case.fixture.engine.mutations())
                finally:case.doCleanups()

    def test_stopped_engine_state_does_not_replace_actual_old_birth_absence(self):
        self.select_service_auth();old = self.fixture.engine.containers[W.OLD]
        old['State'].update(Running=False, Pid=0)
        with patch.object(H, '_auth_birth', return_value=self.auth_births[410]):
            with self.assertRaisesRegex(ValueError, 'OLD_INIT_STILL_LIVE'):self.profile.input_binding()
        with patch.object(H, '_auth_birth', side_effect=PermissionError('owned unknown metadata')):
            with self.assertRaises(PermissionError):self.profile.input_binding()
        self.assertFalse(self.fixture.engine.mutations())

    def test_host_ancestor_rebind_during_guest_observation_is_bracketed(self):
        self.select_service_auth(nested=True);original = H._auth_process.side_effect;calls = 0
        def rebind(pid):
            nonlocal calls
            value = original(pid);calls += 1
            if calls == 2:
                parent = self.auth_root.parent;parent.rename(self.root / 'old-auth-parent')
                parent.mkdir(mode=0o700);self.auth_root.mkdir(mode=0o700)
                leaf = self.auth_root / 'service-auth.json'
                leaf.write_text('{"version":1,"principals":[]}');leaf.chmod(0o600)
            return value
        with patch.object(H, '_auth_process', side_effect=rebind):
            with self.assertRaisesRegex(ValueError, 'SERVICE_AUTH_CHANGED'):self.profile.input_binding()
        self.assertFalse(self.fixture.engine.mutations())

    def other_guest_auth(self):
        path = self.root / 'different-mounted-auth';path.mkdir(mode=0o700)
        leaf = path / 'service-auth.json';leaf.write_text('{"version":1,"principals":[]}');leaf.chmod(0o600)
        fds = [os.open(path, os.O_PATH | os.O_DIRECTORY), os.open(leaf, os.O_PATH | os.O_NOFOLLOW)]
        for fd in fds:self.addCleanup(os.close, fd)
        return fds

    def test_candidate_guest_rebind_at_ready_retains_unknown_without_adoption(self):
        self.select_service_auth();plan = self.approve();self.auth_new_guest = self.other_guest_auth()
        with self.assertRaisesRegex(W.website.WebsiteRefusal, 'attempt held'):
            self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.containers[W.NEW]['State']['Running'])
        self.fixture.assert_no_old_restore()
        self.assertEqual(json.loads((self.fixture.state / 'website-active.json').read_bytes())['state'], 'unconfirmed')

    def test_candidate_guest_rebind_after_http_ready_is_checked_before_adoption(self):
        self.select_service_auth();plan = self.approve();other = self.other_guest_auth();original = self.ready
        def ready(cid):
            self.auth_new_guest = other
            return original(cid)
        self.ready = ready
        with self.assertRaisesRegex(W.website.WebsiteRefusal, 'attempt held'):
            self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.containers[W.NEW]['State']['Running'])
        self.fixture.assert_no_old_restore()

    def test_proof_descriptor_close_failure_attempts_all_and_forbids_reuse(self):
        self.select_service_auth();fds = list(self.profile.auth_fds);closed = [];actual = os.close
        def fail_once(fd):
            actual(fd);closed.append(fd)
            if len(closed) == 1:raise OSError('owned close finalizer fixture')
        with patch.object(H.os, 'close', side_effect=fail_once):
            with self.assertRaisesRegex(ValueError, 'CLOSE_UNCONFIRMED'):self.profile.close()
        self.assertEqual(set(closed), set(fds));self.assertEqual(self.profile.auth_fds, [])
        for fd in fds:
            with self.assertRaises(OSError):os.fstat(fd)
        with self.assertRaisesRegex(ValueError, 'PROOF_CLOSED'):self.profile.input_binding()

    def test_main_closes_proof_before_success_and_reports_close_failure_as_unconfirmed(self):
        self.select_service_auth();initial = self.initial
        selection = initial.roots['ledgerBase'] / 'website-selection.json'
        selection.write_bytes(H.encoded({'version': 1, 'purpose': 'owner-terminal-website-selection-v1',
            'oldId': W.OLD, 'oldImage': W.OLD_IMAGE, 'newImage': W.NEW_IMAGE,
            'providerPIDs': [], 'expiresAtEpoch': time.time() + 300}))
        binding = {'unit': '/nix/store/unit/service', 'python': '/nix/store/python/bin/python',
                   'entry': '/nix/store/source/worker.py'}
        plan = {'specPin': 'sha256:' + 'a' * 64, 'finalSpecApproval': 'approved'}
        for fail in (False, True):
            events = [];stdout = io.StringIO();stderr = io.StringIO()
            def close():
                events.append('close')
                if fail:raise ValueError('H_WEBSITE_AUTH_CLOSE_UNCONFIRMED')
            profile = SimpleNamespace(close=close)
            standard = SimpleNamespace(WebsiteStage=lambda *a, **k: SimpleNamespace(plan=lambda *a: plan),
                                       digest=W.website.digest)
            native = SimpleNamespace(name='reverie', selection={'oldId':W.OLD}, _time=lambda: None, http_ready=lambda *a: True)
            with patch('reverie.website_image_provenance.immutable', side_effect=lambda path, *a: path), \
                 patch.object(Path, 'resolve', lambda path, strict=True: path), \
                 patch.object(L, 'RuntimeManifest', return_value=initial.runtime), \
                 patch.object(L, 'InitialInstallation', return_value=initial), \
                 patch.object(H, '_standard_stage', return_value=standard), \
                 patch.object(H, '_NativeControl', return_value=native), \
                 patch.object(H, 'TerminalWebsiteProfile', return_value=profile), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                rc = H.main(['--installation', str(initial.path), 'prepare', '--operation', str(uuid.uuid4())],
                            runtime_manifest={'path': '/nix/store/runtime', 'sha256': 'a' * 64}, service_binding=binding)
            self.assertTrue(events)
            if fail:
                self.assertEqual(rc, 1);self.assertEqual(stdout.getvalue(), '')
            else:
                self.assertEqual(rc, 0);self.assertEqual(events, ['close'])
                self.assertEqual(json.loads(stdout.getvalue())['state'], 'H_WEBSITE_PREPARED')

    def test_actual_stage_same_OFD_order_exact_CID_spec_and_preserved_isolated_socket(self):
        plan = self.approve(); f = self.fixture
        self.assertTrue(any(x['Target'] == '/run/reverie-workers' and x['ReadOnly'] for x in plan['spec']['HostConfig']['Mounts']))
        self.assertEqual(plan['spec']['HostConfig']['Memory'], 8 * 1024**3)
        self.assertEqual(plan['spec']['HostConfig']['PidsLimit'], 512)
        result = self.stage.apply(plan, W.website.digest(plan))
        self.assertEqual(result['state'], 'adopted')
        names = [x[0] for x in self.events]
        order = ['settle', '/containers/' + W.OLD + '/stop?t=30', 'preflight-created',
                 'prepare-created', 'start-listener', '/containers/' + W.NEW + '/start', 'await-ready', 'http-ready']
        self.assertEqual([name for name in names if name in order], order)
        self.assertEqual(len({inode for name, inode in self.events if name in order and inode is not None}), 1)
        self.assertFalse(f.engine.containers[W.OLD]['State']['Running'])
        self.assertEqual(self.employee, json.loads(self.company.read_bytes())['employees'][0])
        f.assert_no_old_restore()

    def test_generic_stage_still_refuses_libexec_Cmd(self):
        plan = self.approve()
        with self.assertRaisesRegex(W.website.WebsiteRefusal, 'launch/bootstrap'):
            W.website.backup_map(self.fixture.engine.containers[W.OLD], plan['spec'], json.loads(self.fixture.policy.read_bytes()))
        self.assertFalse(self.fixture.engine.mutations())

    def test_foreign_profile_and_source_capability_refuse_before_effects(self):
        self.initial.runtime.value['profile'] = 'resource-terminal'
        with self.assertRaisesRegex(ValueError, 'H_ONLY'):self.rebuild()
        self.initial.runtime.value['profile'] = 'terminal'
        self.rebuild()  # The preceding rejected construction closed the previous proof.
        self.fixture.engine.containers[W.OLD]['HostConfig']['CapAdd'] = ['SYS_ADMIN']
        with self.assertRaisesRegex(ValueError, 'SOURCE_AUTHORITY'):self.approve()
        self.assertFalse(self.fixture.engine.mutations())

    def test_wrong_loaded_image_or_target_Cmd_refuses_before_effects(self):
        self.fixture.engine.images[W.NEW_IMAGE]['Config']['Cmd'] = ['/bin/unqualified-wrapper', 'web']
        with self.assertRaises(Exception):self.approve()
        self.assertFalse(self.fixture.engine.mutations())

    def test_unknown_handoff_phase_retains_receipt_attempt_and_never_starts_candidate(self):
        plan = self.approve();self.phase_failure = 'start-listener'
        with self.assertRaises(W.website.WebsiteRefusal):self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(any(p == '/containers/' + W.NEW + '/start' for p, _ in self.events))
        receipt = self.fixture.receipt();self.assertEqual(receipt['state'], 'unconfirmed')
        attempt = self.fixture.state / ('website-' + plan['operationId']) / 'H-start-listener-ATTEMPT.json'
        self.assertTrue(attempt.exists())
        self.assertFalse(attempt.with_name('H-start-listener-RESULT.json').exists())
        self.fixture.assert_no_old_restore()

    def test_link_target_and_named_leaf_drift_refuse_before_effects(self):
        target = self.fixture.workspace / 'attachments';target.mkdir()
        link = self.fixture.console / 'chatroom-files';link.symlink_to('/reverie_workspace/attachments')
        st = link.lstat();ts = target.stat()
        facts = {'path': 'chatroom-files', 'device': st.st_dev, 'inode': st.st_ino,
                 'target': '/reverie_workspace/attachments', 'targetDevice': ts.st_dev, 'targetInode': ts.st_ino, 'binding': None}
        self.write_links([facts]);self.rebuild()
        review = json.loads(self.fixture.policy.read_bytes());review['backupScopes'][0]['exclude'] = ['accounts', 'chatroom-files']
        self.fixture.policy.write_bytes(H.encoded(review))
        plan = self.approve()
        link.unlink();link.symlink_to('/reverie_workspace/foreign')
        with self.assertRaisesRegex(ValueError, 'LINK_CHANGED'):self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.mutations())

    def reviewed_link(self):
        target = self.fixture.workspace / 'attachments';target.mkdir()
        link = self.fixture.console / 'chatroom-files';link.symlink_to('/reverie_workspace/attachments')
        st = link.lstat();ts = target.stat()
        facts = {'path': 'chatroom-files', 'device': st.st_dev, 'inode': st.st_ino,
                 'target': '/reverie_workspace/attachments', 'targetDevice': ts.st_dev, 'targetInode': ts.st_ino, 'binding': None}
        self.write_links([facts]);self.rebuild()
        review = json.loads(self.fixture.policy.read_bytes());review['backupScopes'][0]['exclude'] = ['accounts', 'chatroom-files']
        self.fixture.policy.write_bytes(H.encoded(review))
        return link

    def test_actual_last_company_reader_close_cannot_hide_link_replacement(self):
        link = self.reviewed_link();plan = self.approve();read = L._data_bytes;reads = []
        def changed(path, *args, **kwargs):
            result = read(path, *args, **kwargs)
            if Path(path) == self.company:
                reads.append(path)
                if len(reads) == 2:
                    link.unlink();link.symlink_to('/reverie_workspace/foreign')
            return result
        with patch.object(L, '_data_bytes', side_effect=changed), self.assertRaisesRegex(ValueError, 'LINK_CHANGED'):
            self.profile.assert_links(W.website._link_codec(), self.fixture.engine.containers[W.OLD], plan['spec'])
        self.assertEqual(len(reads), 2)
        self.assertFalse(self.fixture.engine.mutations())

    def test_same_bytes_new_link_facts_inode_cannot_rebind_prepared_plan(self):
        plan = self.approve();raw = self.links.read_bytes()
        self.links.rename(self.links.with_suffix('.preserved'))
        self.links.write_bytes(raw);self.links.chmod(0o600)
        self.rebuild()
        with self.assertRaises(W.website.WebsiteRefusal):self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.mutations())

    def test_fixed_readonly_link_producer_matches_reviewed_chat_and_current_binding(self):
        self.reviewed_link()
        sid = self.employee['sessionId']
        parent = self.fixture.console / 'custom-model-configs' / sid;parent.mkdir(parents=True)
        target = self.fixture.console / 'accounts/claude/projects';target.mkdir(parents=True)
        (parent / 'projects').symlink_to('/instances/default/accounts/claude/projects')
        facts = H.describe_link_facts(self.initial, W.website._link_codec(), W.OLD)
        self.assertEqual([row['path'] for row in facts['links']], ['chatroom-files', 'custom-model-configs/' + sid + '/projects'])
        custom = facts['links'][1]
        self.assertEqual(custom['binding']['employeeId'], self.employee['id'])
        self.assertEqual(custom['binding']['generation'], self.employee['sessionGeneration'])
        self.write_links(facts['links']);self.rebuild()
        review = json.loads(self.fixture.policy.read_bytes())
        review['backupScopes'][0]['exclude'] = self.profile.exclusions()
        self.fixture.policy.write_bytes(H.encoded(review))
        plan = self.approve()
        company = json.loads(self.company.read_bytes());company['employees'][0]['sessionGeneration'] += 1
        self.company.write_bytes(H.encoded(company))
        with self.assertRaisesRegex(ValueError, 'LINK_BINDING_CHANGED'):
            self.stage.apply(plan, W.website.digest(plan))
        self.assertFalse(self.fixture.engine.mutations())

    def test_arbitrary_link_path_or_target_is_not_an_exclusion_escape(self):
        facts = {'path': 'settings.json', 'device': 1, 'inode': 2, 'target': '/reverie_workspace/attachments',
                 'targetDevice': None, 'targetInode': None, 'binding': None}
        self.write_links([facts])
        with self.assertRaisesRegex(ValueError, 'LINK_BINDING'):self.rebuild()
        facts.update(path='chatroom-files', target='/host/private')
        self.write_links([facts])
        with self.assertRaisesRegex(ValueError, 'LINK_TARGET'):self.rebuild()

    def test_link_facts_do_not_invalidate_actual_initial_generation_directory_contract(self):
        self.initial.unit_state = lambda: {'MainPID': '0', 'ActiveState': 'inactive'}
        self.assertIsNone(self.initial.require_old_settled())
        self.assertEqual(list(self.initial.roots['controlBase'].iterdir()), [self.initial.path])

    def test_actual_created_unapproved_authority_refuses_before_old_writer_stop(self):
        plan = self.approve()
        self.after_created = lambda row: row['HostConfig'].update(DeviceRequests=[{'Driver': 'nvidia', 'Count': -1}])
        with self.assertRaises(W.website.WebsiteRefusal):self.stage.apply(plan, W.website.digest(plan))
        self.assertTrue(self.fixture.engine.containers[W.OLD]['State']['Running'])
        self.assertFalse(any(p == '/containers/' + W.OLD + '/stop?t=30' for p, _ in self.events))
        self.assertFalse(any(name == 'settle' for name, _ in self.events))

    def test_retained_unknown_website_history_refuses_before_engine_or_H_effect(self):
        self.fixture.state.mkdir(mode=0o700)
        active = self.fixture.state / 'website-active.json'
        active.write_bytes(H.encoded({'state': 'unconfirmed'}));active.chmod(0o600)
        with self.assertRaises(W.website.WebsiteRefusal):self.approve()
        self.assertEqual(self.events, [])
        self.assertEqual(json.loads(active.read_bytes()), {'state': 'unconfirmed'})

    def test_complete_record_permutation_preserves_entire_approved_plan_and_apply(self):
        plan = self.approve();original = deepcopy(self.fixture.engine.containers[W.OLD]['Mounts'])
        self.fixture.engine.containers[W.OLD]['Mounts'].reverse()
        after = self.stage.plan('reverie', W.NEW_IMAGE, W.OLD, W.OLD_IMAGE)
        self.assertEqual(after, plan)
        self.assertEqual(self.fixture.engine.containers[W.OLD]['Mounts'], list(reversed(original)))
        result = self.stage.apply(plan, W.website.digest(plan))
        self.assertEqual(result['state'], 'adopted')

    def test_full_record_attributes_and_duplicate_counts_remain_in_container_pin(self):
        row = self.fixture.engine.containers[W.OLD]
        baseline = W.website.container_pin(row)
        changed = deepcopy(row);changed['Mounts'][0]['FutureMetadata'] = {'value': 1}
        self.assertNotEqual(W.website.container_pin(changed), baseline)
        duplicate = deepcopy(row);duplicate['Mounts'].append(deepcopy(row['Mounts'][0]))
        self.assertEqual(len(W.website.container_pin(duplicate)['Mounts']), len(row['Mounts']) + 1)
        self.assertNotEqual(W.website.container_pin(duplicate), baseline)
        for invalid in (None, [None], [{}], [{'Type': 'bind', 'Source': '/data', 'Destination': '/data', 'RW': 'true'}]):
            with self.subTest(invalid=invalid), self.assertRaises(W.website.WebsiteRefusal):
                W.website.canonical_mount_records(invalid)


    def select_scratch_source(self):
        from reverie import owner_terminal_bind_sources as B,worker_cold_tmp as C
        f=self.fixture;scratch=f.root/'scratch-source';scratch.mkdir(mode=0o700)
        alias=f.root/'scratch-alias';alias.symlink_to(scratch,target_is_directory=True)
        old=f.engine.containers[W.OLD]
        old['Mounts'].append({'Type':'bind','Source':str(alias),'Destination':'/scratch','RW':True,'Propagation':'rprivate'})
        old['HostConfig']['Binds']=(old['HostConfig'].get('Binds') or [])+[str(alias)+':/scratch:rw']
        original=self.engine
        def engine(method,path,data=None):
            result=original(method,path,data)
            for row in f.engine.containers.values():
                row['State'].update(Status='running' if row['State']['Running'] else 'exited',
                                    Paused=False,Restarting=False,Dead=False)
            return result
        self.engine=engine
        engine('GET','/containers/'+W.OLD+'/json')
        source_maps={}
        def source_map(pid):
            if pid not in source_maps:
                row=next(row for row in f.engine.containers.values() if row['State']['Pid']==pid)
                source_maps[pid]={m['Destination']:Path(m['Source']).resolve(strict=True)
                                  for m in row['Mounts'] if m['Type']=='bind'}
            return source_maps[pid]
        self.scratch_source_maps=source_maps
        current=[None]
        def root(pid):
            current[0]=pid;source_map(pid)
            return os.open(f.root,os.O_PATH|os.O_DIRECTORY)
        def guest(fd,path,**kwargs):return os.open(source_map(current[0])[path],os.O_PATH|os.O_NOFOLLOW)
        host=C.read_mount_table()
        def table(pid='self'):
            if pid=='self':return host
            return host+[{'id':10**9+i,'device':C._mount_location(source,host)[0],
                          'root':C._mount_location(source,host)[1],'point':Path(destination)}
                         for i,(destination,source) in enumerate(source_map(pid).items())]
        self.enterContext(patch.object(B,'read_proc',side_effect=lambda pid:{'pid':pid,'start':pid,'namespaces':(1,2,3)}))
        self.enterContext(patch.object(B,'_root',side_effect=root))
        self.enterContext(patch.object(B,'open_in_root',side_effect=guest))
        self.enterContext(patch.object(B,'read_mount_table',side_effect=table))
        self.profile.close()
        with patch('reverie.resource_actor_install.artifact',return_value=deepcopy(self.provenance)):
            self.profile=H.TerminalWebsiteProfile(self.initial,self.links,old_id=W.OLD)
        self.addCleanup(self.profile.close)
        self.stage=W.website.WebsiteStage(self.engine,f.state,f.deployment,f.policy,
            guard=f.guard,ready=lambda cid,spec:self.ready(cid),terminal=self.profile)
        return alias,scratch

    def test_scratch_alias_real_stage_preserves_source_through_old_stop_and_ready(self):
        alias,scratch=self.select_scratch_source();plan=self.approve()
        selected=next(m for m in plan['spec']['HostConfig']['Mounts'] if m['Target']=='/scratch')
        self.assertEqual(selected['Source'],str(alias))
        held=[fd for item in self.profile.alias_held for fd in item.fds]
        (scratch/'ordinary-build-directory').mkdir()
        result=self.stage.apply(plan,W.website.digest(plan))
        self.assertEqual(result['state'],'adopted')
        self.assertTrue(self.profile.alias_held)
        self.profile.close()
        for fd in held:
            with self.assertRaises(OSError):os.fstat(fd)
        self.fixture.assert_no_old_restore()

    def test_scratch_alias_rotation_after_prepare_refuses_before_any_effect(self):
        alias,scratch=self.select_scratch_source();plan=self.approve()
        other=self.fixture.root/'other-scratch';other.mkdir(mode=0o700)
        alias.unlink();alias.symlink_to(other,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'BIND_SOURCE_CHANGED'):
            self.stage.apply(plan,W.website.digest(plan))
        self.assertFalse(self.fixture.engine.mutations())


    def test_scratch_candidate_wrong_actual_guest_at_ready_never_adopts_or_restores(self):
        alias,scratch=self.select_scratch_source();plan=self.approve()
        other=self.fixture.root/'wrong-mounted-scratch';other.mkdir(mode=0o700)
        ready=self.initial.await_ready
        def wrong(fd):
            result=ready(fd)
            self.scratch_source_maps[420]['/scratch']=other
            return result
        self.initial.await_ready=wrong
        with self.assertRaises(W.website.WebsiteRefusal):self.stage.apply(plan,W.website.digest(plan))
        self.assertFalse(self.fixture.engine.containers[W.OLD]['State']['Running'])
        self.fixture.assert_no_old_restore()


class FixedNativeWebsiteAPITests(unittest.TestCase):
    """Real owned HTTP/UDS framing; authority/engine metadata ports controlled.

    These are not a native engine, manager, broker-registration or H acceptance.
    """
    def setUp(self):
        self.core = TerminalWebsiteStageTests(methodName='runTest');self.core.setUp();self.addCleanup(self.core.doCleanups)
        c = self.core
        c.initial.value['engine'] = {'id': 'controlled-local-engine'}
        c.initial.path.write_bytes(H.encoded(c.initial.value));c.initial.path.chmod(0o600)
        c.initial.identity = L.private_document(c.initial.path)[1]
        self.selection = c.initial.roots['ledgerBase'] / 'website-selection.json'
        self.value = {'version': 1, 'purpose': 'owner-terminal-website-selection-v1',
                      'oldId': W.OLD, 'oldImage': W.OLD_IMAGE, 'newImage': W.NEW_IMAGE,
                      'providerPIDs': [], 'expiresAtEpoch': time.time() + 300}
        self.write_selection()
        self.config = {**c.initial.guard(), 'deployment': 'fixture'}

    def write_selection(self):
        self.selection.write_bytes(H.encoded(self.value));self.selection.chmod(0o600)

    def control(self):
        with patch('reverie.worker.load_config', return_value=deepcopy(self.config)):
            return H._NativeControl(self.core.initial, self.selection, self.core.fixture.state,
                                    self.core.fixture.policy, W.website)

    def test_actual_Connection_close_HTTP_reply_uses_original_socket_and_exact_plan_body(self):
        plan = self.core.approve();received = [];fixture = self
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                received.append((self.path, json.loads(body)))
                data = H.encoded({'Id': W.NEW})
                self.send_response(201);self.send_header('Connection', 'close');self.send_header('Content-Length', str(len(data)))
                self.end_headers();self.wfile.write(data);self.close_connection = True
        path = self.core.root / 'engine.sock'
        server = socketserver.UnixStreamServer(str(path), Handler);thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        def close():server.shutdown();server.server_close();thread.join(timeout=5)
        self.addCleanup(close)
        identity = path.stat().st_dev, path.stat().st_ino
        def guard():self.assertEqual((path.stat().st_dev, path.stat().st_ino), identity)
        self.core.initial.engine = SimpleNamespace(path=str(path), guard=guard)
        native = self.control();native.bind_plan(plan)
        route = '/containers/create?name=reverie-candidate-' + plan['operationId']
        self.assertEqual(native('POST', route, plan['spec']), {'Id': W.NEW})
        self.assertEqual(received, [(route, plan['spec'])])
        self.assertEqual(native.new_id, W.NEW)
        with self.assertRaisesRegex(ValueError, 'EFFECT_ROUTE'):
            native('POST', '/containers/foreign/start')
        self.assertEqual(len(received), 1)

    def test_wrong_plan_body_and_worker_mutation_have_no_effect_port(self):
        plan = self.core.approve();native = self.control();native.bind_plan(plan)
        with patch.object(native, '_post', side_effect=AssertionError('NO_NATIVE_EFFECT')) as effect:
            with self.assertRaisesRegex(ValueError, 'EFFECT_ROUTE'):
                native('POST', '/containers/create?name=reverie-candidate-' + plan['operationId'], {})
            with self.assertRaisesRegex(ValueError, 'EFFECT_ROUTE'):
                native('POST', '/containers/' + 'f' * 64 + '/stop?t=30')
            effect.assert_not_called()

    def test_unhashable_PID_and_json_owner_flag_refuse_before_configuration_or_peer(self):
        for change in ({'providerPIDs': [{}]}, {'owner': True}):
            with self.subTest(change=change):
                self.value.update(change);self.write_selection()
                with patch('reverie.worker.load_config', side_effect=AssertionError('NO_NATIVE_CONFIGURATION')):
                    with self.assertRaises(ValueError):
                        H._NativeControl(self.core.initial, self.selection, self.core.fixture.state, self.core.fixture.policy, W.website)
                self.value.pop('owner', None);self.value['providerPIDs'] = []

    def test_CLI_accepts_no_runtime_command_or_authority_selectors(self):
        with patch.object(L, 'RuntimeManifest', side_effect=AssertionError('NO_NATIVE_RUNTIME')) as runtime:
            with self.assertRaises(SystemExit):
                H.main(['--installation', '/unused', 'prepare', '--operation', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--program', '/bin/sh'])
            self.assertEqual(H.main(['--installation', '/unused', 'describe-links']), 1)
            runtime.assert_not_called()
