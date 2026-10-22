from __future__ import annotations
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from reverie.config import Config
from reverie.cycle import Cycle
from reverie.cycle_budget import Ledger, BudgetExhausted, MeteredClient
from reverie.cycle_runner import run_process
from reverie.memory import MemoryStore
from reverie.plan_usage import capacity


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
            instance.write_text(json.dumps({'id':name,'agent_name':name,'owner_name':'Owner',
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
        if 'allocating a reverie schedule' in system:
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
        with patch('reverie.cycle.Config',side_effect=lambda **kw:Config(dreams_per_sleep=1,**kw)):
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

    def test_night_default_disables_dreams_without_model_calls(self):
        for index, flag in enumerate((None, True)):
            with self.subTest(dreaming=flag):
                day=f'2026-01-{index+1:02d}'
                if flag is not None: self.cycle.agents['math']['dreaming']=flag
                with patch('reverie.cycle.Dreamer') as dreamer:
                    self.cycle.night('math','local',day)
                dreamer.assert_not_called()
                self.assertEqual(self.calls,[])
                phase=next(p for p in self.cycle.ledger.phases(day,'math') if p['phase']=='dreaming')
                self.assertEqual((phase['status'],phase['detail']),('skipped','dreams disabled'))
                self.assertEqual(self.cycle.ledger.usage(day,'math','dreaming'),{'tokens':0,'seconds':0})

    def test_night_opt_in_makes_one_dream_call(self):
        self.cycle.agents['math']['dreaming']=True
        with patch('reverie.cycle.Config',side_effect=lambda **kw:Config(dreams_per_sleep=1,**kw)):
            self.cycle.night('math','local','2026-01-01')
            self.cycle.night('math','local','2026-01-01')  # the recorded phase is idempotent
        self.assertEqual(len(self.calls),1)
        self.assertIn('asleep and dreaming freely',self.calls[0]['messages'][0]['content'])
        with self.cycle.agent('math') as (_,store,_): self.assertEqual(store.count('dream'),1)

    def test_night_profile_false_vetoes_global_opt_in(self):
        self.cycle.agents['math']['dreaming']=False
        with patch('reverie.cycle.Config',side_effect=lambda **kw:Config(dreams_per_sleep=1,**kw)):
            self.cycle.night('math','local','2026-01-01')
        self.assertEqual(self.calls,[])
        phase=next(p for p in self.cycle.ledger.phases('2026-01-01','math') if p['phase']=='dreaming')
        self.assertEqual((phase['status'],phase['detail']),('skipped','dreams disabled'))

    def test_pause_and_unauthorized_wakes_children_and_models(self):
        (self.cycle.state/'owner-paused').touch()
        self.assertTrue(self.cycle.run(force=True,available=self.cycle.models)['paused'])
        self.assertEqual(self.calls,[])
        assignment={'agent':'math','model':'local','task_ids':['answer'],'allow_subagents':False,
                    'children':[{'task_id':'answer','model':'local','role':'implementer'}]}
        with self.assertRaises(ValueError): self.cycle.validate_schedule({'assignments':[assignment]},self.cycle.models)
        assignment['allow_subagents']=True; assignment['children'][0]['model']='unavailable'
        with self.assertRaises(ValueError): self.cycle.validate_schedule({'assignments':[assignment]},self.cycle.models)

    def test_implementation_permission_does_not_come_from_kind_or_title(self):
        for name in ("cto", "math"):
            assignment = {"agent": name, "model": "local", "task_ids": ["answer"], "children": []}
            with self.assertRaises(ValueError):
                self.cycle.validate_schedule({"assignments": [assignment]}, self.cycle.models)
            self.cycle.agents[name]["allow_implementation"] = True
            self.assertEqual(self.cycle.validate_schedule({"assignments": [assignment]}, self.cycle.models), [assignment])

    def test_attribute_governance_and_weekly_votes(self):
        self.cycle.set_attribute('math','tags',['symmetry'],'A new interest')
        self.assertEqual(self.cycle.attributes('math')['tags']['value'],['symmetry'])
        with self.assertRaises(ValueError): self.cycle.set_attribute('math','stats.focus',.5,'Change a frozen trait')
        for week in range(3):
            with patch('reverie.reverie.time.time',return_value=345600+(2500+week)*604800+10):
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
