"""Bounded OpenCode jobs. Keep harness transcripts in owned disposable scratch."""
from __future__ import annotations
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time
from .cycle_budget import BudgetExhausted
from .opencode import install
from cto import env_names


def stop(process, force_group=False):
    if process.poll() is None or force_group:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: return
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL); process.wait(timeout=3)


def run_process(argv, cwd, timeout, env=None, token_limit=None, cancel=lambda:False):
    """Retain bounded final text/usage, not raw tool or reasoning transcripts."""
    started=time.monotonic(); reported=0; seen=False; final=[]; reason=None
    process=subprocess.Popen(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL,start_new_session=True)
    selector=selectors.DefaultSelector(); selector.register(process.stdout,selectors.EVENT_READ)
    buffer=b""
    try:
        while selector.get_map():
            if cancel(): reason="owner_paused"; break
            if time.monotonic()-started >= timeout: reason="time_limit"; break
            for key,_ in selector.select(timeout=min(.2,max(.01,timeout-(time.monotonic()-started)))):
                data=os.read(key.fileobj.fileno(),65536)
                if not data: selector.unregister(key.fileobj); continue
                buffer+=data
                if len(buffer)>2*1024*1024: reason="event_size_limit"; break
                while b"\n" in buffer:
                    line,buffer=buffer.split(b"\n",1)
                    try: event=json.loads(line)
                    except (ValueError,UnicodeError): continue
                    if not isinstance(event,dict): continue
                    part=event.get("part",{})
                    if event.get("type")=="step_finish" and isinstance(part.get("tokens"),dict):
                        tokens=part["tokens"]; cache=tokens.get("cache",{})
                        values=[tokens.get("input",0),tokens.get("output",0),
                                cache.get("read",0),cache.get("write",0)]
                        if all(isinstance(v,int) and not isinstance(v,bool) and v>=0 for v in values):
                            reported+=sum(values); seen=True
                        if token_limit is not None and reported>=token_limit and part.get('reason')!='stop':
                            reason="token_limit"; break
                    if event.get("type")=="error": reason="provider_error"; break
                    if event.get("type")=="text" and isinstance(part.get("text"),str):
                        final.append(part["text"][:4000]); final=final[-2:]
                if reason: break
            if reason: break
        if reason: stop(process,force_group=True)
        else:
            try: process.wait(timeout=max(.01,timeout-(time.monotonic()-started)))
            except subprocess.TimeoutExpired: reason="time_limit"; stop(process)
        return {"exit_code":process.returncode,"stop_reason":reason,
                "tokens":reported if seen else None,"seconds":time.monotonic()-started,
                "summary":"\n".join(final)[-6000:]}
    finally:
        stop(process); selector.close(); process.stdout.close()


class OpenCodeRunner:
    def __init__(self, scratch):
        self.scratch=Path(scratch); self.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)

    def run(self, *, instance, model, task, cap, cancel=lambda:False):
        if not Path('/run/.containerenv').exists() and not Path('/.dockerenv').exists():
            raise ValueError("scheduled tool jobs require the fleet container")
        with tempfile.TemporaryDirectory(prefix="cycle-job-",dir=self.scratch) as directory:
            root=Path(directory); runtime=root/'runtime'
            install(runtime,model['provider']+'/'+model['model'],instance,
                    model['api_base'],model['context_window'],model['output_tokens'],model.get('api_key_env'))
            settings=json.loads((runtime/'opencode.json').read_text())
            permission=settings['permission']
            # All child jobs are brokered by the CTO schedule; no hidden harness task tree.
            permission['task']='deny'
            permission['cto_room']='deny'
            permission['cto_fleet']='deny'
            if task.get('kind')=='research':
                permission={'*':'deny','read':'allow','glob':'allow','grep':'allow',
                            'webfetch':'allow','websearch':'allow','skill':'allow','task':'deny'}
            settings['permission']=permission; settings['agent']['cto']['permission']=permission
            settings['share']='disabled'
            (runtime/'opencode.json').write_text(json.dumps(settings))
            prompt=root/'assignment.txt'
            prompt.write_text(task['brief']+'\n\nAuthorized project workspace: '+str(task['workdir'])+
                '\nReport evidence, source locations, tests, uncertainty and next action. '
                'Do not spawn other agents or use room tools. Return your report as the final response; the controller delivers it to the lead. Keep private context out of reports.\n')
            env={**os.environ,**env_names.both('CYCLE_MANAGED', '1'),**env_names.both('CYCLE_CHANNEL', 'work'),**env_names.both('INSTANCE_CONFIG', str(instance)),
                 **env_names.both('MODEL', model['model']),**env_names.both('API_BASE', model['api_base']),
                 'XDG_DATA_HOME':str(root/'data'),'XDG_CACHE_HOME':str(root/'cache'),
                 'XDG_STATE_HOME':str(root/'state'),'TMPDIR':str(root/'tmp')}
            (root/'tmp').mkdir()
            result=run_process(['opencode','run','Carry out the attached authorized assignment.','--format','json',
                                '--model',model['provider']+'/'+model['model'],'--agent','cto','--file',str(prompt)],
                               runtime,cap['max_seconds'],env,cap['max_tokens'],cancel)
            result['verification']=[]
            if result['exit_code']==0 and not result['stop_reason']:
                deadline=time.monotonic()+max(0,cap['max_seconds']-result['seconds'])
                for command in task.get('verification',[]):
                    remaining=deadline-time.monotonic()
                    if remaining<1 or cancel():
                        result['stop_reason']='verification_deferred'; break
                    checked=run_process(command,task['workdir'],remaining,cancel=cancel)
                    result['seconds']+=checked['seconds']
                    result['verification'].append({'command':command,'exit_code':checked['exit_code'],
                                                    'stop_reason':checked['stop_reason']})
            return result
