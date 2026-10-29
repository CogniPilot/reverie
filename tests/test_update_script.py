import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = r'''
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ['UPDATE_TEST_ROOT'])
if name=='docker'and args[:1]==['--host']:
    assert not os.environ.get('DOCKER_CONTEXT')and not os.environ.get('DOCKER_HOST')
    with(root/'calls').open('a')as out:out.write(json.dumps(['engine-endpoint',args[1]])+'\n')
    args=args[2:]
with (root/'calls').open('a') as out: out.write(json.dumps([name, *args])+'\n')
state = json.loads((root/'state').read_text())
if name == 'node' and os.environ.get('H_TEST'):
    import hashlib
    if args[1]=='engine-socket':print(json.loads(Path(args[2]).read_bytes())['engine']['socket']);sys.exit(0)
    if args[1] in('validate-created','bind-lock','check-lock'):
        os.execv(os.environ['H_REAL_NODE'],[os.environ['H_REAL_NODE'],*args])
    if args[1] == 'check-image':
        if os.environ.get('H_BAD_IMAGE'):sys.exit(7)
        sys.exit(0) # Immutable artifact port; exact predicate covered in Node.
    if args[1]=='check-source-host':
        sys.exit(0) # Existing host default port, separately covered in Node.
    if args[1] == 'refresh-resource':
        os.fstat(9);sys.exit(0)
    assert args[1] == 'describe'
    repo, deployment, runtime, installation, old_runtime, host_state=args[2:]
    initial=Path(installation);value=json.loads(initial.read_bytes())
    operation=Path(value['ledgerBase'])/('operation-'+__import__('uuid').uuid4().hex);operation.mkdir(mode=0o700)
    helper=operation/'helper'
    helper.write_text('#!'+sys.executable+'\n'+os.environ['H_HELPER_SOURCE']);helper.chmod(0o700)
    lock=Path(host_state)/'update.lock';parent=lock.parent.stat();named=lock.stat()if lock.exists()else None
    description={
      'lockPath':str(lock),'lockIdentity':{'device':str(named.st_dev),'inode':str(named.st_ino)}if named else None,
      'lockParentIdentity':{'device':str(parent.st_dev),'inode':str(parent.st_ino)},
      'installationSHA256':hashlib.sha256(initial.read_bytes()).hexdigest(),
      'bootstrapMount':{'Source':value['bootstrapRoot']}}
    record=operation/'DESCRIBE.json';record.write_text(json.dumps({'descriptor':description}));record.chmod(0o600)
    if os.environ.get('H_REPLACE_LOCK_AFTER_DESCRIBE'):
        lock.rename(lock.with_name('retained-original.lock'));lock.write_bytes(b'');lock.chmod(0o600)
    print(json.dumps({'program':str(helper),'operation':str(operation),'engineSocket':value['engine']['socket'],'description':description}));sys.exit(0)
if name == 'nix':
    if os.environ.get('MOUNT_ORDER_DURING_BUILD'):
        file=root/'metadata.json';data=json.loads(file.read_text());data[0]['Mounts'].reverse();file.write_text(json.dumps(data))
    if os.environ.get('RUNTIME_CHANGE_DURING_BUILD'):
        file=root/'deployment/deployment.json';value=json.loads(file.read_text());value['websiteRuntime']='default';file.write_text(json.dumps(value))
    if os.environ.get('PROTECTED_CHANGE_DURING_BUILD'):
        (root/'deployment/deployment.json').write_text(json.dumps({'containerName':'reverie','protectedWebsite':False}))
    if os.environ.get('PROTECTED_DRIFT_DURING_BUILD'):
        file=root/'metadata.json';data=json.loads(file.read_text());data[0]['HostConfig']['Memory'] += 1048576;file.write_text(json.dumps(data))
    if os.environ.get('CODING_CHANGE_DURING_BUILD'):
        (root/'deployment/deployment.json').write_text(json.dumps({'containerName':'reverie','ownerCodingEvidence':True}))
    if os.environ.get('PHONE_CHANGE_DURING_BUILD'):
        (root/'deployment/deployment.json').write_text(json.dumps({'containerName':'reverie','adminPhoneWake':False}))
    if os.environ.get('STOP_DURING_BUILD'): state['reverie']['running'] = False
    (root/'state').write_text(json.dumps(state))
    sys.exit(int(os.environ.get('BUILD_FAIL', '0')))
if name == 'curl': print('401'); sys.exit(0)
if args[0] == 'inspect':
    target = args[-1]
    if '--format' in args: print(str(state.get(target, {}).get('running', False)).lower())
    elif os.environ.get('H_TEST')and target=='a'*64 and(root/'created.json').exists():print('['+(root/'created.json').read_text()+']')
    elif (root/'metadata.json').exists(): print((root/'metadata.json').read_text())
    else:
        print(json.dumps([{'Image': 'old-image', 'Config': {'User': '1001:100', 'WorkingDir': '/workspace/task', 'Labels': ({} if os.environ.get('NO_SIGNATURE') else {'reverie.deployment': 'a'*64}), 'Env': ['REVERIE_VERSION=old', 'CUSTOM_INSTANCE=kept'] + (['REVERIE_ADMIN_PHONE_WAKE='+os.environ['OLD_PHONE']] if os.environ.get('OLD_PHONE') else [])}, 'HostConfig': {'Memory': 8589934592, 'MemorySwap': 8589934592, 'PidsLimit': 512}, 'Mounts': [
            {'Type':'volume','Name':'instance-data','Destination':'/instances','RW':True},
            {'Type':'volume','Name':'private-home','Destination':'/home/agent','RW':True},
            {'Type':'bind','Source':str(root/'source'),'Destination':'/workspace','RW':True},
            {'Type':'bind','Source':str(root/'second disk'),'Destination':'/scratch2','RW':True},
            {'Type':'bind','Source':str(root/'passwd'),'Destination':'/etc/passwd','RW':False}]}]))
elif args[:2] == ['image', 'inspect']:
    if os.environ.get('H_TEST')and '--format'not in args:
        runtime=json.loads((root/'deployment/deployment.json').read_text())['websiteRuntime']
        print(json.dumps([{'Id':'sha256:'+'b'*64,'Config':{'Cmd':['fixed-node'],'Entrypoint':['fixed-entry'],
          'Env':['REVERIE_VERSION=old'],'Labels':{'org.reverie.website.runtime':runtime},'ExposedPorts':{'3000/tcp':{}}}}]))
    else:print(json.dumps(['REVERIE_VERSION=old'] + ([os.environ['CANDIDATE_LOADER_OVERRIDE']] if os.environ.get('CANDIDATE_LOADER_OVERRIDE') else [])))
elif args[0] == 'stop': state[args[-1]]['running'] = False
elif args[0] == 'rename': state[args[2]] = state.pop(args[1])
elif args[0] == 'run':
    if os.environ.get('RUN_FAIL'): sys.exit(8)
    state[args[args.index('--name')+1]] = {'running': True, 'image': 'new'}
elif args[0]=='create'and os.environ.get('H_TEST'):
    def get(flag):return args[args.index(flag)+1]
    def values(flag):return[args[i+1]for i,v in enumerate(args)if v==flag]
    runtime=json.loads((root/'deployment/deployment.json').read_text())['websiteRuntime']
    mounts=[]
    for raw in values('--mount'):
        fields=dict(item.split('=',1)if'='in item else(item,True)for item in raw.split(','))
        mounts.append({'Type':fields['type'],'Source':fields['src'],'Target':fields['dst'],'ReadOnly':'readonly'in fields})
    tmpfs=dict(raw.split(':',1)for raw in values('--tmpfs'))
    environment={'REVERIE_VERSION':'REVERIE_VERSION=old'}
    for raw in values('--env'):environment[raw.split('=',1)[0]]=raw
    labels={'org.reverie.website.runtime':runtime};labels.update(raw.split('=',1)for raw in values('--label'))
    item={'Id':'a'*64,'Name':'/'+get('--name'),'Image':'sha256:'+'b'*64,'State':{'Running':False,'Pid':0},
      'Config':{'Cmd':['fixed-node'],'Entrypoint':['fixed-entry'],'Env':list(environment.values()),'Labels':labels,
        'ExposedPorts':{'3000/tcp':{}},'Hostname':'a'*12,'Domainname':'','Image':args[-1],
        'User':get('--user'),'WorkingDir':get('--workdir'),'Tty':False,'OpenStdin':False,'StdinOnce':False,'AttachStdin':False},
      'HostConfig':{'Memory':int(get('--memory')),'MemorySwap':int(get('--memory-swap')),'PidsLimit':int(get('--pids-limit')),
        'ReadonlyRootfs':True,'Privileged':False,'CapAdd':None,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],
        'PidMode':'','IpcMode':'private','Init':True,'NetworkMode':'default','PortBindings':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':get('--publish').split(':')[1]}]},
        'Tmpfs':tmpfs,'Mounts':mounts,'LogConfig':{'Type':'json-file','Config':{}},'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},
        'MaskedPaths':['/proc/kcore'],'ReadonlyPaths':['/proc/sys'],'ShmSize':67108864,'Runtime':'runc','CgroupnsMode':'private'},
      'Mounts':[{'Type':m['Type'],'Source':m['Source'],'Name':m['Source']if m['Type']=='volume'else None,'Destination':m['Target'],'RW':not m['ReadOnly']}for m in mounts]+[
        {'Type':'tmpfs','Source':'','Destination':p,'RW':True}for p in tmpfs]}
    (root/'created.json').write_text(json.dumps(item));state[get('--name')]={'running':False,'image':'new','id':'a'*64};print('a'*64)
elif args[0] == 'rm': state.pop(args[-1], None)
elif args[0] == 'start':
    target=args[-1]
    if os.environ.get('H_TEST')and target=='a'*64:state['reverie']['running']=True
    else:state[target]['running'] = True
elif args[0] not in ['load', 'tag']: sys.exit('unexpected '+repr(args))
(root/'state').write_text(json.dumps(state))
'''

H_HELPER = r'''
import os,sys,json,fcntl,hashlib
from pathlib import Path
a=sys.argv[1:];phase=a[a.index('--lock-fd')+2]
config=json.loads(Path(a[a.index('--installation')+1]).read_bytes());held=os.fstat(9);named=Path(config['lockPath']).stat()
assert(held.st_dev,held.st_ino)==(named.st_dev,named.st_ino)
probe=os.open(config['lockPath'],os.O_RDWR|os.O_NOFOLLOW)
try:
 try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:pass
 else:raise AssertionError('No exclusive parent maintenance lock')
finally:os.close(probe)
root=Path(os.environ['UPDATE_TEST_ROOT'])
with(root/'calls').open('a')as out:out.write(json.dumps(['h-helper',phase])+'\n')
if os.environ.get('H_FAIL_PHASE')==phase:sys.exit(7)
if phase in('prepare-created','preflight-created'):
 raw=Path(a[a.index('--spec')+1]).read_bytes();assert hashlib.sha256(raw).hexdigest()==a[a.index('--spec-sha')+1]
if phase=='preflight-created':
 print(json.dumps({'version':1,'state':'STOPPED_WEBSITE_CAPACITY_QUALIFIED','containerId':a[a.index('--container-id')+1],
   'specSHA256':a[a.index('--spec-sha')+1],'workerEffects':False}));sys.exit(0)
print(json.dumps({'version':1,'workerEffects':False,'state':phase}))
'''

@unittest.skipUnless(shutil.which('jq') and shutil.which('flock'), 'host updater requires jq and flock')
class UpdateScriptTests(unittest.TestCase):
    def setUp(self):
        # The updater checks that host Nix build users can traverse every
        # ancestor. Nix's own /build is private, so these host-path fixtures
        # belong in the sandbox's public temporary directory instead.
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp' if os.environ.get('NIX_BUILD_TOP') else None)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root.chmod(0o755)
        self.bin = self.root/'bin'; self.bin.mkdir()
        self.home = self.root/'owner-home'; self.home.mkdir(mode=0o700)
        self.repo = self.root/'source'; self.repo.mkdir(); (self.repo/'flake.nix').touch()
        (self.root/'state').write_text(json.dumps({'reverie': {'running': True, 'image': 'old'}}))
        for command in ['docker', 'nix', 'curl']:
            script = self.bin/command
            script.write_text('#!'+sys.executable+'\n'+FAKE)
            script.chmod(0o700)
        if os.environ.get('NIX_BUILD_TOP'):
            # A Nix sandbox may also make / private to its build group. Model
            # the host root as traversable; retain real permission checks on
            # every fixture directory, including the deliberately private one.
            stat = self.bin/'stat'
            stat.write_text('#!'+sys.executable+'\nimport os, sys\n'
                'if sys.argv[1:] == ["-c", "%a", "/"]: print("755")\n'
                f'else: os.execv({shutil.which("stat")!r}, [{shutil.which("stat")!r}, *sys.argv[1:]])\n')
            stat.chmod(0o700)
        self.env = {**os.environ, 'HOME':str(self.home), 'PATH': str(self.bin)+os.pathsep+os.environ['PATH'],
            'UPDATE_TEST_ROOT': str(self.root), 'REVERIE_REPO': str(self.repo),
            'REVERIE_ROOT': str(self.root/'deployment'),
            'REVERIE_CONTROL_DIR': str(self.root/'control'), 'REVERIE_UPDATE_BUILD_DIR': str(self.root/'build'),
            'REVERIE_UPDATE_STATE_DIR': str(self.root/'host-state'),
            'REVERIE_NIX_BUILD_DIR': str(self.root/'nix-build')}

    def run_update(self, cwd=None, **extra):
        return subprocess.run(['bash', str(ROOT/'scripts/reverie-update')], env={**self.env, **extra}, cwd=cwd, capture_output=True, text=True)

    def calls(self):
        path=self.root/'calls'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def h_fixture(self,runtime):
        selected=self.protected_fixture();file=self.root/'deployment/deployment.json'
        config=json.loads(file.read_text());config['websiteRuntime']=runtime
        ledger=self.root/'h-ledger';ledger.mkdir(mode=0o700,exist_ok=True)
        bootstrap=self.root/'h-bootstrap';bootstrap.mkdir(mode=0o700,exist_ok=True)
        initial=self.root/'h-initial.json';initial.write_text(json.dumps({'ledgerBase':str(ledger),
            'bootstrapRoot':str(bootstrap),'lockPath':str(self.root/'host-state/update.lock'),
            'engine':{'socket':'/controlled/no-engine'}}));initial.chmod(0o600)
        config['ownerTerminalConfig']=str(initial);file.write_text(json.dumps(config))
        node=self.bin/'node';node.write_text('#!'+sys.executable+'\n'+FAKE);node.chmod(0o700)
        self.env.update(H_TEST='1',H_REAL_NODE=shutil.which('node'),H_HELPER_SOURCE=H_HELPER)
        return selected

    def test_success_reuses_named_volumes_extra_mounts_and_only_environment_overrides(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in self.calls() if call[:2] == ['docker', 'run'])
        self.assertIn('--init', run)
        build = next(call for call in self.calls() if call[0] == 'nix')
        self.assertIn(str(self.repo)+'#dockerImage', build)
        self.assertFalse(any(value.startswith('path:') for value in build))
        self.assertIn('type=volume,src=instance-data,dst=/instances', run)
        self.assertIn('type=volume,src=private-home,dst=/home/agent', run)
        self.assertIn(f'type=bind,src={self.root}/second disk,dst=/scratch2', run)
        self.assertIn('CUSTOM_INSTANCE=kept', run)
        self.assertNotIn('REVERIE_VERSION=old', run)
        self.assertIn('unless-stopped', run)
        self.assertIn('reverie.deployment='+'a'*64, run)
        for flag, value in [('--user', '1001:100'), ('--workdir', '/workspace/task'),
                            ('--memory', '8589934592'), ('--memory-swap', '8589934592'), ('--pids-limit', '512')]:
            self.assertEqual(run[run.index(flag)+1], value)
        self.assertIn(f'type=bind,src={self.root}/passwd,dst=/etc/passwd,readonly', run)
        self.assertFalse(any('--volumes' in call for call in self.calls()))
        self.assertEqual(json.loads((self.root/'state').read_text()), {'reverie': {'running': True, 'image': 'new'}})

    def test_owner_adopts_unlabelled_deployment_and_adds_readonly_gpu_directory(self):
        gpu = self.root/'gpu'; gpu.mkdir()
        result = self.run_update(NO_SIGNATURE='1', REVERIE_DEPLOYMENT_SIGNATURE='b'*64, REVERIE_GPU_PUBLISHED_DIR=str(gpu))
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in self.calls() if call[:2] == ['docker', 'run'])
        self.assertIn('reverie.deployment='+'b'*64, run)
        self.assertIn(f'type=bind,src={gpu},dst=/host-published,readonly', run)

    def test_build_scratch_is_traversable_but_metadata_remains_private(self):
        result = self.run_update(REVERIE_REPO=os.path.relpath(self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root/'nix-build').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root/'build').stat().st_mode & 0o777, 0o700)
        call = next(call for call in self.calls() if call[0] == 'nix')
        self.assertEqual(call[call.index('build-dir')+1], str((self.root/'nix-build').resolve()))
        self.assertEqual(call[:3], ['nix', 'build', str(self.repo.resolve())+'#dockerImage'])
        self.assertFalse(any(value.startswith('path:') for value in call))

    def test_inaccessible_build_scratch_fails_before_stopping_live_container(self):
        private = self.root/'private'; private.mkdir(mode=0o700)
        result = self.run_update(REVERIE_NIX_BUILD_DIR=str(private/'nix-build'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not traversable', result.stderr)
        self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_leading_dash_relative_source_selects_the_configured_checkout(self):
        repo = self.root/'-source'
        repo.mkdir()
        (repo/'flake.nix').touch()
        result = self.run_update(cwd=self.root, REVERIE_REPO='-source')
        self.assertEqual(result.returncode, 0, result.stderr)
        build = next(call for call in self.calls() if call[0] == 'nix')
        self.assertEqual(build[:3], ['nix', 'build', str(repo.resolve())+'#dockerImage'])

    def test_source_normalization_failure_never_builds_or_changes_container(self):
        real_realpath = shutil.which('realpath')
        normalizer = self.bin/'realpath'
        normalizer.write_text('#!'+sys.executable+'\nimport os,sys\n'
            f'if sys.argv[-1] == {str(self.repo)!r}: sys.exit(17)\n'
            f'os.execv({real_realpath!r}, [{real_realpath!r}, *sys.argv[1:]])\n')
        normalizer.chmod(0o700)
        result = self.run_update()
        self.assertEqual(result.returncode, 17, result.stderr)
        calls = self.calls()
        self.assertFalse(any(call[0] == 'nix' for call in calls))
        self.assertFalse(any(call[0] == 'docker' and call[1] != 'inspect' and call[1:3] != ['image', 'inspect'] for call in calls))
        self.assertEqual(json.loads((self.root/'state').read_text()), {'reverie': {'running': True, 'image': 'old'}})

    def test_failed_build_never_stops_current_container(self):
        self.assertNotEqual(self.run_update(BUILD_FAIL='9').returncode, 0)
        self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_replacement_failure_restores_original_container(self):
        self.assertNotEqual(self.run_update(RUN_FAIL='1').returncode, 0)
        self.assertEqual(json.loads((self.root/'state').read_text()), {'reverie': {'running': True, 'image': 'old'}})

    def test_stop_during_build_is_not_resurrected(self):
        self.assertNotEqual(self.run_update(STOP_DURING_BUILD='1').returncode, 0)
        self.assertFalse(any(call[:2] in (['docker', 'stop'], ['docker', 'run'], ['docker', 'start']) for call in self.calls()))

    def test_phone_startup_selection_refreshes_old_environment_and_ignores_host_activation(self):
        deployment = self.root/'deployment'; deployment.mkdir()
        file = deployment/'deployment.json'
        for value in (None, False, True):
            with self.subTest(value=value):
                config = {'containerName': 'reverie'}
                if value is not None: config['adminPhoneWake'] = value
                file.write_text(json.dumps(config))
                result = self.run_update(OLD_PHONE='enabled', REVERIE_ADMIN_PHONE_WAKE='enabled')
                self.assertEqual(result.returncode, 0, result.stderr)
                run = [call for call in self.calls() if call[:2] == ['docker', 'run']][-1]
                self.assertEqual([v for v in run if v.startswith('REVERIE_ADMIN_PHONE_WAKE=')],
                                 ['REVERIE_ADMIN_PHONE_WAKE=enabled'] if value else [])

    def test_invalid_phone_setting_fails_before_build_or_stop(self):
        deployment = self.root/'deployment'; deployment.mkdir()
        for value in ('enabled', 1, None, {}):
            (deployment/'deployment.json').write_text(json.dumps({'containerName': 'reverie', 'adminPhoneWake': value}))
            result = self.run_update()
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(any(call[0] == 'nix' or call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_durable_coding_evidence_default_staging_and_invalid_values(self):
        deployment=self.root/'deployment';deployment.mkdir();file=deployment/'deployment.json'
        for selection in ('omitted',False,True):
            config={'containerName':'reverie'}
            if selection!='omitted':config['ownerCodingEvidence']=selection
            file.write_text(json.dumps(config))
            result=self.run_update(REVERIE_OWNER_CODING_EVIDENCE='enabled')
            self.assertEqual(result.returncode,0,result.stderr)
            run=[c for c in self.calls() if c[:2]==['docker','run']][-1]
            self.assertEqual([v for v in run if v.startswith('REVERIE_OWNER_CODING_EVIDENCE=')],['REVERIE_OWNER_CODING_EVIDENCE='+('disabled' if selection is False else 'enabled')])
        before=len(self.calls())
        file.write_text(json.dumps({'containerName':'reverie','ownerCodingEvidence':'false'}))
        self.assertNotEqual(self.run_update().returncode,0)
        self.assertFalse(any(c[0]=='nix' or c[:2]==['docker','stop'] for c in self.calls()[before:]))

    def test_coding_evidence_change_during_build_never_stops_console(self):
        deployment=self.root/'deployment';deployment.mkdir()
        (deployment/'deployment.json').write_text(json.dumps({'containerName':'reverie','ownerCodingEvidence':False}))
        result=self.run_update(CODING_CHANGE_DURING_BUILD='1')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('coding evidence startup setting changed',result.stderr)
        self.assertFalse(any(c[:2]==['docker','stop'] for c in self.calls()))

    def test_phone_selection_change_during_build_never_stops_console(self):
        deployment = self.root/'deployment'; deployment.mkdir()
        (deployment/'deployment.json').write_text(json.dumps({'containerName': 'reverie', 'adminPhoneWake': True}))
        result = self.run_update(PHONE_CHANGE_DURING_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('setting changed', result.stderr)
        self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_request_helper_only_touches_the_fixed_request_file_and_rejects_payloads(self):
        control = self.root/'control'; control.mkdir()
        helper = ROOT/'scripts/reverie-request-update'
        result = subprocess.run(['bash', str(helper)], env=self.env, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual([p.name for p in control.iterdir()], ['update.request'])
        self.assertNotEqual(subprocess.run(['bash', str(helper), 'arbitrary command'], env=self.env, capture_output=True).returncode, 0)

    def protected_fixture(self):
        deployment = self.root/'deployment'; deployment.mkdir(exist_ok=True)
        (deployment/'deployment.json').write_text(json.dumps({'containerName':'reverie','protectedWebsite':True}))
        selected = [{'Id':'fixture-website','Image':'old-image',
            'Config':{'User':'1001:100','WorkingDir':'/workspace/task','Labels':{'reverie.deployment':'a'*64},
                      'Env':['REVERIE_VERSION=old','CUSTOM_INSTANCE=kept']},
            'HostConfig':{'Memory':8589934592,'MemorySwap':8589934592,'PidsLimit':512,
                'ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'CapAdd':None,
                'SecurityOpt':['no-new-privileges:true'],'PidMode':'','IpcMode':'private',
                'Tmpfs':{'/tmp':'rw,nosuid,nodev,size=256m,mode=1777',
                         '/run':'rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=1001,gid=100'},
                'MaskedPaths':['/proc/kcore'],'ReadonlyPaths':['/proc/sys']},
            'Mounts':[{'Type':'volume','Name':'instance-data','Destination':'/instances','RW':True},
                      {'Type':'bind','Source':str(self.root/'home'),'Destination':'/home/agent','RW':True},
                      {'Type':'tmpfs','Destination':'/tmp','RW':True},
                      {'Type':'tmpfs','Destination':'/run','RW':True}]}]
        (self.root/'metadata.json').write_text(json.dumps(selected))
        return selected

    def test_protected_update_preserves_only_the_fixed_profile_and_durable_mounts(self):
        self.protected_fixture()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(c for c in self.calls() if c[:2] == ['docker','run'])
        self.assertIn('--read-only', run)
        for flag,value in [('--cap-drop','ALL'),('--security-opt','no-new-privileges'),('--ipc','private'),
                           ('--memory','8589934592'),('--memory-swap','8589934592'),('--pids-limit','512')]:
            self.assertEqual(run[run.index(flag)+1], value)
        self.assertNotIn('--pid',run);self.assertNotIn('--cap-add',run)
        self.assertEqual([run[i+1] for i,v in enumerate(run) if v == '--tmpfs'],
            ['/tmp:rw,nosuid,nodev,size=256m,mode=1777',
             '/run:rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=1001,gid=100'])
        self.assertIn('type=volume,src=instance-data,dst=/instances',run)
        self.assertIn(f'type=bind,src={self.root}/home,dst=/home/agent',run)
        self.assertFalse(any('type=tmpfs' in v for v in run))
        self.assertEqual(json.loads((self.root/'state').read_text())['reverie']['image'],'new')

    def test_optional_runtime_builds_and_tags_only_the_selected_fixed_image(self):
        for runtime,attribute,image in [('resource','resourceActorImage','reverie:latest'),
                ('terminal','ownerTerminalImage','reverie-owner-terminal:latest'),
                ('resource-terminal','resourceTerminalImage','reverie-owner-terminal:latest')]:
            with self.subTest(runtime=runtime):
                if runtime in('terminal','resource-terminal'):self.h_fixture(runtime)
                else:self.protected_fixture()
                file=self.root/'deployment/deployment.json';value=json.loads(file.read_text())
                value['websiteRuntime']=runtime;file.write_text(json.dumps(value))
                before=len(self.calls())if(self.root/'calls').exists()else 0
                result=self.run_update();self.assertEqual(result.returncode,0,result.stderr)
                calls=self.calls()[before:]
                build=next(c for c in calls if c[0]=='nix');self.assertIn(str(self.repo)+'#'+attribute,build)
                tag=next(c for c in calls if c[:2]==['docker','tag']);self.assertEqual(tag[2],image)
                run=next(c for c in calls if c[:2]==['docker','create'if runtime in('terminal','resource-terminal')else'run']);self.assertIn('--read-only',run)

    def test_runtime_selection_drift_refuses_before_stop(self):
        self.h_fixture('resource-terminal');file=self.root/'deployment/deployment.json'
        value=json.loads(file.read_text());value['websiteRuntime']='resource-terminal';file.write_text(json.dumps(value))
        result=self.run_update(RUNTIME_CHANGE_DURING_BUILD='1')
        self.assertNotEqual(result.returncode,0);self.assertIn('Website runtime changed',result.stderr)
        self.assertFalse(any(c[:2]in(['docker','stop'],['docker','rename'],['docker','run'])for c in self.calls()))

    def test_H_update_orders_real_OFD_phases_around_exact_stopped_create_and_start(self):
        self.h_fixture('terminal');result=self.run_update()
        self.assertEqual(result.returncode,0,result.stderr);calls=self.calls()
        steps=[('h-helper','settle'),('docker','stop'),('docker','create'),('h-helper','preflight-created'),('h-helper','prepare-created'),
               ('h-helper','start-listener'),('docker','start'),('h-helper','await-ready')]
        indexes=[next(i for i,c in enumerate(calls)if tuple(c[:2])==step)for step in steps]
        self.assertEqual(indexes,sorted(indexes))
        start=calls[indexes[-2]];self.assertEqual(start[-1],'a'*64)
        self.assertFalse(any(c[:2]==['docker','run']for c in calls))

    def test_H_listener_failure_retains_unknown_without_legacy_start_or_rollback(self):
        self.h_fixture('terminal');result=self.run_update(H_FAIL_PHASE='start-listener')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[:2]in(['docker','start'],['docker','run'],['docker','rm'])for c in self.calls()))
        self.assertIn('No legacy rollback/start',result.stderr)
        unknown=list((self.root/'h-ledger').glob('*/UPDATE-UNKNOWN.json'))
        self.assertEqual(len(unknown),1)

    def test_H_selection_without_initial_config_refuses_before_build_or_stop(self):
        self.protected_fixture();p=self.root/'deployment/deployment.json';value=json.loads(p.read_text())
        value['websiteRuntime']='terminal';p.write_text(json.dumps(value))
        result=self.run_update();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[0]=='nix'or c[:2]==['docker','stop']for c in self.calls()))

    def test_dangling_H_unit_is_unknown_not_an_absent_default_installation(self):
        self.protected_fixture();units=self.home/'.config/systemd/user';units.mkdir(parents=True)
        (units/'reverie-owner-terminal.service').symlink_to(self.root/'missing-unit-target')
        result=self.run_update();self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.calls(),[])

    def test_H_wrong_image_refuses_before_old_H_or_website_stop(self):
        self.h_fixture('terminal');result=self.run_update(H_BAD_IMAGE='1')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[:2]in(['docker','stop'],['h-helper','settle'])for c in self.calls()))

    def test_described_lock_replacement_refuses_while_original_OFD_remains_held(self):
        import fcntl
        self.h_fixture('terminal');directory=self.root/'host-state';directory.mkdir(mode=0o700)
        lock=directory/'update.lock';lock.write_bytes(b'');lock.chmod(0o600)
        held=os.open(lock,os.O_RDWR|os.O_NOFOLLOW);original=os.fstat(held)
        try:
            fcntl.flock(held,fcntl.LOCK_EX)
            result=self.run_update(H_REPLACE_LOCK_AFTER_DESCRIBE='1')
            self.assertNotEqual(result.returncode,0);self.assertIn('described maintenance lock changed',result.stderr)
            self.assertEqual((os.fstat(held).st_dev,os.fstat(held).st_ino),(original.st_dev,original.st_ino))
            self.assertNotEqual(lock.stat().st_ino,original.st_ino)
            probe=os.open(directory/'retained-original.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(probe)
            self.assertFalse(any(c[:2]in(['h-helper','settle'],['docker','stop'],['docker','create'],['docker','run'])for c in self.calls()))
        finally:os.close(held)

    def test_disabling_H_still_settles_old_channels_and_removes_only_bootstrap_grant(self):
        selected=self.h_fixture('terminal')
        selected[0]['Config']['Labels']['org.reverie.website.runtime']='terminal'
        selected[0]['Mounts'].append({'Type':'bind','Source':str(self.root/'h-bootstrap'),
            'Destination':'/run/reverie-owner-terminal','RW':False})
        (self.root/'metadata.json').write_text(json.dumps(selected))
        file=self.root/'deployment/deployment.json';value=json.loads(file.read_text());value['websiteRuntime']='default';file.write_text(json.dumps(value))
        result=self.run_update();self.assertEqual(result.returncode,0,result.stderr)
        calls=self.calls();self.assertTrue(any(c[:2]==['h-helper','settle']for c in calls))
        self.assertFalse(any(c[:2]==['h-helper','prepare-created']for c in calls))
        command=next(c for c in calls if c[:2]==['docker','run'])
        self.assertFalse(any('/run/reverie-owner-terminal'in item for item in command))

    def test_protected_mount_order_changes_preserve_complete_records_and_do_not_refuse(self):
        self.protected_fixture();result=self.run_update(MOUNT_ORDER_DURING_BUILD='1')
        self.assertEqual(result.returncode,0,result.stderr)

    def test_runtime_selection_rejects_unknown_values_and_missing_protection_before_build(self):
        for runtime,protected in [('resource',False),('constructor',True),('dockerImage;false',True),(None,True),(False,True)]:
            with self.subTest(runtime=runtime,protected=protected):
                directory=self.root/'deployment';directory.mkdir(exist_ok=True)
                (directory/'deployment.json').write_text(json.dumps({'containerName':'reverie',
                    'websiteRuntime':runtime,'protectedWebsite':protected}))
                before=len(self.calls())if(self.root/'calls').exists()else 0
                result=self.run_update();self.assertNotEqual(result.returncode,0)
                self.assertFalse(any(c[0]=='nix'or c[:2]in(['docker','stop'],['docker','run'])for c in self.calls()[before:]))

    def test_protected_update_refuses_unknown_or_weakened_profile_before_build(self):
        original = self.protected_fixture()
        changes = [
            lambda c:c['HostConfig'].pop('CapAdd'),
            lambda c:c['HostConfig'].update(ReadonlyRootfs=False),
            lambda c:c['HostConfig'].update(CapAdd=['SYS_ADMIN']),
            lambda c:c['HostConfig'].update(PidMode='host'),
            lambda c:c['HostConfig'].update(IpcMode='host'),
            lambda c:c['HostConfig'].update(SecurityOpt=[]),
            lambda c:c['HostConfig']['Tmpfs'].update({'/tmp':'rw,nosuid,nodev,size=512m,mode=1777'}),
            lambda c:c['HostConfig']['Tmpfs'].update({'/run':'rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=1002,gid=100'}),
            lambda c:c['HostConfig']['Tmpfs'].update({'/other':'rw'}),
            lambda c:c['HostConfig']['MaskedPaths'].append('/nix/store'),
            lambda c:c['Mounts'].append({'Type':'bind','Source':'/synthetic','Destination':'/tmp','RW':True}),
            lambda c:c['Config']['Env'].append('LD_PRELOAD=/scratch/injected.so'),
            lambda c:c['Config']['Env'].append('GCONV_PATH=/scratch/code'),
            lambda c:c['Config']['Env'].append('OPENSSL_CONF=/scratch/config'),
            lambda c:c['Config']['Env'].append('OPENSSL_MODULES=/scratch/code'),
            lambda c:c['Config']['Env'].append('LD_custom=/scratch/code'),
            lambda c:c['Config']['Env'].append('NODE_OPTIONS'),
        ]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                data=json.loads(json.dumps(original));change(data[0]);(self.root/'metadata.json').write_text(json.dumps(data))
                before=len(self.calls()) if (self.root/'calls').exists() else 0
                result=self.run_update();self.assertNotEqual(result.returncode,0)
                self.assertFalse(any(c[0]=='nix' or c[:2] in (['docker','stop'],['docker','run']) for c in self.calls()[before:]))

    def test_protected_update_rechecks_selection_and_all_actual_limits_after_build(self):
        for key in ('PROTECTED_CHANGE_DURING_BUILD','PROTECTED_DRIFT_DURING_BUILD'):
            with self.subTest(key=key):
                self.protected_fixture();before=len(self.calls()) if (self.root/'calls').exists() else 0
                result=self.run_update(**{key:'1'});self.assertNotEqual(result.returncode,0)
                self.assertIn('changed during the build',result.stderr)
                self.assertFalse(any(c[:2] in (['docker','stop'],['docker','run']) for c in self.calls()[before:]))

    def test_protected_update_refuses_downgrade_invalid_selection_and_candidate_loader_override(self):
        for value in (False,'true',None):
            self.protected_fixture();(self.root/'deployment/deployment.json').write_text(
                json.dumps({'containerName':'reverie','protectedWebsite':value}))
            before=len(self.calls()) if (self.root/'calls').exists() else 0
            self.assertNotEqual(self.run_update().returncode,0)
            self.assertFalse(any(c[0]=='nix' or c[:2]==['docker','stop'] for c in self.calls()[before:]))
        for value in ('LD_PRELOAD=/scratch/injected.so','GCONV_PATH=/scratch/code',
                      'OPENSSL_CONF=/scratch/config','OPENSSL_MODULES=/scratch/code','LD_custom=/scratch/code','NODE_OPTIONS'):
            with self.subTest(candidate=value):
                self.protected_fixture();before=len(self.calls())
                result=self.run_update(CANDIDATE_LOADER_OVERRIDE=value);self.assertNotEqual(result.returncode,0)
                self.assertIn('interpreter environment',result.stderr)
                self.assertFalse(any(c[:2] in (['docker','stop'],['docker','run']) for c in self.calls()[before:]))
