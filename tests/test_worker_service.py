"""Fake owner home and unit manager only; no real engine/service/wake calls."""
import copy
import hashlib
import json
import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from reverie.worker_service import WorkerService, UNIT
from tests import test_worker as fixture


class WorkerServiceTests(unittest.TestCase):
    def setUp(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        self.root, self.config = f.root, copy.deepcopy(f.config)
        self.config.update(budgetMode='admission', memoryMiB=4096, pidsLimit=512, poolMemoryMiB=49152)
        for key in ('stateRoot', 'scratchRoot'): Path(self.config[key]).mkdir(mode=0o700)
        directory = self.root / 'policy'; directory.mkdir(mode=0o700)
        self.path = directory / 'broker.json'; self.write_config()
        self.home = self.root / 'owner'; self.home.mkdir(mode=0o700)
        self.store = self.root / 'store'
        self.target = self.store / 'pinned-unit/share/systemd/user' / UNIT
        self.target.parent.mkdir(parents=True); self.target.write_text('owned immutable-unit fixture')
        self.calls = []; self.active = False; self.endpoint = 'unix:///synthetic/docker.sock'
        self.info = dict(OSType='linux', KernelVersion=os.uname().release, CgroupVersion='2', MemoryLimit=True, SwapLimit=True, PidsLimit=True, MemTotal=64*1024**3)
        self.failure = None
        self.service = WorkerService(self.path, home=self.home, run=self.fake_run)
        pin = patch.object(self.service, 'target_unit', return_value=self.target); pin.start(); self.addCleanup(pin.stop)
        store = patch('reverie.worker_service.STORE_ROOT', self.store); store.start(); self.addCleanup(store.stop)
        env = patch.dict(os.environ, {'DOCKER_HOST': '', 'DOCKER_CONTEXT': ''}); env.start(); self.addCleanup(env.stop)

    def write_config(self):
        self.path.write_text(json.dumps(self.config)); self.path.chmod(0o600)

    def fake_run(self, args, *, deadline=None):
        self.calls.append(args)
        code, output = 0, ''
        if args[:3] == ['docker', 'context', 'inspect']: output = json.dumps(self.endpoint)
        elif args[:2] == ['docker', 'info']: output = json.dumps(self.info)
        elif args == ['systemctl', '--user', 'is-active', UNIT]: code = 0 if self.active else 3
        elif args[:3] == ['systemctl', '--user', 'start']:
            selected = shlex.split(self.service.environment.read_text())[0].split('=', 1)[1]
            self.started_config = Path(selected)
            json.loads(self.started_config.read_text())  # Fake manager opens the decoded actual filename.
            self.active = True
        elif args[:3] == ['systemctl', '--user', 'stop']: self.active = False
        elif args[0] == 'nix-store': Path(args[args.index('--add-root') + 1]).symlink_to(args[-1])
        if self.failure and self.failure in args: code = 1
        return subprocess.CompletedProcess(args, code, output, '')

    def test_install_enables_existing_broker_unit_without_start_or_employee_changes(self):
        before = self.path.read_bytes()
        result = self.service.install()
        self.assertEqual(result['started'], False)
        self.assertEqual(self.service.unit.resolve(), self.target)
        self.assertEqual(self.service.gcroot.resolve(), self.store / 'pinned-unit')
        self.assertEqual(self.service.environment.stat().st_mode & 0o777, 0o600)
        self.assertIn(['systemctl', '--user', 'enable', UNIT], self.calls)
        self.assertFalse(any('start' in c or '--now' in c or 'sudo' in c for c in self.calls))
        self.assertEqual(self.path.read_bytes(), before)

    def test_capability_failure_remote_engine_and_pool_refuse_before_installation(self):
        for mutation in ('memory', 'swap', 'pids', 'cgroup', 'remote', 'budget', 'pool', 'desktop', 'kernel'):
            with self.subTest(mutation=mutation):
                self.setUp()
                if mutation in ('memory', 'swap', 'pids'):
                    self.info[dict(memory='MemoryLimit', swap='SwapLimit', pids='PidsLimit')[mutation]] = False
                elif mutation == 'cgroup': self.info['CgroupVersion'] = '1'
                elif mutation == 'remote': self.endpoint = 'ssh://somewhere'
                elif mutation == 'budget': self.info['MemTotal'] = 8*1024**3
                elif mutation == 'desktop': self.info['OperatingSystem'] = 'Docker Desktop'
                elif mutation == 'kernel': self.info['KernelVersion'] = 'unknown-remote-kernel'
                else: self.config.update(budgetMode='pool', memoryMiB=0); self.write_config()
                with self.assertRaises(ValueError): self.service.install()
                self.assertFalse(self.service.unit.exists()); self.assertFalse(self.service.environment.exists())

    def test_active_or_foreign_unit_never_replaced(self):
        self.active = True
        with self.assertRaises(ValueError): self.service.install()
        self.assertFalse(self.service.unit.exists())
        self.active = False
        self.service.unit.parent.mkdir(parents=True)
        self.service.unit.write_text('foreign owner selection')
        with self.assertRaises(ValueError): self.service.install()
        self.assertEqual(self.service.unit.read_text(), 'foreign owner selection')

    def test_stop_and_uninstall_do_not_require_live_engine_or_mutate_private_state(self):
        self.service.install(); before = self.path.read_bytes()
        self.calls.clear(); self.info = {}
        self.service.action('stop'); self.service.action('uninstall')
        self.assertFalse(self.service.unit.exists()); self.assertTrue(self.service.environment.exists())
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(all(c[:2] == ['systemctl', '--user'] for c in self.calls))
        self.assertFalse(self.service.gcroot.exists())

    def test_uninstall_accepts_unit_link_removed_by_disable(self):
        self.service.install(); before = self.path.read_bytes()
        selected = self.service.environment.read_bytes(); run = self.service.run
        self.calls.clear(); self.info = {}
        def disable_removes_link(args, **kwargs):
            result = run(args, **kwargs)
            if args == ['systemctl', '--user', 'disable', '--now', UNIT]:
                self.service.unit.unlink()
            return result
        self.service.run = disable_removes_link
        self.assertTrue(self.service.action('uninstall')['success'])
        self.assertFalse(self.service.unit.is_symlink()); self.assertFalse(self.service.gcroot.exists())
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.service.environment.read_bytes(), selected)
        self.assertIn(['systemctl', '--user', 'daemon-reload'], self.calls)
        self.assertTrue(all(c[:2] == ['systemctl', '--user'] for c in self.calls))

    def test_uninstall_preserves_replacement_unit_after_disable(self):
        self.service.install(); run = self.service.run
        foreign = self.root / 'foreign-unit'; foreign.write_text('foreign generation')
        def disable_replaces_link(args, **kwargs):
            result = run(args, **kwargs)
            if args == ['systemctl', '--user', 'disable', '--now', UNIT]:
                self.service.unit.unlink(); self.service.unit.symlink_to(foreign)
            return result
        self.service.run = disable_replaces_link
        with self.assertRaises(ValueError): self.service.action('uninstall')
        self.assertEqual(self.service.unit.resolve(), foreign)
        self.assertEqual(self.service.gcroot.resolve(), self.store / 'pinned-unit')

    def test_uninstall_does_not_swallow_missing_manager_or_changed_parent(self):
        self.service.install(); run = self.service.run
        def missing_manager(args, **kwargs):
            if args == ['systemctl', '--user', 'disable', '--now', UNIT]:
                raise FileNotFoundError('owned missing-manager fixture')
            return run(args, **kwargs)
        self.service.run = missing_manager
        with self.assertRaises(FileNotFoundError): self.service.action('uninstall')
        self.assertEqual(self.service.unit.resolve(), self.target)
        self.assertEqual(self.service.gcroot.resolve(), self.store / 'pinned-unit')
        def alias_parent(args, **kwargs):
            result = run(args, **kwargs)
            if args == ['systemctl', '--user', 'disable', '--now', UNIT]:
                parent = self.service.unit.parent; saved = parent.with_name('saved-user')
                parent.rename(saved); parent.symlink_to(saved, target_is_directory=True)
            return result
        self.service.run = alias_parent
        with self.assertRaises(ValueError): self.service.action('uninstall')
        self.assertEqual(self.service.gcroot.resolve(), self.store / 'pinned-unit')

    def test_start_rechecks_capabilities_and_only_starts_installed_generation(self):
        with self.assertRaises(ValueError): self.service.action('start')
        self.service.install(); self.info['MemoryLimit'] = False
        with self.assertRaises(ValueError): self.service.action('start')
        self.assertFalse(self.active)
        self.info['MemoryLimit'] = True
        self.service.action('start'); self.assertTrue(self.active)

    def test_employee_projection_pool_refuses_portable_installation(self):
        fields=('budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax')
        policy={k:self.config[k] for k in fields}
        policy.update(budgetMode='pool',memoryMiB=0)
        self.config['employeeResources']={'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':policy}
        self.write_config()
        with self.assertRaisesRegex(ValueError,'bounded admission'):
            self.service.install()
        self.assertEqual(self.calls,[])

    def test_unknown_private_storage_alias_and_failed_manager_never_report_success(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): self.service.install()
        self.path.chmod(0o600)
        Path(self.config['scratchRoot']).chmod(0o755)
        with self.assertRaises(ValueError): self.service.install()
        Path(self.config['scratchRoot']).chmod(0o700)
        self.failure = 'enable'
        with self.assertRaises(RuntimeError): self.service.install()

    def test_boot_capability_check_never_waits_for_target_it_is_starting(self):
        self.service.positive_preflight(check_manager=False)
        self.assertTrue(all(c[0] == 'docker' for c in self.calls))
        self.info['PidsLimit'] = False
        with self.assertRaises(ValueError): self.service.positive_preflight(check_manager=False)

    def test_start_cannot_validate_one_config_but_run_another_installed_selection(self):
        self.service.install()
        other = self.path.with_name('other.json'); other.write_bytes(self.path.read_bytes()); other.chmod(0o600)
        self.service.config_path = other
        with self.assertRaises(ValueError): self.service.action('start')
        self.assertFalse(self.active)

    def test_space_unicode_and_backslash_config_path_roundtrips_in_environment_file(self):
        selected = self.path.with_name('brøker café path\\selected.json')
        selected.write_bytes(self.path.read_bytes()); selected.chmod(0o600)
        self.service.config_path = selected
        self.service.install(); self.service.action('start')
        self.assertEqual(self.started_config, selected)
        self.assertIn('café'.encode(), self.service.environment.read_bytes())
        self.assertNotIn(b'\\u00', self.service.environment.read_bytes())

    def test_single_user_nix_owned_readonly_unit_is_accepted_but_foreign_owner_is_not(self):
        self.target.chmod(0o444)
        with patch.dict(os.environ, {'REVERIE_WORKER_SERVICE_UNIT': str(self.target)}):
            self.assertEqual(WorkerService.target_unit(self.service), self.target)
            info = self.target.stat()
            foreign = type('Stat', (), dict(st_mode=info.st_mode, st_uid=os.getuid() + 10))()
            with patch('reverie.worker_service.Path.lstat', return_value=foreign):
                with self.assertRaises(ValueError): WorkerService.target_unit(self.service)
        self.assertEqual(self.calls, [])

    def test_disposable_drive_can_be_empty_after_cleanup_without_losing_durable_state(self):
        Path(self.config['scratchRoot']).rmdir()
        self.service.positive_preflight(check_manager=False)
        self.assertFalse(Path(self.config['scratchRoot']).exists())
        self.assertTrue(Path(self.config['stateRoot']).is_dir())

    def test_resource_manifest_gc_roots_preserve_prior_generations_without_start(self):
        paths=[]
        for generation in ('first', 'second'):
            artifact=self.store/generation/'share/reverie/website-image.json'
            artifact.parent.mkdir(parents=True);artifact.write_text(generation)
            with patch('reverie.website_image_provenance.immutable',return_value=artifact):
                self.service.pin_resource_actor(artifact)
                self.service.pin_resource_actor(artifact)  # Same generation is idempotent.
            identity=hashlib.sha256(artifact.read_bytes()).hexdigest()
            root=self.service.gcroot.parent/'resource-actor'/identity/'root'
            self.assertEqual(root.resolve(),self.store/generation);paths.append(root)
        self.assertTrue(all(path.is_symlink()for path in paths))
        self.assertEqual(len(self.calls),2)
        self.assertTrue(all(call[0]=='nix-store'for call in self.calls))
        paths[0].unlink();paths[0].symlink_to(self.store/'second')
        with patch('reverie.website_image_provenance.immutable',return_value=self.store/'first/share/reverie/website-image.json'):
            with self.assertRaisesRegex(ValueError,'generation root differs'):
                self.service.pin_resource_actor(self.store/'first/share/reverie/website-image.json')

    def test_optional_actor_flags_never_implicitly_select_feature_or_partial_transport(self):
        before=self.path.read_bytes()
        with self.assertRaisesRegex(ValueError,'both immutable provenance'):
            self.service.install(resource_actor_provenance=Path('/unselected/provenance'))
        with self.assertRaisesRegex(ValueError,'selected in the private'):
            self.service.install(resource_actor_provenance=Path('/unselected/provenance'),
                                 resource_actor_engine_socket=Path('/synthetic/engine.sock'))
        self.assertEqual(self.path.read_bytes(),before)
        self.assertFalse(self.service.unit.exists());self.assertFalse(self.active)
