"""Owner-only offline paired home/Nix publication by permanent employee identity.

No stop, wake, provider, account, model, grant or intent operation exists here.
The reviewed broker's employee leases/fences must be active before --apply.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import uuid

from .worker import load_config
from .worker_storage import (storage_paths,storage_guard,storage_base,private_directory,
    read_metadata,lock_paths,record_storage_binding,require_uuid)
from .worker_nix import store_guard
from .worker_nix_migrate import (Migration,tree_digest,profile_digest,registration,
    private_json,sync_directory,digest)

SCHEMA='reverie-employee-laptop-migration-v1'
CONFIG_KEYS={'model','continueSession','resumeSessionId','forkSession','reasoningEffort','thinking','effort',
             'autoAllowTools','dangerouslyBypassApprovals','approvalMode','sandboxMode'}


def inode(path):
    info=path.lstat()
    return {'device':info.st_dev,'inode':info.st_ino,'mode':info.st_mode,'uid':info.st_uid,'gid':info.st_gid}


def runtime_selection(config,sid):
    state=read_metadata(Path(config['companyFile']).with_name('state.json'),config['uid'],limit=64*1024**2)
    row=state.get('sessions',{}).get(sid)
    if not isinstance(row,dict) or row.get('id')!=sid:raise ValueError('Saved owned session state unavailable')
    result={key:row.get(key) for key in ('id','mode','workingDir','model','advisorModel','effort','resumeSessionId','subscriptionProfile','runtimeThreads','displayModel')}
    for name in ('codexConfig','openCodeConfig','geminiConfig','antigravityConfig','piConfig','grokConfig','deepSeekConfig','ompConfig'):
        value=row.get(name)
        if isinstance(value,dict):result[name]={key:item for key,item in value.items() if key in CONFIG_KEYS and isinstance(item,(str,bool,int,float))}
    # Never return __envOverrides, auth/config blobs, prompts or transcript bodies.
    return result


def registered_paths(root):
    """Validate a private DB/WAL copy and every registered logical store entry."""
    result=registration(root)
    db=root/'var/nix/db/db.sqlite'
    temporary=Path(os.environ.get('TMPDIR',Path.home()/'scratch/reverie/nix-migration-tmp')).resolve()
    temporary.mkdir(mode=0o700,parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='employee-db-',dir=temporary) as folder:
        for source in (db,db.with_name(db.name+'-wal')):
            if source.exists():shutil.copyfile(source,Path(folder)/source.name)
        with closing(sqlite3.connect((Path(folder)/db.name).as_uri()+'?mode=ro',uri=True)) as connection:
            for (logical,) in connection.execute('SELECT path FROM ValidPaths'):
                path=Path(logical)
                if path.parent!=Path('/nix/store') or path.name in ('.','..') or not (root/'store'/path.name).exists() and not (root/'store'/path.name).is_symlink():
                    raise ValueError('Registered Nix path is missing or outside the private store')
    return result


class EmployeeMigration(Migration):
    def binding(self,sid):
        paths=storage_paths(self.config,sid)
        if paths.kind!='employee':raise ValueError('An exact current employee binding is required')
        company=read_metadata(self.config['companyFile'],self.config['uid'])
        matches=[row for row in company['employees'] if row.get('sessionId')==sid and
                 row.get('id')==paths.identity and row.get('owner')==paths.owner]
        if len(matches)!=1:raise ValueError('Historical or retired storage cannot authorize this migration')
        employee=matches[0]
        # Offline migration is permitted for OFF/vacation employees and preserves
        # exact flags. It never enables a provider to obtain runtime proof.
        selected={key:employee.get(key) for key in ('id','sessionId','owner','desiredRunning','onVacation')}
        selected['runtimeRecipeSha256']=digest(employee.get('runtimeRecipe'))
        return paths,selected

    def no_writers(self,roots):
        for item in self.containers():
            if not item['State']['Running']:continue
            for mount in item['Mounts']:
                if mount['Type']!='bind' or mount.get('RW') is not True:continue
                source=Path(mount['Source']).resolve()
                if any(source==root or source.is_relative_to(root) or root.is_relative_to(source) for root in roots):
                    raise ValueError('A running container can write paired laptop data')

    def plan(self,sid,nix_receipt=None):
        paths,employee=self.binding(sid);storage_base(self.config)
        target=self.target(sid)
        if target['State']['Running'] is not False:raise ValueError('Checkpoint and stop the laptop before planning; this tool never stops it')
        home=Path(self.config['stateRoot'])/sid/'home'
        nix=Path(self.config['stateRoot'])/sid/'nix'
        for path in (home,nix):private_directory(path,self.config['uid'])
        mounts=[list(mount) for mount in self.mounts(target)]
        if not any(m[0]=='bind' and m[1]==str(home) and m[2]=='/home/agent' and m[3] for m in mounts):
            raise ValueError('Original private home mount differs')
        bound=[m for m in mounts if m[2]=='/nix']
        if len(bound)!=1 or bound[0][0]!='bind' or not bound[0][3]:raise ValueError('Original private Nix mount unavailable')
        proof=None
        if bound[0][1]!=str(nix):
            if nix_receipt is None:raise ValueError('Latest durable Nix source requires its published preservation receipt')
            receipt=read_metadata(nix_receipt,self.config['uid'])
            if (receipt.get('session')!=sid or receipt.get('direction')!='durable' or receipt.get('phase') not in ('published','verified') or
                receipt.get('destination')!=str(nix) or receipt.get('container')!=target['Id'] or receipt.get('config')!=digest(self.config)):
                raise ValueError('Durable Nix preservation receipt does not bind this stopped laptop')
            actual=tree_digest(nix,self.config['uid'])
            if actual!=receipt.get('tree') or registration(nix)!=receipt.get('registrations'):
                raise ValueError('Published Nix copy changed after preservation')
            proof={'path':str(Path(nix_receipt)),'sha256':hashlib.sha256(Path(nix_receipt).read_bytes()).hexdigest()}
        if paths.root.exists() or paths.root.is_symlink():raise ValueError('Canonical employee destination already exists; never replace latest data')
        token=uuid.uuid4().hex;stage=paths.root.with_name(paths.identity+'.stage-'+token)
        roots=[home,nix,paths.root,stage];self.no_writers(roots)
        before={name:tree_digest(path,self.config['uid']) for name,path in (('home',home),('nix',nix))}
        parent=paths.root.parent
        while not parent.exists():parent=parent.parent
        if any(path.stat().st_dev!=parent.stat().st_dev for path in (home,nix)):
            raise ValueError('Paired rename requires one durable filesystem; preserve to durable SID storage first')
        return {'schema':SCHEMA,'token':token,'session':sid,'employee':employee,'configSha256':digest(self.config),
                'runtimeSelection':runtime_selection(self.config,sid),'container':target['Id'],
                'sourceMounts':mounts,'sourceResources':self.resources(target),'sourceImage':target['Image'],
                'sources':{'home':str(home),'nix':str(nix)},'sourceIdentities':{'home':inode(home),'nix':inode(nix)},
                'trees':before,'profiles':profile_digest(home),'registrations':registered_paths(nix),
                'destination':str(paths.root),'stage':str(stage),'nixPreservation':proof,'phase':'planned',
                'copyMethod':'same-filesystem-journaled-rename','runtimeAcceptance':'DEFERRED_NO_PROVIDER_STARTED',
                'intentMutation':False,'grantsMutation':False}

    def check(self,plan,*,published=False):
        if plan.get('schema')!=SCHEMA or not isinstance(plan.get('token'),str) or len(plan['token'])!=32 or any(c not in '0123456789abcdef' for c in plan['token']):
            raise ValueError('Invalid paired migration receipt')
        paths,employee=self.binding(plan['session'])
        expected={'home':str(Path(self.config['stateRoot'])/paths.session/'home'),
                  'nix':str(Path(self.config['stateRoot'])/paths.session/'nix')}
        if (plan.get('employee')!=employee or plan.get('configSha256')!=digest(self.config) or
            plan.get('runtimeSelection')!=runtime_selection(self.config,paths.session) or plan.get('sources')!=expected or
            plan.get('destination')!=str(paths.root) or plan.get('stage')!=str(paths.root.with_name(paths.identity+'.stage-'+plan['token']))):
            raise ValueError('Employee/intent/native selection/configuration or fixed paths changed')
        if not published:
            item=self.target(paths.session,plan['container'])
            if item['State']['Running'] is not False or [list(mount) for mount in self.mounts(item)]!=plan['sourceMounts'] or self.resources(item)!=plan['sourceResources'] or item['Image']!=plan['sourceImage']:
                raise ValueError('Stopped source laptop or grants changed')
        self.no_writers([*(Path(v) for v in expected.values()),paths.root,Path(plan['stage'])])
        return paths

    def fences(self,plan,paths,*,create=False):
        _lock,employee=lock_paths(self.config,paths,create=True)
        sid=Path(self.config['stateRoot'])/paths.session/'nix-migration.json'
        expected={'version':1,'token':plan['token']}
        canonical={'version':2,'token':plan['token'],'employeeId':paths.identity,'sessionId':paths.session,'state':'employee-canonical'}
        missing=[]
        for path in (employee,sid):
            if path.exists() or path.is_symlink():
                allowed=(expected,) if path==employee else (expected,canonical)
                if read_metadata(path,self.config['uid']) not in allowed:raise ValueError('Foreign data migration fence')
            elif create:missing.append(path)
            else:raise ValueError('Paired data fence is unavailable')
        for path in missing:private_json(path,expected,exclusive=True)
        return employee,sid,canonical

    def component(self,plan,name,stage,save):
        source=Path(plan['sources'][name]);target=stage/name
        plan['phase']='moving-'+name;save(plan)  # durable intent BEFORE rename
        self.check(plan)
        if source.exists() and not target.exists():
            if inode(source)!=plan['sourceIdentities'][name] or tree_digest(source,self.config['uid'])!=plan['trees'][name]:
                raise ValueError('Source component changed')
            if source.stat().st_dev!=stage.stat().st_dev:raise ValueError('Component filesystem changed')
            source.rename(target);sync_directory(source.parent);sync_directory(stage)
        elif target.exists() and not source.exists():
            # Explicit interrupted-stage recovery, bound to the same pinned inode.
            if inode(target)!=plan['sourceIdentities'][name]:raise ValueError('Interrupted component identity changed')
        else:raise ValueError('Conflicting/missing source and staged component; no overwrite')
        if tree_digest(target,self.config['uid'])!=plan['trees'][name]:raise ValueError('Staged component bytes changed')
        plan['phase']=name+'-staged';save(plan)

    def phase(self,action,plan,save):
        # Both new employee custody and old SID-startup fences protect the entire
        # operation. No account, company intent or engine mutation is performed.
        with storage_guard(self.config,plan['session'],migration=True) as paths, store_guard(self.config,plan['session'],migration=True):
            self.check(plan,published=action=='verify-data')
            if action=='stage':
                if plan['phase'] not in ('planned','moving-home','home-staged','moving-nix','nix-staged','staged'):
                    raise ValueError('Stage requires a fresh or explicitly interrupted paired plan')
                employee,sid,canonical=self.fences(plan,paths,create=True)
                private_directory(paths.root.parent,self.config['uid'],create=True)
                stage=Path(plan['stage'])
                if not stage.exists():
                    stage.mkdir(mode=0o700);sync_directory(stage.parent)
                    plan['stageIdentity']=inode(stage);save(plan)
                elif inode(stage)!=plan.get('stageIdentity'):raise ValueError('Foreign staged directory')
                for name in ('home','nix'):self.component(plan,name,stage,save)
                if profile_digest(stage/'home')!=plan['profiles'] or registered_paths(stage/'nix')!=plan['registrations']:
                    raise ValueError('Paired profiles or registered paths changed')
                marker=stage/'storage.json';ready={'version':1,'kind':'employee','identity':paths.identity,'state':'ready'}
                if marker.exists():
                    if read_metadata(marker,self.config['uid'])!=ready:raise ValueError('Stage publication marker changed')
                else:private_json(marker,ready,exclusive=True)
                subprocess.run(['sync','-f',str(stage)],check=True,capture_output=True,timeout=300)
                self.check(plan);plan['phase']='staged';save(plan)
            elif action=='publish':
                if plan['phase'] not in ('staged','published'):raise ValueError('Publish requires verified paired data')
                employee,sid,canonical=self.fences(plan,paths)
                stage=Path(plan['stage']);destination=paths.root
                if stage.exists() and not destination.exists():
                    if inode(stage)!=plan['stageIdentity']:raise ValueError('Stage root identity changed')
                    self.verify_components(plan,stage)
                    stage.rename(destination);sync_directory(destination.parent)
                elif destination.exists() and not stage.exists():
                    if inode(destination)!=plan['stageIdentity']:raise ValueError('Interrupted destination identity changed')
                else:raise ValueError('Conflicting paired destination; no overwrite')
                self.verify_components(plan,destination)
                record_storage_binding(self.config,paths)
                # Old immutable brokers must remain unable to recreate stale SID
                # storage. New employee-aware code understands this fixed fence.
                private_json(sid,canonical)
                plan['phase']='published';plan['publishedAt']=time.time();save(plan)
                employee.unlink();sync_directory(employee.parent)
            elif action=='verify-data':
                if plan['phase']!='published':raise ValueError('Data verification requires publication')
                _lock,fence=lock_paths(self.config,paths)
                barrier=read_metadata(Path(self.config['stateRoot'])/paths.session/'nix-migration.json',self.config['uid'])
                if fence.exists() or fence.is_symlink() or barrier!={'version':2,'token':plan['token'],'employeeId':paths.identity,'sessionId':paths.session,'state':'employee-canonical'}:
                    raise ValueError('Paired publication fence cleanup is incomplete')
                self.verify_components(plan,paths.root)
                plan['dataVerifiedAt']=time.time();save(plan)
            elif action=='abort':
                if plan['phase']=='published' or paths.root.exists():
                    raise ValueError('Published employee data stays authoritative; never roll back to stale SID copies')
                employee,sid,_canonical=self.fences(plan,paths)
                stage=Path(plan['stage'])
                for name in ('nix','home'):
                    source=Path(plan['sources'][name]);moved=stage/name
                    plan['phase']='aborting-'+name;save(plan)
                    if moved.exists() and not source.exists():
                        if inode(moved)!=plan['sourceIdentities'][name] or tree_digest(moved,self.config['uid'])!=plan['trees'][name]:
                            raise ValueError('Interrupted data changed before abort')
                        moved.rename(source);sync_directory(source.parent);sync_directory(stage)
                    elif moved.exists() or not source.exists():raise ValueError('Abort path conflict; retain all data')
                    if inode(source)!=plan['sourceIdentities'][name] or tree_digest(source,self.config['uid'])!=plan['trees'][name]:
                        raise ValueError('Restored source changed during interrupted abort')
                if profile_digest(Path(plan['sources']['home']))!=plan['profiles'] or registered_paths(Path(plan['sources']['nix']))!=plan['registrations']:
                    raise ValueError('Restored paired metadata changed')
                self.check(plan)
                plan['phase']='aborted';save(plan)
                employee.unlink();sid.unlink();sync_directory(employee.parent);sync_directory(sid.parent)
            else:raise ValueError('Unknown paired migration operation')

    def verify_components(self,plan,root):
        private_directory(root,self.config['uid'])
        for name in ('home','nix'):
            if inode(root/name)!=plan['sourceIdentities'][name] or tree_digest(root/name,self.config['uid'])!=plan['trees'][name]:
                raise ValueError('Canonical paired data changed')
        if profile_digest(root/'home')!=plan['profiles'] or registered_paths(root/'nix')!=plan['registrations']:
            raise ValueError('Canonical profile or Nix registration changed')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False)
    parser.add_argument('--config',type=Path,default=Path.home()/'reverie/runtime/worker-isolation/broker.json')
    parser.add_argument('--engine',choices=('docker','podman'),default='docker')
    parser.add_argument('--apply',action='store_true');parser.add_argument('--broker-ready',action='store_true')
    parser.add_argument('--checkpoint')
    sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('inventory')
    create=sub.add_parser('plan');create.add_argument('--session',required=True);create.add_argument('--nix-receipt',type=Path);create.add_argument('--receipt',type=Path,required=True)
    for name in ('stage','publish','verify-data','abort'):
        child=sub.add_parser(name);child.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args(argv);os.umask(0o077)
    migration=EmployeeMigration(load_config(args.config),args.engine)
    if args.action=='inventory':
        print(json.dumps(migration.inventory(),indent=2));return
    if args.action=='plan':
        plan=migration.plan(args.session,args.nix_receipt)
        if args.apply:private_json(args.receipt,plan,exclusive=True)
        print(json.dumps(plan,indent=2));return
    plan=read_metadata(args.receipt,migration.config['uid'])
    if not args.apply:
        migration.check(plan,published=plan['phase']=='published');print(json.dumps({'phase':plan['phase'],'dryRun':True}));return
    if not args.broker_ready or not args.checkpoint:
        parser.error('Actual employee-aware broker activation and a fresh offline checkpoint are required')
    migration.phase(args.action,plan,lambda value:private_json(args.receipt,value))
    print(json.dumps({'phase':plan['phase'],'runtimeAcceptance':'DEFERRED_NO_PROVIDER_STARTED','intentMutation':False}))


if __name__=='__main__':main()
