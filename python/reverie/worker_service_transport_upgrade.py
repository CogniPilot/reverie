"""Explicit same-config broker transport replacement; never a laptop restart.

Only the packaged launcher's immutable target unit changes. Every canonical
configuration/store byte remains owned by its existing authority. A consumed
attempt is never retried or automatically rolled back after an uncertain effect.
"""
import json
import os
from pathlib import Path
import stat
import re
import time

from . import worker_resource_reservations as R
from .worker_host_job import require_idle
from .worker_service_upgrade import GPUUpgrade, need, digest, encoded, private, stamp, exclusive, directory_lock
from .worker import load_config
from .worker_resources import policy_digest
from .worker_storage import read_metadata, storage_paths, validate_storage

KIND = 'SAME_CONFIG_TRANSPORT_UPGRADE_V1'


class TransportUpgrade:
    def __init__(self, service, operation):
        # Reuse generation recognition and fixed manager/GC-root/socket tools;
        # never invoke the GPU candidate, config CAS or first-provision path.
        self.tools = GPUUpgrade(service, operation)
        self.service, self.operation = service, self.tools.operation
        self.deadline = self.tools.deadline

    def _time(self):
        need(time.monotonic() < self.deadline, 'Transport upgrade deadline exhausted')

    def broker(self, unit):
        current = self.tools.manager_state(active=True)
        entry = Path(unit['entries']['ExecStart']['path'])
        raw = entry.read_bytes()
        need(digest(raw) == unit['entries']['ExecStart']['sha256'], 'Broker wrapper changed')
        found = re.findall(r'^exec python3 (/nix/store/[^\s]+/python/reverie/worker\.py) broker "\$@"$', raw.decode(), re.M)
        need(len(found) == 1, 'Recognized immutable broker source required')
        source = Path(found[0])
        need(source.resolve() == source and source.is_file() and not source.stat().st_mode & 0o022,
             'Immutable broker source required')
        pid = current['process']['pid']; proc = Path('/proc') / str(pid)
        with (proc / 'cmdline').open('rb') as stream: argv = stream.read(16385)
        need(len(argv) <= 16384, 'Broker argv exceeds bound')
        words = argv.rstrip(b'\0').split(b'\0')
        need(len(words) == 5 and words[1:] == [os.fsencode(source), b'broker', b'--config', os.fsencode(self.service.config_path)],
             'Actual broker argv differs from immutable generation')
        exe = (proc / 'exe').resolve(strict=True); info = exe.stat()
        need(exe.is_relative_to('/nix/store') and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022,
             'Immutable broker interpreter required')
        from .worker_gpu_preflight import _process
        need(_process(pid) == current['process'], 'Broker process changed during program observation')
        return {**current, 'program': {'source': str(source), 'sourceSHA256': digest(source.read_bytes()),
                                     'exe': str(exe), 'exeIdentity': [info.st_dev, info.st_ino], 'argvSHA256': digest(argv)}}

    def selection(self, path):
        path = Path(path)
        need(path.is_absolute() and path.resolve() == path, 'Canonical private provider selection required')
        value = json.loads(private(path, maximum=65536))
        need(type(value) is dict and set(value) == {'providerPIDs'}, 'Closed transport provider selection required')
        pids = value['providerPIDs']
        need(type(pids) is list and len(pids) <= 512 and
             all(type(pid) is int and pid > 1 for pid in pids) and len(set(pids)) == len(pids),
             'Distinct bounded provider PIDs required')
        return {'providerPIDs': sorted(pids)}

    def engine(self):
        context = os.environ.get('DOCKER_CONTEXT')
        endpoint = os.environ.get('DOCKER_HOST')
        if context or not endpoint:
            args = ['docker', 'context', 'inspect', *([context] if context else []),
                    '--format', '{{json .Endpoints.docker.Host}}']
            endpoint = json.loads(self.tools.run(args).stdout)
        need(type(endpoint) is str and len(endpoint) <= 4096 and endpoint.startswith('unix:///') and
             not any(ord(c) < 32 for c in endpoint), 'Local Unix engine selection required')
        path = Path(endpoint[7:]).resolve(strict=True)
        before = stamp(path)
        need(stat.S_ISSOCK(path.lstat().st_mode) and before[2] in (0, os.getuid()) and
             not before[3] & 0o002, 'Trusted local engine socket required')
        address = 'unix://' + str(path)
        data = json.loads(self.tools.run(['docker', '--host', address, 'info', '--format', '{{json .}}']).stdout)
        need(type(data) is dict and type(data.get('ID')) is str and 1 <= len(data['ID']) <= 200 and
             data.get('OSType') == 'linux' and data.get('KernelVersion') == os.uname().release and
             str(data.get('CgroupVersion')) == '2' and
             all(data.get(key) is True for key in ('MemoryLimit', 'SwapLimit', 'PidsLimit')) and
             'docker desktop' not in str(data.get('OperatingSystem', '')).lower() and
             data.get('Name') != 'docker-desktop' and stamp(path) == before,
             'Bound native cgroup engine required')
        return {'endpoint': address, 'socketStamp': before, 'engineId': data['ID']}

    def probe(self, config, engine):
        upgrade = self
        class Probe:
            def __init__(self): self.config = config
            def run_engine(self, args, optional=False, *, deadline=None):
                need(args and args[0] in ('ps', 'inspect'), 'Transport probe is metadata-only')
                result = upgrade.service.run(['docker', '--host', engine['endpoint'], *args],
                                             deadline=min(upgrade.deadline, deadline or upgrade.deadline))
                need(result.returncode == 0, 'Transport native inventory unavailable')
                return result
        return Probe()

    def _gate(self, config, engine):
        need(R.option(config) is not None, 'Existing canonical reservation domain required')
        roots = {self.service.home / '.config', Path(os.environ.get('XDG_CONFIG_HOME', str(self.service.home / '.config')))}
        need('resourceActorConfig' not in config and not any(os.path.lexists(p / 'systemd/user/reverie-owner-terminal.service') for p in roots),
             'Registered protected consumers need coordinated maintenance')
        return R.ReservationGate(self.probe(config, engine))

    def idle(self, gate):
        require_idle(gate)
        # This installed schema has no settled/released operation state. Every
        # retained record is a claim, including VERIFY_RECORDED; never credit it.
        need(not gate._document()['operations'], 'Retained resource operation requires reconciliation')
        gate.check_headroom()

    def protected(self, gate):
        config = gate.broker.config
        paths = [self.service.config_path, self.service.environment, R.marker(config),
                 gate.root / 'admission.lock']
        directories = [gate.root, gate.root / 'profiles', gate.root / 'operations']
        for directory in directories[1:]:
            entries = list(directory.iterdir())
            need(len(entries) <= 1024, 'Canonical history exceeds transport snapshot bound')
            paths.extend(entries)
        records = {}; total = 0
        for path in sorted(set(paths), key=str):
            raw = private(path); total += len(raw)
            need(total <= 16 * R.MIB, 'Canonical history exceeds transport byte bound')
            records[str(path)] = {'stamp': stamp(path), 'sha256': digest(raw)}
        company = Path(config['companyFile'])
        view = self.company(config)
        company_stamp = stamp(company)
        directories.extend([self.service.config_path.parent, self.service.environment.parent, company.parent,
                            R.marker(config).parent, self.service.unit.parent, self.service.gcroot.parent])
        ancestors = {p for directory in directories for p in (directory, *directory.parents)}
        need(all(p.resolve() == p for p in ancestors), 'Canonical parent alias refused')
        return {'files': records, 'directories': {str(p): R._identity(p) for p in sorted(ancestors, key=str)},
                'company': {'path': str(company), 'stamp': company_stamp, 'sha256': view}}

    def company(self, config):
        # A hash preserves all owner-selected fields, including OFF/vacation and
        # current recipe/account binding; no employee identity enters public code.
        company = read_metadata(Path(config['companyFile']), config['uid'])
        need(type(company) is dict and type(company.get('employees')) is list,
             'Current company projection required')
        return digest(encoded(company))

    def native(self, gate, selection):
        from .worker_gpu_preflight import _process
        config = gate.broker.config; native = gate.native
        rows = gate._guard()
        native.custody(self.operation, self.operation / 'ATTEMPT.json', deadline=self.deadline)
        peers, roots, storage_leaves = [], {}, {}
        managed = []
        for row in rows:
            labels = row.get('Config', {}).get('Labels') or {}
            if labels.get('reverie.worker') != config['deployment']:
                continue
            sid = labels.get('reverie.session')
            R.journal.canonical_uuid(sid)
            if row['State']['Running']:
                need(row.get('Image') == config['image'] and
                     row.get('Name') == '/' + config['deployment'] + '-agent-' + sid and
                     labels.get('reverie.worker-policy') == policy_digest(config, sid),
                     'Live managed laptop policy differs')
                paths = storage_paths(config, sid)
                if paths.kind == 'employee': validate_storage(config, paths)
                roots[sid] = native.storage(row, paths)
                for destination, source in [('/home/agent', paths.home), ('/nix', paths.nix), ('/scratch', paths.scratch)]:
                    for leaf in (source, Path('/proc') / str(row['State']['Pid']) / 'root' / destination.lstrip('/')):
                        storage_leaves[str(leaf)] = roots[sid][destination]
                _, limits = native.limits(row)
                process = _process(row['State']['Pid'])
                peers.append({**limits, 'process': process})
                managed.append(sid)
        providers = []
        for pid in selection['providerPIDs']:
            process = _process(pid)
            need(any(process['namespaces'] == row['process']['namespaces'] and
                     process['rootIdentity'] == row['process']['rootIdentity'] for row in peers),
                 'Provider is outside the current managed laptops')
            exe = (Path('/proc') / str(pid) / 'exe').stat()
            need(stat.S_ISREG(exe.st_mode), 'Current provider executable required')
            providers.append({**process, 'exeIdentity': [exe.st_dev, exe.st_ino]})
        need(native.inventory(deadline=self.deadline) == rows, 'Transport native inventory changed')
        self._time()
        return {'inventory': rows, 'peers': sorted(peers, key=lambda p: p['containerId']),
                'providers': providers, 'storage': roots, 'storageLeaves': storage_leaves, 'runningSessions': sorted(managed),
                'companySHA256': self.company(config)}

    def _unchanged(self, plan, gate):
        need(self.engine() == plan['engine'], 'Engine selection or daemon changed')
        need(self.protected(gate) == plan['protected'], 'Canonical config or stores changed')
        need(self.native(gate, plan['selection']) == plan['native'], 'Laptop/provider/intent continuity changed')
        self.idle(gate)

    def storage_leaf(self, path):
        return R._identity(path)

    def kernel_current(self, plan):
        from .worker_gpu_preflight import _process
        for peer in plan['native']['peers']:
            need(_process(peer['process']['pid']) == peer['process'], 'Native laptop process changed')
        for provider in plan['native']['providers']:
            expected = {k: v for k, v in provider.items() if k != 'exeIdentity'}
            need(_process(provider['pid']) == expected, 'Native provider process changed')
            info = (Path('/proc') / str(provider['pid']) / 'exe').stat()
            need([info.st_dev, info.st_ino] == provider['exeIdentity'], 'Native provider executable changed')

    def broker_leaf(self, current):
        from .worker_gpu_preflight import _process
        process = current['process']; proc = Path('/proc') / str(process['pid'])
        info = (proc / 'exe').stat()
        with (proc / 'cmdline').open('rb') as stream: argv = stream.read(16385)
        need(len(argv) <= 16384 and digest(argv) == current['program']['argvSHA256'] and
             [info.st_dev, info.st_ino] == current['program']['exeIdentity'] and
             _process(process['pid']) == process, 'New broker process/program changed')

    def _terminal(self, plan, gate, links=None, running=None):
        # Finish all content readers and their descriptor finalizers first.
        # Then observe live processes, followed by physical roots and static
        # metadata only. No content/engine producer follows this finite bracket.
        need(self.protected(gate) == plan['protected'], 'Canonical config or stores changed')
        self.kernel_current(plan)
        if running is not None: self.broker_leaf(running)
        for path, expected in plan['native']['storageLeaves'].items():
            need(self.storage_leaf(Path(path)) == expected, 'Canonical storage root changed')
        for path, identity in plan['protected']['directories'].items():
            need(R._identity(Path(path)) == identity, 'Canonical directory changed at terminal boundary')
        for path, record in plan['protected']['files'].items():
            need(stamp(Path(path)) == record['stamp'], 'Canonical leaf changed at terminal boundary')
        links = links or {str(self.service.unit): {'stamp': plan['generation']['stamps']['unit'],
                                                  'target': plan['generation']['unit']['path']},
                          str(self.service.gcroot): {'stamp': plan['generation']['stamps']['gcroot'],
                                                    'target': plan['generation']['unit']['root']}}
        for path, expected in links.items():
            need(stamp(Path(path)) == expected['stamp'] and os.readlink(path) == expected['target'],
                 'Generation link changed at terminal boundary')
        need(stamp(Path(plan['protected']['company']['path'])) == plan['protected']['company']['stamp'],
             'Company binding changed at terminal boundary')
        self._time()

    def prepare(self, selection_path):
        with directory_lock(self.service.gcroot.parent), directory_lock(self.operation):
            need(not any(p.name != 'operation.lock' for p in self.operation.iterdir()), 'Fresh transport operation required')
            config = load_config(self.service.config_path)
            generation = self.tools.generation()
            need(generation['unit'] != generation['newUnit'], 'New immutable broker generation required')
            selection = self.selection(selection_path); engine = self.engine()
            gate = self._gate(config, engine)
            with gate.admission(deadline=self.deadline):
                self.idle(gate)
                protected = self.protected(gate)
                broker = self.broker(generation['unit'])
                native = self.native(gate, selection)
                need(self.tools.generation() == generation and self.broker(generation['unit']) == broker,
                     'Broker generation changed during transport preparation')
                need(self.protected(gate) == protected, 'Canonical stores changed during preparation')
            plan = {'kind': KIND, 'expiresAt': time.time() + 600, 'generation': generation,
                    'selection': selection, 'engine': engine, 'protected': protected, 'native': native, 'broker': broker}
            self._terminal(plan, gate)
            exclusive(self.operation / 'PLAN.json', encoded(plan))
            return {'planSHA256': digest(encoded(plan)), 'effects': False, 'configUnchanged': True}

    def apply(self, plan_sha256):
        with directory_lock(self.service.gcroot.parent), directory_lock(self.operation):
            need(not os.path.lexists(self.operation / 'ATTEMPT.json'), 'One-attempt transport upgrade already consumed')
            raw = private(self.operation / 'PLAN.json')
            R.journal.digest(plan_sha256)
            need(digest(raw) == plan_sha256, 'Exact prepared transport plan digest required')
            plan = json.loads(raw)
            need(plan.get('kind') == KIND and time.time() < plan['expiresAt'], 'Transport plan expired')
            need(self.tools.generation() == plan['generation'] and
                 self.broker(plan['generation']['unit']) == plan['broker'], 'Prepared broker generation changed')
            config = load_config(self.service.config_path)
            gate = self._gate(config, plan['engine'])
            with gate.admission(deadline=self.deadline):
                self._unchanged(plan, gate)
                need(self.tools.generation() == plan['generation'] and time.time() < plan['expiresAt'],
                     'Prepared generation changed before transport attempt')
                exclusive(self.operation / 'ATTEMPT.json', encoded({'kind': KIND, 'planSHA256': plan_sha256}))
                for label, record in [('old-generation', plan['generation']['unit']),
                                      ('new-generation', plan['generation']['newUnit'])]:
                    root = self.operation / label
                    self.tools.run(['nix-store', '--add-root', str(root), '--indirect', '--realise', record['root']])
                    need(root.is_symlink() and root.resolve() == Path(record['root']), 'Generation GC root publication unknown')
                exclusive(self.operation / 'BROKER-STOP-INTENT.json', encoded({'broker': plan['broker']}))
                # Every durable producer precedes the last pre-stop validation.
                self._unchanged(plan, gate)
                need(self.tools.generation() == plan['generation'] and
                     self.broker(plan['generation']['unit']) == plan['broker'], 'Broker changed before transport stop')
                self._terminal(plan, gate)
                self.tools.manager('stop'); self.tools.manager_state(active=False)
                from .worker_gpu_preflight import _process
                try: old = _process(plan['broker']['process']['pid'])
                except (FileNotFoundError, ProcessLookupError): old = None
                need(old != plan['broker']['process'], 'Previous broker process is still alive')
                self._unchanged(plan, gate)
                need(self.tools.generation() == plan['generation'], 'Generation changed after broker stop')
                exclusive(self.operation / 'GENERATION-COMMIT-INTENT.json', encoded(plan['generation']))
                self._unchanged(plan, gate)
                self._terminal(plan, gate)
                self.tools._replace_link(self.service.unit, plan['generation']['newUnit']['path'], plan['generation']['stamps']['unit'])
                self.tools._replace_link(self.service.gcroot, plan['generation']['newUnit']['root'], plan['generation']['stamps']['gcroot'])
                self.tools.run(['systemctl', '--user', 'daemon-reload'])
                links = {str(path): {'stamp': stamp(path), 'target': target} for path, target in (
                    (self.service.unit, plan['generation']['newUnit']['path']),
                    (self.service.gcroot, plan['generation']['newUnit']['root']))}
            # New recover() must acquire the canonical admission flock itself.
            exclusive(self.operation / 'BROKER-START-INTENT.json', encoded({'unit': plan['generation']['newUnit']}))
            self._terminal(plan, gate, links)
            self.tools.manager('start'); self.tools.manager('is-active')
            current = self.broker(plan['generation']['newUnit'])
            need(current['process'] != plan['broker']['process'], 'New broker process required')
            self.tools.ready_socket(Path(config['socket']), current['process']['pid'])
            for sid in plan['native']['runningSessions']:
                self.tools.ready_socket(Path(config['apiSocketRoot']) / sid / 'office.sock', current['process']['pid'])
            with gate.admission(deadline=self.deadline):
                self._unchanged(plan, gate)
                need(self.service.unit.resolve() == Path(plan['generation']['newUnit']['path']) and
                     self.service.gcroot.resolve() == Path(plan['generation']['newUnit']['root']) and
                     self.broker(plan['generation']['newUnit']) == current, 'New broker generation readback changed')
                result = {'state': 'TRANSPORT_REPLACED', 'configUnchanged': True, 'workerEffects': False,
                          'noWakeCommand': True, 'broker': current}
                exclusive(self.operation / 'DONE.next.json', encoded(result))
                done_stamp = stamp(self.operation / 'DONE.next.json')
            # No descriptor/native finalizer follows the last static check.
            self._terminal(plan, gate, links, current)
            need(stamp(self.operation / 'DONE.next.json') == done_stamp, 'Completion receipt changed')
            self._time()
            os.rename(self.operation / 'DONE.next.json', self.operation / 'DONE.json')
            return result
