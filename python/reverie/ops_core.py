"""Durable OPS core. Authenticated identity and signed AUTH decisions enter through host ports."""
import contextlib,fcntl,json,os,sqlite3,threading,time,uuid
from pathlib import Path
from .ops_common import *
from .worker_storage import read_metadata

def current_actor(company_file,company_id,session,uid):
 require(isinstance(session,str) and UUID.fullmatch(session),'stable-identity-unavailable')
 state=read_metadata(company_file,uid)
 rows=state.get('employees');retired=state.get('retired',[]);require(isinstance(rows,list) and isinstance(retired,list) and len(rows)+len(retired)<=10000 and all(isinstance(r,dict) for r in [*rows,*retired]),'stable-identity-unavailable');require(not any(r.get('sessionId')==session for r in retired),'stable-identity-unavailable')
 ids=[x.get('id') for x in rows];sids=[x.get('sessionId') for x in rows if x.get('sessionId') is not None]
 require(len(ids)==len(set(ids)) and len(sids)==len(set(sids)),'stable-identity-unavailable')
 selected=[r for r in rows if r.get('sessionId')==session]
 require(len(selected)==1 and UUID.fullmatch(selected[0].get('id','')),'stable-identity-unavailable')
 r=selected[0];require(r.get('desiredRunning') is not False and not r.get('onVacation'),'stable-identity-unavailable')
 return {'employeeId':r['id'],'companyId':identifier(company_id),'bindingDigest':digest({'employeeId':r['id'],'companyId':company_id,'sessionId':session,'owner':r.get('owner'),'generation':r.get('sessionGeneration')})}

def evidence(check,result,observation):
 d=digest(observation);return {'check':check,'result':result,'observationDigest':d,'evidenceId':digest([check,result,d])}

class Ledger:
 def __init__(self,directory,max_operations=100000):
  self.directory=private_directory(directory,create=True);self.path=self.directory/'ops.sqlite';self.max=max_operations
  if self.path.exists():
   info=self.path.lstat();require(__import__('stat').S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode&0o077,'custody-invalid')
  else:
   fd=os.open(self.path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600);os.fsync(fd);os.close(fd)
   parent=os.open(self.directory,os.O_RDONLY|os.O_DIRECTORY);os.fsync(parent);os.close(parent)
  with self.db() as db:
   db.executescript('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,command TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(scope,key));CREATE TABLE IF NOT EXISTS receipts(operation TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(operation,sequence));CREATE TABLE IF NOT EXISTS fences(resource TEXT PRIMARY KEY,operation TEXT NOT NULL);CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY,expiry REAL NOT NULL);CREATE TABLE IF NOT EXISTS reconciliations(operation TEXT PRIMARY KEY,generation TEXT NOT NULL,evidence TEXT NOT NULL);')
 @contextlib.contextmanager
 def db(self):
  db=sqlite3.connect(self.path,timeout=5,isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA busy_timeout=5000');db.execute('PRAGMA synchronous=FULL');db.execute('PRAGMA journal_mode=DELETE')
  try:yield db
  finally:db.close()
 def latest(self,db,op):
  r=db.execute('SELECT body FROM receipts WHERE operation=? ORDER BY sequence DESC LIMIT 1',(op,)).fetchone();require(r is not None,'invalid-request');return strict_json(r[0])
 def append(self,db,receipt):
  receipt=dict(receipt);seq=db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM receipts WHERE operation=?',(receipt['operationId'],)).fetchone()[0];receipt.update(sequence=seq,at=now())
  db.execute('INSERT INTO receipts VALUES(?,?,?)',(receipt['operationId'],seq,canonical(receipt).decode()));db.execute('UPDATE operations SET state=? WHERE id=?',(receipt['state'],receipt['operationId']));return receipt
 def nonce(self,nonce,expiry,clock=time.time):
  with self.db() as db:
   db.execute('BEGIN IMMEDIATE');db.execute('DELETE FROM nonces WHERE expiry<?',(clock()-60,))
   try:db.execute('INSERT INTO nonces VALUES(?,?)',(nonce,expiry))
   except sqlite3.IntegrityError:raise Refusal('invalid-request')
   db.commit()

class Core:
 def __init__(self,ledger,company_file,company_id,resources,authorizer,*,uid=None,clock=time.time):
  self.ledger=ledger;self.company_file=company_file;self.company_id=company_id;self.resources=resources;self.auth=authorizer;self.uid=os.getuid() if uid is None else uid;self.clock=clock;self.threads={};self.guard=threading.Lock()
 def actor(self,session):return current_actor(self.company_file,self.company_id,session,self.uid)
 def resource(self,name):
  require(name in self.resources,'adapter-unavailable');return self.resources[name]
 def authorize(self,actor,action,rid,grant=None,artifact=None):
  decision=self.auth.check(actor,action,rid,grant,artifact)
  require(decision.get('availability')=='allowed',decision.get('reason','unauthorized'))
  return decision
 def view(self,actor,rid):
  adapter=self.resource(rid)
  try:snapshot=adapter.snapshot();healthy=True
  except Exception:snapshot=None;healthy=False
  decisions={}
  for action in ACTIONS:
   try:
    decision=self.auth.check(actor,action,rid,None,None)
    if not healthy or not adapter.supports(action):decision={'availability':'unavailable','reason':'adapter-unhealthy' if not healthy else 'adapter-unavailable','policyGeneration':decision.get('policyGeneration',ZERO)}
   except Exception:decision={'availability':'unavailable','reason':'adapter-unavailable','policyGeneration':ZERO}
   decisions[action]=decision
  policy=decisions[ACTIONS[0]].get('policyGeneration',ZERO)
  binding=adapter.binding_digest();generation=adapter.generation(snapshot) if healthy else ZERO
  cap=digest({'binding':binding,'resource':generation,'policy':policy,'support':{a:{k:v for k,v in d.items() if k in ('availability','reason','policyGeneration')} for a,d in decisions.items()}})
  return snapshot,{'kind':'reverie.ops.capabilities','version':1,'actor':actor,'resourceId':rid,'observedAt':now(),'installedExecutor':{'serviceBindingDigest':binding,'adapterId':adapter.adapter_id,'adapterVersion':adapter.version} if adapter.installed else None,'policyGeneration':policy,'capabilityGeneration':cap,'resourceGeneration':generation,'capabilities':[{'action':a,'availability':d['availability'],'reason':d['reason']} for a,d in decisions.items()],'acceptanceStage':'unverified','acceptanceEvidence':[],'learningTelemetry':'disabled'}
 def inspect(self,actor,rid,op=None,key=None):
  self.authorize(actor,ACTIONS[1],rid)
  with self.ledger.db() as db:
   if key is not None:
    match=db.execute('SELECT id FROM operations WHERE scope=? AND key=?',(digest([actor['companyId'],actor['employeeId'],rid]),key)).fetchone();require(match is not None,'not-found');op=match['id']
   row=db.execute('SELECT actor FROM operations WHERE id=?',(op,)).fetchone();require(row is not None,'unauthorized');prior=strict_json(row['actor']);require((prior['employeeId'],prior['companyId'])==(actor['employeeId'],actor['companyId']),'unauthorized');r=self.ledger.latest(db,op);require(r['resourceId']==rid,'unauthorized')
  if r['state']=='unconfirmed':self.reconcile_readonly(op,rid)
  with self.ledger.db() as db:return self.ledger.latest(db,op)
 def reconcile_readonly(self,op,rid):
  adapter=self.resource(rid)
  if not hasattr(adapter,'reconcile'):return
  try:
   with self.ledger.db() as db:stored=strict_json(db.execute('SELECT snapshot FROM operations WHERE id=?',(op,)).fetchone()[0])['resource']
   snapshot=adapter.snapshot();generation=adapter.generation(snapshot);ev=adapter.reconcile(stored,snapshot)
   require(ev and all(e['result']=='pass' for e in ev),'reconciliation-required')
   with self.ledger.db() as db:
    db.execute('BEGIN IMMEDIATE');r=self.ledger.latest(db,op);fence=db.execute('SELECT operation FROM fences WHERE resource=?',(rid,)).fetchone()
    if r['state']!='unconfirmed' or fence is None or fence[0]!=op:db.rollback();return
    existing=db.execute('SELECT generation FROM reconciliations WHERE operation=?',(op,)).fetchone()
    if existing is not None and existing[0]==generation:db.rollback();return
    # Append a correction, preserving every old immutable receipt. This does NOT release the fence.
    r.update(reason='reconciliation-required',evidence=ev);self.ledger.append(db,r);db.execute('INSERT OR REPLACE INTO reconciliations VALUES(?,?,?)',(op,generation,canonical(ev).decode()));db.commit()
  except Exception:return
 def dispatch(self,session,value,start=True):
  cmd=command(value);actor=self.actor(session);rid=cmd['resourceId'];adapter=self.resource(rid)
  if cmd['action']==ACTIONS[0]:
   self.authorize(actor,ACTIONS[0],rid);_,view=self.view(actor,rid);view['requestId']=cmd['requestId'];return view
  if cmd['action']==ACTIONS[1]:return self.inspect(actor,rid,cmd.get('operationId'),cmd.get('lookupIdempotencyKey'))
  dg=command_digest(cmd,actor);scope=digest([actor['companyId'],actor['employeeId'],rid]);admission={'kind':'reverie.ops.admission','version':1,'requestId':cmd['requestId'],'requestDigest':dg,'actor':actor,'resourceId':rid,'action':cmd['action']}
  try:
   # Replay is lookup only, even after expiry/revocation: no second effect or new admission.
   with self.ledger.db() as db:
    row=db.execute('SELECT id,digest FROM operations WHERE scope=? AND key=?',(scope,cmd['idempotencyKey'])).fetchone()
    if row:
     self.authorize(actor,ACTIONS[1],rid);require(row['digest']==dg,'idempotency-conflict');r=self.ledger.latest(db,row['id']);return dict(admission,decision='accepted',reason='none',operationId=row['id'],receiptDigest=digest(r))
   authorization=self.authorize(actor,cmd['action'],rid,cmd['grantRef'],cmd['artifact'])
   snap,view=self.view(actor,rid);require(adapter.supports(cmd['action']),'adapter-unavailable');require(view['resourceGeneration']==cmd['expectedResourceGeneration'],'stale-resource');require(view['capabilityGeneration']==cmd['expectedCapabilityGeneration'],'stale-capability');require(authorization['policyGeneration']==cmd['grantRef']['policyGeneration'],'stale-policy');require(adapter.artifact(cmd['action'],cmd['artifact']),'unreviewed-artifact')
   with self.ledger.db() as db:
    db.execute('BEGIN IMMEDIATE')
    row=db.execute('SELECT id,digest FROM operations WHERE scope=? AND key=?',(scope,cmd['idempotencyKey'])).fetchone()
    if row:
     self.authorize(actor,ACTIONS[1],rid);require(row['digest']==dg,'idempotency-conflict');r=self.ledger.latest(db,row['id']);db.commit();return dict(admission,decision='accepted',reason='none',operationId=row['id'],receiptDigest=digest(r))
    require(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0]<self.ledger.max and self.ledger.path.stat().st_size<256*1024*1024,'audit-unavailable')
    fence=db.execute('SELECT operation FROM fences WHERE resource=?',(rid,)).fetchone()
    if fence is not None:
     prior=self.ledger.latest(db,fence[0]);reconciled=db.execute('SELECT generation FROM reconciliations WHERE operation=?',(fence[0],)).fetchone()
     require(prior['state']=='unconfirmed' and reconciled is not None and reconciled[0]==view['resourceGeneration'],'resource-busy')
     stored=strict_json(db.execute('SELECT snapshot FROM operations WHERE id=?',(fence[0],)).fetchone()[0])['resource']
     require(hasattr(adapter,'reconcile'),'resource-busy');fresh_proof=adapter.reconcile(stored,snap);require(fresh_proof and all(e['result']=='pass' for e in fresh_proof),'reconciliation-required')
     # Only this separately authorized successor command can atomically replace a reconciled fence.
     db.execute('DELETE FROM fences WHERE resource=? AND operation=?',(rid,fence[0]))
    op='op-'+uuid.uuid4().hex;db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)',(op,canonical(actor).decode(),scope,cmd['idempotencyKey'],dg,canonical(cmd).decode(),canonical({'resource':snap,'authorization':{k:authorization.get(k) for k in ('grantRef','epoch','actor','policyGeneration')}}).decode(),'accepted'));db.execute('INSERT INTO fences VALUES(?,?)',(rid,op))
    receipt={'kind':'reverie.ops.receipt','version':1,'operationId':op,'requestId':cmd['requestId'],'requestDigest':dg,'actor':actor,'resourceId':rid,'action':cmd['action'],'grantRef':cmd['grantRef'],'artifact':cmd['artifact'],'idempotencyKey':cmd['idempotencyKey'],'beforeGeneration':view['resourceGeneration'],'capabilityGeneration':view['capabilityGeneration'],'state':'accepted','reason':'none','evidence':[]}
    r=self.ledger.append(db,receipt);db.commit()
   if start:
    with self.guard:
     thread=threading.Thread(target=self.run,args=(session,op),daemon=True);self.threads[op]=thread;thread.start()
   return dict(admission,decision='accepted',reason='none',operationId=op,receiptDigest=digest(r))
  except Refusal as e:return dict(admission,decision='refused',reason=e.reason)
 def terminal(self,op,state,reason,ev,after=None):
  with self.ledger.db() as db:
   db.execute('BEGIN IMMEDIATE');r=self.ledger.latest(db,op);require(r['state'] in ('accepted','executing'),'invalid-request');r.update(state=state,reason=reason,evidence=ev)
   if after is not None:r['afterGeneration']=after
   self.ledger.append(db,r)
   if state in ('verified','failed'):db.execute('DELETE FROM fences WHERE operation=?',(op,))
   db.commit()
 def run(self,session,op):
  begun=False
  with self.ledger.db() as db:
   row=db.execute('SELECT * FROM operations WHERE id=?',(op,)).fetchone()
  if row is None:return
  cmd=strict_json(row['command']);rid=cmd['resourceId'];adapter=self.resource(rid);old_actor=strict_json(row['actor']);admitted_authority=strict_json(row['snapshot'])['authorization']
  with self.ledger.db() as db:
   db.execute('BEGIN IMMEDIATE');r=self.ledger.latest(db,op)
   if r['state']!='accepted':db.rollback();return
   fence=db.execute('SELECT operation FROM fences WHERE resource=?',(rid,)).fetchone()
   if fence is None or fence[0]!=op:db.rollback();return
   r.update(state='executing',reason='none');self.ledger.append(db,r);db.commit()
  try:
   actor=self.actor(session);require(actor==old_actor,'stable-identity-unavailable');decision=self.authorize(actor,cmd['action'],rid,cmd['grantRef'],cmd['artifact']);require({k:decision.get(k) for k in ('grantRef','epoch','actor','policyGeneration')}==admitted_authority,'stale-policy');snap,view=self.view(actor,rid);require(view['resourceGeneration']==cmd['expectedResourceGeneration'],'stale-resource');require(view['capabilityGeneration']==cmd['expectedCapabilityGeneration'],'stale-capability');require(adapter.artifact(cmd['action'],cmd['artifact']),'unreviewed-artifact')
   def begin():
    nonlocal begun
    require(self.actor(session)==actor,'stable-identity-unavailable')
    _,current=self.view(actor,rid);require(current['capabilityGeneration']==cmd['expectedCapabilityGeneration'],'stale-capability');require(adapter.generation(adapter.snapshot())==cmd['expectedResourceGeneration'],'stale-resource')
    with self.ledger.db() as db:
     held=db.execute('SELECT operation FROM fences WHERE resource=?',(rid,)).fetchone();require(held is not None and held[0]==op and self.ledger.latest(db,op)['state']=='executing','resource-busy')
    # No slow engine/resource work follows this fresh AUTH recheck before the fixed effect call.
    decision=self.authorize(actor,cmd['action'],rid,cmd['grantRef'],cmd['artifact']);require({k:decision.get(k) for k in ('grantRef','epoch','actor','policyGeneration')}==admitted_authority,'stale-policy');require(self.actor(session)==actor,'stable-identity-unavailable');begun=True
   before_effect=adapter.snapshot();require(adapter.generation(before_effect)==cmd['expectedResourceGeneration'],'stale-resource')
   state,reason,ev,after=adapter.execute(cmd['action'],cmd['artifact'],before_effect,begin)
   self.terminal(op,state,reason,ev,after)
  except BaseException as error:
   if isinstance(error,(KeyboardInterrupt,SystemExit)):raise
   if begun:self.terminal(op,'unconfirmed','unknown-effect',[evidence('resource-state-known','unknown',{'code':'effect-interrupted'})])
   else:
    try:
     after=adapter.generation(adapter.snapshot());self.terminal(op,'failed',error.reason if isinstance(error,Refusal) else 'preflight-failed',[evidence('no-effect-started','pass',{'claimed':False}),evidence('resource-state-known','pass',{'generation':after})],after)
    except Exception:
     with self.ledger.db() as db:
      current=self.ledger.latest(db,op)
     if current['state']=='executing':self.terminal(op,'unconfirmed','unknown-effect',[evidence('resource-state-known','unknown',{'code':'preflight-unavailable'})])
 def recover(self):
  """Called under exclusive daemon lease. Never retry admitted/executing work."""
  with self.ledger.db() as db:rows=db.execute("SELECT id,state,command FROM operations WHERE state IN ('accepted','executing')").fetchall()
  for row in rows:
   if row['state']=='executing':self.terminal(row['id'],'unconfirmed','unknown-effect',[evidence('resource-state-known','unknown',{'code':'host-interrupted'})])
   else:
    try:
     cmd=strict_json(row['command']);generation=self.resource(cmd['resourceId']).generation(self.resource(cmd['resourceId']).snapshot());self.terminal(row['id'],'failed','preflight-failed',[evidence('no-effect-started','pass',{'durableState':'accepted'}),evidence('resource-state-known','pass',{'generation':generation})],generation)
    except Exception:pass
