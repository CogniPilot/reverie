from __future__ import annotations
import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from cto.cycle import Cycle
from cto.cycle_budget import Ledger, BudgetExhausted, MeteredClient
from cto.cycle_runner import run_process
from cto.memory import MemoryStore
from cto.plan_usage import capacity


class FakeRunner:
    def __init__(self): self.calls=[]
    def run(self, **request):
        self.calls.append(request)
        instance=json.loads(Path(request['instance']).read_text())
        if request['task']['kind']=='implementation':
            assert instance['kind']=='implementer'
            Path(request['task']['workdir'],'answer.py').write_text('answer = 42\n')
        checks=[]
        for command in request['task'].get('verification',[]):
            p=subprocess.run(command,cwd=request['task']['workdir'],capture_output=True)
            checks.append({'command':command,'exit_code':p.returncode,'stop_reason':None})
        return {'exit_code':0,'stop_reason':None,'tokens':40,'seconds':.01,
                'summary':'Synthetic job completed; inspect verification receipts.','verification':checks}


class CycleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.work=self.root/'work'; self.work.mkdir()
        self.calls=[]; self.runner=FakeRunner()
        phases={p:{'max_tokens':50000,'max_seconds':120} for p in
                ('waking','planning','research','implementation','reporting','consolidation','dreaming','sleeping')}
        agents={}
        for name,kind in (('cto','cto'),('math','expert')):
            instance=self.root/(name+'.json')
            instance.write_text(json.dumps({'id':name,'agent_name':name,'owner_name':'Instructor',
                'data_dir':'memory/'+name,'persona':'Be curious and precise.','role':name,'kind':kind,
                'initial_self':{'consciousness':'An open question.','directives':['Check evidence.']}}))
            agents[name]={'instance':str(instance),'kind':kind,'role':name,'model':'local','allowed_models':['local'],
                'projects':['demo'],'interests':['mathematics'],'phases':phases,'allow_subagents':True,
                'max_children':1,'child_models':['local'],'child_roles':['implementer'],
                'attributes':{'tags':{'value':['mathematics'],'editable':'agent'},
                    'stats.focus':{'value':.7,'editable':'frozen'},
                    'stats.curiosity':{'value':.8,'editable':'weekly'}}}
        self.policy={'coordinator':'cto','agents':agents,'state_dir':str(self.root/'state'),
            'scratch_dir':str(self.root/'scratch'),'project_memory_dir':str(self.root/'projects'),
            'timezone':'UTC','wake_at':'08:00','sleep_at':'22:00','planning_horizon_days':14,
            'models':{'local':{'api_base':'http://unused/v1','model':'qwen','provider':'local_agent',
                       'context_window':32768,'output_tokens':4096,'resource':'gpu','local':True,'enabled':True}},
            'resources':{'gpu':{'max_tokens':500000,'max_seconds':3600}},
            'tasks':[{'id':'answer','kind':'implementation','approved':True,'project':'demo',
                      'workdir':str(self.work),'brief':'Create answer.py exporting answer = 42.',
                      'verification':[['python3','-c','from answer import answer; assert answer == 42']]}]}
        self.path=self.root/'policy.json'; self.path.write_text(json.dumps(self.policy))
        self.cycle=Cycle(self.path,self.transport,self.runner); self.addCleanup(self.cycle.close)

    def transport(self,url,body,timeout):
        value=json.loads(body); self.calls.append(value); system=value['messages'][0]['content']
        if 'allocating a fleet schedule' in system:
            content=json.dumps({'assignments':[{'agent':'math','model':'local','task_ids':['answer'],
                'allow_subagents':True,'children':[{'task_id':'answer','model':'local','role':'implementer'}]}],
                'roadmap':[{'date':'2026-10-15','goal':'Verify the answer','dependencies':[],
                            'capacity_assumptions':['Local GPU is available.']}]})
        elif 'consolidating recent experiences' in system:
            content='[{"insight":"A colleague prefers checking small examples first.","importance":7,"section":"user","sources":[]}]'
        elif 'asleep and dreaming freely' in system:
            content=json.dumps({'dream':'A lattice folds into a question about symmetry and then becomes a little staircase.',
                'recall':'I dreamed about a symmetry staircase.','tone':'playful',
                'ideas':[{'hypothesis':'Symmetry may simplify the search','check':'Enumerate small cases'}]})
        else: content='Use the approved task, test the stated condition, and report evidence.'
        return json.dumps({'choices':[{'message':{'content':content}}],
                           'usage':{'prompt_tokens':100,'completion_tokens':50,'total_tokens':150}}).encode()

    def test_complete_day_routes_child_verifies_work_consolidates_and_discards_raw_dream(self):
        with self.cycle.agent('math') as (_,store,_):
            store.add_episode('PRIVATE_INTERACTION_SENTINEL: please check small examples.','I will remember.')
        now=datetime(2026,10,15,12,tzinfo=timezone.utc)
        result=self.cycle.run(now,force=True,available=self.cycle.models)
        self.assertEqual(result['errors'],{})
        self.assertEqual(len(self.runner.calls),1)
        self.assertEqual((self.work/'answer.py').read_text(),'answer = 42\n')
        self.assertEqual(self.cycle.ledger.db.execute('SELECT status FROM jobs').fetchone()[0],'verified')
        for name in ('cto','math'):
            phases={p['phase']:p['status'] for p in result['agents'][name]}
            self.assertEqual(phases['sleeping'],'completed')
            with self.cycle.agent(name) as (_,store,_):
                dream=store.latest_dream(); self.assertTrue(dream.meta['summary_only'])
                self.assertNotIn('lattice folds',dream.text)
        shared=MemoryStore(self.root/'projects/demo/memory.sqlite')
        try: self.assertNotIn('PRIVATE_INTERACTION_SENTINEL',json.dumps([m.as_dict() for m in shared.all()]))
        finally: shared.close()
        cto_prompt=self.calls[0]['messages']
        self.assertNotIn('PRIVATE_INTERACTION_SENTINEL',json.dumps(cto_prompt))
        # A follow-up tick can replan completed backlog; no implementation job repeats.
        again=self.cycle.run(now,force=True,available=self.cycle.models)
        self.assertEqual(len(self.runner.calls),1)
        self.assertEqual(again['errors'],{})

    def test_pause_and_unauthorized_wakes_children_and_models(self):
        (self.cycle.state/'owner-paused').touch()
        self.assertTrue(self.cycle.run(force=True,available=self.cycle.models)['paused'])
        self.assertEqual(self.calls,[])
        assignment={'agent':'math','model':'local','task_ids':['answer'],'allow_subagents':False,
                    'children':[{'task_id':'answer','model':'local','role':'implementer'}]}
        with self.assertRaises(ValueError): self.cycle.validate_schedule({'assignments':[assignment]},self.cycle.models)
        assignment['allow_subagents']=True; assignment['children'][0]['model']='unavailable'
        with self.assertRaises(ValueError): self.cycle.validate_schedule({'assignments':[assignment]},self.cycle.models)

    def test_attribute_governance_and_weekly_votes(self):
        self.cycle.set_attribute('math','tags',['symmetry'],'A new interest')
        self.assertEqual(self.cycle.attributes('math')['tags']['value'],['symmetry'])
        with self.assertRaises(ValueError): self.cycle.set_attribute('math','stats.focus',.5,'Change a frozen trait')
        for week in range(3):
            with patch('cto.fleet.time.time',return_value=345600+(2500+week)*604800+10):
                result=self.cycle.set_attribute('math','stats.curiosity',.9,'Considered change')
        self.assertEqual(result['value'],.9)

    def test_global_budget_is_shared_and_unknown_usage_is_not_free(self):
        cap={'max_tokens':100,'max_seconds':10}
        key=self.cycle.ledger.reserve('day','a','dreaming','gpu',80,5,cap,cap)
        with self.assertRaises(BudgetExhausted): self.cycle.ledger.reserve('day','b','planning','gpu',30,2,cap,cap)
        self.cycle.ledger.finish(key,status='unknown')
        self.assertEqual(self.cycle.ledger.usage('day',resource='gpu')['tokens'],80)

    def test_owned_process_stops_on_wall_time(self):
        result=run_process(['python3','-c','import time; time.sleep(20)'],self.root,.2)
        self.assertEqual(result['stop_reason'],'time_limit')
        self.assertLess(result['seconds'],4)

    def test_plan_reset_requires_fresh_reading_and_checks_both_windows(self):
        now=1000
        reading={'id':'example','status':'ready','updatedAt':now*1000,'usage':{
            'fiveHour':{'usedPercentage':100,'resetAt':1100*1000},
            'sevenDay':{'usedPercentage':99,'resetAt':2000*1000}}}
        value=capacity(reading,now)
        self.assertFalse(value['available']); self.assertEqual(value['retry_at'],2000)
        reading['updatedAt']=1200*1000
        self.assertFalse(capacity(reading,1200)['available'])
        reading['usage']['fiveHour']={'usedPercentage':0,'resetAt':1600*1000}
        reading['usage']['sevenDay']={'usedPercentage':0,'resetAt':3000*1000}
        self.assertTrue(capacity(reading,1200)['available'])


class FakeProbe:
    """The GPU gate's observations, set per test."""
    def __init__(self):
        self.active=None; self.holder={}; self.activity={}; self.busy=False; self.fail=None
        self.states={'qwen':'loaded','other':'unloaded'}; self.slot_list=[{'id':0,'is_processing':False}]; self.calls=[]
    def last_activity(self, instance):
        self.calls.append('activity')
        if getattr(self,'sequence',None): return self.sequence.pop(0)
        return self.active
    def gpu_holder(self): return self.holder
    def gpu_activity(self): return self.activity
    def gpu_busy(self, cfg): return self.busy
    def router_models(self, model):
        self.calls.append('models')
        if self.fail: raise self.fail
        return dict(self.states)
    def slots(self, model): self.calls.append('slots'); return self.slot_list


class NightTests(unittest.TestCase):
    """Night-only cycles: window, GPU gate, one model phase per tick, batches, backups and the morning check."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.calls=[]; self.probe=FakeProbe()
        day_off={p:{'max_tokens':0,'max_seconds':0} for p in ('waking','planning','research','implementation','reporting')}
        phases={**day_off,'consolidation':{'max_tokens':60000,'max_seconds':900},
                'dreaming':{'max_tokens':20000,'max_seconds':300},'sleeping':{'max_tokens':0,'max_seconds':1}}
        agents={}
        for name,kind in (('alpha','cto'),('beta','expert')):
            instance=self.root/(name+'.json')
            instance.write_text(json.dumps({'id':name,'agent_name':name,'owner_name':'Owner','data_dir':'memory/'+name,
                'persona':'Be curious and precise.','role':name,'kind':kind}))
            agents[name]={'instance':str(instance),'kind':kind,'role':name,'model':'local','phases':phases}
        agents['alpha']['live_resource']='gpu'
        self.policy={'coordinator':'alpha','agents':agents,'state_dir':str(self.root/'state'),
            'scratch_dir':str(self.root/'scratch'),'project_memory_dir':str(self.root/'projects'),'timezone':'UTC',
            'night':{'start':'01:00','end':'06:00'},'gpu_gate':{'min_idle_seconds':1800},
            'backup_dir':str(self.root/'backups'),'night_order':['alpha','beta'],
            'models':{'local':{'api_base':'http://unused/v1','model':'qwen','context_window':32768,'output_tokens':4096,
                               'resource':'gpu','local':True,'enabled':True}},
            'resources':{'gpu':{'max_tokens':500000,'max_seconds':7200}},'tasks':[]}
        self.write()

    def write(self):
        self.path=self.root/'policy.json'; self.path.write_text(json.dumps(self.policy))
        self.cycle=Cycle(self.path,self.transport,probe=self.probe); self.addCleanup(self.cycle.close)

    def transport(self,url,body,timeout):
        value=json.loads(body); self.calls.append(value); system=value['messages'][0]['content']
        if 'consolidating recent experiences' in system:
            content=getattr(self,'insights','[{"insight":"A colleague checks small examples first.","importance":6,"section":"shared","sources":[]}]')
        else:
            content=getattr(self,'dream_reply',json.dumps({'dream':'A lattice folds into a question about symmetry and becomes a staircase.',
                'recall':'I dreamed about a symmetry staircase.','tone':'playful','ideas':[]}))
        return json.dumps({'choices':[{'message':{'content':content}}],
                           'usage':{'prompt_tokens':100,'completion_tokens':50,'total_tokens':150}}).encode()

    def episodes(self, name, count, text='I will check small examples first.'):
        with self.cycle.agent(name) as (_,store,_):
            for i in range(count): store.add_episode('Please check examples %d.' % i, text)

    def statuses(self, night, name):
        return {r['phase']:r['status'] for r in self.cycle.ledger.phases(night,name)}

    AT=datetime(2026,10,16,2,tzinfo=timezone.utc)   # inside the 01:00-06:00 night of 2026-10-16

    def test_outside_the_window_nothing_is_touched(self):
        result=self.cycle.run(datetime(2026,10,16,12,tzinfo=timezone.utc))
        self.assertEqual(result,{'outside_night_window':True})
        self.assertEqual(self.probe.calls,[]); self.assertEqual(self.calls,[])
        self.assertFalse((self.root/'memory').exists())          # no store opened, the coordinator's included

    def test_a_night_runs_one_model_phase_per_tick_and_backs_up_first(self):
        self.episodes('alpha',3); self.episodes('beta',3)
        order=['alpha','beta']; shift=datetime(2026,10,16).toordinal()%2
        first_agent,second_agent=(order[shift:]+order[:shift])
        nxt=datetime(2026,10,17).toordinal()%2
        self.assertNotEqual((order[nxt:]+order[:nxt])[0],first_agent)       # the order rotates nightly
        first=self.cycle.run(self.AT,available=self.cycle.models,max_model_phases=1)
        self.assertEqual(first['day'],'2026-10-16'); self.assertIn('tick',first['errors'])
        self.assertEqual(self.statuses('2026-10-16',first_agent),{'consolidation':'completed'})
        self.assertEqual(self.statuses('2026-10-16',second_agent),{})
        backup=self.root/'backups'/first_agent/'2026-10-16.sqlite'
        self.assertEqual(oct(backup.stat().st_mode & 0o777),'0o600')
        self.assertEqual(oct(backup.parent.stat().st_mode & 0o777),'0o700')
        self.assertEqual(list(backup.parent.glob('*.tmp')),[])
        copy=MemoryStore(backup)
        try: self.assertEqual((copy.count('episode'),copy.count('reflection')),(3,0))   # taken before the night wrote
        finally: copy.close()
        self.cycle.run(self.AT,available=self.cycle.models,max_model_phases=1)
        self.assertEqual(self.statuses('2026-10-16',first_agent),
                         {'consolidation':'completed','dreaming':'completed','sleeping':'completed'})
        for tick in range(3): self.cycle.run(self.AT,available=self.cycle.models,max_model_phases=1)
        self.assertEqual(self.statuses('2026-10-16',second_agent)['sleeping'],'completed')
        before=len(self.calls)
        self.assertEqual(self.cycle.run(self.AT,available=self.cycle.models,max_model_phases=1)['errors'],{})
        self.assertEqual(len(self.calls),before)                  # a finished night repeats nothing
        self.assertEqual(len(list(backup.parent.glob('*.sqlite'))),1)
        copy=MemoryStore(backup)
        try: self.assertEqual(copy.count('reflection'),0)          # never retaken after the night's writes
        finally: copy.close()
        for night in range(9):                                     # only the newest backup_keep (7) remain
            self.cycle.backup(first_agent,__import__('cto.config',fromlist=['Config']).Config(
                instance_config=self.root/(first_agent+'.json')),'2026-11-%02d' % (night+1))
        self.assertEqual(len(list(backup.parent.glob('*.sqlite'))),7)

    def test_the_gpu_gate_defers_for_every_kind_of_gpu_use_and_fails_closed(self):
        self.episodes('beta',2)
        cases=[('active',lambda p:setattr(p,'active',time.time()-60),'active'),
               ('lock',lambda p:setattr(p,'holder',{'role':'chat'}),'lock is held'),
               ('recent chat',lambda p:setattr(p,'activity',{'role':'chat','at':time.time()-30}),'served chat'),
               ('hold',lambda p:setattr(p,'busy',True),'hold file'),
               ('other model',lambda p:p.states.update(other='loading'),'another model'),
               ('busy slot',lambda p:setattr(p,'slot_list',[{'id':0,'is_processing':True}]),'serving a request'),
               ('unreachable',lambda p:setattr(p,'fail',OSError('refused')),'failed closed')]
        for label,arrange,reason in cases:
            with self.subTest(label):
                self.probe=FakeProbe(); arrange(self.probe); self.write()
                result=self.cycle.run(self.AT,available=self.cycle.models)
                self.assertIn(reason,result['errors']['beta'])
                self.assertEqual(self.statuses('2026-10-16','beta')['consolidation'],'deferred')
                self.assertEqual(self.calls,[])
        self.probe=FakeProbe(); self.probe.states['qwen']='unloaded'; self.write()   # may load: nothing else is
        result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(result['errors'],{}); self.assertNotIn('slots',self.probe.calls)   # never names an unloaded model

    def test_an_idle_runtime_and_a_coordinator_hold_block_no_one_else(self):
        self.probe.active=time.time()-7200
        Path(self.root/'memory'/'alpha').mkdir(parents=True); (self.root/'memory'/'alpha'/'maintenance.hold').touch()
        result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(result['errors'],{'alpha':'paused'})
        self.assertEqual(self.statuses('2026-10-16','beta')['sleeping'],'completed')
        self.assertFalse((self.root/'memory'/'alpha'/'memory.sqlite').exists())   # the held coordinator was never opened

    def test_night_only_without_a_window_never_plans_or_opens_the_coordinator(self):
        for key in ('night','backup_dir','gpu_gate'): self.policy.pop(key)
        self.policy['sleep_at']='22:00'; self.write()
        Path(self.root/'memory'/'alpha').mkdir(parents=True); (self.root/'memory'/'alpha'/'maintenance.hold').touch()
        result=self.cycle.run(datetime(2026,10,16,23,tzinfo=timezone.utc),available=self.cycle.models)
        self.assertEqual(result['errors'],{'alpha':'paused'})
        self.assertEqual(self.statuses('2026-10-16','beta')['sleeping'],'completed')
        self.assertFalse((self.root/'memory'/'alpha'/'memory.sqlite').exists())   # no capacity_signature write

    def test_a_held_maintenance_lock_defers_that_agent_without_a_phase_row(self):
        import fcntl
        (self.root/'memory'/'beta').mkdir(parents=True)
        with (self.root/'memory'/'beta'/'maintenance.lock').open('a') as held:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertIn('maintenance pass',result['errors']['beta'])
        self.assertEqual(self.statuses('2026-10-16','beta'),{})

    def test_consolidation_batches_fit_the_context_and_an_oversized_episode_cannot_block(self):
        self.episodes('beta',1,'x'*100000)                        # one huge episode first
        self.episodes('beta',60,'A reply of moderate length. '*30)
        result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(result['errors'],{})
        prompts=[c for c in self.calls if 'consolidating' in c['messages'][0]['content']]
        self.assertGreater(len(prompts),1)
        self.assertTrue(all(len(c['messages'][1]['content'].encode())<32768//2+4000 for c in prompts))
        with self.cycle.agent('beta') as (_,store,_):
            self.assertEqual(int(store.get_state('last_reflected_id')),max(m.id for m in store.all('episode')))

    def test_the_gate_is_checked_again_before_each_later_batch(self):
        self.episodes('beta',60,'A reply of moderate length. '*30)
        self.probe.sequence=[None,time.time()-10]              # idle at phase start, then the runtime wakes up
        result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(self.statuses('2026-10-16','beta')['consolidation'],'completed')
        with self.cycle.agent('beta') as (_,_,fleet):
            receipt=fleet.read('cycle:2026-10-16:consolidation')['body']
        self.assertEqual(receipt['batches'],1); self.assertGreater(receipt['pending'],0)
        self.assertEqual(len([c for c in self.calls if 'consolidating' in c['messages'][0]['content']]),1)

    def test_reflection_inserts_and_cursor_commit_together(self):
        self.episodes('beta',2)
        self.insights='[{"insight":"First durable insight here.","importance":6,"section":"shared","sources":[]},'\
                      '{"insight":"Second durable insight here.","importance":6,"section":"shared","sources":[]}]'
        real=MemoryStore.add_reflection; calls=[]
        def flaky(store,*args,**kwargs):
            calls.append(1)
            if len(calls)==2: raise sqlite3.OperationalError('disk I/O error')
            return real(store,*args,**kwargs)
        with patch.object(MemoryStore,'add_reflection',flaky):
            self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(self.statuses('2026-10-16','beta')['consolidation'],'needs_review')
        with self.cycle.agent('beta') as (_,store,_):
            self.assertEqual(store.count('reflection'),0)          # the first insight rolled back with the second
            self.assertIsNone(store.get_state('last_reflected_id'))

    def test_outputs_that_echo_a_secret_are_not_stored(self):
        self.episodes('beta',2)
        self.insights='[{"insight":"The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB","importance":6,"section":"shared","sources":[]},'\
                      '{"insight":"A colleague checks small examples first.","importance":6,"section":"shared","sources":[]}]'
        self.dream_reply=json.dumps({'dream':'A key glows: sk-ant-api03-abcdefghijklmnopqrstuv in a drifting lattice of light.',
                                     'recall':'I dreamed of a glowing key.','tone':'strange','ideas':[]})
        self.assertEqual(self.cycle.run(self.AT,available=self.cycle.models)['errors'],{})
        with self.cycle.agent('beta') as (_,store,_):
            self.assertEqual([m.text for m in store.all('reflection')],['A colleague checks small examples first.'])
            self.assertIsNone(store.latest_dream())

    def test_wrapped_window_dst_and_per_agent_start(self):
        self.policy.update(timezone='America/New_York',night={'start':'23:00','end':'05:00'})
        self.policy['agents']['beta']['night_start']='02:30'; self.write()
        from zoneinfo import ZoneInfo
        zone=ZoneInfo('America/New_York')
        early=datetime(2026,10,16,2,0,tzinfo=zone)
        self.assertEqual(self.cycle.night_day(early),'2026-10-15')   # after midnight: the previous date's night
        self.cycle.run(early,available=self.cycle.models)
        self.assertEqual(self.statuses('2026-10-15','beta'),{})       # its own start has not come yet
        self.cycle.run(datetime(2026,10,16,3,0,tzinfo=zone),available=self.cycle.models)
        self.assertEqual(self.statuses('2026-10-15','beta')['sleeping'],'completed')
        # Fall back: 01:30 happens twice; the second pass is the same night and repeats nothing.
        first=datetime(2026,11,1,1,30,tzinfo=zone,fold=0); second=datetime(2026,11,1,1,30,tzinfo=zone,fold=1)
        self.assertEqual(self.cycle.night_day(first),self.cycle.night_day(second))
        self.cycle.run(first,available=self.cycle.models); count=len(self.calls)
        self.cycle.run(second,available=self.cycle.models); self.assertEqual(len(self.calls),count)
        # Spring forward: 02:00-03:00 does not exist; 03:30 still belongs to the night.
        self.assertEqual(self.cycle.night_day(datetime(2026,3,8,3,30,tzinfo=zone)),'2026-03-07')
        with self.assertRaises(ValueError):
            self.policy['agents']['beta']['night_start']='12:00'; self.write()

    def test_morning_check_and_clear_phase(self):
        from cto.cycle import night_report, clear_phase
        self.cycle.ledger.claim_phase('2026-10-16','beta','consolidation')
        self.cycle.ledger.finish_phase('2026-10-16','beta','consolidation','needs_review','phase failed')
        report=night_report(self.cycle,datetime(2026,10,16,9,tzinfo=timezone.utc))
        self.assertFalse(report['healthy']); self.assertEqual(report['night'],'2026-10-16')
        with self.assertRaises(ValueError): clear_phase(self.cycle,'beta','consolidation','2026-10-16',' ')
        self.assertEqual(clear_phase(self.cycle,'beta','consolidation','2026-10-16','inspected: model timeout')['cleared']['was'],
                         'needs_review')
        self.assertTrue(night_report(self.cycle,datetime(2026,10,16,9,tzinfo=timezone.utc))['healthy'])
        self.assertIn('model timeout',(self.cycle.state/'clear-phase.log').read_text())

    def test_a_pause_between_batches_ends_the_phase_with_the_rest_pending(self):
        self.episodes('beta',60,'A reply of moderate length. '*30)
        real=self.cycle.paused; checks=[]
        def paused(agent=None):
            if agent=='beta': checks.append(1)
            return real(agent) or (agent=='beta' and len(checks)>2)   # paused once the first batch is done
        self.cycle.paused=paused
        self.cycle.run(self.AT,available=self.cycle.models)
        with self.cycle.agent('beta') as (_,_,fleet):
            receipt=fleet.read('cycle:2026-10-16:consolidation')['body']
        self.assertEqual(receipt['batches'],1); self.assertGreater(receipt['pending'],0)

    def test_a_failed_inference_in_a_later_batch_needs_review(self):
        self.episodes('beta',60,'A reply of moderate length. '*30)
        real=self.transport; count=[]
        def flaky(url,body,timeout):
            if 'consolidating' in json.loads(body)['messages'][0]['content']:
                count.append(1)
                if len(count)==2: raise OSError('model server went away')
            return real(url,body,timeout)
        self.cycle.transport=flaky
        self.cycle.run(self.AT,available=self.cycle.models)
        self.assertEqual(self.statuses('2026-10-16','beta')['consolidation'],'needs_review')

    def test_a_backup_that_fails_its_check_publishes_nothing_and_defers(self):
        self.episodes('beta',2)
        (self.root/'memory'/'beta'/'profile.md').write_text('profile')
        with patch.object(Cycle,'integrity_ok',staticmethod(lambda connection: False)):
            result=self.cycle.run(self.AT,available=self.cycle.models)
        self.assertIn('integrity check',result['errors']['beta'])
        self.assertEqual(list((self.root/'backups'/'beta').iterdir()),[])            # no profile, no temporaries
        self.assertEqual(self.statuses('2026-10-16','beta'),{})

    def test_retention_removes_old_nights_orphaned_profiles_and_stale_temporaries(self):
        from cto.config import Config
        self.episodes('beta',1)
        folder=self.root/'backups'/'beta'; folder.mkdir(parents=True)
        (folder/'2026-01-01.profile.md').write_text('orphan'); (folder/'2026-01-02.sqlite.tmp').write_text('stale')
        cfg=Config(instance_config=self.root/'beta.json')
        cfg.profile_path.write_text('a profile')
        for night in range(1,10): self.cycle.backup('beta',cfg,'2026-11-%02d' % night)
        self.assertEqual(sorted(p.name for p in folder.iterdir()),
                         sorted(['2026-11-%02d.%s' % (n,kind) for n in range(3,10) for kind in ('sqlite','profile.md')]))
        self.assertEqual((folder/'2026-11-09.profile.md').read_text(),'a profile')

    def test_the_morning_check_flags_a_phase_stuck_running(self):
        from cto.cycle import night_report
        self.cycle.ledger.claim_phase('2026-10-16','beta','dreaming')
        with self.cycle.ledger.db:
            self.cycle.ledger.db.execute("UPDATE phases SET started=? WHERE phase='dreaming'",(time.time()-7200,))
        self.assertFalse(night_report(self.cycle,datetime(2026,10,16,9,tzinfo=timezone.utc))['healthy'])
        with self.cycle.ledger.db:
            self.cycle.ledger.db.execute("UPDATE phases SET started=? WHERE phase='dreaming'",(time.time(),))
        self.assertTrue(night_report(self.cycle,datetime(2026,10,16,9,tzinfo=timezone.utc))['healthy'])

    def test_policy_requires_backups_and_a_gate_for_a_night_window(self):
        for key in ('backup_dir','gpu_gate','timezone'):
            with self.subTest(key):
                saved=self.policy.pop(key)
                with self.assertRaises(ValueError): self.write()
                self.policy[key]=saved


class GpuProbeTests(unittest.TestCase):
    def test_router_states_and_slots_are_read_without_naming_other_models(self):
        from cto.cycle import GpuProbe
        import io, urllib.error
        seen=[]
        def opener(request, timeout):
            seen.append(request.full_url)
            if request.full_url.endswith('/models'):
                body={'data':[{'id':'qwen','status':{'value':'loaded'}},{'id':'other','status':{'value':'unloaded'}},
                              {'id':'plain'}]}
            elif 'missing' in request.full_url: raise urllib.error.HTTPError(request.full_url,400,'model name is missing',{},None)
            else: body=[{'id':0,'is_processing':True}]
            return io.BytesIO(json.dumps(body).encode())
        model={'api_base':'http://router:8080/v1','model':'qwen'}
        with patch('cto.cycle.urllib.request.urlopen',opener):
            probe=GpuProbe()
            self.assertEqual(probe.router_models(model),{'qwen':'loaded','other':'unloaded','plain':'loaded'})
            self.assertEqual(probe.slots(model),[{'id':0,'is_processing':True}])
            self.assertIsNone(probe.slots({**model,'model':'missing'}))     # 400: no per-model slots, skipped
        self.assertEqual(seen[:2],['http://router:8080/models','http://router:8080/slots?model=qwen'])

    def test_a_string_status_is_read_as_is(self):
        from cto.cycle import GpuProbe
        import io
        body={'data':[{'id':'qwen','status':'unloaded'},{'id':'other','status':'loading'}]}
        with patch('cto.cycle.urllib.request.urlopen',lambda request,timeout: io.BytesIO(json.dumps(body).encode())):
            self.assertEqual(GpuProbe().router_models({'api_base':'http://r/v1','model':'qwen'}),
                             {'qwen':'unloaded','other':'loading'})

    def test_the_lock_probe_is_passive_and_sees_any_holder(self):
        from cto.cycle import GpuProbe
        import fcntl, tempfile
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'gpu.lock'
            self.assertEqual(GpuProbe().gpu_holder(path),{}); self.assertFalse(path.exists())   # never created
            with path.open('w') as held:
                held.write(json.dumps({'role':'chat','pid':1})); held.flush()
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(GpuProbe().gpu_holder(path)['role'],'chat')
            self.assertEqual(GpuProbe().gpu_holder(path),{})
            (Path(folder)/'plain').write_text('')
            with self.assertRaises(OSError): GpuProbe().gpu_holder(Path(folder)/'plain'/'gpu.lock')   # an error, not "free"
