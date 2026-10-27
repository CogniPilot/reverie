"""Operator-selected private Goal bootstrap on the existing worker broker.

No endpoint accepts a key, path, generation, mount list or engine command. The
host config and existing canonical/launch records are the only sources. Mount
inspection and kernel peer identity remain mandatory; private modes alone do not
authorize this projection. This module never creates trust or reconciles state.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time
import uuid

from .goal_assertion import GoalRequestSigner
from .goal_private import absolute, assert_unexposed, private_entry, private_json, PrivateBatch
from .worker_cleanup import run_client

ID = re.compile(r'[A-Za-z0-9_.:-]{1,64}\Z', re.ASCII)
CANONICAL_ID = re.compile(r'[A-Za-z0-9_.:-]{1,100}\Z', re.ASCII)
SESSION = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z', re.ASCII)
CONTAINER = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
PATH_NAMES = {'config', 'key', 'canonical', 'nonce', 'authority'}


def exact(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError('Private Goal configuration unavailable')


def current_binding(company, session_id):
    """Read canonical fields, never a title, header or broker maintenance counter."""
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Current Goal binding unavailable')
    employees = company.get('employees')
    if not isinstance(employees, list) or any(not isinstance(item, dict) for item in employees):
        raise ValueError('Current Goal binding unavailable')
    matches = [item for item in employees if item.get('sessionId') == session_id]
    if len(matches) != 1:
        raise ValueError('Current Goal binding unavailable')
    employee = matches[0]
    generation = employee.get('sessionGeneration')
    owner = employee.get('owner')
    if (not isinstance(employee.get('id'), str) or not CANONICAL_ID.fullmatch(employee['id']) or
            type(generation) is not int or not 1 <= generation <= 2**53-1 or
            employee.get('bindingMigration') is not None or employee.get('onVacation') or
            employee.get('desiredRunning') is False or (owner is not None and not isinstance(owner, str)) or
            len([item for item in employees if item.get('id') == employee['id'] and item.get('owner') == owner]) != 1):
        raise ValueError('Current Goal binding unavailable')
    return dict(employeeId=employee['id'], sessionId=session_id, sessionGeneration=generation,
                **({'owner': owner} if owner is not None else {}))


class GoalBrokerBootstrap:
    def __init__(self, broker, program_observer=None):
        self.broker = broker
        self._config_identity = None
        # Deliberately unavailable in the normal Broker. Neither a container,
        # viewer nor a worker-written receipt attests the ORIGINAL program.
        # A future separately reviewed host observer must bind that exact exec
        # incarnation. Only explicit test fixtures currently supply this port.
        self._program_observer = program_observer
        self._runtime_lock = threading.RLock()

    def config(self):
        path = self.broker.config.get('goalPrivateConfig')
        if not path or not self.broker.config_file:
            raise ValueError('Private Goal bootstrap unavailable')
        live_worker, _, _ = private_json(str(self.broker.config_file))
        if live_worker != self.broker.config:
            raise ValueError('Worker policy changed; Goal bootstrap unavailable')
        config, digest, identity = private_json(path)
        if self._config_identity is None:
            self._config_identity = identity
        elif self._config_identity != identity:
            raise ValueError('Private Goal configuration changed; restart required')
        exact(config, ['version', 'mode', 'issuer', 'epoch', 'serverContainerId', 'paths', 'nonce', 'server'])
        if (type(config['version']) is not int or config['version'] != 1 or config['mode'] not in ('owner-only', 'owner-and-employee') or
                not isinstance(config['issuer'], str) or not ID.fullmatch(config['issuer']) or
                not isinstance(config['epoch'], str) or not ID.fullmatch(config['epoch']) or
                not isinstance(config['serverContainerId'], str) or not CONTAINER.fullmatch(config['serverContainerId'])):
            raise ValueError('Private Goal bootstrap unavailable')
        exact(config['paths'], PATH_NAMES)
        for pair in config['paths'].values():
            exact(pair, ['host', 'server'])
            absolute(pair['host']); absolute(pair['server'])
        if (config['paths']['config']['host'] != path or
                config['paths']['canonical']['host'] != self.broker.config['companyFile'] or
                absolute(config['paths']['key']['host']).is_relative_to('/nix/store')):
            raise ValueError('Private Goal scope mismatch')
        exact(config['nonce'], ['storeId', 'capacity', 'flockExecutable'])
        if (not isinstance(config['nonce']['storeId'], str) or not SESSION.fullmatch(config['nonce']['storeId']) or
                type(config['nonce']['capacity']) is not int or not 1 <= config['nonce']['capacity'] <= 4096):
            raise ValueError('Private Goal nonce configuration unavailable')
        absolute(config['nonce']['flockExecutable'])
        exact(config['server'], ['brokerSocket', 'custodyClient'])
        absolute(config['server']['brokerSocket']); absolute(config['server']['custodyClient'])
        return config, digest

    def _engine(self, arguments):
        # Closed internally constructed inspection only. Never a request-driven engine proxy.
        if self.broker.stopping.is_set():
            raise ValueError('Current Goal engine inventory unavailable')
        try:
            result = run_client([self.broker.engine, *arguments], timeout=.5,
                                owner=self.broker, limit=1024 * 1024, stderr=False)
        except subprocess.TimeoutExpired as error:
            raise ValueError('Current Goal engine inventory deadline exceeded') from error
        except RuntimeError as error:
            raise ValueError('Current Goal engine inventory exceeds bound') from error
        if result.returncode:
            raise ValueError('Current Goal engine inventory unavailable')
        return result.stdout

    def inventory(self, config, peer=None):
        started = time.monotonic()
        # GPU/CDI expands trusted host inputs beyond Mounts (including hooks and
        # devices). This bootstrap does not inventory that expansion. Even a
        # stopped/configured grant must refuse, before any private key read.
        if self.broker.config.get('gpuGrants'):
            raise ValueError('Private Goal custody does not support GPU/CDI grants')
        identifiers = self._engine(['ps', '--all', '--no-trunc', '--quiet']).splitlines()
        if (not 1 <= len(identifiers) <= 64 or len(set(identifiers)) != len(identifiers) or
                any(not CONTAINER.fullmatch(item) for item in identifiers)):
            raise ValueError('Current Goal engine inventory unavailable')
        items = json.loads(self._engine(['inspect', *identifiers]))
        if (not isinstance(items, list) or any(not isinstance(item, dict) for item in items) or len(items) != len(identifiers) or
                {item.get('Id') for item in items} != set(identifiers)):
            raise ValueError('Current Goal engine inventory unavailable')
        for item in items:
            host = item.get('HostConfig')
            if (not isinstance(host, dict) or host.get('Runtime') not in ('runc', 'io.containerd.runc.v2') or
                    host.get('Privileged') is not False or
                    any(host.get(name) not in (None, []) for name in
                        ('Devices', 'DeviceRequests', 'DeviceCgroupRules', 'CDIDevices', 'CdiDevices', 'CapAdd', 'VolumesFrom')) or
                    host.get('Annotations') not in (None, {}) or item.get('Annotations') not in (None, {}) or
                    item.get('Config', {}).get('Annotations') not in (None, {}) or
                    host.get('PidMode') not in (None, '') or
                    host.get('IpcMode') not in (None, '', 'private', 'shareable') or
                    host.get('UsernsMode') not in (None, '') or
                    host.get('SecurityOpt') not in (None, [], ['no-new-privileges'], ['no-new-privileges:true'])):
                raise ValueError('Private Goal custody refuses unsupported runtime injection')
        servers = [item for item in items if item['Id'] == config['serverContainerId']]
        if len(servers) != 1:
            raise ValueError('Pinned Goal server unavailable')
        server = servers[0]
        pid = server.get('State', {}).get('Pid')
        if (server.get('Name') != '/' + self.broker.config['serverContainer'] or
                server.get('State', {}).get('Running') is not True or type(pid) is not int or pid <= 0 or
                server.get('Config', {}).get('User') != f"{self.broker.config['uid']}:{self.broker.config['gid']}"):
            raise ValueError('Pinned Goal server unavailable')
        if peer is not None:
            # Reuse the real broker OS peer; only the pinned current server mount
            # namespace may request this operation. A same-UID sibling is refused.
            if (len(peer) != 3 or peer[1] != self.broker.config['uid'] or peer[0] <= 0 or
                    os.stat(f'/proc/{peer[0]}/ns/mnt').st_ino != os.stat(f'/proc/{pid}/ns/mnt').st_ino):
                raise ValueError('Goal custody caller refused')
        exposed = [mount['source'] for mount in self.broker.config['mounts']]
        for item in items:
            if not isinstance(item.get('Mounts'), list):
                raise ValueError('Current Goal mount inventory unavailable')
            for mount in item['Mounts']:
                if not isinstance(mount, dict) or mount.get('Type') not in ('bind', 'volume', 'tmpfs'):
                    raise ValueError('Current Goal mount inventory ambiguous')
                if item['Id'] != server['Id'] and mount.get('Type') in ('bind', 'volume'):
                    exposed.append(str(absolute(mount.get('Source'))))
        for pair in [*config['paths'].values(), {'host': self.broker.config['socket'], 'server': config['server']['brokerSocket']}]:
            target = absolute(pair['server'])
            matches = [mount for mount in server['Mounts'] if mount.get('Type') == 'bind' and
                       target.is_relative_to(absolute(mount.get('Destination')))]
            if not matches:
                raise ValueError('Goal host/server scope mapping unavailable')
            mount = max(matches, key=lambda entry: len(absolute(entry['Destination']).parts))
            if len([entry for entry in matches if entry['Destination'] == mount['Destination']]) != 1:
                raise ValueError('Goal host/server scope mapping ambiguous')
            mapped = absolute(mount['Source']) / target.relative_to(absolute(mount['Destination']))
            if str(mapped) != pair['host'] or mapped.resolve(strict=False) != mapped:
                raise ValueError('Goal host/server scope mapping unavailable')
        if time.monotonic() - started > 1.5:
            raise ValueError('Current Goal inventory deadline exceeded')
        return exposed, items

    def custody(self, peer=None, session_id=None):
        config, digest = self.config()
        exposed, items = self.inventory(config, peer)
        paths = config['paths']
        # The entire canonical/nonce/authority and trust namespaces are protected,
        # not only today's inode. This covers future atomic temporary/backup files.
        protected = [str(absolute(pair['host']).parent) for name, pair in paths.items() if name != 'authority']
        protected += [paths['authority']['host'], str(absolute(paths['nonce']['host']).parent.parent), str(self.broker.config_file),
                      str(absolute(self.broker.config['socket']).parent)]
        if session_id is not None:
            if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
                raise ValueError('Fixed Goal session unavailable')
            protected.append(str(absolute(self.broker.config['stateRoot']) / session_id / 'runtime.json'))
        assert_unexposed(protected, exposed)
        identities = {}
        with PrivateBatch() as batch:
            for name, pair in paths.items():
                identities[name] = private_entry(pair['host'], directory=name == 'authority', _batch=batch)[0]
                identities[name + 'Root'] = private_entry(str(absolute(pair['host']).parent), directory=True, _batch=batch)[0]
            for name, suffix, absent in [('canonicalLock', '.lock', True), ('nonceLock', '.lock', False), ('noncePending', '.pending', True)]:
                path = paths['canonical' if name == 'canonicalLock' else 'nonce']['host'] + suffix
                identities[name] = private_entry(path, absent=absent, _batch=batch)[0]
            identities['nonceParent'] = private_entry(str(absolute(paths['nonce']['host']).parent.parent), directory=True, _batch=batch)[0]
        # Reread after inspection and path checking; a changed trust config never
        # becomes a successful projection from an older inspection.
        fresh, fresh_digest = self.config()
        if fresh != config or fresh_digest != digest:
            raise ValueError('Private Goal configuration changed')
        return config, dict(version=1, configDigest=digest, identities=identities), items

    def project(self, request, peer):
        exact(request, ['action'])
        if request['action'] != 'goal-custody':
            raise ValueError('Goal custody operation refused')
        return self.custody(peer)[1]

    def _binding(self, session_id, expected=None):
        if self.config()[0]['mode'] != 'owner-and-employee':
            raise ValueError('Employee Goal authentication disabled')
        config, _, items = self.custody(session_id=session_id)
        company, _, _ = private_json(config['paths']['canonical']['host'], limit=16 * 1024 * 1024)
        binding = current_binding(company, session_id)
        record_path = absolute(self.broker.config['stateRoot']) / session_id / 'runtime.json'
        metadata, _, record_identity = private_json(str(record_path))
        pin = metadata.get('goalBinding')
        if (not isinstance(pin, dict) or set(pin) != {'version', 'containerId', *binding.keys()} or
                type(pin.get('version')) is not int or pin.get('version') != 1):
            raise ValueError('Fixed Goal office binding unavailable')
        if any(pin.get(name) != value for name, value in binding.items()) or (expected is not None and pin != expected):
            raise ValueError('Fixed Goal office binding is stale')
        laptops = [item for item in items if item['Id'] == pin['containerId']]
        if len(laptops) != 1 or laptops[0].get('State', {}).get('Running') is not True:
            raise ValueError('Fixed Goal laptop unavailable')
        labels = laptops[0].get('Config', {}).get('Labels') or {}
        if labels.get('reverie.worker') != self.broker.config['deployment'] or labels.get('reverie.session') != session_id:
            raise ValueError('Fixed Goal laptop identity refused')
        exit_name = metadata.get('exit')
        if (not isinstance(exit_name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}\.exit', exit_name, re.ASCII) or
                'goalProgramClosed' in metadata):
            raise ValueError('Fixed Goal program unavailable')
        if (record_path.parent / 'home/.reverie-launch' / exit_name).exists():
            self._close_program(record_path, metadata, record_identity)
            raise ValueError('Fixed Goal program completed')
        if self._program_observer is None:
            raise ValueError('Trusted original Goal program observer unavailable')
        self._program_observer.assert_current(session_id, dict(pin), dict(metadata))
        # The observer may block. Fence canonical/host/record changes afterward;
        # no returned boolean or mutable worker liveness claim grants authority.
        final_config, _, _ = self.custody(session_id=session_id)
        final_company, _, _ = private_json(config['paths']['canonical']['host'], limit=16 * 1024 * 1024)
        final_metadata, _, final_identity = private_json(str(record_path))
        if (final_config != config or current_binding(final_company, session_id) != binding or
                final_metadata != metadata or final_identity != record_identity):
            raise ValueError('Fixed Goal program changed during observation')
        if (record_path.parent / 'home/.reverie-launch' / exit_name).exists():
            self._close_program(record_path, final_metadata, final_identity)
            raise ValueError('Fixed Goal program completed during observation')
        return config, pin

    def _close_program(self, path, metadata, identity):
        """Negative-only durable floor in the existing host-private runtime pin.
        Removing/replacing the worker receipt cannot clear this floor. There is
        no positive state here; absent trusted observation always refuses.
        """
        with self._runtime_lock:
            def unchanged():
                current, _, current_identity = private_json(str(path))
                if current != metadata or current_identity != identity:
                    raise ValueError('Goal runtime changed before closure')
            self._persist_runtime(path, {**metadata, 'goalProgramClosed': True}, unchanged)

    def launch_binding(self, session_id, container_id):
        """Only the existing authenticated NEW launch path may issue this pin.
        Recovery/reconnect reads it; neither may mint/adopt one.
        """
        config, _, items = self.custody(session_id=session_id)
        if not isinstance(container_id, str) or not CONTAINER.fullmatch(container_id):
            raise ValueError('Fixed Goal launch identity unavailable')
        matching = [item for item in items if item['Id'] == container_id]
        if (len(matching) != 1 or
                (matching[0].get('Config', {}).get('Labels') or {}).get('reverie.worker') != self.broker.config['deployment'] or
                (matching[0].get('Config', {}).get('Labels') or {}).get('reverie.session') != session_id):
            raise ValueError('Fixed Goal launch identity unavailable')
        company, _, _ = private_json(config['paths']['canonical']['host'], limit=16 * 1024 * 1024)
        return dict(version=1, containerId=container_id, **current_binding(company, session_id))

    def persist_launch(self, path, metadata):
        """Durably replace the existing launch record without following an alias."""
        with self._runtime_lock:
            pin = metadata['goalBinding']
            def current():
                if self.launch_binding(pin['sessionId'], pin['containerId']) != pin:
                    raise ValueError('Goal launch changed before durable pin')
            self._persist_runtime(path, metadata, current)

    def _persist_runtime(self, path, metadata, assert_current):
        assert_current()
        path = absolute(str(path))
        private_entry(str(path.parent), directory=True)
        private_entry(str(path), absent=True)
        temporary = path.parent / ('.goal-launch-' + str(uuid.uuid4()) + '.tmp')
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(temporary.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, 'w') as out:
                json.dump(metadata, out)
                out.flush(); os.fsync(out.fileno())
            assert_current()
            os.replace(temporary.name, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary.name, dir_fd=parent)
            except FileNotFoundError:
                pass
            os.close(parent)

    def signer(self, session_id):
        config, pin = self._binding(session_id)
        key_identity, key = private_entry(config['paths']['key']['host'], limit=32)
        if len(key) != 32:
            raise ValueError('Private Goal key unavailable')
        def binding(sid):
            fresh, _ = self._binding(sid, pin)
            identity, current = private_entry(fresh['paths']['key']['host'], limit=32)
            if (fresh != config or identity != key_identity or len(current) != 32 or not hmac.compare_digest(key, current)):
                raise ValueError('Private Goal issuer revoked')
            return pin['sessionGeneration']
        return GoalRequestSigner(key=key, issuer=config['issuer'], epoch=config['epoch'], binding=binding)
