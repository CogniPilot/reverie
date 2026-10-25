"""Trusted employee-owned laptop data; session IDs identify transports, never people.

Resolvers are read-only. Preparing storage and holding a lease are explicit host
operations. Human labels are never accepted as storage or API authority.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import stat

UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
PHASES = {'waiting','creating','starting','checking','stopping','completed','failed','recovery-required','quiescing'}


def require_uuid(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError('Canonical laptop identity is unavailable')
    return value


def canonical(path):
    if isinstance(path,str) and str(Path(path))!=path:
        raise ValueError('Canonical laptop storage path required')
    path = Path(path)
    if not path.is_absolute() or path.anchor != '/' or '..' in path.parts or path.resolve() != path:
        raise ValueError('Canonical laptop storage path required')
    return path


def read_metadata(path, uid, limit=16*1024**2):
    path = canonical(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != uid or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > limit:
            raise ValueError('Trusted laptop metadata unavailable')
        chunks = []; count = 0
        while data := os.read(fd, min(1024**2, limit + 1 - count)):
            count += len(data)
            if count > limit: raise ValueError('Laptop metadata exceeds bound')
            chunks.append(data)
        after = os.fstat(fd); current = path.lstat()
        fields = lambda s: (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        if count != before.st_size or fields(before) != fields(after) or fields(after) != fields(current):
            raise ValueError('Laptop metadata changed during read')
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value: raise ValueError('Duplicate laptop metadata key')
                value[key] = item
            return value
        return json.loads(b''.join(chunks), object_pairs_hook=unique)
    finally: os.close(fd)


def company_records(config):
    company = read_metadata(config['companyFile'], config['uid'])
    if not isinstance(company, dict) or not isinstance(company.get('employees'), list) or not isinstance(company.get('retired', []), list):
        raise ValueError('Canonical employee registry unavailable')
    records = [*company['employees'], *company.get('retired', [])]
    if len(records) > 10000 or any(not isinstance(row,dict) for row in records):
        raise ValueError('Canonical employee registry exceeds bounds')
    if any(row.get('owner') is not None and (not isinstance(row['owner'],str) or len(row['owner'])>200) for row in records):
        raise ValueError('Canonical employee owner is unavailable')
    ids = [row.get('id') for row in records]
    sessions = [row.get('sessionId') for row in records if row.get('sessionId') is not None]
    if any(not isinstance(key,str) for key in ids) or len(ids) != len(set(ids)) or len(sessions) != len(set(sessions)):
        raise ValueError('Ambiguous canonical employee identity')
    return records


@dataclass(frozen=True)
class StoragePaths:
    kind: str
    identity: str
    root: Path
    home: Path
    nix: Path
    scratch: Path
    session: str
    owner: str | None

    @property
    def key(self): return self.kind + '-' + self.identity


def storage_paths(config, session_id):
    """Exact trusted company/journal lookup, no name or caller employee argument.

    Historical plan-session edges retain their employee's storage identity, but
    grant no execution eligibility. Unbound ordinary sessions explicitly retain
    the separate legacy SID namespace; no employee identity is synthesized.
    """
    require_uuid(session_id)
    records = company_records(config)
    matches = [row for row in records if row.get('sessionId') == session_id]
    indexed=Path(config['stateRoot'])/session_id/'storage-owner.json'
    if indexed.exists() or indexed.is_symlink():
        value=read_metadata(indexed,config['uid'],limit=65536)
        if not isinstance(value,dict) or set(value)!={'version','employeeId','sessionId','owner'} or value['version']!=1 or value['sessionId']!=session_id:
            raise ValueError('Stored laptop employee binding is unavailable')
        require_uuid(value['employeeId'])
        selected=[row for row in records if row['id']==value['employeeId'] and row.get('owner')==value['owner']]
        if len(selected)!=1 or (matches and matches!=selected):
            raise ValueError('Stored laptop employee binding conflicts with company')
        matches=selected
    journal = Path(config['companyFile']).with_name('plan-moves.json')
    if not matches and (journal.exists() or journal.is_symlink()):
        moves = read_metadata(journal, config['uid'], limit=1024**2)
        if not isinstance(moves,list) or len(moves)>100: raise ValueError('Plan storage journal unavailable')
        selected = set()
        for move in moves:
            if not isinstance(move,dict): raise ValueError('Plan storage journal unavailable')
            if session_id not in (move.get('oldSession'), move.get('newSession')): continue
            if move.get('phase') not in PHASES: raise ValueError('Unknown plan storage phase')
            candidates = [row for row in records if row.get('id') == move.get('employeeId') and row.get('owner') == move.get('owner')]
            if len(candidates)!=1: raise ValueError('Plan storage employee binding changed')
            selected.add(candidates[0]['id'])
        if len(selected)>1: raise ValueError('Ambiguous plan storage identity')
        if selected: matches = [row for row in records if row['id'] in selected]
    base, scratch = canonical(config['stateRoot']), canonical(config['scratchRoot'])
    if matches:
        row = matches[0]; identity = require_uuid(row['id'])
        root = base/'employees'/identity
        return StoragePaths('employee',identity,root,root/'home',root/'nix',scratch/'employees'/identity,session_id,row.get('owner'))
    root = base/session_id
    return StoragePaths('session',session_id,root,root/'home',root/'nix',scratch/session_id,session_id,None)


def storage_start_allowed(config, paths):
    """A historical storage edge never authorizes a new employee process."""
    if storage_paths(config,paths.session)!=paths:return False
    if paths.kind=='session':return True  # Existing outer session/owner gates still apply.
    company=read_metadata(config['companyFile'],config['uid'])
    selected=[row for row in company['employees'] if row.get('id')==paths.identity and
              row.get('sessionId')==paths.session and row.get('owner')==paths.owner]
    return len(selected)==1 and selected[0].get('desiredRunning') is not False and not selected[0].get('onVacation')


def private_directory(path, uid, *, create=False):
    path = canonical(path)
    if create:
        try:
            path.mkdir(mode=0o700)
            parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(parent)
            finally:os.close(parent)
        except FileExistsError: pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise ValueError('Laptop storage must be a private owned directory')
    return path


def storage_base(config, *, create=False):
    root = canonical(config['stateRoot']); scratch = canonical(config['scratchRoot'])
    if root == scratch or root.is_relative_to(scratch) or any(root.is_relative_to(canonical(m['source'])) for m in config.get('mounts', [])):
        raise ValueError('Durable laptop state must be outside scratch/shared mounts')
    return private_directory(root, config['uid'], create=create)


def lock_paths(config, paths, *, create=False):
    base = storage_base(config, create=create)
    directory = private_directory(base/'storage-locks', config['uid'], create=create)
    return directory/(paths.key+'.lock'), directory/(paths.key+'.migration.json')


@contextmanager
def storage_guard(config, session_id, *, migration=False):
    """One employee home/store owner across all transports, including migrations.

    The broker must retain this context for the *laptop lifetime*, not the
    terminal viewer lifetime, and also inspect actual running-container writers.
    """
    paths = storage_paths(config, session_id)
    lock, fence = lock_paths(config, paths, create=True)
    fd = os.open(lock, os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC, 0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=config['uid'] or info.st_nlink!=1 or info.st_mode & 0o077:
            raise ValueError('Invalid stable laptop lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if not migration and (fence.exists() or fence.is_symlink()):
            raise RuntimeError('Employee laptop data is fenced for migration')
        if storage_paths(config,session_id)!=paths: raise RuntimeError('Employee laptop binding changed')
        yield paths
    finally: os.close(fd)


def prepare_storage(config, paths):
    """Create only genuinely new storage; never hide legacy home/Nix data."""
    if storage_paths(config,paths.session)!=paths: raise RuntimeError('Employee laptop binding changed')
    base=storage_base(config,create=True)
    if paths.kind=='employee':
        private_directory(base/'employees',config['uid'],create=True)
        sessions={paths.session}
        journal=Path(config['companyFile']).with_name('plan-moves.json')
        if journal.exists() or journal.is_symlink():
            moves=read_metadata(journal,config['uid'],limit=1024**2)
            if not isinstance(moves,list) or len(moves)>100:raise ValueError('Plan storage journal unavailable')
            for move in moves:
                if not isinstance(move,dict):raise ValueError('Plan storage journal unavailable')
                if move.get('employeeId')==paths.identity and move.get('owner')==paths.owner:
                    if move.get('phase') not in PHASES:raise ValueError('Unknown plan storage phase')
                    sessions.update(require_uuid(move[key]) for key in ('oldSession','newSession') if move.get(key))
        legacy=[p for sid in sessions for p in (base/sid/'home',base/sid/'nix',Path(config['scratchRoot'])/sid/'nix')]
        marker=paths.root/'storage.json'
        if any(p.exists() or p.is_symlink() for p in legacy) and not marker.exists():
            raise RuntimeError('Employee home and Nix require paired offline migration; refusing empty storage')
        if marker.exists() or marker.is_symlink():
            value=read_metadata(marker,config['uid'],limit=65536)
            if value!={'version':1,'kind':paths.kind,'identity':paths.identity,'state':'ready'}:
                raise ValueError('Employee storage publication identity changed')
            private_directory(paths.root,config['uid']);private_directory(paths.home,config['uid'])
            private_directory(paths.nix,config['uid'])
            return paths
    private_directory(paths.root,config['uid'],create=True)
    private_directory(paths.home,config['uid'],create=True)
    if paths.kind=='employee':
        private_directory(paths.nix,config['uid'],create=True)
        fd=os.open(paths.root/'storage.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            value=json.dumps({'version':1,'kind':paths.kind,'identity':paths.identity,'state':'ready'},sort_keys=True).encode()
            view=memoryview(value)
            while view:
                count=os.write(fd,view)
                if count<=0:raise OSError('Laptop storage marker short write')
                view=view[count:]
            os.fsync(fd)
        finally:os.close(fd)
        directory=os.open(paths.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(directory)
        finally:os.close(directory)
    return paths


def validate_storage(config, paths):
    """Read-only restart admission; never initializes data beneath a live bind."""
    storage_base(config)
    private_directory(paths.root,config['uid']);private_directory(paths.home,config['uid'])
    if paths.kind=='employee':
        private_directory(paths.nix,config['uid'])
        marker=read_metadata(paths.root/'storage.json',config['uid'],limit=65536)
        if marker!={'version':1,'kind':paths.kind,'identity':paths.identity,'state':'ready'}:
            raise ValueError('Employee storage publication identity changed')
    return paths


def record_storage_binding(config, paths):
    """Host-private lineage survives plan-journal pruning; no execution grant.

    Publication may record an OFF employee's data. Only an exact *current*
    employee/session binding may create this index; historical reads cannot.
    """
    if paths.kind!='employee':return
    company=read_metadata(config['companyFile'],config['uid'])
    if not any(row.get('id')==paths.identity and row.get('sessionId')==paths.session and
               row.get('owner')==paths.owner for row in company['employees']):
        raise ValueError('Current employee binding required for storage lineage')
    directory=private_directory(Path(config['stateRoot'])/paths.session,config['uid'],create=True)
    path=directory/'storage-owner.json'
    value={'version':1,'employeeId':paths.identity,'sessionId':paths.session,'owner':paths.owner}
    if path.exists() or path.is_symlink():
        if read_metadata(path,config['uid'],limit=65536)!=value:raise ValueError('Stored laptop lineage changed')
        return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        data=memoryview(json.dumps(value,sort_keys=True).encode())
        while data:
            count=os.write(fd,data)
            if count<=0:raise OSError('Storage lineage short write')
            data=data[count:]
        os.fsync(fd)
    finally:os.close(fd)
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
