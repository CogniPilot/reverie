"""Create an isolated, synthetic daily-cycle trial without touching personal instances."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from .cycle import PHASES
from .runtime import atomic_write


def create(directory, api_base, model):
    root=Path(directory).expanduser().resolve()
    if root.exists() and any(root.iterdir()): raise ValueError('choose an empty owned trial directory')
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    work=root/'project'; work.mkdir()
    (work/'README.txt').write_text('Synthetic trial project. Create answer.py with a function answer() returning 42.\n')
    phases={p:{'max_tokens':48000,'max_seconds':180} for p in PHASES}
    for p in ('waking','sleeping'): phases[p]={'max_tokens':0,'max_seconds':5}
    phases['implementation']={'max_tokens':64000,'max_seconds':300}
    agents={}
    for name,kind,role in [('cto','agent','CTO'),('math','agent','Mathematics specialist lead')]:
        instance=root/'instances'/(name+'.json')
        atomic_write(instance,{'id':name,'agent_name':role,'owner_name':'Trial operator',
            'role':role,'kind':kind,'data_dir':'../memory/'+name,
            'persona':'Be inquisitive, candid, precise and professional. Keep personal and project memory separate.',
            'initial_self':{'consciousness':'The nature of AI consciousness is an open question.',
                            'directives':['Seek evidence.','Be curious and test ideas.']}})
        agents[name]={'instance':str(instance),'kind':kind,'role':role,'model':'local',
            'allowed_models':['local'],'projects':['demo'],'interests':['mathematics','small counterexamples'],
            'memory_queries':['prior test results','open questions'],'phases':phases,
            'allow_subagents':True,'max_children':1,'child_models':['local'],'child_roles':['implementer'],
            'attributes':{'tags':{'value':['curious','evidence-focused'],'editable':'agent'},
                          'stats.curiosity':{'value':.8,'editable':'agent'},
                          'stats.creativity':{'value':.7,'editable':'weekly'},
                          'stats.focus':{'value':.8,'editable':'frozen'}}}
    policy={'coordinator':'cto','timezone':'UTC','wake_at':'08:00','sleep_at':'22:00',
        'planning_horizon_days':14,'poll_seconds':30,'max_parallel_leads':1,
        'state_dir':str(root/'controller'),'scratch_dir':str(root/'scratch'),
        'project_memory_dir':str(root/'project-memory'),'agents':agents,
        'models':{'local':{'api_base':api_base,'model':model,'provider':'local_agent',
                          'context_window':32768,'output_tokens':4096,'resource':'local-gpu',
                          'local':True,'enabled':True}},
        'resources':{'local-gpu':{'max_tokens':300000,'max_seconds':3600,
                                'reserved_tokens':8192,'reserved_seconds':120}},
        'tasks':[{'id':'answer-demo','project':'demo','kind':'implementation','approved':True,
                  'workdir':str(work),'brief':'In the authorized workspace create answer.py containing a function answer() that returns integer 42. Do not commit. Run the verification and report the result.',
                  'verification':[['python3','-c','from answer import answer; assert answer() == 42']]}]}
    atomic_write(root/'daily-cycle.json',policy)
    return root/'daily-cycle.json'


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--api-base',required=True)
    parser.add_argument('--model',required=True)
    args=parser.parse_args(argv)
    print(json.dumps({'policy':str(create(args.directory,args.api_base,args.model)),
                      'next':'reverie-cycle --policy POLICY once'}))
    return 0

if __name__=='__main__': raise SystemExit(main())
