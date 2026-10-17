"""CTO-directed daily work, research, consolidation and dreaming with shared budgets."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta
import fcntl
import json
import os
from pathlib import Path
import re
import time
import urllib.request
from zoneinfo import ZoneInfo
from .config import Config
from .cycle_budget import Ledger, MeteredClient, Deferred, BudgetExhausted
from .cycle_runner import OpenCodeRunner
from .dream import Dreamer
from .fleet import Fleet, SAFEGUARDS
from .instance import initial_self_for
from .memory import MemoryStore
from .opencode import dispatch
from .chat import Brain
from .project_memory import ProjectMemory
from .reflection import Reflector
from .room import Room
from .plan_usage import PlanMonitor

PHASES=('waking','planning','research','implementation','reporting','consolidation','dreaming','sleeping')


def object_reply(text):
    start,end=text.find('{'),text.rfind('}')
    if start<0 or end<start: raise ValueError('model did not return a JSON object')
    value=json.loads(text[start:end+1])
    if not isinstance(value,dict): raise ValueError('model reply must be an object')
    return value


def identifier(value):
    return isinstance(value,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',value)


def hhmm(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d\d:\d\d',value): raise ValueError('use HH:MM local times')
    hour,minute=map(int,value.split(':'))
    if hour>23 or minute>59: raise ValueError('invalid time')
    return hour*60+minute


class Cycle:
    def __init__(self, policy_path, transport=None, runner=None):
        self.path=Path(policy_path).expanduser().resolve(strict=True)
        self.policy=json.loads(self.path.read_text())
        self.transport=transport
        self.state=self.resolve(self.policy['state_dir']); self.state.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.ledger=Ledger(self.state/'cycle.sqlite')
        self.agents=self.policy['agents']; self.models=self.policy['models']; self.resources=self.policy['resources']
        self.coordinator=self.policy['coordinator']
        if self.coordinator not in self.agents: raise ValueError('coordinator must be a configured agent')
        self.zone=ZoneInfo(self.policy.get('timezone','UTC'))
        self.runner=runner or OpenCodeRunner(self.resolve(self.policy['scratch_dir']))
        self.validate()

    def resolve(self, value):
        path=Path(value).expanduser()
        return path.resolve() if path.is_absolute() else (self.path.parent/path).resolve()

    def validate(self):
        hhmm(self.policy.get('wake_at','08:00')); hhmm(self.policy.get('sleep_at','22:00'))
        for name,agent in self.agents.items():
            if not identifier(name) or agent.get('kind') not in ('cto','expert'): raise ValueError('invalid persistent agent')
            self.resolve(agent['instance']).resolve(strict=True)
            if agent['model'] not in self.models: raise ValueError('unknown default model')
            for phase in PHASES:
                cap=agent['phases'][phase]
                if set(cap)!={'max_tokens','max_seconds'} or any(not isinstance(v,int) or isinstance(v,bool) or v<0 for v in cap.values()):
                    raise ValueError('phase limits must be nonnegative integer tokens/seconds')
            if agent.get('max_children',0)<0: raise ValueError('invalid child count')
        for resource,limit in self.resources.items():
            if not identifier(resource) or any(not isinstance(limit.get(k),int) or isinstance(limit.get(k),bool) or limit[k]<0
                                               for k in ('max_tokens','max_seconds')):
                raise ValueError('invalid resource ceiling')
        databases=[]
        for agent in self.agents.values():
            cfg=Config(instance_config=self.resolve(agent['instance']))
            if cfg.db_path in databases: raise ValueError('persistent agents require separate private memory stores')
            databases.append(cfg.db_path)
        for name,model in self.models.items():
            if not identifier(name) or model['resource'] not in self.resources: raise ValueError('invalid model resource')
            endpoint=__import__('urllib.parse',fromlist=['urlsplit']).urlsplit(model['api_base'])
            if endpoint.scheme not in ('http','https') or not endpoint.hostname or endpoint.username or endpoint.password:
                raise ValueError('model endpoint must not embed credentials')
            for key in ('context_window','output_tokens'):
                if not isinstance(model[key],int) or model[key]<=0: raise ValueError('invalid model limits')
        for task in self.policy.get('tasks',[]):
            if not identifier(task['id']) or task.get('kind') not in ('research','implementation'):
                raise ValueError('invalid approved backlog task')
            if not isinstance(task.get('approved'),bool): raise ValueError('task needs an explicit approval state')
            task['workdir']=str(self.resolve(task['workdir']))
            if not Path(task['workdir']).is_dir(): raise ValueError('task workspace is missing')
            for command in task.get('verification',[]):
                if not isinstance(command,list) or not command or any(not isinstance(x,str) for x in command):
                    raise ValueError('verification commands must be argument lists')

    def close(self): self.ledger.close()

    def paused(self, agent=None):
        global_pause=self.state/'owner-paused'
        if global_pause.exists(): return True
        if agent:
            cfg=Config(instance_config=self.resolve(self.agents[agent]['instance']))
            return cfg.hold_path.exists()
        return False

    @contextmanager
    def agent(self, name):
        cfg=Config(instance_config=self.resolve(self.agents[name]['instance'])); cfg.ensure_dirs()
        store=MemoryStore(cfg.db_path)
        fleet=Fleet(store,initial_self_for(cfg.instance))
        if not fleet.self_model()['revision']:
            fleet.save_self(initial_self_for(cfg.instance),'Owner-selected instance identity',0)
        try: yield cfg,store,fleet
        finally: store.close()

    @contextmanager
    def lock(self, name):
        with (self.state/(name+'.lock')).open('a') as file:
            try: fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise Deferred('another controller owns this work')
            try: yield
            finally: fcntl.flock(file,fcntl.LOCK_UN)

    def cap(self, name, phase):
        result=dict(self.agents[name]['phases'][phase])
        for key,definition in self.attributes(name).items():
            prefix='phases.'+phase+'.'
            if key.startswith(prefix):
                field=key[len(prefix):]
                if field in result: result[field]=min(result[field],int(definition['value']))
        return result

    def resource_cap(self, model):
        resource=self.resources[model['resource']]
        return {'max_tokens':max(0,resource['max_tokens']-resource.get('reserved_tokens',0)),
                'max_seconds':max(0,resource['max_seconds']-resource.get('reserved_seconds',0))}

    def available(self):
        result={}
        plans={}
        source=self.policy.get('plan_usage')
        if source:
            try:
                plans=PlanMonitor(source['api_url'],self.ledger,source.get('reserve_percent',5),
                                  source.get('max_age_seconds',600)).refresh()
            except Exception:
                plans={}
        self.plan_capacity=plans
        for key,model in self.models.items():
            if not model.get('enabled',False): continue
            try:
                if not model.get('local',False):
                    profile=model.get('plan_profile')
                    if not profile or not plans.get(profile,{}).get('available'): continue
                headers={}
                if model.get('api_key_env'):
                    token=os.environ.get(model['api_key_env'])
                    if not token: continue
                    headers['Authorization']='Bearer '+token
                request=urllib.request.Request(model['api_base'].rstrip('/')+'/models',headers=headers)
                with urllib.request.urlopen(request,timeout=5) as response: value=json.load(response)
                if not any(item.get('id')==model['model'] for item in value.get('data',[])): continue
                result[key]=model
            except (OSError,ValueError,TypeError): continue
        return result

    def context(self, name, task):
        config=self.agents[name]
        # Project evidence is explicitly retrieved; another agent's personal store is never searched.
        parts=['Role: '+config['role'],'Interests: '+', '.join(config.get('interests',[])),
               'Current style traits/tags (not capability claims): '+json.dumps(self.attributes(name)),task]
        root=self.resolve(self.policy['project_memory_dir'])
        for project in config.get('projects',[]):
            memory=ProjectMemory(root,project)
            try:
                for query in config.get('memory_queries',config.get('interests',[]))[:3]:
                    for item in memory.lookup(query)[:3]:
                        parts.append(json.dumps({'project':project,'id':item['id'],'text':item['text'],
                                                 'source':item['meta'].get('source','')})[:1600])
            finally: memory.close()
        return '\n\n'.join(parts)[:10000]

    def client(self, name, phase, model_key, day):
        model=self.models[model_key]
        return MeteredClient(model,self.ledger,day,name,phase,self.cap(name,phase),self.resource_cap(model),self.transport)

    def phase(self, name, phase, model_key, day, callback):
        if self.paused(name): raise Deferred('owner paused this agent')
        previous=next((r for r in self.ledger.phases(day,name) if r['phase']==phase),None)
        if previous:
            if previous['status']=='deferred':
                with self.ledger.db:
                    self.ledger.db.execute('DELETE FROM phases WHERE day=? AND agent=? AND phase=?',(day,name,phase))
            elif previous['status'] in ('completed','skipped'): return
            else: raise Deferred('previous phase failed or was interrupted; inspect before retrying')
        cap=self.cap(name,phase)
        if not cap['max_seconds']:
            if self.ledger.claim_phase(day,name,phase): self.ledger.finish_phase(day,name,phase,'skipped','disabled by policy')
            return
        if not self.ledger.claim_phase(day,name,phase): return
        try:
            with self.agent(name) as (cfg,store,fleet):
                mode=fleet.read('lifecycle',{'mode':'active'})['body']['mode']
                if mode=='vacation' and phase not in ('consolidation','dreaming','sleeping'):
                    self.ledger.finish_phase(day,name,phase,'skipped','on vacation'); return
                if phase not in ('waking','sleeping'):
                    resource=self.models[model_key]['resource']
                    with self.lock('resource-'+resource): result=callback(cfg,store,fleet,self.client(name,phase,model_key,day))
                else: result=callback(cfg,store,fleet,None)
                if result is not None:
                    current=fleet.read('cycle:'+day+':'+phase)
                    fleet.write('cycle:'+day+':'+phase,result,current['revision'])
            self.ledger.finish_phase(day,name,phase,'completed')
        except Deferred as error:
            self.ledger.finish_phase(day,name,phase,'deferred',str(error)); raise
        except BaseException:
            self.ledger.finish_phase(day,name,phase,'needs_review','phase failed; inspect private state and usage receipts')
            raise

    def wake(self,name,model,day):
        def waking(cfg,store,fleet,client):
            # Loading identity/plan is CPU work. Model prefill is charged on the later request.
            brain=Brain(cfg,store,None,Room('',cfg.hold_path))
            packet=dispatch(brain,{'action':'context','channel':'work',
                'context_window':self.models[model]['context_window'],
                'output_tokens':self.models[model]['output_tokens']})
            return {'model':model,'role':self.agents[name]['role'],'context':packet,
                    'note':'Project histories are available through explicit scoped lookup.'}
        self.phase(name,'waking',model,day,waking)

    def approved_tasks(self):
        result={}
        for task in self.policy.get('tasks',[]):
            completed=self.ledger.db.execute('SELECT status FROM jobs WHERE id=?',(task['id'],)).fetchone()
            if task['approved'] and (not completed or completed[0] not in ('verified','research_complete')):
                result[task['id']]=task
        return result

    def validate_schedule(self, value, available):
        assignments=value.get('assignments',[])
        if not isinstance(assignments,list) or len(assignments)>len(self.agents): raise ValueError('invalid wake schedule')
        tasks={t['id']:t for t in self.policy.get('tasks',[]) if t['approved']}; seen=set(); assigned=set()
        for assignment in assignments:
            name=assignment['agent']
            if name not in self.agents or name in seen: raise ValueError('unknown or duplicate scheduled agent')
            seen.add(name); agent=self.agents[name]
            if assignment['model'] not in available or assignment['model'] not in agent.get('allowed_models',[agent['model']]):
                raise ValueError('scheduled model is unavailable or unauthorized')
            hhmm(assignment.get('not_before',self.policy.get('wake_at','08:00')))
            task_ids=assignment.get('task_ids',[])
            if not isinstance(task_ids,list) or any(t not in tasks or t in assigned for t in task_ids):
                raise ValueError('schedule must select distinct approved backlog tasks')
            if any(tasks[t]['project'] not in agent.get('projects',[]) for t in task_ids):
                raise ValueError('assignment is outside the lead project scope')
            assigned.update(task_ids)
            children=assignment.get('children',[])
            if not isinstance(assignment.get('allow_subagents',False),bool) or not isinstance(children,list):
                raise ValueError('invalid delegation policy')
            if assignment.get('allow_subagents') and not agent.get('allow_subagents',False):
                raise ValueError('owner policy forbids this lead from spawning')
            if children and (not assignment.get('allow_subagents') or len(children)>agent.get('max_children',0)):
                raise ValueError('child budget or delegation limit exceeded')
            child_tasks=set()
            for child in children:
                if child['task_id'] not in task_ids or child['task_id'] in child_tasks: raise ValueError('invalid child task')
                child_tasks.add(child['task_id'])
                if child['model'] not in available or child['model'] not in agent.get('child_models',[]):
                    raise ValueError('child model is unavailable or unauthorized')
                if child['role'] not in agent.get('child_roles',['implementer']): raise ValueError('unauthorized child role')
            if agent['kind']=='expert' and any(tasks[t]['kind']=='implementation' and t not in child_tasks for t in task_ids):
                raise ValueError('specialist leads oversee implementers; coding requires a scheduled child')
        return assignments

    def plan(self, day, available):
        name=self.coordinator; model=self.agents[name]['model']
        if model not in available: raise Deferred('CTO model is not registered or available')
        def planning(cfg,store,fleet,client):
            tasks=self.approved_tasks()
            roster={k:{key:a.get(key) for key in ('role','kind','projects','allowed_models','phases','allow_subagents','max_children','child_models','child_roles')}
                    for k,a in self.agents.items()}
            resources={key:{'remaining':{item:max(0,self.resource_cap(m)[item]-self.ledger.usage(day,resource=m['resource'])[item.removeprefix('max_')])
                                         for item in ('max_tokens','max_seconds')},'resource':m['resource']}
                       for key,m in available.items()}
            prompt=self.context(name,'Plan today to maximize useful verified progress within the actual available resources.')
            prompt+='\nRoster: '+json.dumps(roster)+'\nApproved backlog: '+json.dumps(list(tasks.values()))
            prompt+='\nAvailable models/resource balance: '+json.dumps(resources)
            horizon=self.policy.get('planning_horizon_days',14)
            previous=fleet.read('rolling_plan',{})['body']
            prompt+='\nCurrent date: '+day+'; rolling horizon: '+str(horizon)+' days. Previous roadmap: '+json.dumps(previous)[-6000:]
            prompt+='\nMeasured account usage/reset windows (percentages are not token counts): '+json.dumps(getattr(self,'plan_capacity',{}))
            prompt+='\nAlso return roadmap: [{date: YYYY-MM-DD, goal: text, dependencies: [text], capacity_assumptions: [text]}]. '
            prompt+='Plan one to two weeks ahead, with detailed assignments today and tentative milestones later. '
            prompt+='Use observed reset windows for future capacity assumptions, never claim a future quota is already available.'
            prompt+='\nReturn JSON {"assignments":[{"agent":"lead-id","model":"model-key","not_before":"08:00",'
            prompt+='"task_ids":["approved-task-id"],"allow_subagents":true,"children":[{"task_id":"approved-task-id",'
            prompt+='"model":"model-key","role":"implementer"}]}],"notes":"why this allocation"}. '
            prompt+='Experts supervise coding children, may conduct research themselves, and report to you. '
            prompt+='Use only configured agents, available authorized models and approved backlog IDs. Empty assignments are valid. '+SAFEGUARDS
            value=object_reply(client.chat([{'role':'system','content':'You are the CTO allocating a fleet schedule. '+cfg.instance.persona},
                                            {'role':'user','content':prompt}],max_tokens=1800,max_chars=16000,temperature=.2))
            value['assignments']=self.validate_schedule(value,available)
            horizon=int(self.policy.get('planning_horizon_days',14))
            if not 7<=horizon<=14: raise ValueError('planning horizon must be 7..14 days')
            end=datetime.fromisoformat(day).date()+timedelta(days=horizon-1)
            for milestone in value.get('roadmap',[]):
                date=datetime.fromisoformat(milestone['date']).date()
                if not datetime.fromisoformat(day).date()<=date<=end: raise ValueError('milestone is outside rolling horizon')
            previous=fleet.read('rolling_plan',{})
            fleet.write('rolling_plan',{'from':day,'through':end.isoformat(),
                        'roadmap':value.get('roadmap',[]),'notes':value.get('notes',''),
                        'assignments':value['assignments']},previous['revision'])
            return value
        self.wake(name,model,day)
        self.phase(name,'planning',model,day,planning)
        with self.agent(name) as (_,_,fleet): return fleet.read('cycle:'+day+':planning',{})['body']

    def tool_task(self, name, model_key, day, task, phase, child=None):
        existing=self.ledger.db.execute('SELECT status FROM jobs WHERE id=?',(task['id'],)).fetchone()
        if existing:
            if existing[0] in ('verified','research_complete'): return
            raise Deferred('task has a previous attempt; inspect its handoff before retrying')
        model=self.models[model_key]; cap=self.cap(name,phase); resource=self.resource_cap(model)
        own=self.ledger.usage(day,name,phase); shared=self.ledger.usage(day,resource=model['resource'])
        cap={'max_tokens':min(cap['max_tokens']-own['tokens'],resource['max_tokens']-shared['tokens']),
             'max_seconds':min(cap['max_seconds']-own['seconds'],resource['max_seconds']-shared['seconds'])}
        if cap['max_tokens']<1024 or cap['max_seconds']<1: raise BudgetExhausted('no child compute budget remains')
        key=self.ledger.reserve(day,name,phase,model['resource'],cap['max_tokens'],cap['max_seconds'],self.cap(name,phase),resource)
        with self.ledger.db: self.ledger.db.execute('INSERT INTO jobs VALUES (?,?,?,?)',(task['id'],name,'running','{}'))
        try:
            with self.agent(name) as (_,_,fleet): analysis=fleet.read('cycle:'+day+':planning',{})['body']
            brief=self.context(name,task['brief'])+'\nLead guidance (not new permissions): '+json.dumps(analysis)[:4000]
            instance=self.resolve(self.agents[name]['instance'])
            if child:
                # Disposable implementer identity gets only the selected project assignment, no lead private history.
                child_dir=self.state/'children'/task['id']; child_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
                instance=child_dir/'instance.json'
                from .runtime import atomic_write
                atomic_write(instance,{'id':task['id'],'agent_name':child['role'],'owner_name':'Fleet owner',
                    'data_dir':'memory','persona':'You are a bounded coding implementer. Follow the approved assignment and report evidence.',
                    'role':child['role'],'kind':'implementer'})
            started=time.monotonic()
            result=self.runner.run(instance=instance,model=model,task={**task,'brief':brief},cap=cap,
                                   cancel=lambda:self.paused(name))
            tokens=result.get('tokens')
            self.ledger.finish(key,tokens,result.get('seconds',time.monotonic()-started),
                               'completed' if result.get('exit_code')==0 and not result.get('stop_reason') else 'stopped')
            checks=result.get('verification',[])
            verified=(result.get('exit_code')==0 and not result.get('stop_reason') and bool(checks) and
                      len(checks)==len(task.get('verification',[])) and all(c['exit_code']==0 and not c.get('stop_reason') for c in checks))
            status=('research_complete' if task['kind']=='research' and result.get('exit_code')==0 and not result.get('stop_reason')
                    else 'verified' if verified else 'needs_review')
            receipt={'task_id':task['id'],'kind':task['kind'],'project':task['project'],'model':model_key,
                     'child_role':child['role'] if child else None,'exit_code':result.get('exit_code'),
                     'stop_reason':result.get('stop_reason'),'verification':checks,
                     'summary':result.get('summary','')[:6000],
                     'research_is_proposal':task['kind']=='research'}
            with self.ledger.db: self.ledger.db.execute('UPDATE jobs SET status=?,receipt=? WHERE id=?',
                                                      (status,json.dumps(receipt),task['id']))
            # Verified command receipts are shared. A model's narrative is not promoted as fact.
            if verified:
                memory=ProjectMemory(self.resolve(self.policy['project_memory_dir']),task['project'])
                try: memory.remember('Task '+task['id']+' verification commands passed: '+json.dumps(checks),
                                      'cycle receipt '+task['id']+'; inspect project workspace '+task['workdir'])
                finally: memory.close()
        except BaseException:
            self.ledger.finish(key,status='interrupted_or_unknown')
            with self.ledger.db: self.ledger.db.execute('UPDATE jobs SET status=? WHERE id=?',('needs_review',task['id']))
            raise

    def lead(self, assignment, day):
        name=assignment['agent']; model=assignment['model']; tasks=self.approved_tasks()
        self.wake(name,model,day)
        def analyze(cfg,store,fleet,client):
            text=self.context(name,'Review these approved tasks and prepare concise evidence-based context for implementers: '+
                json.dumps([tasks[t] for t in assignment.get('task_ids',[]) if t in tasks]))
            return {'guidance':client.chat([{'role':'system','content':cfg.instance.persona+' Your role is '+self.agents[name]['role']},
                {'role':'user','content':text+' State assumptions, relevant sources, acceptance checks and open questions. '+SAFEGUARDS}],
                max_tokens=900,max_chars=6000,temperature=.3)}
        if name!=self.coordinator: self.phase(name,'planning',model,day,analyze)
        children={c['task_id']:c for c in assignment.get('children',[])}
        for phase,kind in (('research','research'),('implementation','implementation')):
            selected=[tasks[t] for t in assignment.get('task_ids',[]) if t in tasks and tasks[t]['kind']==kind]
            def execute(cfg,store,fleet,client,selected=selected,phase=phase):
                for task in selected:
                    child=children.get(task['id']); actual=child['model'] if child else model
                    # Each child consumes the lead's shared implementation allocation.
                    if self.models[actual]['resource']==self.models[model]['resource']: self.tool_task(name,actual,day,task,phase,child)
                    else:
                        with self.lock('resource-'+self.models[actual]['resource']): self.tool_task(name,actual,day,task,phase,child)
                return {'tasks':[t['id'] for t in selected]}
            if selected: self.phase(name,phase,model,day,execute)
        self.report(name,model,day)

    def report(self,name,model,day):
        def reporting(cfg,store,fleet,client):
            receipts=[json.loads(r[0]) for r in self.ledger.db.execute('SELECT receipt FROM jobs WHERE agent=?',(name,))]
            text='Review the following project work/research receipts. Report results, uncertainty, blockers and recommended next steps. '
            text+='Research and dream ideas remain proposals; do not invent verification. Receipts: '+json.dumps(receipts)[-14000:]
            summary=client.chat([{'role':'system','content':self.agents[name]['role']+' reporting to the CTO.'},
                                 {'role':'user','content':text}],max_tokens=900,max_chars=6000,temperature=.2)
            return {'summary':summary,'source':'project job receipts','proposal_not_new_fact':True}
        self.phase(name,'reporting',model,day,reporting)

    def night(self,name,model,day):
        def consolidate(cfg,store,fleet,client):
            reflector=Reflector(store,client,cfg.profile_path,min_episodes=1)
            before=self.ledger.db.execute("SELECT COUNT(*) FROM usage WHERE day=? AND agent=? AND phase=? AND status!='completed'",
                                          (day,name,'consolidation')).fetchone()[0]
            memories=reflector.reflect()
            after=self.ledger.db.execute("SELECT COUNT(*) FROM usage WHERE day=? AND agent=? AND phase=? AND status!='completed'",
                                         (day,name,'consolidation')).fetchone()[0]
            if after>before: raise RuntimeError('consolidation inference failed')
            return {'private_memory_ids':[m.id for m in memories]}
        def dream(cfg,store,fleet,client):
            vacation=fleet.read('lifecycle',{'mode':'active'})['body']['mode']=='vacation'
            if vacation:
                last=float(store.get_state('vacation_last_dream_attempt','0'))
                if time.time()-last<86400: return {'skipped':'vacation daily limit'}
                store.set_state('vacation_last_dream_attempt',str(time.time())); client.timeout=min(client.timeout,120)
            dreamer=Dreamer(store,client)
            # Shared technical context + this specialist's own experiences; no other private store.
            dreamer.creative_context=lambda:self.context(name,'Questions you may freely explore: '+', '.join(self.agents[name].get('interests',[])))
            dreamer.system_prompt_path=cfg.dream_prompt_path
            memory=dreamer.dream()
            if memory is None:
                failures=self.ledger.db.execute("SELECT COUNT(*) FROM usage WHERE day=? AND agent=? AND phase=? AND status!='completed'",
                                                (day,name,'dreaming')).fetchone()[0]
                if failures: raise RuntimeError('dream inference failed')
            return {'dream_memory_id':memory.id if memory else None,'raw_narrative_retained':False}
        self.phase(name,'consolidation',model,day,consolidate)
        self.phase(name,'dreaming',model,day,dream)
        self.phase(name,'sleeping',model,day,lambda *args:{'state':'sleeping','background_inference':False})

    def run(self, now=None, force=False, available=None):
        now=now or datetime.now(self.zone); now=now.astimezone(self.zone); day=now.date().isoformat()
        minute=now.hour*60+now.minute
        if self.paused(): return {'paused':True}
        if not force and minute<hhmm(self.policy.get('wake_at','08:00')): return {'sleeping':True}
        with self.lock('controller'):
            available=self.available() if available is None else available
            signature=json.dumps({'models':sorted(available),
                'windows':{p:[(w['name'],w['reset_at']) for w in v.get('windows',[])]
                           for p,v in getattr(self,'plan_capacity',{}).items()},
                'tasks':sorted(self.approved_tasks())},sort_keys=True)
            with self.agent(self.coordinator) as (_,_,fleet):
                stored=fleet.read('capacity_signature',{})
                if stored['body'].get('value')!=signature:
                    # Only reopen completed planning. An interrupted tool/model call requires inspection.
                    with self.ledger.db:
                        self.ledger.db.execute("DELETE FROM phases WHERE day=? AND agent=? AND phase='planning' AND status='completed'",
                                               (day,self.coordinator))
                    fleet.write('capacity_signature',{'value':signature},stored['revision'])
            plan=self.plan(day,available)
            # A persisted wake plan is validated again against current resource availability.
            assignments=self.validate_schedule(plan,available)
            errors={}; awake={self.coordinator:self.agents[self.coordinator]['model']}
            ready=[a for a in sorted(assignments,key=lambda a:-a.get('priority',0))
                   if force or minute>=hhmm(a.get('not_before',self.policy.get('wake_at','08:00')))]
            def run_lead(assignment):
                child=Cycle(self.path,self.transport,self.runner)
                try:
                    with child.lock('agent-'+assignment['agent']): child.lead(assignment,day)
                    return None
                except Exception as error: return type(error).__name__
                finally: child.close()
            from concurrent.futures import ThreadPoolExecutor
            workers=max(1,min(8,self.policy.get('max_parallel_leads',len(self.resources))))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures=[(a,pool.submit(run_lead,a)) for a in ready]
                for assignment,future in futures:
                    awake[assignment['agent']]=assignment['model']
                    error=future.result()
                    if error: errors[assignment['agent']]=error
            if force or minute>=hhmm(self.policy.get('sleep_at','22:00')):
                # Every configured persistent specialist gets a bounded night allocation,
                # selected by the CTO's default/last approved model, even with no coding task.
                for name,agent in self.agents.items():
                    model=awake.get(name,agent['model'])
                    if model not in available: errors[name]='model_unavailable'; continue
                    try: self.night(name,model,day)
                    except Exception as error: errors[name]=type(error).__name__
            return {'day':day,'awake':list(awake),'errors':errors,
                    'agents':{name:self.ledger.phases(day,name) for name in self.agents},
                    'resources':{name:self.ledger.usage(day,resource=name) for name in self.resources}}

    def attributes(self,name):
        definitions=self.agents[name].get('attributes',{})
        with self.agent(name) as (_,_,fleet): current=fleet.read('cycle_attributes',{})['body']
        return {key:{**rule,'value':rule['value'] if rule.get('editable')=='frozen' else current.get(key,rule['value'])} for key,rule in definitions.items()}

    def set_attribute(self,name,field,value,reason):
        definition=self.agents[name].get('attributes',{}).get(field)
        if not definition or definition.get('editable')=='frozen': raise ValueError('attribute is owner-frozen or unknown')
        if not reason.strip(): raise ValueError('explain the proposed change')
        if field=='tags':
            if not isinstance(value,list) or len(value)>30 or any(not isinstance(t,str) or not identifier(t) for t in value):
                raise ValueError('tags must be a bounded list of identifiers')
        elif field.startswith('stats.'):
            if not isinstance(value,(int,float)) or isinstance(value,bool) or not 0<=value<=1: raise ValueError('trait statistics use 0..1')
        elif field.startswith('phases.'):
            _,phase,key=field.split('.')
            ceiling=self.agents[name]['phases'][phase][key]
            if not isinstance(value,int) or isinstance(value,bool) or not 0<=value<=ceiling: raise ValueError('phase allocation exceeds owner ceiling')
        else: raise ValueError('only tags, style statistics and phase allocations are editable here')
        with self.agent(name) as (_,_,fleet):
            if definition.get('editable')=='weekly':
                ballot=fleet.vote('attribute:'+field,{'value':value},reason)
                if not ballot['approved']: return {'ballot':ballot}
            elif definition.get('editable')!='agent': raise ValueError('invalid attribute governance')
            current=fleet.read('cycle_attributes',{})
            result=fleet.write('cycle_attributes',{**current['body'],field:value},current['revision'])
            return {'revision':result['revision'],'field':field,'value':value}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy',type=Path,default=os.environ.get('FLEET_CYCLE_POLICY'))
    sub=parser.add_subparsers(dest='action',required=True)
    for command in ('status','tick','once','watch','pause','resume'): sub.add_parser(command)
    profile=sub.add_parser('profile'); profile.add_argument('agent')
    edit=sub.add_parser('set'); edit.add_argument('agent'); edit.add_argument('field'); edit.add_argument('value'); edit.add_argument('--reason',required=True)
    args=parser.parse_args(argv)
    if not args.policy: parser.error('select an external daily-cycle policy')
    while True:
        cycle=Cycle(args.policy)
        try:
            if args.action=='status':
                day=datetime.now(cycle.zone).date().isoformat()
                result={'paused':cycle.paused(),'agents':{n:cycle.ledger.phases(day,n) for n in cycle.agents}}
            elif args.action=='profile': result=cycle.attributes(args.agent)
            elif args.action=='set': result=cycle.set_attribute(args.agent,args.field,json.loads(args.value),args.reason)
            elif args.action=='pause': (cycle.state/'owner-paused').touch(mode=0o600); result={'paused':True}
            elif args.action=='resume': (cycle.state/'owner-paused').unlink(missing_ok=True); result={'paused':False}
            else: result=cycle.run(force=args.action=='once')
            print(json.dumps(result),flush=True)
        except (Exception,KeyboardInterrupt) as error:
            print(json.dumps({'error':type(error).__name__,'detail':str(error) if isinstance(error,Deferred) else 'inspect policy and private receipts'}),flush=True)
            if args.action!='watch': return 1
        finally: cycle.close()
        if args.action!='watch': return 0
        time.sleep(max(1,min(60,cycle.policy.get('poll_seconds',30))))

if __name__=='__main__': raise SystemExit(main())
