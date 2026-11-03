"""Non-authorizing current native-command observations, separate from viewers.

Only fixed engine metadata/probes and bounded kernel/file metadata are read.
No provider arguments/environment, terminal output, model API or action permit.
"""
import copy,hashlib,json,os,re,stat,subprocess,threading,time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .worker_storage import read_metadata,storage_paths,validate_storage
from .worker_resources import policy_digest
from .worker_gpu_preflight import _process

TTL=5.0
BUDGET=20.0
MAX_EMPLOYEES=64
MAX_PROCESSES=512
UUID=re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')
FIELDS=('id','owner','sessionId','sessionGeneration','desiredRunning','onVacation','bindingMigration','runtimeRecipe','permissions')
INSPECT=('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
 '"Config":{"Labels":{{json .Config.Labels}}},"State":{'
 '"Running":{{.State.Running}},"Pid":{{.State.Pid}},"Paused":{{.State.Paused}},'
 '"Restarting":{{.State.Restarting}},"Dead":{{.State.Dead}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},'
 '"Mounts":{{json .Mounts}}}')


def _need(ok):
    if not ok:raise ValueError('PROVIDER_OBSERVATION_UNKNOWN')


def _stamp(path):
    s=Path(path).lstat()
    return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)


def _key(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def _process_record(pid):
    _need(type(pid)is int and pid>1);root=Path('/proc')/str(pid)
    with(root/'stat').open('rb')as f:raw=f.read(8193)
    _need(len(raw)<=8192);fields=raw.rsplit(b')',1)[1].split();_need(fields[0]not in(b'Z',b'X'))
    with(root/'status').open('rb')as f:raw=f.read(16385)
    _need(len(raw)<=16384);rows=[r.split()[1:]for r in raw.splitlines()if r.startswith(b'NSpid:')]
    _need(len(rows)==1 and 1<=len(rows[0])<=32 and all(v.isdigit()for v in rows[0]))
    facts=_process(pid);_need(facts['startTick']==int(fields[19]))
    return {**facts,'parentPid':int(fields[1]),'guestPid':int(rows[0][-1])}


class ProviderHealthObserver:
    def __init__(self,broker,*,monotonic=time.monotonic,epoch=time.time):
        self.broker=broker;self.monotonic=monotonic;self.epoch=epoch;self.cache={};self.lock=threading.Lock();self.cursor=0

    def _engine(self,args,end):
        _need(self.monotonic()<end and not self.broker.stopping.is_set()and not getattr(self.broker,'cleanup_uncertain',()))
        stop=self.broker.stopping.deadline;actual=min(end,stop)if stop is not None else end
        result=self.broker.run_engine(args,optional=True,deadline=actual)
        _need(self.monotonic()<end and not getattr(self.broker,'cleanup_uncertain',())and len(result.stdout.encode())<=4<<20);return result

    def _binding(self,employee):
        _need(type(employee)is dict and type(employee.get('id'))is str and UUID.fullmatch(employee['id'])and
            type(employee.get('sessionId'))is str and UUID.fullmatch(employee['sessionId'])and
            type(employee.get('sessionGeneration'))is int and 0<employee['sessionGeneration']<=9007199254740991 and
            (employee.get('owner')is None or type(employee['owner'])is str))
        return {k:employee.get(k)for k in FIELDS}

    def _unknown(self,binding):
        return {'observedBinding':[binding[k]for k in FIELDS],'employeeId':binding['id'],'sessionId':binding['sessionId'],'sessionGeneration':binding['sessionGeneration'],
            'state':'unknown','observedAtEpochMs':int(self.epoch()*1000),'reason':'UNCONFIRMED'}

    def _inspect(self,names,end):
        if not names:return {}
        result=self._engine(['inspect','--format',INSPECT,*names],end);wanted=set(names);rows={};ids=set()
        # Missing containers can make Docker return nonzero with a partial
        # metadata result. Only exact named, unique rows are accepted; missing
        # bindings remain UNKNOWN and never elect another current container.
        for line in result.stdout.splitlines():
            row=json.loads(line);_need(type(row)is dict and type(row.get('Name'))is str)
            name=row['Name'].removeprefix('/')
            _need(name in wanted and name not in rows and row.get('Id')not in ids)
            mounts=row.get('Mounts');_need(type(mounts)is list and all(type(m)is dict for m in mounts))
            # Docker metadata record order is not a mount identity. Keep every
            # attribute and duplicate while matching the full-record convention
            # used by NativeObserver; HostConfig and nested field order stay exact.
            row['Mounts']=sorted(mounts,key=lambda m:json.dumps(m,sort_keys=True,separators=(',',':'),allow_nan=False))
            rows[name]=row;ids.add(row.get('Id'))
        _need(len(rows)<=len(wanted));return rows

    def _prepare(self,config,binding,row):
        sid=binding['sessionId'];labels=row.get('Config',{}).get('Labels')or{};state=row['State'];cid=row['Id']
        _need(type(cid)is str and re.fullmatch('[0-9a-f]{64}',cid)and row['Name']=='/'+config['deployment']+'-agent-'+sid and
            labels.get('reverie.worker')==config['deployment']and labels.get('reverie.session')==sid and
            labels.get('reverie.employee')==binding['id']and labels.get('reverie.worker-policy')==policy_digest(config,sid)and
            row['Image']==config['image']and type(state['Pid'])is int and
            ((state['Running']is True and state['Pid']>1)or(state['Running']is False and state['Pid']==0 and
              type(state.get('FinishedAt'))is str and bool(state['FinishedAt'])and not state['FinishedAt'].startswith('0001-')))and
            all(state.get(k)is False for k in ('Paused','Restarting','Dead')))
        stopped=state['Running']is False
        init=None if stopped else _process_record(state['Pid']);paths=storage_paths(config,sid)
        _need(paths.kind=='employee'and paths.identity==binding['id']and paths.owner==binding['owner'])
        storage_marker=paths.root/'storage.json';storage_stamp=_stamp(storage_marker)
        validate_storage(config,paths);_need(_stamp(storage_marker)==storage_stamp)
        mounts=[m for m in row['Mounts']if m.get('Destination')=='/home/agent']
        _need(len(mounts)==1 and mounts[0].get('Type')=='bind'and mounts[0].get('Source')==str(paths.home)and mounts[0].get('RW')is True)
        if not stopped:
            host=paths.home.stat();guest=(Path('/proc')/str(init['pid'])/'root/home/agent').stat()
            _need((host.st_dev,host.st_ino)==(guest.st_dev,guest.st_ino))
        metadata=Path(config['stateRoot'])/sid/'runtime.json';metadata_stamp=_stamp(metadata)
        runtime=read_metadata(metadata,config['uid'],65536);_need(_stamp(metadata)==metadata_stamp)
        _need(type(runtime)is dict and set(runtime)=={'exit'}and type(runtime['exit'])is str and
            runtime['exit'].endswith('.exit')and UUID.fullmatch(runtime['exit'][:-5]))
        launch_dir=paths.home/'.reverie-launch';directory=launch_dir.lstat()
        _need(stat.S_ISDIR(directory.st_mode)and launch_dir.resolve(strict=True)==launch_dir and directory.st_uid==config['uid']and not directory.st_mode&0o077)
        exit_file=launch_dir/runtime['exit'];request=launch_dir/(runtime['exit'][:-5]+'.json');temporary=exit_file.with_name(exit_file.name+'.tmp')
        prepared={'binding':binding,'row':row,'init':init,'stopped':stopped,'metadata':metadata,'metadataStamp':metadata_stamp,
            'storagePaths':paths,'storageMarker':storage_marker,'storageStamp':storage_stamp,
            'directory':launch_dir,'directoryStamp':_stamp(launch_dir),'exit':exit_file,'request':request,'temporary':temporary,
            'completed':os.path.lexists(exit_file),'starting':os.path.lexists(request)or os.path.lexists(temporary)}
        prepared['key']=_key([config,binding,row,init,storage_stamp,prepared['metadataStamp'],prepared['directoryStamp'],prepared['completed'],prepared['starting']])
        return prepared

    def _current(self,p,proof):
        _need(_stamp(p['storageMarker'])==p['storageStamp']and
            storage_paths(self.broker.config,p['binding']['sessionId'])==p['storagePaths'])
        validate_storage(self.broker.config,p['storagePaths'])
        _need(_stamp(p['storageMarker'])==p['storageStamp'])
        if proof:
            _need(_process_record(proof['pane']['pid'])==proof['pane']and all(_process_record(v['pid'])==v for v in proof['children']))
        _need((p['stopped']or _process_record(p['init']['pid'])==p['init'])and _stamp(p['metadata'])==p['metadataStamp']and
            _stamp(p['directory'])==p['directoryStamp']and os.path.lexists(p['exit'])==p['completed']and
            (os.path.lexists(p['request'])or os.path.lexists(p['temporary']))==p['starting'])

    def _probe(self,p,end,cached):
        unknown=self._unknown(p['binding']);proof=None
        try:
            if cached and cached[0]==p['key']and 0<=self.monotonic()-cached[1]<=TTL:
                self._current(p,cached[3]);return copy.deepcopy(cached[2]),cached[3],cached[1]
            cid=p['row']['Id']
            if p['stopped']:
                self._current(p,None)
                return {**unknown,'state':'dead','reason':'CONTAINER_STOPPED','proofKind':'stopped-container',
                    'containerId':cid},None,self.monotonic()
            pane=self._engine(['exec','--env','LANG=C.UTF-8','--env','LC_ALL=C.UTF-8',cid,
                '/bin/tmux','-u','-L','reverie-laptop','display-message','-p','-t','office','#{pane_dead}|#{pane_pid}'],end)
            _need(pane.returncode==0);match=re.fullmatch(r'([01])\|([1-9][0-9]*)',pane.stdout.strip());_need(match is not None)
            dead=match[1]=='1';guest_pid=int(match[2]);state='unknown';reason='UNCONFIRMED'
            if p['completed']or dead:state='dead';reason='COMMAND_EXITED'if p['completed']else'OFFICE_PANE_EXITED'
            elif not p['starting']:
                top=self._engine(['top',cid,'-eo','pid,ppid'],end);_need(top.returncode==0)
                lines=top.stdout.splitlines();_need(1<len(lines)<=MAX_PROCESSES+1 and lines[0].split()==['PID','PPID']);pairs={}
                for line in lines[1:]:
                    values=line.split();_need(len(values)==2 and all(v.isdecimal()for v in values));pid,parent=map(int,values)
                    _need(pid>1 and pid not in pairs);pairs[pid]=parent
                _need(p['init']['pid']in pairs);records=[]
                for pid,parent in pairs.items():
                    _need(self.monotonic()<end and not self.broker.stopping.is_set()and not getattr(self.broker,'cleanup_uncertain',()))
                    try:observed=_process_record(pid)
                    except(FileNotFoundError,ProcessLookupError,ValueError):continue
                    if observed['parentPid']==parent and observed['rootIdentity']==p['init']['rootIdentity']and observed['namespaces']==p['init']['namespaces']:records.append(observed)
                panes=[v for v in records if v['guestPid']==guest_pid];_need(len(panes)==1)
                children=[v for v in records if v['parentPid']==panes[0]['pid']]
                if children:proof={'pane':panes[0],'children':children};state='healthy';reason='LIVE_NATIVE_COMMAND'
            self._current(p,proof)
            return {**unknown,'observedAtEpochMs':int(self.epoch()*1000),'state':state,'reason':reason,
                'proofKind':'live-container','containerId':cid,'initPID':p['init']['pid'],'initStartTick':p['init']['startTick']},proof,self.monotonic()
        except(OSError,ValueError,RuntimeError,subprocess.TimeoutExpired,KeyError,TypeError,IndexError):return unknown,None,self.monotonic()

    def read(self):
        empty={'version':1,'purpose':'worker-provider-health-v1','providers':[]}
        if not self.lock.acquire(blocking=False):return empty
        try:
            end=self.monotonic()+BUDGET
            stop=self.broker.stopping.deadline
            if stop is not None:end=min(end,stop)
            _need(self.monotonic()<end and not self.broker.stopping.is_set()and not getattr(self.broker,'cleanup_uncertain',()))
            from .worker import load_config
            config=copy.deepcopy(self.broker.config);path=Path(self.broker.config_file);config_stamp=_stamp(path)
            # Use the supported parser, including its optional defaults. Raw
            # JSON need not equal the canonical in-memory loaded configuration.
            _need(load_config(path)==config)
            company_path=Path(config['companyFile']);company_stamp=_stamp(company_path)
            company=read_metadata(company_path,config['uid']);_need(_stamp(company_path)==company_stamp)
            employees=company.get('employees');_need(type(employees)is list and len(employees)<=MAX_EMPLOYEES)
            bindings=[self._binding(e)for e in employees];_need(len({b['id']for b in bindings})==len(bindings)and len({b['sessionId']for b in bindings})==len(bindings))
            bindings.sort(key=lambda b:b['id']);n=len(bindings);offset=self.cursor%n if n else 0
            bindings=bindings[offset:]+bindings[:offset];self.cursor=(offset+1)%n if n else 0
            eligible=[b for b in bindings if b['desiredRunning']is True and b['onVacation']is False and not b['bindingMigration']]
            name=lambda b:config['deployment']+'-agent-'+b['sessionId'];names=[name(b)for b in eligible]
            rows=self._inspect(names,end);prepared={};results={b['sessionId']:self._unknown(b)for b in bindings}
            for b in eligible:
                try:
                    _need(self.monotonic()<end);prepared[b['sessionId']]=self._prepare(config,b,rows[name(b)])
                except(OSError,ValueError,RuntimeError,KeyError,TypeError):continue
            # At most four owned fixed-probe clients. Every future and its engine
            # futures join before readback. Any retained-client uncertainty forbids
            # new probes/publication; the existing owned cleanup ledger remains.
            keys=list(prepared);proofs={};observed={}
            # Reserve final metadata readback time; expired queued probes cannot
            # consume a new engine deadline or outlive this observation.
            probe_end=end-min(2.0,BUDGET/10)
            with ThreadPoolExecutor(max_workers=4,thread_name_prefix='provider-read')as pool:
                futures={sid:pool.submit(self._probe,prepared[sid],probe_end,self.cache.get(sid))for sid in keys}
                for sid,future in futures.items():results[sid],proofs[sid],observed[sid]=future.result()
            after=self._inspect(names,end);_need(after==rows)
            staged={}
            for sid,p in prepared.items():
                try:
                    _need(self.monotonic()<end and not self.broker.stopping.is_set()and not getattr(self.broker,'cleanup_uncertain',()))
                    self._current(p,proofs.get(sid));result=results[sid]
                    staged[sid]=(p['key'],observed[sid],copy.deepcopy(result),proofs.get(sid))
                except(OSError,ValueError,RuntimeError,KeyError):results[sid]=self._unknown(p['binding'])
            _need(self.monotonic()<end and not self.broker.stopping.is_set()and not getattr(self.broker,'cleanup_uncertain',())and self.broker.config==config and
                  _stamp(path)==config_stamp and _stamp(company_path)==company_stamp)
            self.cache=staged
            return {**empty,'providers':[results[b['sessionId']]for b in sorted(bindings,key=lambda b:b['id'])]}
        except(OSError,ValueError,RuntimeError,subprocess.TimeoutExpired,KeyError,TypeError):return empty
        finally:self.lock.release()
