"""Owner-only, fenced offline copies of one laptop Nix store. Never wakes laptops.

Run inventory or plan first. Mutating phases require --apply, a private receipt,
and the reviewed broker that holds store_guard through container startup.
"""
from __future__ import annotations
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import uuid

from .worker import load_config
from .worker_nix import SESSION, session_directory, store_guard


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def private_json(path, value, exclusive=False):
    """Private atomic receipt; an interrupted copy never implies publication."""
    path = Path(path)
    if path.parent.resolve() != path.parent:
        raise ValueError('Receipt directory must be canonical')
    info = path.parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Receipt directory must be owner-only')
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, sort_keys=True, indent=2)
        out.write('\n'); out.flush(); os.fsync(out.fileno())
    if exclusive:
        os.link(temp, path)
        temp.unlink()
    else:
        os.replace(temp, path)
    sync_directory(path.parent)


def read_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Receipt must be an owner-only regular file')
    return json.loads(path.read_text())


def tree_digest(root, uid):
    """Hash bytes, links, permissions and ownership without following links."""
    root = Path(root)
    if root.resolve() != root or not root.is_dir():
        raise ValueError('Store root must be a canonical directory')
    result = hashlib.sha256(); size = 0; count = 0
    for current, dirs, files in os.walk(root, followlinks=False):
        for path in [Path(current)] + [Path(current)/n for n in sorted(dirs + files)]:
            # Child directories are included on their own walk iteration.
            if path != Path(current) and path.is_dir() and not path.is_symlink():
                continue
            info = path.lstat()
            if info.st_uid != uid or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError('Store contains unsupported ownership or special files')
            result.update(json.dumps([str(path.relative_to(root)), info.st_mode, info.st_uid, info.st_gid]).encode())
            if stat.S_ISLNK(info.st_mode): result.update(os.readlink(path).encode())
            elif stat.S_ISREG(info.st_mode):
                with path.open('rb') as source:
                    for block in iter(lambda: source.read(1024*1024), b''): result.update(block)
                size += info.st_size
            count += 1
        dirs.sort()
    return dict(sha256=result.hexdigest(), bytes=size, entries=count)


def registration(root):
    # A read-only SQLite connection can still update/create WAL shared memory.
    # Validate an independent DB+WAL copy, leaving both offline stores untouched.
    db = Path(root)/'var/nix/db/db.sqlite'
    temporary=Path(os.environ.get('TMPDIR',Path.home()/'scratch/reverie/nix-migration-tmp')).resolve()
    temporary.mkdir(mode=0o700,parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='nix-db-',dir=temporary) as folder:
        target=Path(folder)/db.name
        for source in (db,db.with_name(db.name+'-wal')):
            if source.exists():
                if not stat.S_ISREG(source.lstat().st_mode): raise ValueError('Database file must be regular')
                shutil.copyfile(source,Path(folder)/source.name)
        with closing(sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)) as conn:
            if conn.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Nix database integrity check failed')
            paths = [r[0] for r in conn.execute('SELECT path FROM ValidPaths ORDER BY path')]
    return dict(paths=len(paths), sha256=digest(paths))


def profile_digest(home):
    """Only profile links/files, never other private home or account data."""
    values = []
    for relative in ('.nix-profile', '.local/state/nix/profiles', '.nix-defexpr'):
        top = home/relative
        if not top.exists() and not top.is_symlink(): continue
        pending = [top]
        while pending:
            path = pending.pop(); info = path.lstat()
            row = [str(path.relative_to(home)), info.st_mode]
            if path.is_symlink(): row.append(os.readlink(path))
            elif path.is_dir(): pending.extend(sorted(path.iterdir(), reverse=True))
            elif path.is_file():
                if info.st_size > 16*1024*1024: raise ValueError('Unexpected profile file size')
                row.append(hashlib.sha256(path.read_bytes()).hexdigest())
            else: raise ValueError('Unexpected profile special file')
            values.append(row)
    return digest(values)


class Migration:
    def __init__(self, config, engine='docker'):
        self.config = config; self.engine = engine

    def run(self, args, timeout=120):
        r = subprocess.run([self.engine, *args], text=True, capture_output=True, timeout=timeout)
        if r.returncode: raise RuntimeError('Engine operation failed: ' + args[0])
        return r.stdout

    def containers(self, deployment_only=False):
        args = ['ps', '-aq']
        if deployment_only: args += ['--filter', 'label=reverie.worker='+self.config['deployment']]
        ids = self.run(args).split()
        return json.loads(self.run(['inspect', *ids])) if ids else []

    def target(self, sid, expected=None):
        items = json.loads(self.run(['inspect', self.config['deployment']+'-agent-'+sid]))
        item = items[0]; labels = item['Config'].get('Labels') or {}
        if labels.get('reverie.worker') != self.config['deployment'] or labels.get('reverie.session') != sid:
            raise ValueError('Container deployment/session mismatch')
        if expected and item['Id'] != expected: raise ValueError('Exact container identity changed')
        return item

    def employee(self, sid):
        company = json.loads(Path(self.config['companyFile']).read_text())
        matches = [(kind, e) for kind in ('employees', 'retired') for e in company.get(kind, []) if e.get('sessionId') == sid]
        if len(matches) != 1: raise ValueError('Session must have exactly one current or retired employee binding')
        kind, e = matches[0]
        selected = {k: e.get(k) for k in ('id', 'sessionId', 'owner', 'runtimeRecipe', 'desiredRunning', 'onVacation')}
        return dict(id=e['id'], binding=digest([kind, selected]), eligible=kind=='employees' and e.get('desiredRunning') is True and not e.get('onVacation'))

    @staticmethod
    def mounts(item):
        return sorted([(m['Type'], m['Source'], m['Destination'], m.get('RW')) for m in item['Mounts']])

    @staticmethod
    def resources(item):
        return digest({k: item['HostConfig'].get(k) for k in ('Memory','MemorySwap','PidsLimit','NanoCpus','CpuQuota','CpuPeriod','CpuShares','CgroupParent','Devices','DeviceRequests','SecurityOpt','CapDrop','ReadonlyRootfs','NetworkMode')})

    def inventory(self):
        return [dict(session=(x['Config'].get('Labels') or {}).get('reverie.session'), container=x['Id'], running=x['State']['Running'],
                     image=x['Image'], replacementImage=self.config['image'], imageMatches=x['Image']==self.config['image'],
                     mounts=[m for m in self.mounts(x) if m[2] in ('/nix','/home/agent','/scratch')]) for x in self.containers(True)]

    def plan(self, sid, direction='durable', sentinel=None, allow_image_upgrade=False):
        if not SESSION.fullmatch(sid): raise ValueError('Invalid session identity')
        c = self.config; target = self.target(sid)
        if target['Image'] != c['image'] and not allow_image_upgrade:
            raise ValueError('Selected laptop image differs from broker image; separately review image compatibility before recreation')
        durable = Path(c['stateRoot'])/sid/'nix'; legacy = Path(c['scratchRoot'])/sid/'nix'
        source, destination = (legacy, durable) if direction == 'durable' else (durable, legacy)
        bound = [m for m in target['Mounts'] if m['Destination'] == '/nix']
        if len(bound) != 1 or bound[0]['Source'] != str(source) or not bound[0]['RW'] or bound[0]['Type'] != 'bind':
            raise ValueError('Exact source store binding does not match direction')
        if source.resolve() != source or source.stat().st_uid != c['uid'] or source.stat().st_mode & 0o077:
            raise ValueError('Store must be a private owned canonical directory')
        home = Path(c['stateRoot'])/sid/'home'
        if not any(m['Source']==str(home) and m['Destination']=='/home/agent' for m in target['Mounts']):
            raise ValueError('Private home binding differs')
        if sentinel and not re.fullmatch(r'/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+', sentinel):
            raise ValueError('Sentinel must be a Nix store path')
        if target['State']['Running'] and not sentinel:
            raise ValueError('Running laptop migration requires a registered non-base sentinel before planning')
        sentinel_hash = None
        if sentinel:
            if not target['State']['Running']: raise ValueError('Capture sentinel proof before stopping the selected laptop')
            sentinel_hash = self.run(['exec',target['Id'],'nix-store','--query','--hash',sentinel]).strip()
        peers = {x['Id']: dict(running=x['State']['Running'], pid=x['State']['Pid']) for x in self.containers(True) if x['Id'] != target['Id']}
        token = uuid.uuid4().hex
        return dict(version=1, token=token, session=sid, config=digest(c), direction=direction,
                    source=str(source), destination=str(destination), stage=str(destination.with_name('nix.stage-'+token)),
                    retained=str(destination.with_name('nix.retained-'+token)), container=target['Id'], image=target['Image'], replacementImage=c['image'],
                    running=target['State']['Running'], pid=target['State']['Pid'], employee=self.employee(sid), mounts=self.mounts(target), resources=self.resources(target),
                    profiles=profile_digest(home), sentinel=sentinel, sentinelHash=sentinel_hash, peers=peers, phase='planned')

    def check(self, plan, exact=True):
        sid=plan['session']; token=plan['token']
        if plan.get('version') != 1 or not SESSION.fullmatch(sid) or not re.fullmatch('[a-f0-9]{32}',token):
            raise ValueError('Invalid migration receipt identity')
        durable=Path(self.config['stateRoot'])/sid/'nix';legacy=Path(self.config['scratchRoot'])/sid/'nix'
        source,destination=(legacy,durable) if plan['direction']=='durable' else (durable,legacy)
        expected=dict(source=str(source),destination=str(destination),stage=str(destination.with_name('nix.stage-'+token)),retained=str(destination.with_name('nix.retained-'+token)))
        if plan['direction'] not in ('durable','legacy') or any(plan[k]!=v for k,v in expected.items()):
            raise ValueError('Receipt paths differ from fixed laptop storage locations')
        if plan['config'] != digest(self.config): raise ValueError('Broker configuration changed; prepare a fresh plan')
        if self.employee(plan['session']) != plan['employee']: raise ValueError('Employee binding, runtime recipe or running intent changed')
        item = self.target(plan['session'], plan['container'] if exact else None)
        if profile_digest(Path(self.config['stateRoot'])/plan['session']/'home') != plan['profiles']:
            raise ValueError('Profiles changed; halt and inspect')
        peers = {x['Id']:dict(running=x['State']['Running'],pid=x['State']['Pid']) for x in self.containers(True) if (x['Config'].get('Labels') or {}).get('reverie.session') != plan['session']}
        if peers != plan['peers']: raise ValueError('A peer laptop changed; halt for coordinator review')
        return item

    def no_writers(self, plan):
        roots = [Path(plan[k]) for k in ('source','destination','stage')]
        for item in self.containers():
            if not item['State']['Running']: continue
            for m in item['Mounts']:
                if m.get('RW') and m['Type']=='bind':
                    path = Path(m['Source']).resolve()
                    if any(path.is_relative_to(root) or root.is_relative_to(path) for root in roots):
                        raise ValueError('A running container can write a migration store')

    def fence(self, plan):
        return Path(self.config['stateRoot'])/plan['session']/'nix-migration.json'

    def require_fence(self, plan):
        if read_private(self.fence(plan)) != {'version':1,'token':plan['token']}:
            raise ValueError('Migration fence belongs to another operation')

    def phase(self, action, plan, save):
        sid = plan['session']
        with store_guard(self.config, sid, migration=True):
            item = self.check(plan, exact=action != 'verify')
            fence = self.fence(plan)
            if action == 'quiesce':
                if plan['phase'] != 'planned': raise ValueError('Quiesce requires a fresh plan')
                if plan['running'] and not plan['sentinel']:
                    raise ValueError('Running laptop migration requires a registered non-base sentinel before quiescence')
                if item['State']['Running'] != plan['running'] or item['State']['Pid'] != plan['pid']:
                    raise ValueError('Selected laptop running state/PID changed; obtain a fresh checkpoint and plan')
                private_json(fence, {'version':1,'token':plan['token']}, exclusive=True)
                # Preserve the target and every peer; no rm, no wake, no API writes.
                if item['State']['Running']: self.run(['stop','--time','20',plan['container']])
                if self.target(sid,plan['container'])['State']['Running']: raise RuntimeError('Selected laptop did not stop')
                self.no_writers(plan); plan['phase']='quiesced'; save(plan)
                return
            if action != 'verify': self.require_fence(plan)
            if action in ('stage','publish','abort'):
                if item['State']['Running']: raise ValueError('Selected laptop must remain stopped')
                self.no_writers(plan)
            if action == 'stage':
                if plan['phase'] != 'quiesced': raise ValueError('Stage requires quiescence')
                source=Path(plan['source']); stage=Path(plan['stage']); destination=Path(plan['destination'])
                previous=tree_digest(destination,self.config['uid']) if destination.exists() else None
                before=tree_digest(source,self.config['uid']); db=registration(source)
                if shutil.disk_usage(destination.parent).free < before['bytes'] + 512*1024**2: raise ValueError('Insufficient durable disk headroom')
                stage.mkdir(mode=0o700)
                subprocess.run(['cp','--archive','--reflink=auto','--',str(source)+'/.',str(stage)],check=True,capture_output=True,timeout=3600)
                if tree_digest(stage,self.config['uid']) != before or tree_digest(source,self.config['uid']) != before or registration(stage) != db:
                    raise ValueError('Copied store/database changed or failed verification; retain stage and fence')
                subprocess.run(['sync','-f',str(stage)],check=True,capture_output=True,timeout=300)
                self.no_writers(plan)
                plan.update(phase='staged',tree=before,registrations=db,previousDestination=previous); save(plan)
            elif action == 'publish':
                if plan['phase'] not in ('staged','published'): raise ValueError('Publish requires a verified stage')
                source=Path(plan['source']); stage=Path(plan['stage']); destination=Path(plan['destination'])
                if tree_digest(source,self.config['uid']) != plan['tree']: raise ValueError('Source changed')
                rollback = Path(self.config['stateRoot'])/sid/'nix-rollback.json'
                retained=Path(plan['retained'])
                if stage.exists():
                    if tree_digest(stage,self.config['uid']) != plan['tree']: raise ValueError('Stage changed')
                    if destination.exists():
                        if retained.exists() or not plan['previousDestination'] or tree_digest(destination,self.config['uid']) != plan['previousDestination']:
                            raise ValueError('Existing destination changed; no overwrite')
                        destination.rename(retained)
                    elif plan['previousDestination'] and (not retained.exists() or tree_digest(retained,self.config['uid']) != plan['previousDestination']):
                        raise ValueError('Retained original destination is unavailable')
                    stage.rename(destination)
                elif not destination.exists() or tree_digest(destination,self.config['uid']) != plan['tree']:
                    raise ValueError('Interrupted publication has no verified destination')
                subprocess.run(['sync','-f',str(destination)],check=True,capture_output=True,timeout=300)
                if plan['direction']=='legacy': private_json(rollback, {'version':1,'sessionId':sid,'legacy':True})
                else:
                    if rollback.exists(): rollback.unlink()
                    # A resurrected selector could silently select the stale legacy
                    # store. Flush absence even on retry after a failed unlink sync.
                    sync_directory(rollback.parent)
                plan['phase']='published'; save(plan)
                fence.unlink()
                sync_directory(fence.parent)
                # Operator now uses the normal owner/scoped wake, only if plan was
                # running AND remains explicitly desired-running/non-vacation.
            elif action == 'abort':
                if plan['phase'] not in ('planned','quiesced','staged'): raise ValueError('Published migration needs a fresh reverse-direction plan')
                rollback = Path(self.config['stateRoot'])/sid/'nix-rollback.json'
                if plan['direction']=='durable': private_json(rollback, {'version':1,'sessionId':sid,'legacy':True})
                else:
                    if rollback.exists(): rollback.unlink()
                    sync_directory(rollback.parent)
                plan['phase']='aborted'; save(plan); fence.unlink()
                sync_directory(fence.parent)
            elif action == 'verify':
                if plan['phase'] != 'published': raise ValueError('Verify requires publication and explicit normal recreation')
                if item['Id']==plan['container']: raise ValueError('Fresh container recreation has not occurred')
                if not plan['running'] or not plan['employee']['eligible']: raise ValueError('Originally stopped/vacation/retired targets must stay stopped; defer runtime proof until an authorized wake')
                if not item['State']['Running'] or item['Image'] != plan['replacementImage'] or self.resources(item) != plan['resources']:
                    raise ValueError('New laptop image, state or resources differ')
                expected=[list(m) for m in plan['mounts']]
                for m in expected:
                    if m[2]=='/nix': m[1]=plan['destination']
                if sorted(expected) != [list(m) for m in self.mounts(item)]: raise ValueError('Mount/account/device grants changed')
                if not plan['sentinel']: raise ValueError('Non-base registered sentinel proof was not captured before migration')
                if self.run(['exec',item['Id'],'nix-store','--query','--hash',plan['sentinel']]).strip()!=plan['sentinelHash']:
                    raise ValueError('Registered non-base sentinel changed')
                self.run(['exec',item['Id'],'nix-store','--verify-path',plan['sentinel']])
                if self.run(['exec',item['Id'],'curl','--max-time','10','--silent','--output','/dev/null','--write-out','%{http_code}','http://127.0.0.1:8093/api/company']).strip()!='200':
                    raise ValueError('Scoped office API is unavailable')
                if self.run(['exec',item['Id'],'/bin/tmux','-u','-L','reverie-laptop','display-message','-p','-t','office','#{pane_dead}']).strip()!='0':
                    raise ValueError('Provider terminal has exited')
                plan.update(phase='verified',replacement=item['Id'],verifiedAt=time.time()); save(plan)
            else: raise ValueError('Unknown migration phase')


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',type=Path,default=Path.home()/'reverie/runtime/worker-isolation/broker.json')
    p.add_argument('--engine',choices=('docker','podman'),default='docker')
    p.add_argument('--apply',action='store_true',help='Execute the selected phase; default is read-only')
    p.add_argument('--broker-ready',action='store_true',help='Operator verified reviewed broker store_guard is active and transports healthy')
    p.add_argument('--checkpoint',help='Owner/team checkpoint reference required before stopping exactly this laptop')
    sub=p.add_subparsers(dest='action',required=True); sub.add_parser('inventory')
    plan=sub.add_parser('plan'); plan.add_argument('--session',required=True); plan.add_argument('--direction',choices=('durable','legacy'),default='durable');plan.add_argument('--sentinel');plan.add_argument('--receipt',type=Path,required=True)
    plan.add_argument('--allow-image-upgrade',action='store_true',help='Explicit separately reviewed compatibility gate; record current broker image as replacement')
    for name in ('quiesce','stage','publish','verify','abort'):
        sub.add_parser(name).add_argument('--receipt',type=Path,required=True)
    a=p.parse_args(argv); os.umask(0o077)
    migration=Migration(load_config(a.config),a.engine)
    if a.action=='inventory': print(json.dumps(migration.inventory(),indent=2)); return
    if a.action=='plan':
        value=migration.plan(a.session,a.direction,a.sentinel,a.allow_image_upgrade)
        if a.apply: private_json(a.receipt,value,exclusive=True)
        print(json.dumps(value,indent=2));return
    value=read_private(a.receipt)
    if not a.apply:
        migration.check(value,exact=a.action!='verify')
        print(json.dumps(dict(action=a.action,phase=value['phase'],session=value['session'],dryRun=True)));return
    if not a.broker_ready: p.error('--broker-ready requires actual reviewed broker activation before mutation')
    if a.action=='quiesce' and not a.checkpoint: p.error('--checkpoint is required before selected laptop quiescence')
    if a.checkpoint: value['checkpoint']=a.checkpoint
    migration.phase(a.action,value,lambda v:private_json(a.receipt,v))
    print(json.dumps(dict(action=a.action,phase=value['phase'],session=value['session'])))


if __name__=='__main__': main()
