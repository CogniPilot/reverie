"""Owned directories only; no engine, private instance or service calls."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reverie.worker import create_args, child
from reverie.worker_tmp import prepare_temporary, temporary_environment, write_storage_instructions, home_workspace_alias, START
from tests import test_worker as fixture

SID = fixture.SID
EMPLOYEE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


class WorkerTemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = dict(scratchRoot=str(self.root / 'scratch'), uid=os.getuid())

    def test_employee_temp_is_private_exact_child_and_does_not_touch_peer(self):
        scratch = Path(self.config['scratchRoot']) / 'employees' / EMPLOYEE
        prior = os.umask(0o022)
        try: result = prepare_temporary(self.config, scratch)
        finally: os.umask(prior)
        self.assertEqual(result, scratch / 'tmp')
        for path in (Path(self.config['scratchRoot']), scratch.parent, scratch, result):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertFalse((scratch.parent / SID).exists())

    def test_symlink_root_employee_or_tmp_is_refused_without_following(self):
        for component in ('root', 'employee', 'tmp'):
            with self.subTest(component=component):
                root = self.root / component
                config = dict(self.config, scratchRoot=str(root))
                other = self.root / (component + '-other'); other.mkdir(mode=0o700)
                scratch = root / 'employees' / EMPLOYEE
                if component == 'root': root.symlink_to(other, target_is_directory=True)
                else:
                    (root / 'employees').mkdir(parents=True, mode=0o700)
                    root.chmod(0o700)
                    if component == 'employee': scratch.symlink_to(other, target_is_directory=True)
                    else:
                        scratch.mkdir(mode=0o700); (scratch / 'tmp').symlink_to(other, target_is_directory=True)
                with self.assertRaises((ValueError, OSError)): prepare_temporary(config, scratch)
                self.assertEqual(list(other.iterdir()), [])

    def test_public_existing_tmp_or_human_name_or_escape_never_becomes_a_mount(self):
        root = Path(self.config['scratchRoot']); root.mkdir(mode=0o700)
        for scratch in (root / 'Kai', root / 'employees' / 'Kai', self.root / EMPLOYEE, root / '..' / SID):
            with self.subTest(path=scratch), self.assertRaises(ValueError): prepare_temporary(self.config, scratch)
        scratch = root / SID; scratch.mkdir(mode=0o700)
        (scratch / 'tmp').mkdir(mode=0o755)
        (scratch / 'tmp').chmod(0o755)  # Keep the negative valid under a private process umask too.
        with self.assertRaises(ValueError): prepare_temporary(self.config, scratch)
        self.assertEqual((scratch / 'tmp').stat().st_mode & 0o777, 0o755)

    def test_mounts_are_only_one_employee_tmp_and_compatibility_drive(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        scratch = Path(f.config['scratchRoot']) / 'employees' / EMPLOYEE
        _, _, args = create_args(f.config, SID, f.root / 'home', scratch=scratch)
        mounts = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount']
        self.assertIn(f'type=bind,src={scratch / "tmp"},dst=/tmp', mounts)
        self.assertIn(f'type=bind,src={scratch},dst=/scratch', mounts)
        self.assertFalse(any(value.startswith('/tmp:') for value in args))
        self.assertFalse(any('src=' + f.config['scratchRoot'] + ',dst=/tmp' in value for value in mounts))
        self.assertIn('TMPDIR=/tmp', args); self.assertIn('TMP=/tmp', args); self.assertIn('TEMP=/tmp', args)

    def test_project_directories_are_stable_distinct_and_inside_tmp(self):
        a = temporary_environment('/projects/a'); b = temporary_environment('/projects/b')
        self.assertEqual(a, temporary_environment('/projects/a'))
        self.assertEqual({a[k] for k in ('TMPDIR', 'TMP', 'TEMP')}, {'/tmp'})
        self.assertNotEqual(a['XDG_CACHE_HOME'], b['XDG_CACHE_HOME'])
        self.assertTrue(all(value.startswith('/tmp/') for key, value in a.items() if key not in ('TMPDIR', 'TMP', 'TEMP')))

    def test_workspace_alias_preserves_grants_and_masks_attachments_at_both_paths(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        shared = dict(source=str(f.root / 'shared'), destination='/reverie_workspace', readOnly=False)
        config = dict(f.config, mounts=[shared])
        _, _, args = create_args(config, SID, f.root / 'home')
        self.assertIn(f'type=bind,src={shared["source"]},dst=/workspace', args)
        for prefix in ('/workspace', '/reverie_workspace'):
            self.assertIn(f'type=tmpfs,dst={prefix}/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly', args)
        occupied = dict(config, mounts=[shared, dict(source=str(f.root / 'project'), destination='/workspace', readOnly=True)])
        _, _, args = create_args(occupied, SID, f.root / 'home')
        self.assertNotIn(f'type=bind,src={shared["source"]},dst=/workspace', args)
        self.assertIn(f'type=bind,src={f.root / "project"},dst=/workspace,readonly', args)

    def test_home_workspace_alias_is_grant_bound_and_never_overwrites_owner_data(self):
        home = self.root / 'home'; home.mkdir(mode=0o700)
        config = dict(mounts=[])
        home_workspace_alias(config, home); self.assertFalse((home / 'workspace').exists())
        config['mounts'].append(dict(destination='/reverie_workspace'))
        home_workspace_alias(config, home)
        self.assertEqual(os.readlink(home / 'workspace'), '/reverie_workspace')
        (home / 'workspace').unlink(); (home / 'workspace').mkdir()
        (home / 'workspace/retained.txt').write_text('keep')
        home_workspace_alias(config, home)
        self.assertEqual((home / 'workspace/retained.txt').read_text(), 'keep')

    def test_workspace_cwd_alias_uses_only_the_existing_writable_grant(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        shared = dict(source=str(f.root/'shared'), destination='/reverie_workspace', readOnly=False)
        config = dict(f.config, mounts=[shared])
        request = dict(f.request, cwd='/workspace/project')
        self.assertEqual(fixture.validate_request(request, config), request)
        for mounts in ([dict(shared, readOnly=True)],
                       [shared, dict(source=str(f.root/'other'), destination='/workspace', readOnly=True)],
                       [shared, dict(source=str(f.root/'other'), destination='/workspace/private', readOnly=True)]):
            with self.subTest(mounts=mounts), self.assertRaises(ValueError):
                fixture.validate_request(request, dict(config, mounts=mounts))
        with self.assertRaises(ValueError):
            fixture.validate_request(dict(request, cwd='/workspace/../etc'), config)

    def test_real_child_overrides_caller_temp_and_does_not_inherit_host_broker(self):
        launch = self.root / 'launch'; launch.mkdir(mode=0o700)
        record = launch / 'request.json'
        record.write_text(json.dumps(dict(cwd='/projects/a', command='true', env=dict(TMPDIR='/caller', TMP='/caller', TEMP='/caller'))))
        record.chmod(0o600)
        def path(value):
            return launch if str(value) == '/home/agent/.reverie-launch' else Path(value)
        with patch('reverie.worker.Path', side_effect=path), patch('reverie.worker.os.chdir'), \
                patch('reverie.worker.subprocess.Popen'), patch('reverie.worker.os.execve') as execute, \
                patch.dict(os.environ, {'REVERIE_WORKER_SOCKET': '/host/broker', 'TMPDIR': '/host'}):
            child(record)
        environment = execute.call_args.args[2]
        self.assertEqual({environment[k] for k in ('TMPDIR', 'TMP', 'TEMP')}, {'/tmp'})
        self.assertNotIn('CARGO_TARGET_DIR', temporary_environment('/projects/a'))
        self.assertNotIn('REVERIE_WORKER_SOCKET', environment)
        self.assertFalse(record.exists())

    def test_managed_agents_block_preserves_owner_text_and_is_idempotent(self):
        home = self.root / 'home'; home.mkdir(mode=0o700)
        path = home / 'AGENTS.md'; path.write_text('Owner instructions remain.\n'); path.chmod(0o600)
        write_storage_instructions(home)
        once = path.read_text(); write_storage_instructions(home)
        self.assertEqual(path.read_text(), once)
        self.assertTrue(once.startswith('Owner instructions remain.\n'))
        self.assertEqual(once.count(START), 1)
        self.assertIn('employee identity', once); self.assertIn('`/tmp`', once)

    def test_instruction_symlink_hardlink_and_ambiguous_block_refuse(self):
        for kind in ('symlink', 'hardlink', 'block'):
            with self.subTest(kind=kind):
                home = self.root / kind; home.mkdir(mode=0o700)
                other = self.root / (kind + '.txt'); other.write_text('unchanged'); other.chmod(0o600)
                if kind == 'symlink': (home / 'AGENTS.md').symlink_to(other)
                elif kind == 'hardlink': os.link(other, home / 'AGENTS.md')
                else: (home / 'AGENTS.md').write_text(START)
                with self.assertRaises((ValueError, OSError)): write_storage_instructions(home)
                self.assertEqual(other.read_text(), 'unchanged')

    def test_direct_host_loader_keeps_helper_paired(self):
        path = Path(__file__).resolve().parents[1] / 'python/reverie/worker.py'
        spec = importlib.util.spec_from_file_location('owned_worker_tmp_loader', path)
        loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded)
        self.assertEqual(loaded.temporary_environment('/a'), temporary_environment('/a'))

    def test_admission_needs_no_pool_and_keeps_cpu_uncapped_with_hard_caps(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        config = dict(f.config, budgetMode='admission', memoryMiB=4096, pidsLimit=512, cpus=0)
        broker = fixture.Broker(config)
        broker.check_pool(self.root / 'missing-pool')
        _, _, args = create_args(config, SID, f.root / 'home')
        self.assertNotIn('--cgroup-parent', args); self.assertNotIn('--cpus', args)
        self.assertEqual(args[args.index('--memory') + 1], '4096m')
        self.assertEqual(args[args.index('--memory-swap') + 1], '4096m')
        self.assertEqual(args[args.index('--pids-limit') + 1], '512')
