"""Fixed image-materialization purpose for an already running employee laptop.

Only scoped message/file IDs cross this boundary. No command, arbitrary path,
credential, URL, lifecycle operation or container engine argument is accepted.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import threading

from .chat_image_paths import ImagePaths, ImagePathRefused, UUID, directory, request
from .chat_image_reader import OfficeImageReader
from .chat_image_custody import ImageCacheCustody
from .worker_storage import storage_paths, storage_start_allowed

PURPOSE = 'chat-image-paths-v1'
CACHE_NAME = '.reverie-chat-images'
PUBLIC_ROOT = Path('/tmp') / CACHE_NAME


def decode(raw):
    if type(raw) is not bytes or len(raw) > 4096:
        raise ImagePathRefused('invalid_request')
    def unique(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ImagePathRefused('invalid_request')
            value[key] = item
        return value
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, ValueError):
        raise ImagePathRefused('invalid_request') from None
    if (type(value) is not dict or value.get('purpose') != PURPOSE
            or value.get('action') not in ('binding', 'materialize')):
        raise ImagePathRefused('invalid_request')
    expected = {'purpose', 'action', 'sessionId'}
    if value['action'] == 'materialize':
        expected.add('request')
    if (set(value) != expected or type(value['sessionId']) is not str
            or not UUID.fullmatch(value['sessionId'])):
        raise ImagePathRefused('invalid_request')
    if value['action'] == 'materialize':
        scope = request(value['request'])
        if scope['sessionId'] != value['sessionId']:
            raise ImagePathRefused('invalid_identity')
    return value


def attachment_masks(config, mounts):
    """Require actual read-only masks on every grant exposing the shared drive.

    This is a materialization prerequisite, not a migration/recreation helper.
    Unknown sources, aliases and shadow mounts are refused, never repaired.
    """
    grants = [item for item in config['mounts'] if item.get('destination') == '/reverie_workspace']
    if len(grants) != 1 or type(mounts) is not list or any(type(item) is not dict for item in mounts):
        raise ImagePathRefused('isolation_unverified')
    workspace = Path(grants[0]['source']).resolve(strict=True)
    attachment = workspace / 'attachments'
    if attachment.is_symlink() or not attachment.is_dir():
        raise ImagePathRefused('isolation_unverified')
    masks = []
    for item in mounts:
        if item.get('Type') != 'bind':
            continue
        source, destination = item.get('Source'), item.get('Destination')
        if type(source) is not str or type(destination) is not str:
            raise ImagePathRefused('isolation_unverified')
        source = Path(source).resolve(strict=True)
        if source == workspace:
            if destination not in ('/reverie_workspace', '/workspace'):
                raise ImagePathRefused('isolation_unverified')
            masks.append(destination + '/attachments')
        elif (source == attachment or source.is_relative_to(attachment) or attachment.is_relative_to(source)):
            raise ImagePathRefused('isolation_unverified')
    if '/reverie_workspace/attachments' not in masks:
        raise ImagePathRefused('isolation_unverified')
    for target in masks:
        exact = [item for item in mounts if item.get('Destination') == target]
        if len(exact) != 1 or exact[0].get('Type') != 'tmpfs' or exact[0].get('RW') is not False:
            raise ImagePathRefused('isolation_unverified')
        if any(type(item.get('Destination')) is not str or
               Path(item['Destination']).is_relative_to(target) and item['Destination'] != target for item in mounts):
            raise ImagePathRefused('isolation_unverified')


def namespace_temporary(pid, temporary, cache):
    """Bracket actual namespace/inode observations with the init process birth tick."""
    proc = Path('/proc') / str(pid)
    start = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    inside = (proc / 'root/tmp').stat()
    outside = temporary.stat()
    if (inside.st_dev, inside.st_ino) != (outside.st_dev, outside.st_ino):
        raise ImagePathRefused('scratch_unverified')
    if cache:
        inside_cache = (proc / 'root' / PUBLIC_ROOT.relative_to('/')).lstat()
        outside_cache = (temporary / CACHE_NAME).lstat()
        if (not stat.S_ISDIR(inside_cache.st_mode) or
                (inside_cache.st_dev, inside_cache.st_ino) != (outside_cache.st_dev, outside_cache.st_ino)):
            raise ImagePathRefused('scratch_unverified')
    if (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19] != start:
        raise ImagePathRefused('binding_changed')
    return start, outside


class WorkerChatImages:
    def __init__(self, broker):
        self.broker = broker
        self.lock = threading.Lock()
        self.caches = {}
        self.admission = threading.BoundedSemaphore(2)

    def _observe(self, sid, *, cache=False):
        broker = self.broker
        if broker.stopping.is_set() or broker.draining.is_set() or not broker.allowed(sid):
            raise ImagePathRefused('laptop_unavailable')
        generation = broker.generation
        paths = storage_paths(broker.config, sid)
        if paths.kind != 'employee' or not storage_start_allowed(broker.config, paths):
            raise ImagePathRefused('binding_changed')
        name = broker.config['deployment'] + '-agent-' + sid
        item = broker.inspect_container(name)
        state = item.get('State', {})
        labels = item.get('Config', {}).get('Labels') or {}
        if (item.get('Name') != '/' + name or type(item.get('Id')) is not str
                or len(item['Id']) != 64 or any(c not in '0123456789abcdef' for c in item['Id'])
                or labels.get('reverie.worker') != broker.config['deployment']
                or labels.get('reverie.session') != sid or labels.get('reverie.employee') != paths.identity
                or item.get('Config', {}).get('User') != f"{broker.config['uid']}:{broker.config['gid']}"
                or state.get('Running') is not True or state.get('Paused') is not False
                or state.get('Restarting') is not False or state.get('Dead') is not False
                or type(state.get('Pid')) is not int or state['Pid'] <= 0):
            raise ImagePathRefused('laptop_unavailable')
        mounts = item.get('Mounts')
        attachment_masks(broker.config, mounts)
        private_root = Path(paths.root).resolve(strict=True)
        for mount in mounts:
            if mount.get('Type') != 'bind':
                continue
            source = Path(mount['Source']).resolve(strict=True)
            if (private_root.is_relative_to(source) or
                    source.parent == private_root and source.name.startswith('.chat-image-custody')):
                raise ImagePathRefused('custody_exposed')
        temporary = Path(paths.scratch) / 'tmp'
        exact = [mount for mount in mounts if mount.get('Destination') == '/tmp']
        if (len(exact) != 1 or exact[0].get('Type') != 'bind'
                or exact[0].get('Source') != str(temporary) or exact[0].get('RW') is not True
                or any(Path(mount['Destination']).is_relative_to('/tmp') and mount['Destination'] != '/tmp'
                       for mount in mounts)):
            raise ImagePathRefused('scratch_unverified')
        pid = state['Pid']
        start, outside = namespace_temporary(pid, temporary, cache)
        if sid not in broker.offices or broker.offices[sid].closing.is_set():
            raise ImagePathRefused('office_unavailable')
        socket_path = Path(broker.config['apiSocketRoot']) / sid / 'office.sock'
        socket_info = socket_path.lstat()
        if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != broker.config['uid']:
            raise ImagePathRefused('office_unavailable')
        projection = {'session': sid, 'employee': paths.identity, 'owner': paths.owner, 'storage': str(paths.root),
                      'container': item['Id'], 'image': item.get('Image'), 'pid': pid, 'start': start,
                      'startedAt': state.get('StartedAt'), 'generation': generation,
                      'temporary': [outside.st_dev, outside.st_ino],
                      'office': [socket_info.st_dev, socket_info.st_ino],
                      'mounts': sorted(mounts, key=lambda row: json.dumps(row, sort_keys=True))}
        digest = hashlib.sha256(json.dumps(projection, sort_keys=True).encode()).hexdigest()
        if broker.generation != generation or broker.stopping.is_set() or broker.draining.is_set() or not storage_start_allowed(broker.config, paths):
            raise ImagePathRefused('binding_changed')
        return digest, paths, socket_path

    def _current(self, scope):
        try:
            return self._observe(scope['sessionId'], cache=True)[0] == scope['generation']
        except Exception:
            return False

    def dispatch(self, raw):
        if not self.admission.acquire(blocking=False):
            raise ImagePathRefused('busy')
        try:
            return self._dispatch(raw)
        finally:
            self.admission.release()

    def _dispatch(self, raw):
        value = decode(raw)
        sid = value['sessionId']
        try:
            observed, paths, socket_path = self._observe(sid)
            if value['action'] == 'binding':
                return {'version': 1, 'status': 'bound', 'sessionId': sid, 'generation': observed}
            scope = value['request']
            if scope['generation'] != observed:
                raise ImagePathRefused('binding_changed')
            # The common lock protects construction only; a slow HTTP operation
            # cannot hold admission for another laptop or block the broker lock.
            with self.lock:
                for previous, (_, old_service, old_root) in tuple(self.caches.items()):
                    if previous != sid and old_root == paths.root:
                        old_service.retire()
                        self.caches.pop(previous)
                existing = self.caches.get(sid)
                if existing and existing[0] != observed:
                    existing[1].retire()
                    self.caches.pop(sid)
                    existing = None
                if existing is None:
                    parent = Path(paths.scratch) / 'tmp'
                    fd = directory(parent)
                    try:
                        try:
                            os.mkdir(CACHE_NAME, mode=0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                    finally:
                        os.close(fd)
                    root = parent / CACHE_NAME
                    if self._observe(sid, cache=True)[0] != observed:
                        raise ImagePathRefused('binding_changed')
                    reader = OfficeImageReader(socket_path, sid)
                    custody = ImageCacheCustody(paths.root, root)
                    try:
                        custody.recover()
                        service = ImagePaths(root, PUBLIC_ROOT, reader.fetch, self._current,
                                             checkpoint=custody.checkpoint, close_hook=custody.close)
                    except BaseException:
                        custody.close()
                        raise
                    self.caches[sid] = (observed, service, paths.root)
                else:
                    service = existing[1]
            return service.materialize(scope)
        except ImagePathRefused:
            raise
        except Exception:
            raise ImagePathRefused('materialization_unavailable') from None

    def close(self):
        failures = False
        with self.lock:
            for sid, (_, service, _) in tuple(self.caches.items()):
                try:
                    service.close()
                    self.caches.pop(sid)
                except Exception:
                    failures = True
        return not failures
