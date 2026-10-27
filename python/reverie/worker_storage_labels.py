"""Host human labels only; canonical employee IDs remain the data authority."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import unicodedata

from .worker_storage import (canonical,read_metadata,require_uuid,private_directory,
                             storage_paths,storage_base,validate_storage)


def label_name(value):
    if (not isinstance(value,str) or not value or value!=value.strip() or value.startswith('.') or
        value.endswith('.') or len(value.encode('utf-8'))>120 or value!=unicodedata.normalize('NFC',value) or
        any(char in '/\\' or unicodedata.category(char).startswith('C') for char in value)):
        raise ValueError('Employee label is not a safe single human filename')
    return value


def hostname(config,paths):
    if paths.kind!='employee':return None
    company=read_metadata(config['companyFile'],config['uid'])
    rows=[row for row in company['employees'] if row.get('id')==paths.identity and row.get('owner')==paths.owner]
    if len(rows)!=1:raise ValueError('Current employee hostname binding unavailable')
    name=rows[0].get('name','')
    base=re.sub('[^a-z0-9]+','-',name.lower()).strip('-')[:48].strip('-') or 'employee'
    return base+'-'+paths.identity[:8]


def label_plan(config,root):
    root=canonical(root);base=storage_base(config)
    prohibited=[base,canonical(config['scratchRoot']),*[canonical(m['source']) for m in config.get('mounts',[])]]
    if any(root==path or root.is_relative_to(path) or path.is_relative_to(root) for path in prohibited):
        raise ValueError('Human labels must remain outside data, scratch and shared mounts')
    company=read_metadata(config['companyFile'],config['uid']);bindings={};folded=set()
    for row in company['employees']:
        identity=require_uuid(row.get('id'));name=label_name(row.get('name'))
        key=name.casefold()
        if key in folded or identity in bindings.values():raise ValueError('Employee human label collision')
        paths=storage_paths(config,row.get('sessionId'))
        if paths.kind!='employee' or paths.identity!=identity:raise ValueError('Label employee binding changed')
        bindings[name]=identity;folded.add(key)
    if len(bindings)>256 or len(json.dumps(bindings).encode())>60000:raise ValueError('Human label registry exceeds bound')
    return {'version':1,'root':str(root),'labels':bindings,'authority':'NONE_LABELS_ONLY'}


def apply_labels(config,root):
    from .worker_nix_migrate import private_json
    plan=label_plan(config,root);root=Path(plan['root'])
    parent=canonical(root.parent).stat()
    if parent.st_uid!=config['uid'] or parent.st_mode & 0o022:raise ValueError('Human label parent is not privately controlled')
    private_directory(root,config['uid'],create=True)
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    lock=os.open('.labels.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=directory)
    try:
        info=os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=config['uid'] or info.st_nlink!=1 or info.st_mode & 0o077:
            raise ValueError('Unsafe human label lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        prior_file=root/'.labels.json'
        prior=read_metadata(prior_file,config['uid'],limit=65536) if prior_file.exists() or prior_file.is_symlink() else {'version':1,'labels':{}}
        if not isinstance(prior,dict) or set(prior)!={'version','labels'} or prior['version']!=1 or not isinstance(prior['labels'],dict):
            raise ValueError('Human label registry unavailable')
        base=storage_base(config)/'employees'
        def expected(name,identity):
            label_name(name);require_uuid(identity);return str(base/identity)
        # Validate every affected old/new entry BEFORE creating/removing any.
        for name,identity in prior['labels'].items():
            path=root/name;info=path.lstat()
            if not stat.S_ISLNK(info.st_mode) or info.st_uid!=config['uid'] or os.readlink(path)!=expected(name,identity):
                raise ValueError('Foreign or modified human label; no replacement')
        for name,identity in plan['labels'].items():
            paths=storage_paths(config,next(row['sessionId'] for row in read_metadata(config['companyFile'],config['uid'])['employees'] if row.get('id')==identity))
            validate_storage(config,paths)
            path=root/name
            if path.exists() or path.is_symlink():
                if prior['labels'].get(name)!=identity:raise ValueError('Existing human name belongs to another path')
        if label_plan(config,root)!=plan:raise ValueError('Employee labels changed before publication')
        for name,identity in plan['labels'].items():
            if name not in prior['labels']:
                os.symlink(expected(name,identity),name,dir_fd=directory)  # exclusive, never overwrite
                os.fsync(directory)
        for name,identity in prior['labels'].items():
            if name not in plan['labels']:
                # Parent is private and the owned registry/lock fences label writers.
                if os.readlink(root/name)!=expected(name,identity):raise ValueError('Human label changed before removal')
                os.unlink(name,dir_fd=directory);os.fsync(directory)
        private_json(prior_file,{'version':1,'labels':plan['labels']})
        return plan
    finally:os.close(lock);os.close(directory)
