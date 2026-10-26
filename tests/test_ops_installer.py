"""Bootstrap works only in owned fixtures. No service activation or key publication."""
import copy,json,os,tempfile,unittest,uuid
from pathlib import Path
from reverie.ops_common import *
from reverie.ops_installer import prepare_authority_state,atomic_private
class Bootstrap(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.auth=self.root/'auth';self.auth.mkdir(mode=0o700);self.nonce=self.auth/'nonces';self.key=self.auth/'ops.key';self.config=self.auth/'service-auth.json';self.store=str(uuid.uuid4());self.source={'version':1,'principals':[{'principal':'ops','epoch':'one','key':str(self.key)}],'purposes':{'OPS_STATUS':{'scope':'employees+resources','action':ACTIONS[0]}},'nonce':{'file':str(self.nonce/'ledger.json'),'storeId':self.store,'capacity':1024,'flockExecutable':'/immutable/flock'}};self.source.pop('nonce');self.config.write_bytes(canonical(self.source));self.config.chmod(0o600);self.nonce.mkdir(mode=0o700);atomic_private(self.nonce/'ledger.json',canonical({'version':1,'storeId':self.store,'capacity':1024,'revision':0,'clockFloor':0,'entries':[]}));atomic_private(self.nonce/'ledger.json.lock',b'');self.goal=self.auth/'goal.json';self.goal.write_bytes(canonical({'version':1,'mode':'owner-only','paths':{'nonce':{'host':str(self.nonce/'ledger.json'),'server':str(self.nonce/'ledger.json')}},'nonce':{'storeId':self.store,'capacity':1024}}));self.goal.chmod(0o600);self.cfg={'authorization':{'config':str(self.config),'principal':'ops','goalPrivateConfig':str(self.goal)}}
 def test_exact_ada_nonce_bootstrap_is_repeatable_and_never_grants(self):
  result=prepare_authority_state(self.cfg);key=self.key.read_bytes();ledger=(self.nonce/'ledger.json').read_bytes();self.assertEqual(len(key),32);self.assertFalse(result['grantsCreated']);self.assertEqual(json.loads(ledger)['storeId'],self.store);prepare_authority_state(self.cfg);self.assertEqual(self.key.read_bytes(),key);self.assertEqual((self.nonce/'ledger.json').read_bytes(),ledger);self.assertEqual(json.loads(self.config.read_bytes()),self.source)
 def test_existing_nonce_history_is_preserved_not_reset(self):
  prepare_authority_state(self.cfg);file=self.nonce/'ledger.json';v=json.loads(file.read_bytes());v['revision']=7;v['entries']=[{'opaque':'prior replay tombstone'}];file.write_bytes(canonical(v));before=file.read_bytes();prepare_authority_state(self.cfg);self.assertEqual(file.read_bytes(),before)
 def test_foreign_or_mismatched_nonce_storage_refuses(self):
  (self.nonce/'ledger.json').unlink();(self.nonce/'unrelated').write_text('preserve')
  with self.assertRaises((Refusal,OSError)):prepare_authority_state(self.cfg)
  self.assertEqual((self.nonce/'unrelated').read_text(),'preserve');self.assertFalse((self.nonce/'ledger.json').exists())
 def test_no_config_has_no_authority_bootstrap(self):
  result=prepare_authority_state({'authorization':None});self.assertFalse(result['configured']);self.assertFalse(self.key.exists())
 def test_keys_symlinks_and_nonprivate_paths_refuse(self):
  outside=self.root/'outside';outside.write_bytes(os.urandom(32));outside.chmod(0o600);self.key.symlink_to(outside)
  with self.assertRaises((Refusal,OSError)):prepare_authority_state(self.cfg)
  self.assertTrue(self.key.is_symlink())
 def test_atomic_private_never_replaces_existing_content(self):
  file=self.root/'existing';file.write_bytes(b'keep');file.chmod(0o600)
  with self.assertRaises(Refusal):atomic_private(file,b'different')
  self.assertEqual(file.read_bytes(),b'keep')
if __name__=='__main__':unittest.main()

class InstallerProtocol(unittest.TestCase):
 def test_real_private_install_repeat_preserves_ledger_key_and_has_no_activation(self):
  from unittest.mock import patch
  import subprocess
  from reverie.ops_installer import Installer
  from reverie.ops_core import Ledger
  package=Path(os.environ.get('OPS_TEST_PACKAGE','/unavailable'))
  if not package.exists():self.skipTest('separate immutable package-build fixture unavailable')
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp).resolve();home=root/'home';home.mkdir(mode=0o700);private=root/'ops';private.mkdir(mode=0o700);engineconfig=private/'engine';company=root/'company.json';company.write_bytes(canonical({'employees':[]}));company.chmod(0o600);broker=root/'broker.json';broker.write_bytes(canonical({'mounts':[{'source':str(root/'workspace')}],'scratchRoot':str(root/'disposable'),'stateRoot':str(root/'workers'),'companyRoot':str(root/'company'),'deployment':'owned','serverContainer':'website'}));broker.chmod(0o600)
   cfg={'version':1,'companyId':'owned','companyFile':str(company),'brokerConfig':str(broker),'stateDirectory':str(private/'state'),'socketDirectory':str(private/'socket'),'requestKey':str(private/'keys/request.key'),'engineBinary':'/immutable/engine','engineSocket':'/private/engine.sock','engineConfigDirectory':str(engineconfig),'resources':{'website':{'containerId':'d'*64,'image':'sha256:'+'e'*64,'deployment':'owned','employees':[],'readiness':{'host':'127.0.0.1','port':3000,'path':'/api/status'},'catalogue':{},'schemaEpoch':'goal-r3-auth-r2'}},'authorization':None,'packageManifest':str(package/'manifest.json')};file=private/'ops.json';file.write_bytes(canonical(cfg));file.chmod(0o600);calls=[]
   class ReadOnlyEngine:
    def __init__(self,*args):pass
    def run(self,args,**kw):calls.append(('engine-read',args));return 0,b'',b''
   def run(args,**kw):
    calls.append(tuple(args))
    if args[0]=='nix-store':
     destination=Path(args[args.index('--add-root')+1]);destination.symlink_to(args[-1])
    return subprocess.CompletedProcess(args,0,'ActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\n' if 'show' in args else 'active\n','')
   with patch('reverie.ops_installer.Engine',ReadOnlyEngine):
    installer=Installer(file,package/'bin/reverie-ops-daemon',package/'manifest.json',home=home,run=run);r=installer.action('install');self.assertFalse(r['started']);self.assertFalse(r['authorityCreated']);key=Path(cfg['requestKey']).read_bytes();ledger=Ledger(cfg['stateDirectory']);
    with ledger.db() as db:db.execute("INSERT INTO nonces VALUES('preserved',99999999999)")
    repeated=installer.action('install');self.assertEqual(Path(cfg['requestKey']).read_bytes(),key)
    upgraded=installer.upgrade(repeated['receiptDigest']);self.assertTrue(upgraded['upgraded']);self.assertFalse(upgraded['started']);self.assertEqual(Path(cfg['requestKey']).read_bytes(),key)
    with ledger.db() as db:self.assertIsNotNone(db.execute("SELECT * FROM nonces WHERE nonce='preserved'").fetchone())
    with self.assertRaises(Refusal):installer.upgrade('sha256:'+'f'*64)

    with ledger.db() as db:self.assertIsNotNone(db.execute("SELECT * FROM nonces WHERE nonce='preserved'").fetchone())
   self.assertFalse(any(isinstance(c,tuple) and c[:3]==('systemctl','--user','start') for c in calls));self.assertTrue((home/'.config/systemd/user/reverie-ops.service').exists())
