"""Module-managed real host/laptop lease acceptance. No prune, unit start or live mode.

The module runs this before its observation. Root-owned receipts bind the exact
configuration/code, boot, current fleet image/layout and full kernel controls.
"""
import argparse
import fcntl
import importlib.util
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time
import uuid


def sibling(name):
    spec = importlib.util.spec_from_file_location('_reverie_acceptance_'+name, Path(__file__).with_name(name+'.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

if __package__:
    from . import acceptance_io as I
    from .peer_port import PeerClient, expected_labels
    from . import peer_artifact as Artifact
else:
    I = sibling('acceptance_io')
    _peer=sibling('peer_port');PeerClient=_peer.PeerClient;expected_labels=_peer.expected_labels
    Artifact=sibling('peer_artifact')

HOST_HOLD_SECONDS = 60
PEER_REFUSAL_SECONDS = 5
CONFIG_FIELDS = {'version','stateDirectory','deploymentConfig','peerSocket','brokerUid','peerEmployeeId','peerBinary','peerImageId','generation','receiptLifetimeSeconds','companyFile','brokerConfig'}


def validate_config(value):
    I.require(isinstance(value,dict) and set(value)==CONFIG_FIELDS and type(value['version']) is int and value['version']==1, 'invalid acceptance configuration')
    for name in ('stateDirectory','deploymentConfig','peerSocket','companyFile','peerBinary','brokerConfig'):I.absolute(value[name])
    I.canonical_id(value['peerEmployeeId'])
    I.require(type(value['brokerUid']) is int and value['brokerUid']>0, 'nonroot broker uid required')
    for name in ('generation',):I.nonce(value[name])
    I.require(isinstance(value['peerImageId'],str) and value['peerImageId'].startswith('sha256:') and len(value['peerImageId'])==71, 'immutable peer image required')
    I.nonce(value['peerImageId'][7:])
    I.require(type(value['receiptLifetimeSeconds']) is int and 60<=value['receiptLifetimeSeconds']<=86400, 'bounded receipt lifetime required')
    return value


def mount_id(fd):
    lines=Path('/proc/self/fdinfo/'+str(fd)).read_text().splitlines()
    found=[line.split(':',1)[1].strip() for line in lines if line.startswith('mnt_id:')]
    I.require(len(found)==1 and found[0].isdigit(),'mount identity unavailable')
    return int(found[0])


def metadata(config, deployment, docker, command,broker_config):
    """Fixed complete running inventory; no environment, command or account inspection."""
    def engine(*values):
        result=command([str(docker),'--config',str(Path(config['stateDirectory'])/'docker-config'),'--host','unix://'+deployment['docker_socket'],*values])
        I.require(result.returncode==0,'worker metadata request failed')
        return result.stdout
    ids=engine('ps','-q','--no-trunc','--filter','label=reverie.worker='+deployment['deployment']).split()
    I.require(len(ids)<=len(deployment['employee_ids']) and len(set(ids))==len(ids),'ambiguous running inventory')
    I.require(all(len(v)==64 and all(c in 'abcdef0123456789' for c in v) for v in ids),'invalid container identity')
    if not ids:return []
    fmt='{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"user":{{json .Config.User}},"pid":{{.State.Pid}},"running":{{.State.Running}},"readOnlyRootfs":{{.HostConfig.ReadonlyRootfs}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"mounts":{{json .Mounts}}}'
    raw=[I.decoded(line) for line in engine('inspect','--type','container','--format',fmt,*ids).splitlines()]
    I.require(len(raw)==len(ids) and {r['id'] for r in raw}==set(ids),'incomplete running inventory')
    rows=[];seen=set();control=I.absolute(config['peerSocket']).parent;state=I.absolute(config['stateDirectory'])
    authorities=(I.absolute(config['brokerConfig']),I.absolute(config['companyFile']))
    for item in raw:
        labels=item.get('labels') or {};session=I.canonical_id(labels.get('reverie.session'))
        I.require(labels.get('reverie.worker')==deployment['deployment'] and item.get('name')=='/'+deployment['deployment']+'-agent-'+session,'worker label mismatch')
        I.require(item.get('running') is True and type(item.get('pid')) is int and item['pid']>1 and item.get('user')==f"{deployment['laptop_uid']}:{deployment['laptop_gid']}",'worker process/user differs')
        selected={}
        for target in ('/home/agent','/tmp'):
            mounts=[m for m in item['mounts'] if m.get('Destination')==target]
            I.require(len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('RW') is True,'worker bind missing')
            selected[target]=I.absolute(mounts[0]['Source'])
        relative=selected['/home/agent'].relative_to(I.absolute(deployment['laptop_home_root']))
        I.require(len(relative.parts)==2 and relative.parts[1]=='home','employee home layout differs')
        employee=I.canonical_id(relative.parts[0])
        I.require(employee in deployment['employee_ids'] and employee not in seen,'unknown/duplicate employee')
        I.require(selected['/tmp']==Path(deployment['b_mount'])/deployment['laptops_root']/employee/'tmp','employee tmp layout differs')
        for m in item['mounts']:
            if m.get('Type')=='bind':
                source=I.absolute(m['Source']);resolved=source.resolve(strict=True)
                I.require(source==resolved,'noncanonical worker bind source')
                for private in (control,state,*authorities):
                    for authority in (private,private.resolve()):
                        I.require(not (source==authority or source.is_relative_to(authority) or authority.is_relative_to(source)),'worker mount exposes acceptance control/state/authority')
        I.require(os.access('/proc/'+str(item['pid'])+'/mountinfo',os.R_OK),'host init PID invisible')
        home_fd=I.open_directory(selected['/home/agent'],uid=deployment['laptop_uid']);tmp_fd=I.open_directory(selected['/tmp'],uid=deployment['laptop_uid'])
        try:
            row={'employeeId':employee,'sessionId':session,'containerId':item['id'],'imageId':item['image'],'initPid':item['pid'],
                 'home':str(selected['/home/agent']),'tmp':str(selected['/tmp']),'uid':deployment['laptop_uid'],'gid':deployment['laptop_gid'],
                 'workerConfigHash':labels.get('reverie.worker-config'),'workerPolicyHash':labels.get('reverie.worker-policy'),
                 'homeIdentity':{'inode':I.inode(os.fstat(home_fd)),'mountId':mount_id(home_fd)},'tmpIdentity':{'inode':I.inode(os.fstat(tmp_fd)),'mountId':mount_id(tmp_fd)}}
        finally:os.close(home_fd);os.close(tmp_fd)
        if employee==config['peerEmployeeId']:
            hashes=expected_labels(broker_config,session)
            I.require(row['workerConfigHash']==hashes['workerConfigHash'] and row['workerPolicyHash']==hashes['workerPolicyHash'],'root current peer config/grants differ')
            row['helperArtifact']=Artifact.mounted(item,Artifact.artifact(config['peerBinary']))
        seen.add(employee);rows.append(row)
    return sorted(rows,key=lambda r:r['employeeId'])


class Host:
    """Production custody/backend. Tests can supply owned synthetic backends explicitly."""
    def __init__(self, config, initializer, docker, command=None):
        self.config=config;self.initializer=Path(initializer);self.docker=Path(docker)
        self.H=sibling('host_install')
        self.command=I.command if command is None else command
        self.H.immutable(self.initializer);self.H.immutable(self.docker)
        self.H.immutable(config['deploymentConfig'])
        self.H.protected_chain(config['stateDirectory'])

    def binding(self):
        result=self.command([str(self.initializer),'--state-dir',self.config['stateDirectory'],'--config',self.config['deploymentConfig']])
        I.require(result.returncode==0 and I.decoded(result.stdout).get('status')=='CHECKED_DECLARED_DRY_RUN_ONLY','declared dry-only initializer refused')
        state=Path(self.config['stateDirectory'])
        manifest=I.read_path(state/'install.json',protected=True,limit=65536)
        deployment_bytes=I.read_path(state/'deployment.json',protected=True,limit=65536)
        deployment=I.decoded(deployment_bytes)
        I.require(deployment.get('live_enabled') is False and self.config['peerEmployeeId'] in deployment['employee_ids'],'configured peer/dry-only mode differs')
        parsed=I.decoded(manifest)
        lease=I.read_path(state/'lib/lease.py',protected=True,limit=1024*1024)
        I.require(I.digest(lease)==parsed['files']['lib/lease.py'],'installed lease code differs')
        broker_bytes=I.read_path(self.config['brokerConfig'],uid=self.config['brokerUid'],limit=1024*1024)
        I.require(not Path(self.config['brokerConfig']).stat().st_mode&0o022,'broker config writable by others')
        broker_config=I.decoded(broker_bytes);option=broker_config.get('leaseAcceptance')
        I.require(isinstance(option,dict) and option.get('employeeId')==self.config['peerEmployeeId'] and option.get('peerBinary')==self.config['peerBinary'] and option.get('socket')==self.config['peerSocket'] and broker_config.get('companyFile')==self.config['companyFile'],'broker/module declarations differ')
        fleet=metadata(self.config,deployment,self.docker,self.command,broker_config)
        selected=[r for r in fleet if r['employeeId']==self.config['peerEmployeeId']]
        I.require(len(selected)==1 and selected[0]['imageId']==self.config['peerImageId'],'approved peer image/running identity unavailable')
        registry=I.peer_registry(self.config['companyFile'],self.config['brokerUid'],self.config['peerEmployeeId'])
        I.require(selected[0]['sessionId']==registry['sessionId'],'current canonical peer session differs')
        lease_dir=I.open_directory(Path(selected[0]['home'])/deployment['lease_subdir'],uid=deployment['laptop_uid'])
        try:
            persistent={'directoryKey':I.inode(os.fstat(lease_dir)),'directoryMountId':mount_id(lease_dir),'barrierKey':None,'barrierMountId':None}
            try:barrier=I.regular(lease_dir,'barrier.lock',write=True,uid=deployment['laptop_uid'],private=True)
            except FileNotFoundError:barrier=None
            if barrier is not None:
                try:persistent.update(barrierKey=I.inode(os.fstat(barrier)),barrierMountId=mount_id(barrier))
                finally:os.close(barrier)
        finally:os.close(lease_dir)
        fd=I.open_directory(deployment['b_mount'])
        try:disposable={'inode':I.inode(os.fstat(fd)),'mountId':mount_id(fd)}
        finally:os.close(fd)
        code={name:I.digest(Path(__file__).with_name(name+'.py').read_bytes()) for name in ('acceptance','acceptance_io','peer_port','peer_artifact','host_install')}
        return {'configSha256':I.digest(self.config),'generation':self.config['generation'],'brokerConfigSha256':I.digest(broker_bytes),'manifestSha256':I.digest(manifest),'deploymentSha256':I.digest(deployment_bytes),
                'helperArtifact':Artifact.artifact(self.config['peerBinary']),'leaseSha256':I.digest(lease),'peerRegistryBinding':registry,'persistentLease':persistent,'code':code,'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'disposableIdentity':disposable,'fleet':fleet},deployment,lease

    def begin(self,attempt,token,status='RUNNING'):
        self.H.atomic(Path(self.config['stateDirectory'])/'lease-acceptance-attempt.json',self.H.encoded({'version':1,'attemptId':attempt,'nonce':token,'status':status}),0o600)

    def store(self,value):
        self.H.atomic(Path(self.config['stateDirectory'])/'lease-acceptance.json',self.H.encoded(value),0o600)
        self.begin(value['attemptId'],value['nonce'],'ACCEPTED')


def expect_peer(binding, witness, config, deployment):
    fields={'employeeId','sessionId','containerId','imageId','initPid','home','tmp','uid','gid','helperSha256','leaseSubdirectory','sessionGeneration','workerConfigHash','workerPolicyHash'}
    I.require(isinstance(witness,dict) and set(witness)==fields,'invalid peer binding schema')
    own=[r for r in binding['fleet'] if r['employeeId']==config['peerEmployeeId']][0]
    for name in fields-{'helperSha256','leaseSubdirectory','sessionGeneration','workerConfigHash','workerPolicyHash'}:I.require(witness[name]==own[name],'peer binding differs from root inventory')
    I.require(type(witness['sessionGeneration']) is int and witness['sessionGeneration']==binding['peerRegistryBinding']['sessionGeneration'],'canonical peer generation differs')
    I.require(witness['helperSha256']==binding['helperArtifact']['sha256'] and witness['leaseSubdirectory']==deployment['lease_subdir'],'peer helper/config differs')
    return own


def validate_control(result, phase, attempt, nonce, probe, root_key, uid, gid):
    fields={'status','phase','attemptId','nonce','durationSeconds','barrierKey','rootBarrierKey','rootBarrierUid','rootBarrierGid','rootBarrierMode','uid'}
    I.require(isinstance(result,dict) and set(result)==fields,'invalid peer control schema')
    I.require(result['attemptId']==attempt and result['nonce']==nonce and result['phase']==phase and result['status']==('REFUSED' if phase=='during' else 'ACQUIRED'),'peer control failed/mismatched')
    I.require(result['barrierKey']==probe['barrierKey'] and result['rootBarrierKey']==root_key,'peer control inode differs')
    I.require(result['uid']==result['rootBarrierUid']==uid and result['rootBarrierGid']==gid and result['rootBarrierMode']==0o600,'root-created barrier not user-openable')
    duration=result['durationSeconds']
    I.require(type(duration) in (int,float) and 0<=duration<=10 and (phase!='during' or duration>=PEER_REFUSAL_SECONDS),'peer control duration insufficient')


def kernel_gate(config, prepared, peer, deployment, lease_source, *, clock=time.monotonic, sleep=time.sleep, fixture_owner=0):
    """Actual descriptor/flock core. Production always uses root fixture_owner=0.

    An explicitly supplied test backend/owner may rehearse ordinary owned files;
    such results cannot be stored by Host as actual root acceptance through CLI.
    """
    result=prepared['result'];attempt=result['attemptId'];token=result['nonce'];probe=result['probe']
    I.require(set(probe)=={'heldKey','reservedKey','barrierKey','probeKey','leaseFixtureKey','tmpFixtureKey'},'invalid probe schema')
    for value in probe.values():I.require(isinstance(value,str) and __import__('re').fullmatch('[0-9]{1,24}-[0-9]{1,24}',value),'invalid probe inode')
    own=prepared['binding'];uid,gid=own['uid'],own['gid'];fds=[]
    def keep(fd):fds.append(fd);return fd
    def busy(fd):
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return True
        fcntl.flock(fd,fcntl.LOCK_UN);return False
    try:
        leases=keep(I.open_directory(Path(own['home'])/deployment['lease_subdir'],uid=uid));tmp=keep(I.open_directory(own['tmp'],uid=uid))
        fixture=keep(I.child_directory(tmp,'.reverie-lease-gate-'+attempt,uid=uid))
        held=keep(I.child_directory(fixture,'held',uid=uid));reserved=keep(I.child_directory(fixture,'reserved',uid=uid))
        lease_fixture=keep(I.child_directory(leases,'.acceptance-'+attempt,uid=uid))
        for fd,name in ((fixture,'tmpFixtureKey'),(held,'heldKey'),(reserved,'reservedKey'),(lease_fixture,'leaseFixtureKey')):I.require(I.inode(os.fstat(fd))==probe[name],'H1 directory inode differs')
        barrier=keep(I.regular(leases,'barrier.lock',write=True,uid=uid))
        probe_fd=keep(I.regular(leases,'acceptance-'+attempt+'.probe.lock',uid=uid))
        held_fd=keep(I.regular(leases,probe['heldKey']+'.lock',uid=uid))
        I.require(I.inode(os.fstat(barrier))==probe['barrierKey'] and I.inode(os.fstat(probe_fd))==probe['probeKey'],'H1 lease inode differs')
        I.require(busy(probe_fd) and busy(held_fd),'H2 shared locks not visible')
        reservation_fd=keep(I.regular(leases,probe['reservedKey']+'.reserve.json',uid=uid))
        reservation=I.decoded(I.snapshot(reservation_fd));now=time.time();created,until=reservation['created_utc'],reservation['until_utc']
        I.require(type(created) in (int,float) and type(until) in (int,float) and reservation.get('version')==1 and created<=now+60 and 0<until-created<=86400 and now<until<=now+86400,'H3 reservation not valid/live')
        scope={'__name__':'_installed_lease_acceptance'};exec(compile(lease_source,'<root-verified installed lease>','exec'),scope)
        root_fd=None
        def exclusive(path,flags=os.O_RDWR|os.O_CREAT):
            nonlocal root_fd
            I.require(str(path)==f'/proc/self/fd/{lease_fixture}/barrier.lock' and flags==os.O_RDWR|os.O_CREAT and root_fd is None,'unexpected lease fixture operation')
            fd=os.open('barrier.lock',flags|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=lease_fixture)
            try:
                I.require(os.fstat(fd).st_uid==fixture_owner,'root fixture was not freshly root-owned')
                root_fd=keep(os.dup(fd));return fd
            except BaseException:
                os.close(fd);raise
        scope['_open']=exclusive
        with scope['_barrier'](Path('/proc/self/fd')/str(lease_fixture),fcntl.LOCK_EX,0):
            info=os.fstat(root_fd)
            I.require((info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(uid,gid,0o600),'installed root-fchown branch failed')
            I.require(I.inode(os.stat('barrier.lock',dir_fd=lease_fixture,follow_symlinks=False))==I.inode(info),'root fixture replaced')
        # A duplicate shares the flock description; explicit unlock is mandatory.
        fcntl.flock(root_fd,fcntl.LOCK_UN);root_key=I.inode(os.fstat(root_fd))
        fcntl.flock(barrier,fcntl.LOCK_EX|fcntl.LOCK_NB);started=clock()
        try:
            before=clock();during=peer.call({'version':1,'method':'during','attemptId':attempt,'nonce':token});received=clock()
            I.require(received-before>=PEER_REFUSAL_SECONDS and received-started<HOST_HOLD_SECONDS,'during proof outside full host hold')
            I.require(during['binding']==own,'peer changed during hold')
            validate_control(during['result'],'during',attempt,token,probe,root_key,uid,gid)
            remaining=HOST_HOLD_SECONDS-(clock()-started)
            I.require(remaining>0,'host hold deadline elapsed before proof')
            sleep(remaining)
            I.require(clock()-started>=HOST_HOLD_SECONDS,'host EX held for less than sixty seconds')
        finally:fcntl.flock(barrier,fcntl.LOCK_UN)
        released=clock();after=peer.call({'version':1,'method':'after','attemptId':attempt,'nonce':token})
        I.require(clock()-released<=15 and after['binding']==own,'postrelease proof late/peer changed')
        validate_control(after['result'],'after',attempt,token,probe,root_key,uid,gid)
        I.require(I.inode(os.stat('barrier.lock',dir_fd=leases,follow_symlinks=False))==probe['barrierKey'],'persistent barrier replaced')
        I.require(I.inode(os.stat('barrier.lock',dir_fd=lease_fixture,follow_symlinks=False))==root_key,'root fixture replaced')
        return {'H1':True,'H2':True,'H3':True,'hostHoldSeconds':released-started,'rootFixtureKey':root_key,'rootBeforeUid':fixture_owner,'rootAfterUid':uid,'during':during['result'],'after':after['result']}
    finally:
        for fd in reversed(fds):os.close(fd)


def run_acceptance(config,host,peer):
    attempt=str(uuid.uuid4());token=secrets.token_hex(32);expires=time.time()+590
    host.begin(attempt,token)  # Old success is unusable as soon as a requalification begins.
    prepared=None;retired=False;accepted=False
    try:
        before,deployment,lease=host.binding()
        prepared=peer.call({'version':1,'method':'prepare','attemptId':attempt,'nonce':token,'employeeId':config['peerEmployeeId'],'expiresAt':expires})
        expect_peer(before,prepared['binding'],config,deployment)
        result=prepared['result']
        I.require(result.get('status')=='PREPARED' and result.get('attemptId')==attempt and result.get('nonce')==token and result.get('uid')==deployment['laptop_uid'] and result.get('gid')==deployment['laptop_gid'],'invalid prepared peer')
        current,_,_=host.binding()
        # First holder may create an absent barrier, but no existing inode or other binding may change.
        if before['persistentLease']['barrierKey'] is None:
            expected=dict(before);expected['persistentLease']=dict(current['persistentLease'])
            I.require(expected['persistentLease']['directoryKey']==before['persistentLease']['directoryKey'] and expected['persistentLease']['directoryMountId']==before['persistentLease']['directoryMountId'],'persistent lease directory changed')
        else:expected=before
        I.require(current==expected and current['persistentLease']['barrierKey']==result['probe']['barrierKey'],'binding/barrier changed during prepare')
        before=current
        proof=kernel_gate(config,prepared,peer,deployment,lease)
        I.require(proof.get('rootBeforeUid')==0,'root-created fixture ownership was not physically established')
        ending=peer.call({'version':1,'method':'retireOwn','attemptId':attempt,'nonce':token})
        I.require(ending['binding']==prepared['binding'] and ending['result'].get('status')=='RETIRED' and ending['result'].get('cleanupComplete') is True,'owned peer retirement unconfirmed')
        retired=True
        current,_,_=host.binding();I.require(current==before,'configuration/code/fleet/layout changed during acceptance')
        receipt={'version':1,'status':'LEASE_ACCEPTED','attemptId':attempt,'nonce':token,'acceptedAt':time.time(),'expiresAt':time.time()+config['receiptLifetimeSeconds'],
                 'binding':before,'peerBinding':prepared['binding'],'proof':proof,'peerRetired':True}
        host.store(receipt);accepted=True
        return receipt
    finally:
        if not retired:
            try:peer.call({'version':1,'method':'retireOwn','attemptId':attempt,'nonce':token})
            except Exception:pass
        if not accepted:host.begin(attempt,token,'FAILED')


def check_receipt(config,host):
    receipt=I.decoded(I.read_path(Path(config['stateDirectory'])/'lease-acceptance.json',protected=True,limit=1024*1024))
    attempt=I.decoded(I.read_path(Path(config['stateDirectory'])/'lease-acceptance-attempt.json',protected=True))
    I.require(attempt=={'version':1,'attemptId':receipt.get('attemptId'),'nonce':receipt.get('nonce'),'status':'ACCEPTED'},'current qualification failed, pending or changed')
    I.require(isinstance(receipt,dict) and receipt.get('version')==1 and receipt.get('status')=='LEASE_ACCEPTED' and receipt.get('peerRetired') is True,'accepted receipt unavailable')
    I.require(type(receipt.get('expiresAt')) in (int,float) and time.time()<receipt['expiresAt']<=time.time()+86400,'acceptance expired')
    current,_,_=host.binding();I.require(receipt.get('binding')==current,'acceptance binding changed')
    proof=receipt['proof'];I.require(proof['during']['barrierKey']==current['persistentLease']['barrierKey'] and proof['after']['barrierKey']==current['persistentLease']['barrierKey'],'accepted persistent barrier differs');I.require(all(proof.get(k) is True for k in ('H1','H2','H3')) and proof.get('hostHoldSeconds',0)>=HOST_HOLD_SECONDS and proof.get('rootBeforeUid')==0,'physical proof incomplete')
    I.canonical_id(receipt['attemptId']);I.nonce(receipt['nonce'])
    return receipt


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False)
    for flag in ('config','initializer','docker','peer-binary'):parser.add_argument('--'+flag,type=Path,required=True)
    modes=parser.add_mutually_exclusive_group(required=True);modes.add_argument('--run',action='store_true');modes.add_argument('--check',action='store_true')
    raw=sys.argv[1:] if argv is None else argv
    for flag in ('config','initializer','docker','peer-binary'):
        if sum(v.split('=',1)[0]=='--'+flag for v in raw)>1:parser.error('module bindings cannot be overridden')
    args=parser.parse_args(raw)
    try:
        I.require(sys.flags.isolated and os.geteuid()==0,'isolated immutable module on actual host root required')
        H=sibling('host_install');H.immutable(args.config);H.immutable(Path(__file__));H.immutable(args.initializer);H.immutable(args.docker)
        I.require(Path('/proc/1/comm').read_text().strip()=='systemd','systemd host PID namespace required')
        config=validate_config(I.decoded(H.read_file(args.config)))
        I.require(config['peerBinary']==str(args.peer_binary),'module artifact pin cannot be overridden')
        H.immutable(args.peer_binary)
        host=Host(config,args.initializer,args.docker)
        # The initializer independently enforces host/container identity and exact declared custody.
        state=I.open_directory(config['stateDirectory'],protected=True)
        lock=os.open('lease-acceptance.lock',(os.O_RDONLY if args.check else os.O_RDWR|os.O_CREAT)|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=state)
        try:
            info=os.fstat(lock);I.require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o077,'private root lease lock required')
            fcntl.flock(lock,(fcntl.LOCK_SH if args.check else fcntl.LOCK_EX)|fcntl.LOCK_NB)
            receipt=run_acceptance(config,host,PeerClient(config['peerSocket'],config['brokerUid'])) if args.run else check_receipt(config,host)
        finally:os.close(lock);os.close(state)
        receipt_path=Path(config['stateDirectory'])/'lease-acceptance.json'
        print(I.encoded({'status':'CHECKED_LEASE_ACCEPTANCE' if args.check else 'LEASE_ACCEPTED','attemptId':receipt['attemptId'],
                         'receiptPath':str(receipt_path),'receiptSha256':I.digest(I.read_path(receipt_path,protected=True,limit=1024*1024)),
                         'livePruneQualified':False}).decode())
        return 0
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError) as error:
        print('reverie-prune-acceptance: '+str(error),file=sys.stderr);return 2


if __name__=='__main__':raise SystemExit(main())
