"""Owned procfs-shaped files and fake engine metadata; no native registration."""
import copy
import json
import os
from pathlib import Path
import socket
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from reverie import worker_resume_peer as P
from reverie import worker_resume_program as Q


class AuthenticatedStartupPeer(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='rsa-'))).resolve()
        self.socket_path = self.root / 'broker.sock'
        listener = socket.socket(socket.AF_UNIX); self.addCleanup(listener.close)
        listener.bind(str(self.socket_path)); self.socket_path.chmod(0o600)
        self.console = '/nix/store/' + '0' * 32 + '-console'
        self.node = '/nix/store/' + '1' * 32 + '-node/bin/node'
        self.auth = '/run/private-services/service-auth.json'
        self.base = ['web', '--host', '0.0.0.0', '--port', '3000']
        self.tail = ['--service-auth-config', self.auth]
        self.item = {'Id': 'c' * 64, 'Image': 'sha256:' + 'd' * 64, 'Name': '/website',
                     'Config': {'User': f'{os.getuid()}:{os.getgid()}',
                                'Env': ['REVERIE_WORKER_SOCKET=/run/workers/broker.sock'],
                                'Cmd': ['reverie', *self.base, *self.tail]},
                     'HostConfig': {'Privileged': False, 'PidMode': ''},
                     'Mounts': [{'Type': 'bind', 'RW': False, 'Source': str(self.root),
                                 'Destination': '/run/workers'}],
                     'State': {'Running': True, 'Paused': False, 'Restarting': False,
                               'Pid': 410, 'StartedAt': 'fixture-start'}}
        broker = SimpleNamespace(config={'uid': os.getuid(), 'gid': os.getgid(),
                                         'serverContainer': 'website', 'socket': str(self.socket_path)})
        broker.run_engine = Mock(side_effect=lambda *a, **k: SimpleNamespace(
            returncode=0, stdout=json.dumps([self.item])))
        peer = self.peer = object.__new__(P.ResumeWebsitePeer)
        peer.broker = broker; peer.deadline = time.monotonic() + 60
        peer.manifest = {'console': self.console, 'nodeInvocation': self.node,
                         'programs': Q.programs(self.console, self.node)}
        peer.executable = Path(self.node); peer.code_identities = {self.node: (23, 24)}
        peer.manifest_path = self.root / 'manifest.json'; peer.manifest_path.write_text('{}')
        peer.manifest_identity = Q.signature(peer.manifest_path.stat())
        peer.credentials = (420, os.getuid(), os.getgid())
        peer.initial = {'pid': 410, 'parent': 1, 'namespaces': {'pid': (1, 2)}, 'exe': (21, 22)}
        peer.node_process = {'pid': 420, 'parent': 410, 'namespaces': {'pid': (1, 2)}, 'exe': (23, 24)}
        self.enterContext(patch.object(P, 'read_proc', side_effect=lambda pid: copy.deepcopy(
            peer.node_process if pid == 420 else peer.initial)))
        self.proc = self.root / 'proc' / '420'; self.proc.mkdir(parents=True)
        (self.proc / 'status').write_text(''.join(f'{key}:\t0\n' for key in (
            'CapInh', 'CapPrm', 'CapEff', 'CapAmb')) +
            f'Uid:\t{os.getuid()} {os.getuid()} {os.getuid()} {os.getuid()}\n' +
            f'Gid:\t{os.getgid()} {os.getgid()} {os.getgid()} {os.getgid()}\n')
        def selected_path(value):
            return self.root / 'proc' if value == '/proc' else Path(value)
        self.enterContext(patch.object(P, 'Path', side_effect=selected_path))
        peer.initial_item = peer._item()
        self.argv([*Q.programs(self.console, self.node)[0], *self.tail])

    def argv(self, value):
        (self.proc / 'cmdline').write_bytes(b'\0'.join(x.encode() for x in value) + b'\0')

    def check(self):
        return self.peer.assert_process(self.peer.credentials, 'node')

    def test_normal_authenticated_startup_and_final_resource_variant(self):
        self.check()
        self.item['Config']['Cmd'][0] = '/bin/reverie'
        self.peer.initial_item = self.peer._item()
        self.check()
        self.item['Config']['Cmd'].append('--resource-replacement')
        self.peer.initial_item = self.peer._item()
        self.argv([*Q.programs(self.console, self.node)[0], *self.tail, '--resource-replacement'])
        self.check()

    def test_selected_path_and_node_arguments_must_match_exactly(self):
        for tail in ([], [*self.tail, '--arbitrary'], ['--service-auth-config', '/different/config.json'],
                     [*self.tail, *self.tail], ['--resource-replacement', *self.tail]):
            with self.subTest(tail=tail):
                self.argv([*Q.programs(self.console, self.node)[0], *tail])
                with self.assertRaisesRegex(ValueError, 'RESUME_NODE_PROGRAM'): self.check()

    def test_invalid_native_command_cannot_authorize_matching_node_arguments(self):
        for tail in (['--service-auth-config'], [*self.tail, *self.tail],
                     [*self.tail, '--unknown'], ['--resource-replacement', *self.tail],
                     ['--service-auth-config', 'relative.json'],
                     ['--service-auth-config', '/private/../config.json'],
                     ['--service-auth-config', '//private/config.json'],
                     ['--service-auth-config', '/private//config.json'],
                     ['--service-auth-config=' + self.auth],
                     ['--service-auth-config', '/'], ['--service-auth-config', '/' + 'a' * 4096],
                     ['--service-auth-config', '/private/config\n.json']):
            with self.subTest(tail=tail):
                self.item['Config']['Cmd'] = ['reverie', *self.base, *tail]
                self.peer.initial_item = self.peer._item()
                self.argv([*Q.programs(self.console, self.node)[0], *tail])
                with self.assertRaisesRegex(ValueError, 'RESUME_.*(?:ARGV|PROGRAM)'): self.check()

    def test_changed_native_config_and_loader_environment_refuse(self):
        self.item['Config']['Cmd'][-1] = '/different/config.json'
        with self.assertRaisesRegex(ValueError, 'RESUME_WEBSITE_CHANGED'): self.check()
        self.item['Config']['Cmd'][-1] = self.auth
        self.item['Config']['Env'].append('NODE_OPTIONS=--require=/private/inject.js')
        with self.assertRaisesRegex(ValueError, 'RESUME_WEBSITE_LOADER_ENV'): self.check()

    def test_final_code_rechecks_selected_command_and_all_environment(self):
        self.peer.qualify_code = Mock(return_value=self.peer.code_identities)
        self.peer.socket_identity = (1, 2); self.peer.qualify_socket = Mock(return_value=(1, 2))
        self.peer.final_code()
        self.item['Config']['Env'].append('REVERIE_UNRELATED=changed')
        with self.assertRaisesRegex(ValueError, 'RESUME_WEBSITE_CHANGED'): self.peer.final_code()
        self.item['Config']['Env'].pop()
        self.item['Config']['Cmd'][-1] = '/different/config.json'
        with self.assertRaisesRegex(ValueError, 'RESUME_WEBSITE_CHANGED'): self.peer.final_code()

    def test_other_launchers_host_port_and_command_order_cannot_authorize_auth(self):
        for command in (['/private/wrapper', *self.base, *self.tail],
                        ['reverie', 'web', '--port', '3000', '--host', '0.0.0.0', *self.tail],
                        ['reverie', 'web', '--host', '127.0.0.1', '--port', '3000', *self.tail],
                        ['reverie', 'web', '--host', '0.0.0.0', '--port', '3001', *self.tail]):
            with self.subTest(command=command):
                self.item['Config']['Cmd'] = command
                self.peer.initial_item = self.peer._item()
                self.argv([self.node, self.console + '/lib/reverie/dist/index.js', *command[1:]])
                with self.assertRaisesRegex(ValueError, 'RESUME_FIXED_WEBSITE_ARGV'): self.check()

    def test_measured_entry_executable_and_peer_credentials_still_required(self):
        self.argv([self.node, '/private/arbitrary.js', *self.base, *self.tail])
        with self.assertRaisesRegex(ValueError, 'RESUME_NODE_PROGRAM'): self.check()
        self.argv([*Q.programs(self.console, self.node)[0], *self.tail])
        self.peer.code_identities[self.node] = (99, 100)
        with self.assertRaisesRegex(ValueError, 'RESUME_NODE_PROGRAM'): self.check()
        with self.assertRaisesRegex(ValueError, 'RESUME_WEBSITE_PEER'):
            self.peer.assert_process((420, os.getuid() + 1, os.getgid()), 'node')

    def test_authenticated_command_does_not_authorize_protected_wrapper(self):
        self.argv([*Q.programs(self.console, self.node)[2], *self.tail])
        with self.assertRaisesRegex(ValueError, 'RESUME_NODE_PROGRAM'): self.check()

    def test_original_no_auth_variants_remain_exact(self):
        self.item['Config']['Cmd'] = ['reverie', *self.base]
        self.peer.initial_item = self.peer._item()
        for argv in Q.programs(self.console, self.node):
            with self.subTest(argv=argv): self.argv(argv); self.check()
