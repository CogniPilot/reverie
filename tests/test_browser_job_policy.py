"""Private typed policy controls; no actor, service, driver, GPU or filesystem target execution."""
import copy,json,os,tempfile,unittest
from pathlib import Path
from reverie.browser_job_policy import *

def policy():
    pair=lambda n:{'path':'/nix/store/fixed/'+n,'sha256':'d'*64}
    return {'version':1,'enabled':True,'jobKey':'slam-office640','maxStarts':1,'notBeforeMS':1,'controlRoot':'/owned/control',
      'actor':{'employeeId':'00000000-0000-4000-8000-000000000001','sessionId':'00000000-0000-4000-8000-000000000002','sessionGeneration':3,'owner':None,'recipeSHA256':'e'*64},
      'ownerCue':{'roomId':'00000000-0000-4000-8000-000000000003','messageId':'00000000-0000-4000-8000-000000000004','sha256':'f'*64},
      'targetURL':'https://example.invalid/app/','capture':{'path':'/owned/capture.mjs','sha256':'c'*64},'manifest':{'path':'/owned/manifest.json','sha256':'b'*64},'profileSourceSHA256':'a'*64,'nativeWorkerPath':'/app/assets/native-worker.js','hookSHA256':'a'*64,
      'assets':{'/app/assets/native-worker.js':{'sha256':'b'*64,'maxBytes':1048576,'requiredForCapture':True}},'hardware':{'uuid':'GPU-00000000-0000-0000-0000-000000000001','vendorId':4318,'deviceId':8752,'driverVersion':'555.42','rendererSHA256':'c'*64},
      'tools':{k:pair('bin/'+k)for k in('node','chromium','nvidiaSMI','systemctl','systemdRun','taskset')},'runner':pair('slam-job-run.mjs'),'driver':pair('slam-driver.mjs'),'vulkanIcd':pair('nvidia_icd.json'),
      'limits':{'memoryBytes':6*1024**3,'pids':256,'cpuSet':[0,1,2,3],'setupSeconds':180,'captureSeconds':1200,'runtimeSeconds':1380,'stopSeconds':30,'outerSeconds':1440,'outputBytes':268435456,'hostReserveMiB':4096},'pythonSource':{k:'d'*64 for k in MODULES}}
class PolicyControls(unittest.TestCase):
    def test_absence_is_unavailable_not_an_implicit_allowance(self):self.assertIsNone(load_browser_job_policy({}))
    def test_actual_private_raw_bytes_are_pinned_and_returned_document_is_detached(self):
        with tempfile.TemporaryDirectory()as tmp:
            file=Path(tmp).resolve()/'policy.json';file.write_text(json.dumps(policy()));file.chmod(0o600);v=load_browser_job_policy({'browserJobPolicy':str(file)});self.assertEqual(v.sha256,hashlib.sha256(file.read_bytes()).hexdigest());p=v.document;p['limits']['cpuSet'].append(4);self.assertEqual(v.document['limits']['cpuSet'],[0,1,2,3])
    def test_group_readable_or_symlink_policy_does_not_mint_configuration(self):
        with tempfile.TemporaryDirectory()as tmp:
            file=Path(tmp).resolve()/'policy.json';file.write_text(json.dumps(policy()));file.chmod(0o644)
            with self.assertRaises(BrowserJobPolicyUnknown):load_browser_job_policy({'browserJobPolicy':str(file)})
            file.chmod(0o600);link=file.with_name('link');link.symlink_to(file)
            with self.assertRaises(BrowserJobPolicyUnknown):load_browser_job_policy({'browserJobPolicy':str(link)})
    def test_typed_private_limits_have_no_bool_cpu_or_wider_timer_fallback(self):
        for key,value in [('memoryBytes',True),('cpuSet',[]),('cpuSet',[0,0]),('cpuSet',[True]),('runtimeSeconds',1381),('outputBytes',536870912)]:
            p=policy();p['limits'][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(BrowserJobPolicyUnknown):validate_document(p)
    def test_actor_owner_body_fields_or_arbitrary_driver_graph_cannot_replace_fixed_schema(self):
        for change in({'ownerTrue':True},{'jobKey':'arbitrary'},{'maxStarts':True},{'targetURL':'http://127.0.0.1/'},{'runner':{'path':'/nix/store/fixed/other.mjs','sha256':'d'*64}}):
            p=policy();p.update(change)
            with self.subTest(change=change),self.assertRaises(BrowserJobPolicyUnknown):validate_document(p)
    def test_noncanonical_gpu_alias_and_unbounded_asset_policy_refuse(self):
        p=policy();p['hardware']['uuid']='GPU-ABCDEFAB-0000-0000-0000-000000000001'
        with self.assertRaises(BrowserJobPolicyUnknown):validate_document(p)
        p=policy();p['assets']['/app/assets/native-worker.js']['maxBytes']=134217729
        with self.assertRaises(BrowserJobPolicyUnknown):validate_document(p)
    def test_compiler_revision_is_optional_only_as_one_exact_glue_wasm_pair(self):
        p=policy();validate_document(p)
        paths=['/app/vendor/rumoca/rumoca_bind_wasm.js','/app/vendor/rumoca/rumoca_bind_wasm_bg.wasm']
        for name in paths:p['assets'][name]={'sha256':'b'*64,'maxBytes':1048576,'requiredForCapture':True,'compilerRevision':'a'*40}
        validate_document(p)
        for change in ('missing','otherpath','mismatch','extra','bool','encoded','notrequired'):
            q=copy.deepcopy(p)
            if change=='missing':del q['assets'][paths[1]]
            if change=='otherpath':q['assets']['/app/other.js']=q['assets'].pop(paths[1])
            if change=='mismatch':q['assets'][paths[1]]['compilerRevision']='b'*40
            if change=='extra':q['assets'][paths[1]]['query']='revision=ignored'
            if change=='bool':q['assets'][paths[1]]['compilerRevision']=True
            if change=='encoded':q['assets'][paths[1]]['compilerRevision']='%61'*40
            if change=='notrequired':q['assets'][paths[1]]['requiredForCapture']=False
            with self.subTest(change=change),self.assertRaises(BrowserJobPolicyUnknown):validate_document(q)
if __name__=='__main__':unittest.main()
