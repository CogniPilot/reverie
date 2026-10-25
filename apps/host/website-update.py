"""Owner-reviewed, website-only pinned-image stage for the paired planner.

No import, plan or error path builds/loads/resolves an image, writes broker state,
starts a laptop, restores old data, or restarts the old website. CLI/flake wiring
belongs to the separately reviewed paired planner, not a second swap algorithm.
"""
from __future__ import annotations
import contextlib
import copy
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import threading
import time
import urllib.parse
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'python'))
from reverie.ops_common import canonical, digest, private_directory, private_read
try:
    from reverie.owner_control import custody_digests, CUSTODY_FIELDS
except ModuleNotFoundError as error:
    if error.name!='reverie.owner_control':raise
    custody_digests=None;CUSTODY_FIELDS=None

IMAGE=re.compile(r'sha256:[a-f0-9]{64}')
CONTAINER=re.compile(r'[a-f0-9]{64}')
NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}')
LABEL='reverie.website-update'
MAX_FILE=256*1024*1024
MAX_TOTAL=4*1024*1024*1024
MAX_FILES=100000
PLAN_KEYS={'version','operationId','name','oldId','oldImage','newImage','oldPin','oldImagePin','newImagePin','inputPin','guardPin','controlBinding','controlGrantDigest','stateDirectory','deploymentPath','policyPath','backupScopes','bindSources','spec','specPin','finalSpecApproval','environmentInference','schemaFloors','automaticOldImageRollback'}

class WebsiteRefusal(RuntimeError):
    pass

def require(ok,reason):
    if not ok:raise WebsiteRefusal(reason)

def exact(value,pattern):return type(value) is str and pattern.fullmatch(value) is not None

def strict(raw):
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result,'Duplicate JSON key')
            result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(WebsiteRefusal('Nonfinite JSON')))

def absolute(value):
    require(type(value) is str and value.startswith('/') and str(PurePosixPath(value))==value and not value.startswith('//') and '..' not in PurePosixPath(value).parts and value!='/' and not any(ord(c)<32 or ord(c)==127 for c in value),'Unsupported path')
    return PurePosixPath(value)

def relative(value):
    require(type(value) is str and value and not value.startswith('/') and str(PurePosixPath(value))==value and not any(part in ('.','..') for part in value.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in value),'Unsupported exclusion')
    return PurePosixPath(value)

def environment(values):
    require(type(values) is list,'Unsupported environment')
    result={}
    for value in values:
        require(type(value) is str and '=' in value and '\0' not in value,'Unsupported environment')
        key=value.split('=',1)[0]
        require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',key) and key not in result,'Duplicate/invalid environment key')
        result[key]=value
    return result

def image_pin(image):
    require(exact(image.get('Id'),IMAGE),'Exact loaded image identity required')
    return {key:image.get(key) for key in ('Id','Config','RootFS','Os','Architecture','Variant')}

def container_pin(container):
    state=container['State']
    return {**{key:container.get(key) for key in ('Id','Name','Image','Config','HostConfig','Mounts')},
            'State':{key:state.get(key) for key in ('Running','Paused','Restarting','Dead','Pid','StartedAt')}}

def mounts(value):
    result=[]
    for mount in value['Mounts']:
        require(mount.get('Type') in ('bind','volume') and type(mount.get('RW')) is bool,'Unsupported mount type')
        result.append(tuple(mount.get(key) for key in ('Type','Source','Destination','RW','Propagation')))
    return sorted(result,key=repr)

def bind_sources(container):
    result=[]
    require(type(container['Mounts']) is list and 1<=len(container['Mounts'])<=256,'Unsupported bind inventory')
    for mount in container['Mounts']:
        require(mount['Type']=='bind','Only existing explicit bind layouts are supported')
        source=str(absolute(mount['Source']));path=Path(source);real=str(path.resolve(strict=True));info=path.stat()
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),'Bind source is not regular data/directory')
        result.append({'source':source,'realPath':real,'device':info.st_dev,'inode':info.st_ino,'mode':info.st_mode,'uid':info.st_uid,'gid':info.st_gid})
    return result

def no_create_mounts(old):
    """Legacy -v may create missing sources; structured bind mounts must not."""
    host=old['HostConfig'];original=host.get('Mounts') or [];legacy=host.get('Binds') or []
    require(type(original) is list and type(legacy) is list,'Unsupported bind specification')
    require(not old['Config'].get('Volumes'),'Implicit/anonymous volumes require separate review')
    result=[];used_legacy=set();used_original=set()
    propagation={'private','rprivate','shared','rshared','slave','rslave'}
    for mount in old['Mounts']:
        require(mount['Type']=='bind','Only explicit bind layouts are supported')
        source=str(absolute(mount['Source']));target=str(absolute(mount['Destination']))
        modes=set(filter(None,(mount.get('Mode') or '').split(',')))
        require(modes<={'ro','rw',*propagation},'Unsupported bind mode/label option')
        options={'CreateMountpoint':False}
        if mount.get('Propagation'):
            require(mount['Propagation'] in propagation,'Unsupported bind propagation');options['Propagation']=mount['Propagation']
        for i,value in enumerate(original):
            if value.get('Type')=='bind' and value.get('Source')==source and value.get('Target')==target:
                require(set(value)<={'Type','Source','Target','ReadOnly','BindOptions','Consistency'} and value.get('Consistency','default') in ('','default'),'Unsupported structured bind option')
                extra=value.get('BindOptions') or {}
                require(set(extra)<={'Propagation','NonRecursive','ReadOnlyNonRecursive','ReadOnlyForceRecursive','CreateMountpoint'} and extra.get('CreateMountpoint') is not True,'Unsupported/create-source bind option')
                options.update(extra);options['CreateMountpoint']=False;used_original.add(i)
        for i,value in enumerate(legacy):
            prefix=source+':'+target
            if value==prefix or value.startswith(prefix+':'):
                flags=set(filter(None,value[len(prefix):].lstrip(':').split(',')))
                require(flags<={'ro','rw',*propagation},'Unsupported legacy bind option');used_legacy.add(i)
        result.append({'Type':'bind','Source':source,'Target':target,'ReadOnly':not mount['RW'],'BindOptions':options})
    require(len(used_legacy)==len(legacy) and len(used_original)==len(original),'Unresolved/aliased bind option layout')
    require(len({value['Target'] for value in result})==len(result),'Duplicate bind target')
    return result

def replacement_spec(old,previous_image,target_image,admin_phone_wake):
    """Refresh inherited image defaults; preserve explicit owner settings."""
    require(type(admin_phone_wake) is bool,'Explicit durable adminPhoneWake boolean required')
    require(exact(old.get('Id'),CONTAINER) and exact(old.get('Image'),IMAGE),'Exact container/image identity required')
    require(previous_image['Id']==old['Image'] and exact(target_image.get('Id'),IMAGE),'Loaded image identities differ')
    require(target_image.get('Os')=='linux' and target_image.get('Architecture')==previous_image.get('Architecture'),'Unsupported target platform')
    require((target_image['Config'].get('Labels') or {}).get('reverie.worker.nix-store')=='0','Target must be a reviewed website image')
    host=old['HostConfig']
    require(host.get('NetworkMode') in ('bridge','default') and not host.get('AutoRemove'),'Unsupported website network/lifecycle')
    require(not any(host.get(key) for key in ('ContainerIDFile','Links','VolumesFrom')),'Unsupported external container coupling')
    require((host.get('RestartPolicy') or {}).get('Name','no') in ('no','unless-stopped'),'Retained old image restart policy is unsupported')
    networks=old.get('NetworkSettings',{}).get('Networks',{})
    require(set(networks)<= {'bridge'},'Unsupported extra network attachment')
    for value in networks.values():
        require(not any(value.get(key) for key in ('IPAMConfig','Aliases','Links','DriverOpts')),'Static-IP/endpoint options require separate review')
    mounts(old)
    cfg=copy.deepcopy(old['Config']);before=previous_image['Config'];after=target_image['Config']
    defaults=environment(after.get('Env') or []);inherited=set(before.get('Env') or [])
    for key,value in environment(cfg.get('Env') or []).items():
        if value not in inherited:defaults[key]=value
    defaults.pop('REVERIE_ADMIN_PHONE_WAKE',None)
    defaults['REVERIE_ADMIN_PHONE_WAKE']='REVERIE_ADMIN_PHONE_WAKE='+('enabled' if admin_phone_wake else 'disabled')
    cfg['Env']=list(defaults.values())
    for field in ('Cmd','Entrypoint','Healthcheck','StopSignal','StopTimeout','Shell'):
        if cfg.get(field)==before.get(field):
            if field in after:cfg[field]=copy.deepcopy(after[field])
            else:cfg.pop(field,None)
    labels=dict(after.get('Labels') or {});old_labels=before.get('Labels') or {}
    labels.update({key:value for key,value in (cfg.get('Labels') or {}).items() if old_labels.get(key)!=value})
    cfg['Labels']=labels;cfg['Image']=target_image['Id'];cfg['HostConfig']=copy.deepcopy(host)
    require(not after.get('Volumes'),'Target implicit volumes require separate review')
    cfg['HostConfig'].pop('Binds',None);cfg['HostConfig']['Mounts']=no_create_mounts(old)
    require(cfg.get('User')==old['Config'].get('User') and cfg.get('WorkingDir')==old['Config'].get('WorkingDir'),'Owner process settings changed')
    return cfg

def assert_outside_grants(paths,sources):
    require(type(sources) is list and len(sources)<=8192,'Qualified grant inventory required')
    for value in paths:
        p=Path(str(absolute(str(value))))
        for source in sources:
            mount=Path(str(absolute(source)))
            for a,b in ((p,mount),(p.resolve(),mount.resolve())):
                require(not (a==b or a.is_relative_to(b) or b.is_relative_to(a)),'Website control state overlaps a website/worker grant')

def inherited_environment_keys(old,previous_image):
    defaults=set(previous_image['Config'].get('Env') or [])
    return sorted(key for key,value in environment(old['Config'].get('Env') or []).items() if value in defaults)

def normalized_host_mounts(values):
    require(type(values) is list,'Unsupported mount readback')
    result=[]
    option_names={'Propagation','NonRecursive','ReadOnlyNonRecursive','ReadOnlyForceRecursive','CreateMountpoint'}
    for value in values:
        require(type(value) is dict and set(value)<={'Type','Source','Target','ReadOnly','BindOptions','Consistency'} and value.get('Consistency') in (None,'','default'),'Unknown mount readback option')
        options=value.get('BindOptions') or {};require(type(options) is dict and set(options)<=option_names,'Unknown bind readback option')
        normalized={'Propagation':options.get('Propagation') or 'rprivate'}
        for key in option_names-{'Propagation'}:
            require(options.get(key) in (None,False,True),'Invalid bind option');normalized[key]=options.get(key) is True
        result.append({'Type':value.get('Type'),'Source':value.get('Source'),'Target':value.get('Target'),'ReadOnly':value.get('ReadOnly') is True,'BindOptions':normalized})
    return sorted(result,key=lambda value:(str(value['Target']),str(value['Source'])))

def _stamp(info):return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def _safe_info(info):
    require(info.st_uid in (0,os.getuid()) and not info.st_mode&0o022,'Unsafe state ownership/mode')

def open_path(path):
    """Open a real local file/directory through anchored nofollow descriptors."""
    path=Path(str(absolute(str(path))));fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        for index,part in enumerate(path.parts[1:]):
            flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
            if index<len(path.parts)-2:flags|=os.O_DIRECTORY
            new=os.open(part,flags,dir_fd=fd);os.close(fd);fd=new;_safe_info(os.fstat(fd))
        info=os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),'State scope is not regular data')
        if stat.S_ISREG(info.st_mode):require(info.st_nlink==1,'Hardlinked state is unsupported')
        return fd
    except BaseException:os.close(fd);raise

def resolve_mounted(container_path,old):
    path=absolute(container_path);candidates=[]
    for mount in old['Mounts']:
        destination=absolute(mount['Destination'])
        if path==destination or path.is_relative_to(destination):candidates.append((len(destination.parts),mount,destination))
        require(not destination.is_relative_to(path) or destination==path,'Backup scope crosses an overlapping mount')
    require(candidates,'Backup state is not mapped by an existing mount')
    _,mount,destination=max(candidates,key=lambda value:value[0])
    require(mount['Type']=='bind','State backup requires an owner-readable bind mount')
    host=Path(mount['Source']).joinpath(*path.relative_to(destination).parts)
    fd=open_path(host)
    try:info=os.fstat(fd);pin={'device':info.st_dev,'inode':info.st_ino,'type':'directory' if stat.S_ISDIR(info.st_mode) else 'file'}
    finally:os.close(fd)
    return {'containerPath':container_path,'hostPath':str(host),'rootPin':pin}

def _flag(argv,name):
    require(type(argv) is list and all(type(value) is str for value in argv),'Unsupported website command')
    values=[]
    for index,value in enumerate(argv):
        if value==name:
            require(index+1<len(argv),'Missing selected auth path');values.append(argv[index+1])
        elif value.startswith(name+'='):values.append(value.split('=',1)[1])
    require(len(values)<=1,'Duplicate selected auth path')
    return values[0] if values else None

def backup_map(old,spec,review):
    env=environment(spec.get('Env') or [])
    get=lambda key,default:env.get(key,key+'='+default).split('=',1)[1] or default
    data=str(absolute(get('REVERIE_DATA_DIR',get('REVERIE_DATA','/instances/default')+'/console')))
    scopes=review['backupScopes'];require(type(scopes) is list and 1<=len(scopes)<=32,'Explicit finite backup scopes required')
    planned=[]
    for scope in scopes:
        require(type(scope) is dict and set(scope)=={'containerPath','exclude'} and type(scope['exclude']) is list,'Unsupported backup scope')
        exclusions=[str(relative(value)) for value in scope['exclude']]
        require(len(exclusions)==len(set(exclusions)),'Duplicate exclusion')
        item=resolve_mounted(scope['containerPath'],old);item['exclude']=exclusions;planned.append(item)
    require(len({item['containerPath'] for item in planned})==len(planned),'Duplicate backup scope')
    for i,item in enumerate(planned):
        for other in planned[i+1:]:
            a=Path(item['hostPath']);b=Path(other['hostPath'])
            require(not (a==b or a.is_relative_to(b) or b.is_relative_to(a)),'Overlapping host backup scopes')
    selected=[item for item in planned if item['containerPath']==data]
    require(len(selected)==1 and selected[0]['rootPin']['type']=='directory' and selected[0]['exclude']==['accounts'],'Console scope must be explicit, excluding only live provider accounts')
    argv=(spec.get('Entrypoint') or [])+(spec.get('Cmd') or [])
    old_argv=(old['Config'].get('Entrypoint') or [])+(old['Config'].get('Cmd') or [])
    old_env=environment(old['Config'].get('Env') or [])
    goals=[_flag(old_argv,'--goal-private-config'),_flag(argv,'--goal-private-config')]
    for values in (old_env,env):
        for key,value in values.items():
            if key in ('REVERIE_GOAL_PRIVATE_CONFIG','CODEMAN_GOAL_PRIVATE_CONFIG'):
                goals.append(value.split('=',1)[1])
    for goal in set(value for value in goals if value):
        mapped=resolve_mounted(goal,old);fd=open_path(mapped['hostPath'])
        try:raw=os.read(fd,65537);require(len(raw)<=65536,'Goal config too large');value=strict(raw)
        finally:os.close(fd)
        require(not value.get('serverContainerId'),'Literal Goal serverContainerId requires separately reviewed migration; unsupported website-only stage')
        raise WebsiteRefusal('Selected Goal private bootstrap requires separately reviewed migration')
    # Unknown wrappers/daemon launches can hide effective bootstrap selection;
    # do not infer absence by searching just one argv spelling.
    known_entrypoint=['/bin/tini','-g','-s','--','/usr/local/bin/reverie-start']
    for cfg in (old['Config'],spec):
        cmd=cfg.get('Cmd')
        require(cfg.get('Entrypoint')==known_entrypoint and type(cmd) is list and len(cmd)>=2 and cmd[0] in ('reverie','/bin/reverie') and cmd[1]=='web','Effective website launch/bootstrap layout is unsupported')
    def data_path(values):
        read=lambda key,default:values.get(key,key+'='+default).split('=',1)[1] or default
        return str(absolute(read('REVERIE_DATA_DIR',read('REVERIE_DATA','/instances/default')+'/console')))
    require(data_path(old_env)==data,'Website data-directory migration is unsupported')
    required=[]
    owner_password=str(absolute(get('REVERIE_DATA','/instances/default')+'/owner-password'))
    try:resolve_mounted(owner_password,old)
    except FileNotFoundError:pass
    else:required.append(owner_password)
    auth=_flag(argv,'--service-auth-config')
    require(auth==_flag(old_argv,'--service-auth-config'),'Effective service-auth selection change requires separate review')
    if auth:
        mapped=resolve_mounted(auth,old);fd=open_path(mapped['hostPath'])
        try:raw=os.read(fd,65537);require(len(raw)<=65536,'Service auth config too large');value=strict(raw)
        finally:os.close(fd)
        require(type(value) is dict and type(value.get('version')) is int and value['version']==1 and set(value)<={'version','serviceUid','purposes','principals','setupGrants'} and type(value.get('principals')) is list and len(value['principals'])<=32 and all(type(principal) is dict and set(principal)=={'principal','epoch','key'} for principal in value['principals']),'Unknown selected service auth scope')
        required += [auth]+[principal['key'] for principal in value['principals']]
        for name in required:
            resolve_mounted(name,old)
            require(any(absolute(name)==absolute(item['containerPath']) or (item['rootPin']['type']=='directory' and absolute(name).is_relative_to(absolute(item['containerPath'])) and not any(absolute(name).is_relative_to(absolute(item['containerPath'])/exclude) for exclude in item['exclude'])) for item in planned),'Selected service auth/key not covered by reviewed backup scopes')
    for name in required:
        require(any(absolute(name)==absolute(item['containerPath']) or (item['rootPin']['type']=='directory' and absolute(name).is_relative_to(absolute(item['containerPath'])) and not any(absolute(name).is_relative_to(absolute(item['containerPath'])/exclude) for exclude in item['exclude'])) for item in planned),'Selected owner/auth state not covered by reviewed backup scopes')
    allowed={data,*required}
    require(all(item['containerPath'] in allowed for item in planned),'Unrelated/broad backup scope is unsupported')
    return planned

def bounded_names(fd,remaining):
    """Bound allocation before sorting; never allocate an unbounded listdir."""
    names=[]
    with os.scandir(fd) as entries:
        for entry in entries:
            require(len(names)<remaining,'Backup entry bound exceeded')
            require(entry.name not in ('.','..') and '/' not in entry.name and not any(ord(c)<32 or ord(c)==127 for c in entry.name),'Unsupported checkpoint entry name')
            names.append(entry.name)
    return sorted(names)

def tree_snapshot(scopes,*,deadline):
    """All included identities/listings before copy, and again after copy.

    Call only with every writer quiescent. This detects ordinary mutation; it is
    not a replacement for the owner's quiescence/custody admission.
    """
    result={};count=0;total=0
    def scan(fd,scope,key,rel='',depth=0):
        nonlocal count,total
        require(time.monotonic()<deadline and depth<=64 and count<MAX_FILES,'Checkpoint snapshot bounds exceeded')
        info=os.fstat(fd);_safe_info(info);before=_stamp(info);count+=1
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),'Special checkpoint state')
        if stat.S_ISDIR(info.st_mode):
            names=bounded_names(fd,MAX_FILES-count+1)
            result[key]={'stamp':before,'children':names}
            for name in names:
                child=name if not rel else rel+'/'+name
                if any(PurePosixPath(child)==PurePosixPath(exclude) or PurePosixPath(child).is_relative_to(PurePosixPath(exclude)) for exclude in scope['exclude']):continue
                item=os.stat(name,dir_fd=fd,follow_symlinks=False)
                require(stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode),'Special/symlink checkpoint state')
                child_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
                try:
                    require(_stamp(os.fstat(child_fd))==_stamp(item),'Checkpoint entry changed before open')
                    scan(child_fd,scope,key+'/'+name,child,depth+1)
                finally:os.close(child_fd)
        else:
            require(info.st_nlink==1 and info.st_size<=MAX_FILE,'Unsafe checkpoint file')
            total+=info.st_size;require(total<=MAX_TOTAL,'Checkpoint size bound exceeded');result[key]={'stamp':before}
        require(_stamp(os.fstat(fd))==before,'State changed during checkpoint snapshot')
    for index,scope in enumerate(scopes):
        fd=open_path(scope['hostPath'])
        try:
            info=os.fstat(fd);require((info.st_dev,info.st_ino)==(scope['rootPin']['device'],scope['rootPin']['inode']),'Checkpoint root changed')
            scan(fd,scope,'scope-'+str(index))
        finally:os.close(fd)
    return result

def hash_fd(fd,*,limit,deadline):
    before=os.fstat(fd);require(stat.S_ISREG(before.st_mode) and before.st_size<=limit,'Checkpoint archive bounds exceeded')
    value=hashlib.sha256();length=0
    while True:
        require(time.monotonic()<deadline,'Checkpoint archive deadline exceeded')
        part=os.read(fd,1024*1024)
        if not part:break
        value.update(part);length+=len(part);require(length<=limit,'Checkpoint archive bounds exceeded')
    require(length==before.st_size and _stamp(before)==_stamp(os.fstat(fd)),'Checkpoint archive changed')
    return 'sha256:'+value.hexdigest(),length

def file_hash(path,*,limit,deadline):
    fd=open_path(path)
    try:return hash_fd(fd,limit=limit,deadline=deadline)
    finally:os.close(fd)

def validate_layout(scopes):
    """Bounded read-only preflight; checkpoint repeats checks after quiescence."""
    count=0;total=0;started=time.monotonic()
    def scan(fd,scope,rel='',depth=0):
        nonlocal count,total
        info=os.fstat(fd);_safe_info(info);count+=1
        require(depth<=64 and count<=MAX_FILES and time.monotonic()-started<30,'Backup preflight bounds exceeded')
        if stat.S_ISDIR(info.st_mode):
            for name in bounded_names(fd,MAX_FILES-count+1):
                child=name if not rel else rel+'/'+name
                if any(PurePosixPath(child)==PurePosixPath(exclude) or PurePosixPath(child).is_relative_to(PurePosixPath(exclude)) for exclude in scope['exclude']):continue
                entry=os.stat(name,dir_fd=fd,follow_symlinks=False)
                require(stat.S_ISREG(entry.st_mode) or stat.S_ISDIR(entry.st_mode),'Special/symlink state file refused')
                child_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
                try:
                    actual=os.fstat(child_fd);require((actual.st_dev,actual.st_ino)==(entry.st_dev,entry.st_ino),'State changed before preflight open')
                    scan(child_fd,scope,child,depth+1)
                finally:os.close(child_fd)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=MAX_FILE,'Unsafe backup file')
            total+=info.st_size;require(total<=MAX_TOTAL,'Backup size exceeds bound')
    for scope in scopes:
        fd=open_path(scope['hostPath'])
        try:scan(fd,scope)
        finally:os.close(fd)
    return {'files':count,'bytes':total}

def checkpoint(scopes,output):
    """Durable private tar of finite regular data; no following or archiving sockets."""
    output=Path(output);started=time.monotonic();count=0;total=0;manifest=[]
    initial=tree_snapshot(scopes,deadline=started+120)
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    def budget(size=0):
        nonlocal count,total
        count+=1;total+=size
        require(count<=MAX_FILES and total<=MAX_TOTAL and time.monotonic()-started<120,'Backup bounds exceeded')
    with os.fdopen(fd,'wb') as stream:
        with tarfile.open(fileobj=stream,mode='w') as tar:
            def add(file_fd,name,scope,relative_name=''):
                require(len(PurePosixPath(name).parts)<=64,'Backup depth exceeded')
                info=os.fstat(file_fd);_safe_info(info);before=_stamp(info)
                require(name in initial and before==initial[name]['stamp'],'State changed since initial checkpoint snapshot')
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),'Special state file refused')
                if stat.S_ISDIR(info.st_mode):
                    budget();entry=tarfile.TarInfo(name);entry.type=tarfile.DIRTYPE;entry.mode=0o700;tar.addfile(entry)
                    for child in bounded_names(file_fd,MAX_FILES-count+1):
                        rel=child if not relative_name else relative_name+'/'+child
                        if any(PurePosixPath(rel)==PurePosixPath(exclude) or PurePosixPath(rel).is_relative_to(PurePosixPath(exclude)) for exclude in scope['exclude']):continue
                        require(child not in ('.','..') and '/' not in child,'Invalid state entry')
                        child_info=os.stat(child,dir_fd=file_fd,follow_symlinks=False)
                        require(stat.S_ISDIR(child_info.st_mode) or stat.S_ISREG(child_info.st_mode),'Special state file refused')
                        child_fd=os.open(child,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=file_fd)
                        try:
                            require((child_info.st_dev,child_info.st_ino)==(os.fstat(child_fd).st_dev,os.fstat(child_fd).st_ino),'State entry changed before open')
                            add(child_fd,name+'/'+child,scope,rel)
                        finally:os.close(child_fd)
                else:
                    require(info.st_nlink==1 and info.st_size<=MAX_FILE,'Unsafe/oversized state file');budget(info.st_size)
                    # A bounded regular file copy is checked again before sealing.
                    chunks=[];remaining=info.st_size
                    while remaining:
                        require(time.monotonic()-started<120,'Backup deadline exceeded')
                        part=os.read(file_fd,min(1024*1024,remaining));require(part,'State file changed during backup');chunks.append(part);remaining-=len(part)
                    raw=b''.join(chunks);entry=tarfile.TarInfo(name);entry.size=len(raw);entry.mode=0o600;tar.addfile(entry,io.BytesIO(raw));manifest.append({'name':name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
                require(_stamp(os.fstat(file_fd))==before,'State changed during backup')
            for index,scope in enumerate(scopes):
                data_fd=open_path(scope['hostPath'])
                try:
                    info=os.fstat(data_fd);expected=scope['rootPin'];require((info.st_dev,info.st_ino)==(expected['device'],expected['inode']),'Backup scope identity changed')
                    add(data_fd,'scope-'+str(index),scope)
                finally:os.close(data_fd)
        stream.flush();os.fsync(stream.fileno())
    require(tree_snapshot(scopes,deadline=started+120)==initial,'State changed across checkpoint copy')
    archive_hash,archive_bytes=file_hash(output,limit=MAX_TOTAL+MAX_FILES*10240,deadline=started+120)
    directory=os.open(output.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)
    return {'file':output.name,'files':count,'bytes':total,'entries':manifest,'archiveSha256':archive_hash,'archiveBytes':archive_bytes,'treeDigest':digest(initial),'excluded':[{key:scope[key] for key in ('containerPath','exclude')} for scope in scopes]}

class WebsiteStage:
    def __init__(self,api,state_directory,deployment_path,schema_policy_path,*,guard,ready):
        self.api=api;self.state=Path(str(absolute(str(state_directory))));self.deployment=Path(str(absolute(str(deployment_path))));self.policy=Path(str(absolute(str(schema_policy_path))))
        self.guard=guard;self.ready=ready;self._mutex=threading.RLock();self._depth=0;self._lock_fd=None
    def _container(self,selector):return self.api('GET','/containers/'+urllib.parse.quote(selector,safe='')+'/json')
    def _image(self,image):
        require(exact(image,IMAGE),'Exact image SHA256 ID required; tags are unsupported')
        result=self.api('GET','/images/'+image+'/json');require(result['Id']==image,'Loaded image identity mismatch');return result
    def _inputs(self,name,old_image,new_image):
        raw=private_read(self.deployment,65536);deployment=strict(raw)
        require(type(deployment) is dict and deployment.get('containerName')==name and type(deployment.get('adminPhoneWake')) is bool,'Deployment must explicitly select container and adminPhoneWake boolean')
        review_raw=private_read(self.policy,65536);review=strict(review_raw)
        keys={'version','reviewId','oldImage','newImage','adoption','schemaFloors','backupScopes','approvedSpecDigest'}
        require(type(review) is dict and set(review)==keys and type(review['version']) is int and review['version']==1,'Unsupported schema review policy')
        require(type(review['reviewId']) is str and 1<=len(review['reviewId'])<=128 and all(32<=ord(c)<127 for c in review['reviewId']),'Missing review identity')
        require(review['approvedSpecDigest'] is None or exact(review['approvedSpecDigest'],re.compile(r'sha256:[a-f0-9]{64}')),'Invalid final-spec approval')
        require(review['oldImage']==old_image and review['newImage']==new_image and review['adoption']=='forward-only' and review['schemaFloors']==['GOAL','AUTH'],'Exact reviewed forward GOAL/AUTH adoption policy required')
        return deployment,review,digest({'deployment':hashlib.sha256(raw).hexdigest(),'schemaPolicy':hashlib.sha256(review_raw).hexdigest()})
    def control_paths(self):
        return (self.state,self.deployment,self.policy,self.deployment.parent/'runtime/update-state')
    def _admit_control(self,name,old,snapshot):
        require(type(snapshot) is dict and type(snapshot.get('workerBindSources')) is list,'Qualified all-worker bind inventory unavailable')
        binding=snapshot.get('websiteControlBinding')
        keys={'resourceId','containerName','stateDirectory','deploymentPath','policyPath','maintenanceLockDirectory','generation'}
        require(type(binding) is dict and set(binding)==keys and exact(binding.get('resourceId'),re.compile(r'[a-z0-9][a-z0-9-]{0,95}')) and exact(binding.get('generation'),re.compile(r'sha256:[a-f0-9]{64}')),'Canonical website control binding unavailable')
        require(binding['containerName']==name and binding['stateDirectory']==str(self.state) and binding['deploymentPath']==str(self.deployment) and binding['policyPath']==str(self.policy) and binding['maintenanceLockDirectory']==str(self.deployment.parent/'runtime/update-state'),'Selected paths differ from canonical resource control binding')
        sources=[mount['Source'] for mount in old['Mounts']]+snapshot['workerBindSources']
        assert_outside_grants(self.control_paths(),sources)
        require(callable(custody_digests),'Owner control custody codec unavailable')
        port=getattr(self.guard,'admit_control_custody',None)
        require(callable(port),'Qualified inode/mount custody admission unavailable')
        proof=port(copy.deepcopy(binding),[str(path) for path in self.control_paths()],copy.deepcopy(sources))
        require(type(proof) is dict and set(proof)==CUSTODY_FIELDS and all(exact(value,re.compile(r'sha256:[a-f0-9]{64}')) for value in proof.values()),'Qualified custody proof unavailable')
        expected=custody_digests(binding,self.control_paths(),sources)
        require(all(proof[key]==value for key,value in expected.items()),'Custody proof binding differs')
        return copy.deepcopy(binding),digest(sources)
    def plan(self,name,target_image,expected_container_id,expected_image):
        require(exact(name,NAME) and exact(expected_container_id,CONTAINER) and exact(expected_image,IMAGE),'Exact website/container/image selectors required')
        require(target_image!=expected_image,'Same image uses explicit same-candidate recovery, not cutover')
        old=self._container(name)
        require(old['Id']==expected_container_id and old['Image']==expected_image and old['Name']=='/'+name and old['State']['Running'] and not old['State'].get('Paused') and not old['State'].get('Restarting'),'Website ID/image/running CAS failed')
        require(not (old['Config'].get('Labels') or {}).get('reverie.worker'),'Selected container is a laptop')
        previous=self._image(expected_image);target=self._image(target_image)
        snapshot=self.guard.snapshot();control_binding,grant_digest=self._admit_control(name,old,snapshot)
        deployment,review,input_pin=self._inputs(name,expected_image,target_image)
        spec=replacement_spec(old,previous,target,deployment['adminPhoneWake']);scopes=backup_map(old,spec,review)
        for scope in scopes:
            a=self.state;b=Path(scope['hostPath'])
            require(not (a==b or a.is_relative_to(b) or b.is_relative_to(a)),'Journal/backups overlap live state')
        validate_layout(scopes);source_pins=bind_sources(old)
        operation=digest([expected_container_id,expected_image,target_image,review['reviewId']]).split(':',1)[1][:32];spec.setdefault('Labels',{})[LABEL]=operation
        spec_pin=digest(spec);approval='approved' if review['approvedSpecDigest']==spec_pin else 'required'
        result={'version':1,'operationId':operation,'name':name,'oldId':expected_container_id,'oldImage':expected_image,'newImage':target_image,'oldPin':digest(container_pin(old)),'oldImagePin':digest(image_pin(previous)),'newImagePin':digest(image_pin(target)),'inputPin':input_pin,'guardPin':digest(snapshot),'controlBinding':control_binding,'controlGrantDigest':grant_digest,'stateDirectory':str(self.state),'deploymentPath':str(self.deployment),'policyPath':str(self.policy),'backupScopes':scopes,'bindSources':source_pins,'spec':spec,'specPin':spec_pin,'finalSpecApproval':approval,'environmentInference':{'status':'ambiguous-legacy-values','equalOldImageDefaults':inherited_environment_keys(old,previous)},'schemaFloors':['GOAL','AUTH'],'automaticOldImageRollback':False}
        active=self.state/'website-active.json'
        if os.path.lexists(active):self._adopted_history(active,result)
        return result
    @contextlib.contextmanager
    def maintenance_lock(self):
        """Same-instance reentrant common lock for the paired owner planner."""
        require(self._mutex.acquire(False),'Maintenance already active')
        try:
            if self._depth==0:
                selected=strict(private_read(self.deployment,65536));name=selected.get('containerName')
                require(exact(name,NAME),'Selected deployment unavailable')
                self._admit_control(name,self._container(name),self.guard.snapshot())
                directory=private_directory(self.deployment.parent/'runtime/update-state',create=True)
                fd=os.open(directory/'update.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
                try:
                    info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode&0o077,'Unsafe maintenance lock');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BaseException:os.close(fd);raise
                self._lock_fd=fd
            self._depth+=1
            try:yield
            finally:
                self._depth-=1
                if not self._depth:os.close(self._lock_fd);self._lock_fd=None
        finally:self._mutex.release()
    def _save(self,path,value,*,exclusive=False):
        path=Path(path);raw=canonical(value)+b'\n';temp=path.with_name(path.name+'.tmp-'+uuid.uuid4().hex)
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        try:
            with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
            if exclusive:
                os.link(temp,path,follow_symlinks=False);temp.unlink()
            else:
                if os.path.lexists(path):private_read(path,1024*1024)
                os.replace(temp,path)
            directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(directory)
            finally:os.close(directory)
        finally:
            if temp.exists():temp.unlink()
    def _verify_created(self,candidate,plan,old_mounts):
        require(candidate['Id']!=plan['oldId'] and candidate['Image']==plan['newImage'],'Candidate identity/image mismatch')
        expected=plan['spec']
        for key,value in expected['HostConfig'].items():
            actual=candidate['HostConfig'].get(key)
            if key=='Mounts':
                require(normalized_host_mounts(actual)==normalized_host_mounts(value),'Candidate bind configuration differs');continue
            require(actual==value or key=='OomKillDisable' and value is None and actual is False,'Candidate host configuration differs')
        for key,value in expected.items():
            if key in ('HostConfig','Image'):continue
            require(candidate['Config'].get(key)==value,'Candidate process/environment configuration differs')
        require(mounts(candidate)==old_mounts,'Candidate mount grants differ')
    def _adopted_history(self,active,plan):
        """No filename or partial adopted object proves a durable prior success."""
        record=strict(private_read(active,1024*1024))
        fields={'version','operationId','oldId','oldImage','newImage','phase','state','newId','oldStopped','newStartAttempted','automaticOldImageRollback','schemaState','planDigest','controlBinding','controlGrantDigest','retainedOldName','backup','checkpointDigest'}
        require(type(record) is dict and set(record)==fields,'Prior receipt is partial/unknown')
        require(type(record['version']) is int and record['version']==1 and record['state']=='adopted' and record['phase']=='complete' and record['schemaState']=='adopted-forward-only' and record['oldStopped'] is True and record['newStartAttempted'] is True and record['automaticOldImageRollback'] is False,'Prior forward-schema receipt is not complete')
        require(exact(record['operationId'],re.compile('[a-f0-9]{32}')) and all(exact(record[key],CONTAINER) for key in ('oldId','newId')) and record['oldId']!=record['newId'] and all(exact(record[key],IMAGE) for key in ('oldImage','newImage')) and record['oldImage']!=record['newImage'],'Prior receipt selectors invalid')
        require(all(exact(record[key],re.compile(r'sha256:[a-f0-9]{64}')) for key in ('planDigest','controlGrantDigest','checkpointDigest')),'Prior receipt digest invalid')
        require(record['newId']==plan['oldId'] and record['newImage']==plan['oldImage'],'Prior receipt does not select current website')
        operation=self.state/('website-'+record['operationId']);private_directory(operation)
        saved=strict(private_read(operation/'receipt.private.json',1024*1024))
        require(digest(saved)==digest(record),'Active/operation receipt mismatch')
        historical=strict(private_read(operation/'plan.private.json',8*1024*1024))
        require(type(historical) is dict and set(historical)==PLAN_KEYS and digest(historical)==record['planDigest'],'Prior plan mismatch')
        require(type(historical['version']) is int and historical['version']==1 and historical['automaticOldImageRollback'] is False and historical['schemaFloors']==['GOAL','AUTH'] and historical['finalSpecApproval']=='approved','Prior approval/schema fields invalid')
        for key in ('operationId','oldId','oldImage','newImage','controlBinding','controlGrantDigest'):
            require(historical[key]==record[key],'Prior receipt/plan binding mismatch')
        require(historical['name']==plan['name'] and historical['stateDirectory']==str(self.state) and historical['deploymentPath']==str(self.deployment) and historical['policyPath']==str(self.policy),'Historical owner resource differs')
        prior=historical['controlBinding'];current=plan['controlBinding']
        require(type(prior) is dict and set(prior)==set(current) and exact(prior.get('generation'),re.compile(r'sha256:[a-f0-9]{64}')) and all(prior[key]==current[key] for key in current if key!='generation'),'Historical canonical control resource differs')
        require(digest(historical['spec'])==historical['specPin'] and historical['spec']['Image']==record['newImage'] and historical['spec']['Labels'].get(LABEL)==record['operationId'],'Prior replacement spec mismatch')
        require(record['retainedOldName']==plan['name']+'-before-'+record['operationId'] and record['backup']=='website-state.private.tar','Prior retained artifacts differ')
        checkpoint_manifest=strict(private_read(operation/'checkpoint.private.json',64*1024*1024))
        checkpoint_fields={'file','files','bytes','entries','excluded','archiveSha256','archiveBytes','treeDigest'}
        require(type(checkpoint_manifest) is dict and set(checkpoint_manifest)==checkpoint_fields and digest(checkpoint_manifest)==record['checkpointDigest'],'Prior checkpoint manifest mismatch')
        require(checkpoint_manifest['file']==record['backup'] and type(checkpoint_manifest['files']) is int and 1<=checkpoint_manifest['files']<=MAX_FILES and type(checkpoint_manifest['bytes']) is int and 0<=checkpoint_manifest['bytes']<=MAX_TOTAL and type(checkpoint_manifest['archiveBytes']) is int and 0<=checkpoint_manifest['archiveBytes']<=MAX_TOTAL+MAX_FILES*10240 and exact(checkpoint_manifest['treeDigest'],re.compile(r'sha256:[a-f0-9]{64}')),'Prior checkpoint bounds invalid')
        require(checkpoint_manifest['excluded']==[{key:scope[key] for key in ('containerPath','exclude')} for scope in historical['backupScopes']],'Prior checkpoint scopes differ')
        deadline=time.monotonic()+120
        expected=checkpoint_manifest['entries'];require(type(expected) is list and len(expected)<=MAX_FILES,'Prior checkpoint entry manifest invalid')
        names=set();total=0
        for item in expected:
            require(type(item) is dict and set(item)=={'name','sha256','bytes'} and type(item['name']) is str and str(relative(item['name']))==item['name'] and item['name'] not in names and exact(item['sha256'],re.compile('[a-f0-9]{64}')) and type(item['bytes']) is int and 0<=item['bytes']<=MAX_FILE,'Prior checkpoint file record invalid')
            names.add(item['name']);total+=item['bytes']
        require(total==checkpoint_manifest['bytes'],'Prior checkpoint byte manifest differs')
        # Hash the archive stream members without extracting or following names.
        fd=open_path(operation/record['backup']);members=[];count=0
        try:
            before=_stamp(os.fstat(fd))
            actual_hash,actual_bytes=hash_fd(fd,limit=MAX_TOTAL+MAX_FILES*10240,deadline=deadline)
            require(actual_hash==checkpoint_manifest['archiveSha256'] and actual_bytes==checkpoint_manifest['archiveBytes'],'Prior checkpoint archive differs')
            os.lseek(fd,0,os.SEEK_SET)
            with os.fdopen(os.dup(fd),'rb') as stream,tarfile.open(fileobj=stream,mode='r|') as archive:
                for item in archive:
                    count+=1;require(count<=MAX_FILES and time.monotonic()<deadline and (item.isdir() or item.isfile()),'Unsafe prior archive member')
                    require(type(item.name) is str and str(relative(item.name))==item.name,'Unsafe prior archive path')
                    if item.isfile():
                        require(0<=item.size<=MAX_FILE,'Oversized prior archive member');entry=archive.extractfile(item);value=hashlib.sha256();length=0
                        while True:
                            require(time.monotonic()<deadline,'Prior archive deadline exceeded');part=entry.read(1024*1024)
                            if not part:break
                            value.update(part);length+=len(part);require(length<=MAX_FILE,'Oversized prior archive read')
                        require(length==item.size,'Partial prior archive member');members.append({'name':item.name,'sha256':value.hexdigest(),'bytes':length})
            require(_stamp(os.fstat(fd))==before==_stamp(os.stat(operation/record['backup'],follow_symlinks=False)),'Prior archive changed during validation')
        finally:os.close(fd)
        require(members==expected and count==checkpoint_manifest['files'],'Prior checkpoint contents differ')
        # Epoch/catalogue monotonicity is an additional required parent gate.
        return record
    def apply(self,plan,expected_plan_digest):
        require(os.getuid()!=0,'Run as the ordinary owner, without sudo')
        keys=PLAN_KEYS
        require(type(plan) is dict and set(plan)==keys and digest(plan)==expected_plan_digest and type(plan.get('version')) is int and plan['version']==1 and plan.get('automaticOldImageRollback') is False and plan.get('schemaFloors')==['GOAL','AUTH'],'Reviewed exact closed plan digest required')
        require(plan.get('stateDirectory')==str(self.state) and plan.get('deploymentPath')==str(self.deployment) and plan.get('policyPath')==str(self.policy),'Plan owner paths differ')
        require(exact(plan.get('operationId'),re.compile('[a-f0-9]{32}')) and exact(plan.get('oldId'),CONTAINER) and exact(plan.get('oldImage'),IMAGE) and exact(plan.get('newImage'),IMAGE) and exact(plan.get('name'),NAME),'Invalid plan selectors')
        require(plan['newImage']!=plan['oldImage'],'Same image is not a website cutover')
        require(digest(plan['spec'])==plan['specPin'] and plan['spec']['Image']==plan['newImage'] and plan['spec']['Labels'].get(LABEL)==plan['operationId'],'Plan spec changed')
        require(plan.get('finalSpecApproval')=='approved','Exact final-spec owner approval required')
        # Admission of canonical control location precedes any journal/lock creation.
        observed=self._container(plan['name']);snapshot=self.guard.snapshot()
        control,grants=self._admit_control(plan['name'],observed,snapshot)
        require(control==plan['controlBinding'] and grants==plan['controlGrantDigest'] and digest(snapshot)==plan['guardPin'],'Canonical control/grant binding changed')
        with self.maintenance_lock():
            private_directory(self.state.parent);private_directory(self.state,create=True)
            parent_fd=os.open(self.state.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:os.fsync(parent_fd)  # Persist registered state-directory reachability before effects.
            finally:os.close(parent_fd)
            active=self.state/'website-active.json'
            if os.path.lexists(active):
                self._adopted_history(active,plan)
            operation=self.state/('website-'+plan['operationId']);operation.mkdir(mode=0o700)
            record={'version':1,'operationId':plan['operationId'],'oldId':plan['oldId'],'oldImage':plan['oldImage'],'newImage':plan['newImage'],'phase':'admission','state':'held','newId':None,'oldStopped':False,'newStartAttempted':False,'automaticOldImageRollback':False,'schemaState':'not-started','planDigest':expected_plan_digest,'controlBinding':copy.deepcopy(plan['controlBinding']),'controlGrantDigest':plan['controlGrantDigest']}
            def save():self._save(operation/'receipt.private.json',record);self._save(active,record)
            def stable():
                current=self.guard.snapshot();require(digest(current)==plan['guardPin'],'Worker/broker/native intent guard changed')
                bound,grants=self._admit_control(plan['name'],observed,current)
                require(bound==plan['controlBinding'] and grants==plan['controlGrantDigest'],'Fresh custody/control admission changed')
                _,_,pin=self._inputs(plan['name'],plan['oldImage'],plan['newImage']);require(pin==plan['inputPin'],'Owner inputs changed')
            def old_cas():
                old=self._container(plan['name']);require(digest(container_pin(old))==plan['oldPin'],'Website changed after plan');return old
            stable();old=old_cas()
            previous=self._image(plan['oldImage']);target=self._image(plan['newImage'])
            require(digest(image_pin(previous))==plan['oldImagePin'] and digest(image_pin(target))==plan['newImagePin'],'Loaded image metadata changed')
            deployment,review,_=self._inputs(plan['name'],plan['oldImage'],plan['newImage'])
            require(review['approvedSpecDigest']==plan['specPin'],'Exact final-spec approval missing/stale')
            expected_spec=replacement_spec(old,previous,target,deployment['adminPhoneWake']);expected_spec.setdefault('Labels',{})[LABEL]=plan['operationId']
            require(expected_spec==plan['spec'] and backup_map(old,expected_spec,review)==plan['backupScopes'],'Plan spec/backup map does not match actual reviewed inputs')
            require(bind_sources(old)==plan['bindSources'],'Bind source changed after plan')
            def sources_stable():require(bind_sources(old)==plan['bindSources'],'Bind source disappeared/replaced')
            estimate=validate_layout(plan['backupScopes'])
            require(__import__('shutil').disk_usage(self.state).free>estimate['bytes']+64*1024*1024,'Insufficient scoped checkpoint space')
            save();self._save(operation/'plan.private.json',plan,exclusive=True)
            candidate_name=plan['name']+'-candidate-'+plan['operationId'];old_name=plan['name']+'-before-'+plan['operationId'];new_id=None
            old_mounts=mounts(old)
            try:
                record['phase']='create-attempt';save();sources_stable()
                created=self.api('POST','/containers/create?name='+candidate_name,plan['spec']);new_id=created['Id'];require(exact(new_id,CONTAINER) and new_id!=plan['oldId'],'Invalid candidate identity')
                record.update(newId=new_id,phase='candidate-created');save()
                candidate=self._container(new_id);require(not candidate['State']['Running'],'Candidate unexpectedly running');self._verify_created(candidate,plan,old_mounts);sources_stable()
                stable();old_cas();sources_stable();record['phase']='stop-old-attempt';save()
                self.api('POST','/containers/'+plan['oldId']+'/stop?t=30')
                stopped=self._container(plan['oldId']);require(stopped['Id']==plan['oldId'] and stopped['Image']==plan['oldImage'] and not stopped['State']['Running'],'Old website did not stop exactly')
                record.update(oldStopped=True,phase='checkpoint');save();stable()
                backup=checkpoint(plan['backupScopes'],operation/'website-state.private.tar');require(len(canonical(backup))<=64*1024*1024,'Checkpoint manifest exceeds history bound');self._save(operation/'checkpoint.private.json',backup,exclusive=True);stable()
                record['phase']='rename-old-attempt';save();self.api('POST','/containers/'+plan['oldId']+'/rename?name='+old_name)
                require(self._container(plan['oldId'])['Name']=='/'+old_name,'Old retained name differs')
                self.api('POST','/containers/'+new_id+'/rename?name='+plan['name'])
                selected=self._container(plan['name']);require(selected['Id']==new_id and not selected['State']['Running'],'Candidate/name changed');self._verify_created(selected,plan,old_mounts);stable();sources_stable()
                record.update(phase='new-start-attempt',newStartAttempted=True,schemaState='unknown');save();stable();sources_stable()
                self.api('POST','/containers/'+new_id+'/start')
                require(self.ready(new_id,copy.deepcopy(plan['spec'])) is True,'Candidate readiness unverified')
                selected=self._container(plan['name']);require(selected['Id']==new_id and selected['State']['Running'],'Candidate is not current/running');self._verify_created(selected,plan,old_mounts);stable()
                require(not self._container(plan['oldId'])['State']['Running'],'Old image unexpectedly running')
                record.update(phase='complete',state='adopted',schemaState='adopted-forward-only',retainedOldName=old_name,backup='website-state.private.tar',checkpointDigest=digest(backup));save();return copy.deepcopy(record)
            except BaseException as error:
                record.update(state='unconfirmed',schemaState='unknown' if record['newStartAttempted'] else 'not-started',failure=type(error).__name__)
                # Quiesce ONLY an exact owned candidate. Never delete a container,
                # start old, restore an old name/image, or overwrite live state.
                try:
                    found=self._container(new_id or candidate_name)
                    if found['Id']!=plan['oldId'] and found['Image']==plan['newImage'] and (found['Config'].get('Labels') or {}).get(LABEL)==plan['operationId']:
                        record['newId']=found['Id']
                        if found['State']['Running']:self.api('POST','/containers/'+found['Id']+'/stop?t=5')
                except Exception:record['candidateState']='unknown'
                save()
                raise WebsiteRefusal('Website attempt held; inspect retained candidate/backup/journal; no automatic old-image recovery') from error
