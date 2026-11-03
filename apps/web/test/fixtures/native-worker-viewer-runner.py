"""Isolated tmux acceptance orchestration; no engine, instance or credentials."""
import hashlib,json,os,shutil,signal,subprocess,sys,time,uuid
from pathlib import Path
source=Path(sys.argv[1]).resolve();evidence=Path(sys.argv[3]).resolve()
web_source=source/'apps/web' if (source/'apps/web/src').is_dir() else source
python_source=source/'python' if (source/'python/reverie/worker.py').is_file() else web_source/'test/fixtures/goal-source/python'
if not (python_source/'reverie/worker.py').is_file():raise RuntimeError('Native fixture requires repository Python sources or packaged goal-source fixture')
if sys.argv[2]=='@leased':
 sys.path.insert(0,str(python_source))
 os.environ.setdefault('REVERIE_LEASE_DIR',str(evidence.parent/'lease-registry'))
 os.environ['REVERIE_LEASE_LIB']=str(python_source/'reverie/cleanup/lease.py')
 from reverie.workspaces import Workspaces
 manager=Workspaces();name='v229-'+uuid.uuid4().hex[:12];task=manager.create(name)
 # Short normal task names keep Unix socket paths below the kernel bound even
 # when Vitest's temporary evidence directory is deeply nested in a build shell.
 result=manager.run(name,[sys.executable,'-I','-B',__file__,str(source),str(task),str(evidence)])
 settlement=evidence/'native-settlement.json'
 if settlement.exists() and json.loads(settlement.read_text())['provider_and_inner_server_settled']:
  manager.finish(name,'Synthetic results captured in '+str(evidence));manager.clean(name,apply=True)
  (evidence/'workspace-cleanup.json').write_text(json.dumps({'workspace':str(task),'absent':not task.exists(),'leased_cleanup':True})+'\n')
 else:print('Retained uncertain leased native fixture: '+str(task),file=sys.stderr)
 raise SystemExit(result)
workspace=Path(sys.argv[2]).resolve();variant='r';dest=evidence;dest.mkdir(mode=0o700)
fixtures=Path(__file__).parent
root=workspace/variant;root.mkdir(mode=0o700);web=root/'web';web.mkdir();shutil.copytree(web_source/'src',web/'src');shutil.copy2(web_source/'package.json',web/'package.json');shutil.copy2(fixtures/'native-worker-viewer-program.ts',web/'acceptance.ts');dependencies=Path(os.environ.get('FIXTURE_NODE_MODULES',str(web_source/'node_modules'))).resolve();(web/'node_modules').symlink_to(dependencies)
files={}
for p in(web/'src').rglob('*'):
 if p.is_file():files[str(p.relative_to(web))]=hashlib.sha256(p.read_bytes()).hexdigest()
(dest/'source-manifest.json').write_text(json.dumps({'source':str(source),'files':files,'git_revision':subprocess.run(['git','-C',str(source),'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip() or 'packaged offline fixture'},indent=2)+'\n')
for p in [root/'home',root/'data',root/'runtime',root/'bin']:p.mkdir(mode=0o700)
python=sys.executable;tmux=shutil.which('tmux');node=shutil.which('node');sid=str(uuid.uuid4());outer='v'+str(os.getpid());rootpython=str(python_source)
wrapper=root/'bin/reverie-worker-exec';wrapper.write_text('#!'+python+'\nimport json,os,sys\nassert "--attach-only" in sys.argv, "Fixture forbids provider launch"\nwith open(os.path.join(os.environ["FIXTURE_ROOT"],"worker-client-calls.jsonl"),"a")as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nfrom reverie.worker import main\nsys.argv=[sys.argv[0],"client",*sys.argv[1:]]\nraise SystemExit(main())\n');wrapper.chmod(0o700)
env={k:v for k,v in os.environ.items() if k in ['PATH','LANG','LC_ALL','LD_LIBRARY_PATH','NIX_LD_LIBRARY_PATH','NIX_LD']};env.update(HOME=str(root/'home'),TMPDIR=str(root),TMUX_TMPDIR=str(root/'runtime'),TERM='xterm-256color',PYTHONDONTWRITEBYTECODE='1',PYTHONPATH=rootpython,REVERIE_DATA_DIR=str(root/'data'),REVERIE_INSTANCE='issue229-'+variant,REVERIE_TMUX_SOCKET=outer,REVERIE_WORKER_SOCKET=str(root/'control/broker.sock'),FIXTURE_SOURCE_ROOT=str(python_source.parent),FIXTURE_ROOT=str(root),FIXTURE_SID=sid,FIXTURE_TMUX=tmux,FIXTURE_PYTHON=python,FIXTURE_VARIANT=variant,FIXTURE_RESULT=str(dest/'result.json'));env['PATH']=str(root/'bin')+':'+env['PATH']
helperlog=(dest/'helper.log').open('wb');helper=subprocess.Popen([python,'-I','-B',str(fixtures/'native-worker-viewer-helper.py')],env=env,stdout=helperlog,stderr=subprocess.STDOUT)
# -I intentionally ignores PYTHONPATH; use the verified source path in isolated launcher.
try:
 end=time.monotonic()+10
 while not(root/'helper-ready.json').exists():
  if helper.poll()is not None:raise RuntimeError('helper exited '+str(helper.returncode))
  if time.monotonic()>end:raise RuntimeError('helper readiness timeout')
  time.sleep(.05)
 with(dest/'node.log').open('wb')as log:
  child=subprocess.run([node,str(dependencies/'tsx/dist/cli.mjs'),str(web/'acceptance.ts')],env=env,cwd=web,stdout=log,stderr=subprocess.STDOUT,timeout=85)
 print(json.dumps({'variant':variant,'exit_code':child.returncode,'result':str(dest/'result.json')}))
 sys.exit(child.returncode)
finally:
 if helper.poll()is None:helper.terminate()
 try:helper.wait(timeout=8)
 except subprocess.TimeoutExpired:helper.kill();helper.wait(timeout=3)
 helperlog.close()
 subprocess.run([tmux,'-L',outer,'kill-server'],env=env,capture_output=True)
 subprocess.run([tmux,'-S',str(root/'inner.sock'),'kill-server'],env=env,capture_output=True)
 for name in ['provider-input.jsonl','adapter-calls.jsonl','worker-client-calls.jsonl','helper-ready.json','helper-settled.json','provider.py']:
  p=root/name
  if p.is_file():shutil.copy2(p,dest/name)
 ready_path=root/'helper-ready.json';ready=json.loads(ready_path.read_text()) if ready_path.exists() else {}
 def live(pid):
  try:return Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[0] not in ['Z','X']
  except FileNotFoundError:return False
 deadline=time.monotonic()+3
 while any(live(ready.get(k,0)) for k in ['provider_pid','inner_server_pid']) and time.monotonic()<deadline:time.sleep(.03)
 settled=not any(live(ready.get(k,0)) for k in ['provider_pid','inner_server_pid'])
 (dest/'native-settlement.json').write_text(json.dumps({'provider_and_inner_server_settled':settled,'helper_exit':helper.returncode})+'\n')
 assert settled,'Owned native fixture process did not settle'
 print(json.dumps({'helper_exit':helper.returncode,'evidence':str(dest)}))
