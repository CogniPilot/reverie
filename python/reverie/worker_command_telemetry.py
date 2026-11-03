"""Protected host writer for authenticated-laptop SELF_REPORTED_RESULT metadata.

Identity is resolved from the host-owned OfficeAPI session closure and the current
canonical company registry. Reports are telemetry, never proof a command ran.
No client may choose employee, harness, time, pathname, catalog, or database.
"""
from pathlib import Path
import json
import os
import re
import stat
import threading

from .hands.command_catalog import CATALOG
from .hands.command_telemetry import FailureLog, Principal
from .worker_storage import canonical, company_records, private_directory, require_uuid, storage_paths, storage_start_allowed

PATH = '/api/command-telemetry/hands'
PROVENANCE = 'SELF_REPORTED_RESULT'


def configuration(config):
    value = config.get('commandTelemetry')
    if value is None:
        return False, ()
    if (not isinstance(value, dict) or set(value) - {'enabled', 'keys'} or
            type(value.get('enabled')) is not bool):
        raise ValueError('TELEMETRY_CONFIG_REFUSED')
    keys = value.get('keys', [])
    if (not isinstance(keys, list) or len(keys) > len(CATALOG) or
            any(type(key) is not str or key not in CATALOG for key in keys) or
            len(set(keys)) != len(keys) or (value['enabled'] and not keys)):
        raise ValueError('TELEMETRY_CONFIG_REFUSED')
    return value['enabled'], tuple(keys)


class _LearningLog(FailureLog):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        with self._connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS telemetry_origin (id INTEGER PRIMARY KEY CHECK(id=1), provenance TEXT NOT NULL)')
            db.execute('INSERT OR IGNORE INTO telemetry_origin VALUES (1,?)', (PROVENANCE,))
            if db.execute('SELECT provenance FROM telemetry_origin WHERE id=1').fetchone() != (PROVENANCE,):
                raise ValueError('TELEMETRY_STORE_REFUSED')

    def report(self):
        value = super().report()
        value['provenance'] = PROVENANCE
        return value


class CommandTelemetry:
    def __init__(self, config, run_engine=None):
        self.config = config
        self.enabled, self.keys = configuration(config)
        self.lock = threading.Lock()
        self.report_lock = threading.Lock()
        self.root = None
        if not self.enabled:
            return
        if config['uid'] != os.getuid():
            raise ValueError('TELEMETRY_BOUNDARY_REFUSED')
        state = canonical(config['stateRoot'])
        private_directory(state, config['uid'])
        self.root = state / 'command-telemetry'
        sources = [mount['source'] for mount in config['mounts']]
        sources += [config['scratchRoot'], config['apiSocketRoot'], state/'employees',
                    Path(config['companyRoot'])/'accounts', Path(config['companyRoot'])/'console/accounts']
        # Legacy session storage can be present alongside employee storage.
        sources += [entry / leaf for entry in state.iterdir() if re.fullmatch(r'[0-9a-f-]{36}', entry.name)
                    for leaf in ('home', 'nix')]
        self.check_sources(sources)
        if run_engine is None:
            raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
        self.check_existing(run_engine)
        private_directory(self.root, config['uid'], create=True)

    def check_sources(self, sources):
        if not self.enabled:
            return
        sink = canonical(self.root)
        for source in sources:
            source = canonical(source)
            # Includes mount ancestors, aliases/symlinks, read-only sources and
            # future canonical homes. Hidden data must not be mounted at all.
            if source == sink or source.is_relative_to(sink) or sink.is_relative_to(source):
                raise ValueError('TELEMETRY_BOUNDARY_REFUSED')

    def check_existing(self, run_engine):
        listing = run_engine(['ps', '--all', '--filter', 'label=reverie.worker', '--format', '{{.ID}}'])
        ids = listing.stdout.splitlines()
        if len(ids) > 64 or any(not re.fullmatch(r'[a-f0-9]{12,64}', item) for item in ids):
            raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
        for identity in ids:
            items = json.loads(run_engine(['inspect', identity]).stdout)
            if (not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict) or
                    not isinstance(items[0].get('Mounts'), list)):
                raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
            sources = []
            for mount in items[0]['Mounts']:
                if not isinstance(mount, dict):
                    raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
                if mount.get('Type') == 'tmpfs':
                    continue
                if mount.get('Type') not in ('bind', 'volume') or not isinstance(mount.get('Source'), str) or not mount['Source']:
                    raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
                sources.append(mount['Source'])
            self.check_sources(sources)

    def check_create_args(self, args):
        if not self.enabled:
            return
        sources = []
        for i, arg in enumerate(args):
            if arg in ('-v', '--volume') or arg.startswith(('--mount=', '--volume=')):
                raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
            if arg != '--mount':
                continue
            if i + 1 >= len(args):
                raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
            pairs = args[i+1].split(',')
            values = {}
            for pair in pairs:
                key, sep, value = pair.partition('=')
                if key in values:
                    raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
                values[key] = value if sep else True
            if values.get('type') == 'tmpfs':
                continue
            if values.get('type') != 'bind' or not isinstance(values.get('src'), str):
                raise ValueError('TELEMETRY_INVENTORY_UNCONFIRMED')
            sources.append(values['src'])
        self.check_sources(sources)

    def observe(self, session_id, raw):
        if not self.enabled or not isinstance(raw, bytes) or len(raw) > 512:
            return False
        try:
            def unique(pairs):
                out = {}
                for key, value in pairs:
                    if key in out:
                        raise ValueError('TELEMETRY_EVENT_REFUSED')
                    out[key] = value
                return out
            event = json.loads(raw, object_pairs_hook=unique)
            if (not isinstance(event, dict) or set(event) != {'v', 'execution_id', 'tool', 'exit_code'} or
                    type(event['v']) is not int or event['v'] != 1 or
                    type(event['tool']) is not str or event['tool'] not in (*self.keys, 'UNKNOWN_COMMAND') or
                    type(event['exit_code']) is not int or event['exit_code'] == 0 or not -255 <= event['exit_code'] <= 255):
                return False
            require_uuid(event['execution_id'])
            require_uuid(session_id)
            binding = self._binding(session_id)
            # No sink path enters the laptop. Serialize writers in this broker;
            # this is not an adversarial same-UID host-process security boundary.
            with self.lock:
                if self._binding(session_id) != binding:
                    return False
                log = self._log(binding[0])
                if self._binding(session_id) != binding:
                    return False
                return log.observe(event['tool'], event['exit_code'], event['execution_id'])
        except Exception:
            return False  # no event/error text escapes to caller or logs

    def _binding(self, session_id):
        require_uuid(session_id)
        # Never use a historical storage edge alone as current identity.
        rows = [row for row in company_records(self.config) if row.get('sessionId') == session_id]
        if len(rows) != 1:
            raise ValueError('TELEMETRY_BINDING_REFUSED')
        employee = require_uuid(rows[0]['id'])
        paths = storage_paths(self.config, session_id)
        if (paths.kind != 'employee' or paths.identity != employee or paths.owner != rows[0].get('owner') or
                not storage_start_allowed(self.config, paths)):
            raise ValueError('TELEMETRY_BINDING_REFUSED')
        return employee, paths.owner

    def _log(self, employee):
        directory = self.root / employee
        private_directory(directory, self.config['uid'], create=True)
        return _LearningLog(directory / 'hands', Principal(employee, 'hands'),
                            {key: [key] for key in self.keys})

    def report(self, session_id):
        """Host-only reader; no HTTP report/audience route is introduced here."""
        if not self.enabled:
            return None
        try:
            binding = self._binding(session_id)
            with self.lock:
                if self._binding(session_id) != binding:
                    return None
                log = self._log(binding[0])
                if self._binding(session_id) != binding:
                    return None
                return log.report()
        except Exception:
            return None

    def report_employee(self, employee_id):
        """Protected host reader, including stopped/retired employee metadata.

        Read access is supplied by the protected broker, never the laptop Office
        route. Absence is explicit; reading never initializes an empty database.
        Browser owner authentication remains the caller's separate obligation.
        """
        if not self.enabled:
            return {'status': 'unavailable', 'report': None}
        try:
            employee_id = require_uuid(employee_id)
            def binding():
                selected = [row for row in company_records(self.config) if row.get('id') == employee_id]
                if len(selected) != 1:
                    raise ValueError('TELEMETRY_BINDING_REFUSED')
                return employee_id, selected[0].get('owner')
            expected = binding()
            # Do not hold the producer mutex across reader storage I/O.
            if binding() != expected:
                raise ValueError('TELEMETRY_BINDING_REFUSED')
            private_directory(self.root, self.config['uid'])
            directory = self.root / employee_id
            try:
                directory.lstat()
            except FileNotFoundError:
                if binding() != expected:
                    raise ValueError('TELEMETRY_BINDING_REFUSED')
                return {'status': 'no_data', 'report': None}
            private_directory(directory, self.config['uid'])
            private_directory(directory / 'hands', self.config['uid'])
            # A missing DB inside an existing store is unavailable, not zero.
            path = directory / 'hands' / 'command-failures.sqlite'
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            try:
                current = os.fstat(fd)
                if (not stat.S_ISREG(current.st_mode) or current.st_uid != self.config['uid'] or
                        current.st_nlink != 1 or stat.S_IMODE(current.st_mode) != 0o600):
                    raise ValueError('TELEMETRY_STORE_REFUSED')
            finally:
                os.close(fd)
            report = self._log(employee_id).report()
            if binding() != expected:
                raise ValueError('TELEMETRY_BINDING_REFUSED')
            private_directory(self.root, self.config['uid'])
            return {'status': 'ready', 'report': report}
        except Exception:
            return {'status': 'unavailable', 'report': None}
