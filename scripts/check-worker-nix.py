#!/usr/bin/env python3
from pathlib import Path
import argparse,json,os,subprocess,sys,time
from reverie.workspaces import Workspaces
from reverie.worker import Broker
from reverie.worker_nix import prepare_store
from reverie.worker_nix_migrate import Migration, registration
parser=argparse.ArgumentParser(description="Exercise Nix inside an isolated synthetic laptop; no company data is mounted")
parser.add_argument('--image',required=True)
parser.add_argument('--root',type=Path,default=Path.home()/'scratch/reverie/nix-acceptance')
options=parser.parse_args()
manager=Workspaces(options.root);task='native-'+str(time.time_ns());out=manager.create(task);image=options.image
assert image.startswith('sha256:') and len(image)==71, 'Use an immutable, scanned image ID'
metadata=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
assert metadata['Config']['Labels'].get('reverie.worker.nix-store')=='1'
sid='eaaf0001-0000-4000-8000-000000000001';root=out/'fixture';root.mkdir(mode=0o700);home=root/'home';home.mkdir(mode=0o700);work=root/'work';work.mkdir(mode=0o700);(work/'tmp').mkdir()
uid=os.getuid();gid=os.getgid();assert uid!=0
passwd=root/'passwd';passwd.write_text(f'root:x:0:0:root:/root:/bin/bash\nagent:x:{uid}:{gid}:Agent:/home/agent:/bin/bash\n');group=root/'group';group.write_text(f'root:x:0:\nagent:x:{gid}:\n')
company=root/'company.json';company.write_text(json.dumps({'employees':[dict(id='synthetic-employee',sessionId=sid,desiredRunning=True,onVacation=False)]}));state=root/'state';state.mkdir(mode=0o700);(state/sid).mkdir(mode=0o700);
home=state/sid/'home';home.mkdir(mode=0o700)
cfg=dict(deployment='nix-smoke-'+task,image=image,uid=uid,gid=gid,budgetMode='admission',scratchRoot=str(root/'scratch'),stateRoot=str(state),companyFile=str(company),maxWorkers=2,mounts=[dict(source=str(passwd),destination='/etc/passwd',readOnly=True),dict(source=str(group),destination='/etc/group',readOnly=True)])
broker=Broker(cfg)
# Seed a synthetic legacy store without mounting any real office or host store.
# It becomes the exact scratch-backed source for the migration rehearsal.
seed_cfg=dict(cfg,stateRoot=str(root/'seed'));Path(seed_cfg['stateRoot']).mkdir(mode=0o700);(Path(seed_cfg['stateRoot'])/sid).mkdir(mode=0o700);(Path(seed_cfg['stateRoot'])/sid/'home').mkdir(mode=0o700)
try:
 seeded=prepare_store(broker,seed_cfg,sid)
 store=Path(cfg['scratchRoot'])/sid/'nix';store.parent.mkdir(mode=0o700,parents=True);seeded.rename(store)
except BaseException:
 log=home/'.reverie-nix-prepare.log'
 if log.exists():print(log.read_text()[-10000:],flush=True)
 raise
print('Private Nix store prepared:',store,flush=True)
name=cfg['deployment']+'-agent-'+sid;base=['docker','create','--name',name,'--label','reverie.worker='+cfg['deployment'],'--label','reverie.session='+sid,'--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',f'{uid}:{gid}','--memory','2g','--memory-swap','2g','--cpus','2','--pids-limit','512','--tmpfs','/tmp:rw,nosuid,nodev,size=134217728,mode=1777','--mount',f'type=bind,src={store},dst=/nix','--mount',f'type=bind,src={home},dst=/home/agent','--mount',f'type=bind,src={work},dst=/scratch','--mount',f'type=bind,src={passwd},dst=/etc/passwd,readonly','--mount',f'type=bind,src={group},dst=/etc/group,readonly','--entrypoint','/bin/sleep',image,'infinity']
def run(args,timeout=300):
 r=subprocess.run(args,text=True,capture_output=True,timeout=timeout)
 with (out/'commands.log').open('a') as log:log.write('COMMAND '+json.dumps(args)+'\n'+r.stdout+r.stderr+'\n')
 if r.returncode:print((r.stdout+r.stderr)[-7000:],flush=True);raise RuntimeError('Native smoke command failed: '+str(args[:4]))
 return r.stdout.strip()
def inside(*args,timeout=300):return run(['docker','exec',name,*args],timeout)
try:
 run(base);run(['docker','start',name]);print(inside('nix','--version'),flush=True)
 inside('/bin/bash','-c','test "$NIX_REMOTE" = local; test ! -S /nix/var/nix/daemon-socket/socket; test ! -S /var/run/docker.sock; test -w /nix/store; test ! -w /etc/nix/nix.conf')
 inside('nix','profile','install','nixpkgs#openssh',timeout=600);print('Real nix profile install openssh: PASS',flush=True)
 print(inside('/home/agent/.nix-profile/bin/ssh','-V'),flush=True)
 # A genuine local build, distinct from package substitution.
 (work/'project').mkdir(exist_ok=True)
 (work/'project/flake.nix').write_text('''{ inputs.nixpkgs.url="nixpkgs"; outputs={nixpkgs,...}: let p=nixpkgs.legacyPackages.x86_64-linux; in { packages.x86_64-linux.default=p.runCommand "laptop-nix-acceptance" {} "printf nix-build-ok > $out"; devShells.x86_64-linux.default=p.mkShell { packages=[p.openssh]; }; }; }''')
 output=inside('nix','build','path:/scratch/project','--no-link','--print-out-paths',timeout=600);assert inside('cat',output)=='nix-build-ok';print('Real local Nix build: PASS',flush=True)
 inside('nix','develop','path:/scratch/project','--command','ssh','-V',timeout=600);print('nix develop: PASS',flush=True)
 (work/'migration-sentinel').write_text('unique non-base Nix object '+task+'\n')
 sentinel=inside('nix-store','--add','/scratch/migration-sentinel');sentinel_hash=inside('nix-store','--query','--hash',sentinel)
 inside('ln','-s',sentinel,'/nix/var/nix/gcroots/reverie-migration-sentinel')
 migration=Migration(cfg);plan=migration.plan(sid,sentinel=sentinel)
 for action in ('quiesce','stage','publish'):migration.phase(action,plan,lambda value:(out/'migration.json').write_text(json.dumps(value,indent=2)+'\n'))
 durable=Path(plan['destination']);assert registration(durable)==plan['registrations'] and store.exists()
 base=[value.replace(f'src={store},dst=/nix',f'src={durable},dst=/nix') for value in base]
 run(['docker','rm',name]);prepare_store(broker,cfg,sid);run(base);run(['docker','start',name]);inside('/home/agent/.nix-profile/bin/ssh','-V')
 assert inside('nix-store','--query','--hash',sentinel)==sentinel_hash
 inside('nix-store','--verify-path',sentinel);assert inside('cat',sentinel)=='unique non-base Nix object '+task
 print('Offline migration + fresh mount: profile, non-base sentinel and registration preserved: PASS',flush=True)
 (work/'rollback-sentinel').write_text('new installation after durable migration '+task+'\n')
 latest=inside('nix-store','--add','/scratch/rollback-sentinel');latest_hash=inside('nix-store','--query','--hash',latest)
 inside('ln','-s',latest,'/nix/var/nix/gcroots/reverie-rollback-sentinel')
 reverse=migration.plan(sid,'legacy',sentinel)
 for action in ('quiesce','stage','publish'):migration.phase(action,reverse,lambda value:(out/'rollback.json').write_text(json.dumps(value,indent=2)+'\n'))
 assert Path(reverse['retained']).exists() and durable.exists()
 base=[value.replace(f'src={durable},dst=/nix',f'src={store},dst=/nix') for value in base]
 run(['docker','rm',name]);prepare_store(broker,cfg,sid);run(base);run(['docker','start',name])
 assert inside('nix-store','--query','--hash',latest)==latest_hash and inside('nix-store','--query','--hash',sentinel)==sentinel_hash
 inside('nix-store','--verify-path',sentinel);inside('nix-store','--verify-path',latest)
 assert inside('cat',latest)=='new installation after durable migration '+task
 inside('/home/agent/.nix-profile/bin/ssh','-V');print('Per-laptop rollback preserves post-migration installations and both originals: PASS',flush=True)
 inside('nix','store','gc',timeout=300);inside('nix','--version');inside('/home/agent/.nix-profile/bin/ssh','-V');print('GC retains image runtime and installed profile: PASS',flush=True)
 result=dict(image=image,unprivileged=True,noHostDaemon=True,readOnlyRoot=True,profileInstall=True,localBuild=True,nixDevelop=True,recreation=True,offlineMigration=True,rollback=True,registeredNonBaseSentinel=True,garbageCollection=True)
 (out/'acceptance.json').write_text(json.dumps(result,indent=2)+'\n');print('NATIVE NIX ACCEPTANCE PASS',flush=True)
finally:
 subprocess.run(['docker','rm','--force',name],capture_output=True)
 manager.finish(task, 'Native Nix acceptance evidence: '+str(out))
