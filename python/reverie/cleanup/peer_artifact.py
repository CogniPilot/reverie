"""Pinned static peer artifact and exact read-only single-file mount admission."""
import importlib.util
import os
from pathlib import Path
import struct

if __package__:
    from . import acceptance_io as I
    from . import host_install as H
else:
    def sibling(name):
        spec=importlib.util.spec_from_file_location('_acceptance_artifact_'+name,Path(__file__).with_name(name+'.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
    I=sibling('acceptance_io');H=sibling('host_install')

TARGET='/opt/reverie-acceptance-peer'


def static_elf(data):
    I.require(len(data)>=64 and data[:7]==b'\x7fELF\x02\x01\x01','native little-endian ELF64 artifact required')
    kind,machine=struct.unpack_from('<HH',data,16)
    expected={'x86_64':62,'aarch64':183}.get(os.uname().machine)
    I.require(kind==2 and expected is not None and machine==expected,'native fixed static executable required')
    offset=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54)
    I.require(size>=56 and 0<count<=128 and offset+size*count<=len(data),'invalid ELF program headers')
    I.require(all(struct.unpack_from('<I',data,offset+i*size)[0] not in (2,3) for i in range(count)),'dynamic loader/interpreter artifact refused')


def artifact(path):
    path=I.absolute(path);I.require(path.resolve()==path,'artifact path must not alias another output')
    H.immutable(path)
    data=H.read_file(path,4*1024*1024);static_elf(data)
    I.require(path.stat().st_mode&0o111 and not path.stat().st_mode&0o222,'artifact must be immutable executable')
    return {'path':str(path),'sha256':I.digest(data),'inode':I.inode(path.stat())}


def mounted(row, expected):
    I.require(row.get('readOnlyRootfs') is True and row.get('privileged') is False,'peer root must be read-only and unprivileged')
    caps=row.get('capAdd') or []
    I.require(isinstance(caps,list) and all(isinstance(c,str) for c in caps) and not ({c.upper().removeprefix('CAP_') for c in caps}&{'ALL','SYS_ADMIN','SYS_PTRACE'}),'peer may not remount artifacts or trace its proof process')
    found=[];target=Path(TARGET);source=Path(expected['path'])
    for mount in row['mounts']:
        destination=I.absolute(mount['Destination'])
        if destination==target:
            found.append(mount);continue
        I.require(not (target.is_relative_to(destination) or destination==Path('/bin') or destination.is_relative_to('/bin') or destination==Path('/opt') or destination.is_relative_to('/opt')),'peer executable namespace is shadowed')
        if mount.get('Type')=='bind':
            selected=I.absolute(mount['Source'])
            I.require(not (selected==source or source.is_relative_to(selected) or selected.is_relative_to(source)),'artifact exposed through another mount alias')
    I.require(len(found)==1 and found[0].get('Type')=='bind' and found[0].get('RW') is False and found[0].get('Source')==str(source),'exact immutable read-only peer artifact bind required')
    pid=row['pid'];I.require(type(pid) is int and pid>1,'current init PID required')
    # Follow only this kernel proc magic link, after binding the PID to the inspected container.
    root=os.open('/proc/'+str(pid)+'/root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    opt=file=None
    try:
        opt=I.child_directory(root,'opt')
        file=I.regular(opt,'reverie-acceptance-peer',uid=0,allow_links=True)
        I.require(I.inode(os.fstat(file))==expected['inode'] and I.digest(I.snapshot(file,4*1024*1024))==expected['sha256'],'actual peer artifact inode/content differs')
    finally:
        if file is not None:os.close(file)
        if opt is not None:os.close(opt)
        os.close(root)
    return {'target':TARGET,'source':str(source),'sha256':expected['sha256'],'inode':expected['inode'],'readOnly':True}
