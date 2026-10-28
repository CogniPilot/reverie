"""Owner-local metadata-only GPU laptop preflight; never creates or changes a laptop.

The optional Nix launcher pins Python/YAML and the engine client. Every subprocess
is a fixed read-only command. CDI bytes remain a separately reviewed host policy,
not a device entitlement or evidence that rendering/compute has succeeded.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reverie import worker_gpu as G
from reverie import worker_storage as S
from reverie import worker_resources as R
from reverie import worker_resource_reservations as A
from reverie import worker_docker as D
from reverie.worker import validate_config

LIMIT = 1 << 20
COMMAND_SECONDS = 8
SHA = re.compile(r'[0-9a-f]{64}\Z')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
GPU_ROOT = Path('/proc/driver/nvidia/gpus')
INFO_FORMAT = '{"ID":{{json .ID}},"OSType":{{json .OSType}},"KernelVersion":{{json .KernelVersion}},"ServerVersion":{{json .ServerVersion}},"CDISpecDirs":{{json .CDISpecDirs}}}'
IMAGE_FORMAT = '{"Id":{{json .Id}},"Config":{"User":{{json .Config.User}},"Labels":{{json .Config.Labels}}}}'
LAPTOP_FORMAT = '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}},"OOMKilled":{{json .State.OOMKilled}},"StartedAt":{{json .State.StartedAt}}},"Config":{"User":{{json .Config.User}},"Labels":{{json .Config.Labels}}},"HostConfig":{{json .HostConfig}}}'


def need(value, message):
    if not value: raise ValueError(message)


def run(args):
    """Fixed caller-owned metadata commands, bounded before allocation."""
    need(type(args)is list and all(type(value)is str and len(value)<=4096 and '\0'not in value for value in args),
         'Closed metadata arguments required')
    allowed=args==['context','inspect','--format','{{json .Endpoints.docker.Host}}'] or args==['info','--format',INFO_FORMAT]
    if len(args)==5 and args[:3]in (['image','inspect','--format'],['container','inspect','--format']):
        allowed=(args[:4]==['image','inspect','--format',IMAGE_FORMAT]and IMAGE.fullmatch(args[4]))or(
            args[:4]==['container','inspect','--format',LAPTOP_FORMAT]and
            re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}-agent-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',args[4]))
    need(allowed,'Only fixed read-only engine metadata commands are available')
    deadline=time.monotonic()+COMMAND_SECONDS
    env={key:os.environ[key]for key in ('HOME','PATH','DOCKER_HOST','DOCKER_CONTEXT','XDG_CONFIG_HOME')if key in os.environ}
    process=subprocess.Popen(['docker',*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL,env=env)
    selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
    raw=bytearray()
    try:
        while True:
            left=deadline-time.monotonic();need(left>0,'Engine metadata deadline exceeded')
            need(selector.select(left),'Engine metadata deadline exceeded')
            data=os.read(process.stdout.fileno(),min(65536,LIMIT+1-len(raw)))
            if not data:break
            raw.extend(data);need(len(raw)<=LIMIT,'Engine metadata exceeds bound')
        left=deadline-time.monotonic();need(left>0,'Engine metadata deadline exceeded')
        need(process.wait(timeout=left)==0,'Engine metadata unavailable')
        return json.loads(raw)
    finally:
        selector.close();process.stdout.close()
        if process.poll()is None:process.kill()
        process.wait(timeout=2)


def read_config(path):
    path=S.canonical(path);info=path.lstat()
    need(stat.S_ISREG(info.st_mode)and not info.st_mode&0o077,'Private owner broker configuration required')
    return validate_config(S.read_metadata(path,os.getuid(),limit=65536))


def binding(config,employee):
    S.require_uuid(employee)
    company=S.read_metadata(config['companyFile'],config['uid'])
    rows=company.get('employees')if type(company)is dict else None
    need(type(rows)is list,'Current employee registry unavailable')
    selected=[row for row in rows if type(row)is dict and row.get('id')==employee]
    need(len(selected)==1,'Select one current employee, never a retired identity')
    row=selected[0];session=S.require_uuid(row.get('sessionId'))
    current=G.current_employee(config,session)
    need(current is not None and current['id']==employee,'Current GPU employee binding unavailable')
    need(type(row.get('desiredRunning',True))is bool and type(row.get('onVacation',False))is bool,
         'Owner running/vacation intent is unavailable')
    return {**current,'desiredRunning':row.get('desiredRunning')is not False,'onVacation':bool(row.get('onVacation')),
        'recipeDigest':hashlib.sha256(json.dumps(row.get('runtimeRecipe'),sort_keys=True,
            separators=(',',':'),allow_nan=False).encode()).hexdigest()}


def decode_cdi(raw):
    if raw.lstrip().startswith(b'{'):
        def unique(pairs):
            value={}
            for key,item in pairs:
                need(key not in value,'Duplicate CDI field');value[key]=item
            return value
        return json.loads(raw,object_pairs_hook=unique,
            parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite CDI field')))
    # YAML is included only in the opt-in Nix tool, never the ordinary worker.
    import yaml
    class Loader(yaml.SafeLoader):
        def compose_node(self,parent,index):
            need(not self.check_event(yaml.AliasEvent),'CDI YAML aliases are unsupported')
            return super().compose_node(parent,index)
        def construct_mapping(self,node,deep=False):
            keys=[self.construct_object(key,deep=deep)for key,_ in node.value]
            need(all(type(key)is str for key in keys)and len(keys)==len(set(keys)),'Duplicate or unsupported CDI key')
            return super().construct_mapping(node,deep=deep)
    return yaml.load(raw,Loader=Loader)


def _spec_bytes(file):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        need(stat.S_ISREG(st.st_mode)and st.st_uid in (0,os.getuid())and st.st_nlink==1
             and not st.st_mode&0o022 and st.st_size<=262144,'Unprotected CDI specification')
        parts=[];count=0
        while data:=os.read(fd,min(65536,262145-count)):
            count+=len(data);need(count<=262144,'CDI specification exceeds bound');parts.append(data)
        stamp=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        need(count==st.st_size and stamp(os.fstat(fd))==stamp(st)==stamp(file.lstat()),'CDI specification changed')
        return b''.join(parts)
    finally:os.close(fd)


def cdi_device(directories,device):
    need(type(directories)is list and 1<=len(directories)<=8,'Engine CDI specification directories unavailable')
    matches=[];count=0;total=0;deadline=time.monotonic()+5
    for directory in directories:
        path=Path(directory)
        need(type(directory)is str and path.is_absolute()and '..'not in path.parts,'Canonical CDI directory required')
        if not path.exists():continue
        parent=path.resolve(strict=True);info=parent.stat()
        need(stat.S_ISDIR(info.st_mode)and info.st_uid in (0,os.getuid())and not info.st_mode&0o022,'Unprotected CDI directory')
        with os.scandir(parent)as entries:
            files=[]
            for entry in entries:
                count+=1;need(count<=128 and time.monotonic()<deadline,'CDI directory exceeds bound or deadline')
                files.append(parent/entry.name)
        for file in files:
            if file.suffix not in ('.json','.yaml','.yml'):continue
            raw=_spec_bytes(file);total+=len(raw);need(total<=LIMIT and time.monotonic()<deadline,'CDI bytes exceed bound or deadline')
            value=decode_cdi(raw);need(type(value)is dict and type(value.get('devices'))is list and len(value['devices'])<=256,'Invalid CDI device catalogue')
            if value.get('kind')!='nvidia.com/gpu':continue
            names=[row.get('name')if type(row)is dict else None for row in value['devices']]
            need(all(type(name)is str for name in names)and len({name.lower()for name in names})==len(names),'Ambiguous CDI device identity')
            for row in value['devices']:
                if 'nvidia.com/gpu='+row['name']==device:
                    edits=value.get('containerEdits',{});local=row.get('containerEdits',{})
                    need(type(edits)is dict and type(local)is dict,'Invalid CDI edits')
                    mounts=[*edits.get('mounts',[]),*local.get('mounts',[])]
                    nodes=[*edits.get('deviceNodes',[]),*local.get('deviceNodes',[])]
                    hooks=[*edits.get('hooks',[]),*local.get('hooks',[])]
                    need(len(mounts)<=256 and len(nodes)<=64 and len(hooks)<=32,'CDI edits exceed bound')
                    matches.append({'path':str(file),'sha256':hashlib.sha256(raw).hexdigest(),
                        'deviceNodePaths':[item.get('path')for item in nodes],
                        'mountCount':len(mounts),'allMountsReadonly':all('ro'in item.get('options',[])for item in mounts),
                        'hookCount':len(hooks),'hostPolicyReviewRequired':True})
    need(len(matches)==1,'Selected physical GPU CDI entry is missing or ambiguous')
    return matches[0]


def _process(pid):
    need(type(pid)is int and pid>1,'Current laptop process unavailable')
    root=Path('/proc')/str(pid)
    with (root/'stat').open('rb')as stream:raw=stream.read(8193)
    need(len(raw)<=8192,'Laptop process metadata exceeds bound')
    values=raw.rsplit(b')',1)[1].split();need(values[0]not in (b'Z',b'X'),'Laptop process ended')
    guest=(root/'root').stat()
    return {'pid':pid,'startTick':int(values[19]),'rootIdentity':[guest.st_dev,guest.st_ino],
        'namespaces':{name:(root/'ns'/name).stat().st_ino for name in ('mnt','pid','user')}}


def physical_device(device):
    """Fixed kernel-driver metadata, no NVML context, index identity or workload."""
    matches=[]
    with os.scandir(GPU_ROOT)as entries:
        for count,entry in enumerate(entries,1):
            need(count<=64 and entry.is_dir(follow_symlinks=False),'NVIDIA kernel inventory unavailable')
            with (GPU_ROOT/entry.name/'information').open('rb')as stream:raw=stream.read(16385)
            need(len(raw)<=16384,'NVIDIA kernel metadata exceeds bound')
            fields=dict(line.split(':',1)for line in raw.decode().splitlines()if ':'in line)
            identity=fields.get('GPU UUID','').strip()
            if ('nvidia.com/gpu='+identity).lower()==device.lower():
                need(G.DEVICE.fullmatch('nvidia.com/gpu='+identity),'Invalid native physical GPU identity')
                need(re.fullmatch(r'[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]',fields.get('Bus Location','').strip())
                     and fields.get('Device Minor','').strip().isdecimal(),'Physical GPU coordinates unavailable')
                matches.append({'uuid':identity,'pci':fields.get('Bus Location','').strip(),
                                'deviceMinor':fields.get('Device Minor','').strip(),
                                'model':fields.get('Model','').strip()[:128]})
    need(len(matches)==1,'Selected CDI UUID does not match one current kernel GPU')
    return matches[0]


def laptop(config,current):
    name=config['deployment']+'-agent-'+current['sessionId']
    item=run(['container','inspect','--format',LAPTOP_FORMAT,name])
    labels=item['Config'].get('Labels')or{}
    need(labels.get('reverie.employee')==current['id']and labels.get('reverie.session')==current['sessionId']
         and labels.get('reverie.worker')==config['deployment'],'Current native employee laptop differs')
    host=item['HostConfig'];resources=R.effective_config(config,current['sessionId'])
    need(item['Config']['User']==f"{config['uid']}:{config['gid']}" and host.get('ReadonlyRootfs')is True,
         'Native laptop identity or readonly protection differs')
    caps=host.get('CapAdd');expected={'SETUID','SETGID'}if D.enabled(config)else set()
    need('CapAdd'in host and (caps is None or type(caps)is list and all(type(value)is str for value in caps))and
         {value.removeprefix('CAP_')for value in (caps or[])}==expected and host.get('CapDrop')==['ALL']
         and host.get('Privileged')is False and host.get('PidMode')in ('','private'),
         'Current laptop capability or namespace policy differs')
    need(host.get('Memory')==resources['memoryMiB']*1048576 and host.get('MemorySwap')==resources['memoryMiB']*1048576
         and host.get('PidsLimit')==resources['pidsLimit'],'Current laptop resource labels or limits differ')
    need(labels.get('reverie.worker-policy')==R.policy_digest(config,current['sessionId']),'Current laptop policy differs')
    process=_process(item['State']['Pid'])if item['State']['Running']else None
    return {'id':item['Id'],'image':item['Image'],'running':item['State']['Running'],
        'startedAt':item['State']['StartedAt'],'oomKilled':item['State']['OOMKilled'],'process':process,
        'resources':{key:host.get(key)for key in ('Memory','MemorySwap','PidsLimit')},
        'devices':host.get('Devices'),'cdiDevices':host.get('CDIDevices'),
        'deviceRequests':host.get('DeviceRequests'),'capAdd':host.get('CapAdd'),'capDrop':host.get('CapDrop')}


def check(config,employee,device,*,image=None,browser=False,spec_sha256=None):
    need(type(device)is str and G.DEVICE.fullmatch(device),'Select one physical NVIDIA CDI UUID')
    before=binding(config,employee);session=before['sessionId']
    selected=copy.deepcopy(config);selected.setdefault('employeeGpuGrants',{})[employee]=device
    need((G.projected_gpu_grants(selected,session)or{}).get(session)==device,'An explicit SID grant overrides this employee selection')
    endpoint=os.environ.get('DOCKER_HOST')
    if os.environ.get('DOCKER_CONTEXT')or not endpoint:
        endpoint=run(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])
    need(type(endpoint)is str and endpoint.startswith('unix:///'),'GPU laptop preflight requires the existing local Unix engine')
    info_args=['info','--format',INFO_FORMAT]
    info=run(info_args)
    need(info.get('OSType')=='linux'and info.get('KernelVersion')==os.uname().release,'Native same-kernel Linux engine required')
    cdi=cdi_device(info.get('CDISpecDirs'),device)
    physical=physical_device(device)
    numeric=[path for path in cdi['deviceNodePaths']if type(path)is str and re.fullmatch(r'/dev/nvidia[0-9]+',path)]
    need(numeric==['/dev/nvidia'+physical['deviceMinor']],'CDI physical node does not match the current GPU UUID')
    if spec_sha256 is not None:
        need(type(spec_sha256)is str and SHA.fullmatch(spec_sha256)and cdi['sha256']==spec_sha256,'Reviewed CDI specification changed')
    image=image or config['image'];need(type(image)is str and IMAGE.fullmatch(image),'Immutable image ID required')
    artifact=run(['image','inspect','--format',IMAGE_FORMAT,image])
    need(artifact.get('Id')==image,'Selected image identity changed')
    D.require_image(config,artifact)
    labels=artifact['Config'].get('Labels')or{}
    if browser:need(labels.get('org.reverie.worker.browser')=='1','Matching opt-in browser image must be built and qualified first')
    native=laptop(config,before)
    need(cdi_device(info.get('CDISpecDirs'),device)==cdi,'CDI specification changed during preflight')
    need(run(info_args)==info,'Engine identity or CDI selection changed during preflight')
    need(laptop(config,before)==native,'Native laptop facts changed during preflight')
    need(physical_device(device)==physical,'Physical GPU changed during preflight')
    resources=R.effective_config(config,session)
    configured=(G.projected_gpu_grants(config,session)or{}).get(session)
    if native['process']is not None:need(_process(native['process']['pid'])==native['process'],'Current laptop process changed')
    need(binding(config,employee)==before,'Employee identity or owner intent changed during preflight')
    return {'kind':'GPU_LAPTOP_METADATA_ONLY','employee':before,'engine':{'endpoint':endpoint,'id':info.get('ID'),'version':info.get('ServerVersion')},
        'device':device,'physicalGPU':physical,'cdi':cdi,'image':image,'browserProfile':labels.get('org.reverie.worker.browser')=='1',
        'ownerIntentAllowsStart':before['desiredRunning']and not before['onVacation'],
        'resources':{key:resources[key]for key in R.RESOURCE_FIELDS},'currentLaptop':native,
        'currentlyConfiguredGrant':configured,
        'policyDomain':{'before':A.domain_digest(config),'proposed':A.domain_digest(selected),
            'reconciliationRequiredIfProvisioned':True,'neverResetExistingJournal':True},
        'protectedConfigGenerationRebindRequiredIfInstalled':True,
        'newGrantRequiresReviewedBrokerConfigurationAndSelectedLaptopRecreation':True,
        'nativeDeviceAccessVerified':False,'GPUComputeOrRenderingVerified':False,'VRAMQuotaEnforced':False,'effectsPerformed':False}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False)
    parser.add_argument('--config',required=True,type=Path);parser.add_argument('--employee',required=True)
    parser.add_argument('--device',required=True);parser.add_argument('--image');parser.add_argument('--browser',action='store_true')
    parser.add_argument('--cdi-sha256',help='Owner-reviewed specification digest; mismatches refuse')
    args=parser.parse_args(argv)
    try:
        config=read_config(args.config)
        result=check(config,args.employee,args.device,image=args.image,browser=args.browser,spec_sha256=args.cdi_sha256)
        need(read_config(args.config)==config,'Broker configuration changed during preflight')
        raw=json.dumps(result,sort_keys=True,allow_nan=False);need(len(raw)<=65536,'GPU preflight report exceeds bound');print(raw);return 0
    except(ImportError,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
        print('GPU laptop metadata preflight unavailable: verify current owner binding, existing local CDI/driver, immutable UID/GID image and reviewed specification. No setup or laptop change was performed.',file=sys.stderr)
        return 77


if __name__=='__main__':raise SystemExit(main())
