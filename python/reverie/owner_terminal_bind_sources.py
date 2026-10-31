"""Existing bind-source aliases: held path custody and actual live kernel join only."""
from collections import deque
from contextlib import contextmanager
import copy
import os
from pathlib import Path
import stat
import time

from .owner_terminal_channel import need, read_proc
from .linux_root_files import open_in_root
from .worker_cold_tmp import read_mount_table, refuse_host_mount_aliases, refuse_mount_aliases


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


def _close(fds):
    failed = False
    for fd in reversed(fds):
        try:os.close(fd)
        except OSError:failed = True
    need(not failed, 'H_BIND_DESCRIPTOR_CLOSE_UNCONFIRMED')


def _path(value):
    need(type(value) is str and 0 < len(os.fsencode(value)) <= 4096 and value.startswith('/')
         and not value.startswith('//') and str(Path(value)) == value and '..' not in Path(value).parts
         and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'H_BIND_SOURCE_PATH')
    return Path(value)


def _source(value):
    """Intentionally resolve bounded symlinks using held nofollow parent FDs.

    Only existing directory aliases are supported. Nothing creates a source,
    reads payloads, or changes the lexical engine mount specification.
    """
    path = _path(value); queue = deque(path.parts[1:]); stack = []; records = []; links = 0
    flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        stack.append((Path('/'), os.open('/', flags | os.O_DIRECTORY)))
        while queue:
            need(len(records) < 256, 'H_BIND_SOURCE_COMPONENT_BOUND')
            part = queue.popleft()
            if part in ('', '.'):continue
            if part == '..':
                if len(stack) > 1:os.close(stack.pop()[1])
                continue
            parent, fd = stack[-1]; named = parent / part
            child = os.open(part, flags, dir_fd=fd)
            try:
                before = os.fstat(child)
                if stat.S_ISLNK(before.st_mode):
                    links += 1;need(links <= 40, 'H_BIND_SOURCE_LINK_BOUND')
                    need(before.st_uid==os.getuid(),'H_BIND_ALIAS_OWNER_REQUIRED')
                    target = os.readlink(part, dir_fd=fd)
                    need(0 < len(os.fsencode(target)) <= 4096 and
                         not any(ord(c) < 32 or ord(c) == 127 for c in target), 'H_BIND_SOURCE_LINK')
                    need(_identity(os.stat(part, dir_fd=fd, follow_symlinks=False)) == _identity(before),
                         'H_BIND_SOURCE_CHANGED')
                    records.append((str(named), _identity(before), before.st_ctime_ns, before.st_mtime_ns, target))
                    if target.startswith('/'):
                        while len(stack) > 1:os.close(stack.pop()[1])
                    queue.extendleft(reversed(Path(target).parts[1:] if target.startswith('/') else Path(target).parts))
                else:
                    need(stat.S_ISDIR(before.st_mode) or not queue and not links and not stat.S_ISLNK(before.st_mode),
                         'H_BIND_DIRECTORY_ALIAS_REQUIRED')
                    records.append((str(named), _identity(before)))
                    stack.append((named, child));child = None
            finally:
                if child is not None:os.close(child)
        target, fd = stack[-1]; info = os.fstat(fd)
        need(str(target.resolve(strict=True)) == str(target) and _identity(target.lstat()) == _identity(info),
             'H_BIND_SOURCE_CHANGED')
        if links:need(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700,
                      'H_BIND_ALIAS_PRIVATE_DIRECTORY_REQUIRED')
        result={'source':str(path),'canonical':str(target),'chain':records,'identity':_identity(info),'aliased':bool(links)}
        held=os.dup(fd)
    finally:
        try:_close([fd for _, fd in stack])
        except BaseException:
            if 'held' in locals():_close([held])
            raise
    return result,held


def _root(pid):
    return os.open('/proc/'+str(pid)+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)


class BoundMount:
    def __init__(self, engine, row, mount, cache):
        self.engine, self.row, self.mount = engine, row, mount
        self.path = _path(mount['Source']);self.fds = [];self.held = [];self.retained = False
        self.facts = None;self.guest_table = None;self.item = None;self.process = None;self.closed=False
        try:
            self.facts, fd = _source(str(self.path));self.path = Path(self.facts['canonical'])
            self.fds.append(fd);self.held.append((fd, _identity(os.fstat(fd))))
            if row['Id'] not in cache:cache[row['Id']]=self._inspect()
            item=cache[row['Id']];state=item['State'];self.item=item
            matches=[m for m in item['Mounts'] if all(m.get(k)==mount.get(k) for k in ('Type','Source','Destination','RW'))]
            need(len(matches)==1,'H_BIND_MOUNT_CHANGED')
            if state['Running']:
                self.process = read_proc(state['Pid'])
                root = _root(state['Pid'])
                self.fds.append(root);self.held.append((root, _identity(os.fstat(root))))
                guest = open_in_root(root, mount['Destination'], path_link=True)
                self.fds.append(guest);self.held.append((guest, _identity(os.fstat(guest))))
                need(_identity(os.fstat(guest)) == self.facts['identity'], 'H_BIND_GUEST_SOURCE_CHANGED')
                self.guest_table = read_mount_table(state['Pid'])
        except BaseException:
            self.close();raise

    def _inspect(self):
        cid = self.row['Id'];need(type(cid) is str and len(cid) == 64 and all(c in '0123456789abcdef' for c in cid),
                                'H_BIND_CONTAINER_ID')
        raw = self.engine.get('/containers/' + cid + '/json');state = raw['State']
        need(raw['Id'] == cid and raw['Image'] == self.row['ImageID'] and raw['Name'] in self.row['Names']
             and state['Status'] == self.row['State'] and type(state['Running']) is bool
             and type(state['Pid']) is int and all(type(state[k]) is bool and state[k] is False
                 for k in ('Paused','Restarting','Dead')),
             'H_BIND_CONTAINER_CHANGED')
        need((state['Running'] and state['Status'] == 'running' and state['Pid'] > 1) or
             (not state['Running'] and state['Status'] in ('created', 'exited') and state['Pid'] == 0),
             'H_BIND_CONTAINER_STATE_UNKNOWN')
        selected = [m for m in raw['Mounts'] if all(m.get(k) == self.mount.get(k)
                    for k in ('Type', 'Source', 'Destination', 'RW'))]
        need(len(selected) == 1, 'H_BIND_MOUNT_CHANGED')
        return {k:copy.deepcopy(raw[k]) for k in ('Id', 'Image', 'Name', 'State', 'Mounts')}

    def check_source(self):
        need(not self.closed,'H_BIND_PROOF_CLOSED')
        if self.facts is None:
            need(self.path.resolve(strict=True) == self.path, 'H_BIND_SOURCE_CHANGED');return
        current, fd = _source(self.facts['source'])
        try:need(current == self.facts, 'H_BIND_SOURCE_CHANGED')
        finally:os.close(fd)
        need(all(_identity(os.fstat(fd)) == expected for fd, expected in self.held), 'H_BIND_HELD_SOURCE_CHANGED')

    def check(self):
        self.check_source()
        if self.item is not None:
            need(self._inspect() == self.item, 'H_BIND_CONTAINER_CHANGED')
            if self.process is not None:
                pid = self.process['pid'];need(read_proc(pid) == self.process, 'H_BIND_INIT_CHANGED')
                named = _root(pid)
                try:need(_identity(os.fstat(named)) == self.held[1][1], 'H_BIND_INIT_ROOT_CHANGED')
                finally:os.close(named)
                need(read_mount_table(pid) == self.guest_table, 'H_BIND_NAMESPACE_CHANGED')

    def exclude(self, protected, table):
        if self.guest_table is None:refuse_host_mount_aliases(protected, self.path, table)
        else:refuse_mount_aliases(protected, self.path, Path(self.mount['Destination']), table, self.guest_table)

    def retain(self):
        self.retained = True;return self

    def close(self):
        self.closed=True
        fds, self.fds = self.fds, [];self.held = []
        _close(fds)


@contextmanager
def bound_mounts(engine, rows):
    result=[];completed=False;cache={};end=time.monotonic()+30
    def check():
        seen=set()
        for item in result:
            need(time.monotonic()<end,'H_BIND_OBSERVATION_DEADLINE')
            item.check_source()
            if item.row['Id'] not in seen:
                item.check();seen.add(item.row['Id'])
    try:
        for row in rows:
            for mount in row['Mounts']:
                if mount.get('Type') == 'bind':
                    need(time.monotonic()<end,'H_BIND_OBSERVATION_DEADLINE')
                    result.append(BoundMount(engine,row,mount,cache))
                    need(sum(bool(item.facts['aliased']) for item in result)<=16,'H_BIND_ALIAS_BOUND')
        check()
        yield result
        check()
        completed = True
    finally:
        failed = False
        for item in reversed(result):
            if not (item.retained and completed):
                try:item.close()
                except Exception:failed = True
        need(not failed, 'H_BIND_DESCRIPTOR_CLOSE_UNCONFIRMED')


def inspected_row(item):
    return {'Id':item['Id'], 'ImageID':item['Image'], 'Names':[item['Name']],
            'Labels':item.get('Config', {}).get('Labels'), 'State':item['State'].get('Status'),
            'Mounts':item['Mounts']}
