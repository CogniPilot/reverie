"""Real private files/flocks, injected fixed manager/engine; never host effects."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from reverie.worker_image import (WorkerImageUpdate,ImageRefused,ImageUpdateUnconfirmed,
    PrivateConfig,Audit,SHOW_ARGS,INSPECT_FORMAT,sha,replace_image)
from tests import test_worker as fixture

OLD='sha256:'+'a'*64
NEW='sha256:'+'b'*64
OTHER='sha256:'+'d'*64
CID='c'*64


class WorkerImageTests(unittest.TestCase):
    def setUp(self):
        f=fixture.WorkerTests();f.setUp();self.addCleanup(f.doCleanups)
        self.root=f.root;self.config=copy.deepcopy(f.config)
        # Existing pool mode must remain supported without the admission installer.
        self.policy=self.root/'policy';self.policy.mkdir(mode=0o700)
        self.path=self.policy/'broker.json';self.write_config()
        self.calls=[];self.loaded={OLD,NEW,OTHER};self.tags={'worker:latest':NEW}
        self.engine='local-engine-1';self.endpoint='unix:///synthetic/docker.sock'
        self.manager=dict(Id='reverie-worker-broker.service',LoadState='loaded',ActiveState='inactive',SubState='dead',MainPID='0',ControlPID='0',Job='')
        self.rows=[dict(id=CID,name='/test-agent-'+fixture.SID,labels={'reverie.worker':'test'},running=False,paused=False,restarting=False,pid=0,status='exited',mounts=[{'Type':'bind','Source':str(self.root/'work')}])]
        self.hook=None;self.ps_override=None;self.inspect_override=None;self.command_fail=None;self.image_override=None;self.manager_override=None
        self.updater=WorkerImageUpdate(self.path,home=self.root,run=self.fake_run)
        env=patch.dict(os.environ,{'DOCKER_HOST':'','DOCKER_CONTEXT':''});env.start();self.addCleanup(env.stop)
    def write_config(self,raw=None):
        self.path.write_bytes(raw if raw is not None else (json.dumps(self.config,indent=2,ensure_ascii=False)+'\n').encode());self.path.chmod(0o600)
    def fake_run(self,args):
        self.calls.append(list(args))
        if self.hook:self.hook(args)
        if self.command_fail and self.command_fail(args):return subprocess.CompletedProcess(args,1,'','private synthetic error')
        code=0
        if args==SHOW_ARGS:
            output=self.manager_override if self.manager_override is not None else ''.join(k+'='+v+'\n' for k,v in self.manager.items())
        elif args[:3]==['docker','context','inspect']:output=json.dumps(self.endpoint)
        else:
            self.assertEqual(args[:3],['docker','--host',self.endpoint]);tail=args[3:]
            if tail==['info','--format','{{json .}}']:
                output=json.dumps(dict(ID=self.engine,OSType='linux',KernelVersion=os.uname().release,Name='local-host'))
            elif tail[:4]==['image','inspect','--format','{{json .Id}}']:
                image=tail[-1]
                self.assertRegex(image,r'^sha256:[0-9a-f]{64}$')
                if image not in self.loaded:code=1;output=''
                else:output=json.dumps(self.image_override if self.image_override is not None else image)
            elif tail==['ps','--all','--no-trunc','--format','{{.ID}}']:
                output=self.ps_override if self.ps_override is not None else '\n'.join(r['id'] for r in self.rows)
            elif tail[:3]==['inspect','--format',INSPECT_FORMAT]:
                selected=tail[3:];output=self.inspect_override if self.inspect_override is not None else '\n'.join(json.dumps(r) for r in self.rows if r['id'] in selected)
            else:self.fail('unexpected fixed command '+repr(args))
        return subprocess.CompletedProcess(args,code,output,'')
    def plan(self):return self.updater.plan(OLD,NEW)
    def apply(self,plan=None):
        p=plan or self.plan()
        return self.updater.apply(OLD,NEW,expect_config_sha256=p['configSha256'],expect_plan_digest=p['planDigest'])
    def audit(self):
        return next(p for p in self.policy.iterdir() if p.is_dir())
    def assert_no_lifecycle(self):
        for args in self.calls:
            self.assertFalse(any(a in {'start','stop','restart','pull','load','build','tag','rm','kill','sudo'} for a in args),args)

    def test_plan_is_read_only_and_pool_policy_does_not_need_reinstallation(self):
        before=self.path.read_bytes();names=sorted(p.name for p in self.policy.iterdir())
        p=self.plan()
        self.assertEqual(p['oldImage'],OLD);self.assertEqual(p['newImage'],NEW)
        self.assertEqual(p['configSha256'],sha(before));self.assertTrue(p['brokerInactive']);self.assertEqual(p['runningLaptops'],0)
        self.assertEqual(sorted(p.name for p in self.policy.iterdir()),names);self.assertEqual(self.path.read_bytes(),before)
        self.assertEqual(self.config['budgetMode'],'pool');self.assert_no_lifecycle()

    def test_atomic_apply_changes_only_image_bytes_and_keeps_exact_private_backup(self):
        self.config['commandTelemetry']={'enabled':False};self.config['sessionResources']={fixture.SID:{**{k:self.config[k] for k in ('budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax')},'budgetMode':'admission','memoryMiB':512}}
        self.write_config();before=self.path.read_bytes();company=Path(self.config['companyFile']);company_before=company.read_bytes()
        result=self.apply();after=self.path.read_bytes()
        self.assertEqual(result['state'],'committed');self.assertFalse(result['started'])
        self.assertEqual(after,before.replace(json.dumps(OLD).encode(),json.dumps(NEW).encode(),1))
        expected=copy.deepcopy(self.config);expected['image']=NEW;self.assertEqual(json.loads(after),expected)
        self.assertEqual(company.read_bytes(),company_before)
        audit=self.audit();transaction=result['transactionId']
        self.assertEqual((audit/(transaction+'.before.json')).read_bytes(),before)
        self.assertEqual(json.loads((audit/(transaction+'.prepared.json')).read_bytes())['state'],'prepared')
        self.assertEqual(json.loads((audit/(transaction+'.committed.json')).read_bytes()),result)
        for p in audit.iterdir():self.assertEqual(p.stat().st_mode&0o777,0o600)
        self.assertEqual(audit.stat().st_mode&0o777,0o700);self.assert_no_lifecycle()

    def test_rollback_uses_the_same_writer_with_reversed_pins(self):
        before=self.path.read_bytes();forward=self.apply();p=self.updater.plan(NEW,OLD)
        reverse=self.updater.apply(NEW,OLD,expect_config_sha256=p['configSha256'],expect_plan_digest=p['planDigest'])
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(reverse['oldImage'],NEW);self.assertEqual(reverse['newImage'],OLD)
        self.assertNotEqual(forward['transactionId'],reverse['transactionId']);self.assertEqual(len(list(self.audit().glob('*.before.json'))),2);self.assert_no_lifecycle()

    def test_unicode_escaped_key_and_nested_old_pin_preserve_every_other_byte(self):
        mount=self.root/('café-'+OLD);mount.mkdir();self.config['mounts'][0]['source']=str(mount)
        raw=(json.dumps(self.config,indent=1,ensure_ascii=False)+'\n\n').encode()
        raw=raw.replace(b'"image":',b'"\\u0069mage" :',1)
        encoded_old=('"sha256:'+r'\u0061'*64+'"').encode()
        raw=raw.replace(json.dumps(OLD).encode(),encoded_old,1);self.write_config(raw)
        self.apply();after=self.path.read_bytes()
        self.assertEqual(after.replace(json.dumps(NEW).encode(),encoded_old,1),raw)
        self.assertIn(('café-'+OLD).encode(),after)

    def test_tags_urls_short_ids_same_id_and_missing_pins_refuse_before_commands(self):
        for value in ('worker:latest','worker','a'*12,'https://example.invalid/image','sha256:'+'A'*64,NEW+'\n',None):
            with self.subTest(value=value),self.assertRaises(ImageRefused):self.updater.plan(OLD,value)
        with self.assertRaises(ImageRefused):self.updater.plan(OLD,OLD)
        with self.assertRaises(ImageRefused):self.updater.plan('worker:latest',NEW)
        self.assertEqual(self.calls,[])

    def test_moved_latest_tag_cannot_change_id_selection(self):
        p=self.plan();self.tags['worker:latest']=OTHER;self.apply(p)
        self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
        selected=[a[-1] for a in self.calls if 'image' in a and 'inspect' in a]
        self.assertTrue(selected);self.assertEqual(set(selected),{OLD,NEW});self.assertFalse(any('latest' in a for args in self.calls for a in args));self.assert_no_lifecycle()

    def test_missing_or_mismatched_loaded_image_never_writes_config(self):
        before=self.path.read_bytes();self.loaded.remove(NEW)
        with self.assertRaises(ImageRefused):self.plan()
        self.loaded.add(NEW);self.image_override=OTHER
        with self.assertRaises(ImageRefused):self.plan()
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(list(self.policy.iterdir()),[self.path])

    def test_active_pending_failed_or_unknown_manager_state_refuses(self):
        original=dict(self.manager)
        for key,value in [('LoadState','not-found'),('ActiveState','active'),('ActiveState','activating'),('ActiveState','deactivating'),('ActiveState','failed'),('SubState','running'),('MainPID','12'),('ControlPID','9'),('Job','123')]:
            self.manager=dict(original);self.manager[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ImageRefused):self.plan()
        self.manager=dict(original);self.manager_override='ActiveState=inactive\n'
        with self.assertRaises(ImageRefused):self.plan()
        self.manager_override=''.join(k+'='+v+'\n' for k,v in original.items())+'MainPID=0\n'
        with self.assertRaises(ImageRefused):self.plan()

    def test_running_paused_restarting_removing_or_unknown_laptop_refuses(self):
        baseline=copy.deepcopy(self.rows[0])
        for change in [dict(running=True,pid=123,status='running'),dict(paused=True,status='paused'),dict(restarting=True,status='restarting'),dict(status='removing'),dict(status='unknown'),dict(pid=True)]:
            self.rows=[{**baseline,**change}]
            with self.subTest(change=change),self.assertRaises(ImageRefused):self.plan()

    def test_unlabelled_named_deployment_laptop_still_cannot_be_live(self):
        self.rows[0].update(labels=None,running=True,pid=123,status='running')
        with self.assertRaises(ImageRefused):self.plan()

    def test_foreign_running_container_is_retained_but_private_mount_exposure_refuses(self):
        self.rows[0].update(name='/another-container',labels=None,running=True,pid=123,status='running')
        self.assertEqual(self.plan()['runningLaptops'],0)
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(self.policy),'RW':False}]
        with self.assertRaises(ImageRefused):self.plan()

    def test_bad_duplicate_partial_or_failed_inventory_refuses(self):
        for output in (CID+'\n'+CID,'not-an-id',CID+'\n'):
            self.ps_override=output
            if output==CID+'\n':self.inspect_override=''
            with self.subTest(output=output),self.assertRaises(ImageRefused):self.plan()
        self.ps_override=None;self.inspect_override=None;self.command_fail=lambda a:'ps' in a
        with self.assertRaises(ImageRefused):self.plan()

    def test_exact_old_image_and_config_byte_cas_refuse_drift(self):
        p=self.plan();self.config['cpus']=1;self.write_config();drift=self.path.read_bytes()
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(self.path.read_bytes(),drift)
        self.config['image']=OTHER;self.write_config()
        with self.assertRaises(ImageRefused):self.plan()
        self.assertEqual(json.loads(self.path.read_bytes())['image'],OTHER)

    def test_engine_plan_or_context_drift_refuses_without_publication(self):
        p=self.plan();before=self.path.read_bytes();self.engine='another-local-engine'
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(self.path.read_bytes(),before)
        self.endpoint='ssh://remote'
        with self.assertRaises(ImageRefused):self.plan()

    def test_concurrent_apply_has_one_real_flock_winner(self):
        p=self.plan();entered=threading.Event();release=threading.Event();results=[]
        def hold(args):
            if 'image' in args and not entered.is_set():entered.set();self.assertTrue(release.wait(5))
        self.hook=hold
        def first():
            try:results.append(self.apply(p))
            except BaseException as error:results.append(error)
        thread=threading.Thread(target=first);thread.start();self.assertTrue(entered.wait(3))
        try:
            with self.assertRaises(ImageRefused) as caught:self.apply(p)
            self.assertEqual(caught.exception.code,'busy')
        finally:release.set();thread.join(5)
        self.assertFalse(thread.is_alive());self.assertEqual(len(results),1);self.assertIsInstance(results[0],dict);self.assertEqual(results[0]['state'],'committed')

    def test_config_change_during_last_preflight_is_preserved_and_refused(self):
        p=self.plan();self.calls.clear();counter=[0]
        def drift(args):
            if 'image' in args:
                counter[0]+=1
                if counter[0]==4:self.config['cpus']=2;self.write_config()
        self.hook=drift
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(json.loads(self.path.read_bytes())['cpus'],2);self.assertEqual(json.loads(self.path.read_bytes())['image'],OLD)
        self.assertFalse(list(self.audit().glob('*.committed.json')))

    def test_after_publication_runtime_change_is_unconfirmed_not_rollback(self):
        p=self.plan();self.calls.clear();counter=[0]
        def activate(args):
            if args==SHOW_ARGS:
                counter[0]+=1
                if counter[0]==5:self.manager['ActiveState']='active'
        self.hook=activate
        with self.assertRaises(ImageUpdateUnconfirmed) as caught:self.apply(p)
        self.assertEqual(caught.exception.result['state'],'unconfirmed');self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
        self.assertTrue(list(self.audit().glob('*.unconfirmed.json')));self.assertFalse(list(self.audit().glob('*.committed.json')));self.assert_no_lifecycle()

    def test_interrupted_replace_retains_prepared_backup_and_never_retries(self):
        p=self.plan();before=self.path.read_bytes();replace=os.replace;calls=[]
        def interrupted(*args,**kwargs):
            self.assertTrue(list(self.audit().glob('*.before.json')));self.assertTrue(list(self.audit().glob('*.prepared.json')))
            calls.append(args);replace(*args,**kwargs);raise OSError('synthetic interruption after replace')
        with patch('reverie.worker_image.os.replace',side_effect=interrupted):
            with self.assertRaises(ImageUpdateUnconfirmed):self.apply(p)
        self.assertEqual(len(calls),1);self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
        self.assertEqual(next(self.audit().glob('*.before.json')).read_bytes(),before)

    def test_symlink_fifo_hardlink_and_nonprivate_configuration_refuse(self):
        before=self.path.read_bytes();self.path.chmod(0o644)
        with self.assertRaises(ImageRefused):self.plan()
        self.path.chmod(0o600);link=self.policy/'other.json';os.link(self.path,link)
        with self.assertRaises(ImageRefused):self.plan()
        link.unlink();self.path.unlink();os.mkfifo(self.path,0o600);start=time.monotonic()
        with self.assertRaises(ImageRefused):self.plan()
        self.assertLess(time.monotonic()-start,1)
        self.path.unlink();link.write_bytes(before);link.chmod(0o600);self.path.symlink_to(link)
        with self.assertRaises(ImageRefused):self.plan()
        self.assertEqual(link.read_bytes(),before)

    def test_duplicate_json_or_non_image_token_replacement_is_never_accepted(self):
        before=self.path.read_bytes();duplicate=before.rstrip()[:-1]+b',"image":'+json.dumps(OLD).encode()+b'}'
        self.write_config(duplicate)
        with self.assertRaises(ImageRefused):self.plan()
        with self.assertRaises(ImageRefused):replace_image(before,OTHER,NEW)

    def test_config_parent_alias_and_unsafe_audit_are_not_adopted(self):
        p=self.plan();target=self.root/'foreign';target.mkdir(mode=0o700);(target/'sentinel').write_text('preserve')
        with PrivateConfig(self.path) as guard:
            name='.worker-image-'+__import__('hashlib').sha256(str(guard.path).encode()).hexdigest()[:16]
        (self.policy/name).symlink_to(target,target_is_directory=True)
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual((target/'sentinel').read_text(),'preserve');self.assertEqual(json.loads(self.path.read_bytes())['image'],OLD)

    def test_file_fsync_failure_before_replace_keeps_original(self):
        p=self.plan();before=self.path.read_bytes()
        with patch('reverie.worker_image.os.fsync',side_effect=OSError('synthetic storage failure')):
            with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(self.path.read_bytes(),before)

    def test_root_execution_is_refused_before_opening_or_engine_calls(self):
        with patch('reverie.worker_image.os.geteuid',return_value=0):
            with self.assertRaises(ImageRefused):self.plan()
        self.assertEqual(self.calls,[])


    def test_post_publication_non_image_drift_is_unconfirmed_and_not_clobbered(self):
        p=self.plan();counter=[0]
        def change(args):
            if args==SHOW_ARGS:
                counter[0]+=1
                if counter[0]==5:
                    value=json.loads(self.path.read_bytes());value['cpus']=3
                    self.path.write_bytes(json.dumps(value).encode())
        self.hook=change
        with self.assertRaises(ImageUpdateUnconfirmed):self.apply(p)
        value=json.loads(self.path.read_bytes());self.assertEqual(value['image'],NEW);self.assertEqual(value['cpus'],3)
        self.assertFalse(list(self.audit().glob('*.committed.json')))

    def test_ancestor_replacement_is_detected_without_writing_new_target(self):
        p=self.plan();saved=self.root/'saved-policy';other=self.root/'other-policy';other.mkdir(mode=0o700)
        replacement=other/self.path.name;replacement.write_bytes(self.path.read_bytes());replacement.chmod(0o600)
        original=self.path.read_bytes();done=[False]
        def swap(args):
            if args==SHOW_ARGS and not done[0]:
                done[0]=True;self.policy.rename(saved);self.policy.symlink_to(other,target_is_directory=True)
        self.hook=swap
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(replacement.read_bytes(),original);self.assertEqual((saved/self.path.name).read_bytes(),original)

    def test_bounded_real_client_output_is_refused_without_host_manager(self):
        from reverie.worker_image import bounded_run,MAX_OUTPUT
        with self.assertRaises(RuntimeError):
            bounded_run([sys.executable,'-I','-B','-c',f'import sys;sys.stdout.write("x"*{MAX_OUTPUT+1})'])
        self.assertEqual(self.calls,[])


    def test_foreign_lock_contents_and_changed_lock_identity_refuse(self):
        p=self.plan();lock=self.policy/'.worker-image.lock';lock.write_text('unrelated private data');lock.chmod(0o600)
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(lock.read_text(),'unrelated private data');lock.unlink()
        done=[False]
        def change(args):
            if args==SHOW_ARGS and not done[0]:
                done[0]=True;lock.unlink();lock.touch(mode=0o600)
        self.hook=change
        with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(json.loads(self.path.read_bytes())['image'],OLD)


    def test_control_lock_and_specific_backup_descendant_must_not_be_mounted(self):
        lock=self.policy/'.worker-image.lock';lock.touch(mode=0o600)
        self.rows[0].update(name='/foreign',labels=None)
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(lock),'RW':False}]
        with self.assertRaises(ImageRefused):self.plan()
        self.rows[0]['mounts']=[]
        with PrivateConfig(self.path) as guard:
            audit=Audit(guard);location=self.policy/audit.name;audit.close()
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(location/'marker.json'),'RW':False}]
        with self.assertRaises(ImageRefused):self.plan()


    def test_same_uid_private_control_parent_inside_shared_grant_is_refused(self):
        self.assertEqual(self.policy.stat().st_uid,os.getuid());self.assertEqual(self.policy.stat().st_mode&0o777,0o700)
        self.config['mounts'][0]['source']=str(self.root);self.write_config()
        with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'private-config-exposed')
        self.assertEqual(json.loads(self.path.read_bytes())['image'],OLD)

    def test_engine_shared_mount_alias_of_control_parent_is_refused(self):
        alias=self.root/'shared-alias';alias.symlink_to(self.policy,target_is_directory=True)
        self.rows[0].update(name='/website',labels=None)
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(alias),'RW':False}]
        with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'private-config-exposed')

    def test_unexpected_post_publication_interrupt_is_unknown_with_private_identity(self):
        p=self.plan();counter=[0]
        def interrupt(args):
            if args==SHOW_ARGS:
                counter[0]+=1
                if counter[0]==5:raise KeyboardInterrupt('PRIVATE_SENTINEL_SHOULD_NOT_LEAK')
        self.hook=interrupt
        with self.assertRaises(ImageUpdateUnconfirmed) as caught:self.apply(p)
        result=caught.exception.result;self.assertEqual(result['state'],'unconfirmed')
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result));self.assertNotIn('PRIVATE_SENTINEL',str(caught.exception))
        self.assertEqual(next(self.audit().glob('*.prepared.json')).stem.split('.')[0],result['transactionId'])
        self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)


    def test_absolute_budget_exhaustion_refuses_before_any_client_or_publication(self):
        before=self.path.read_bytes();counter=[0]
        def clock():
            counter[0]+=1
            return 0.0 if counter[0]==1 else 10000.0
        with patch('reverie.worker_image.time.monotonic',side_effect=clock):
            with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'operation-budget-exhausted')
        self.assertEqual(self.calls,[]);self.assertEqual(self.path.read_bytes(),before)

    def test_unavailable_actual_engine_mount_custody_refuses(self):
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(self.root/'absent-host-source')}]
        with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'mount-custody-unavailable')
        self.assertEqual(list(self.policy.iterdir()),[self.path])

    def test_mount_table_unavailable_or_drift_refuses(self):
        for effects in ([OSError('synthetic unavailable')],[(b'before',[]),(b'after',[])]):
            with patch.object(WorkerImageUpdate,'_mount_table',side_effect=effects):
                with self.assertRaises(ImageRefused):self.plan()
        self.assertEqual(list(self.policy.iterdir()),[self.path])

    def test_host_visible_bind_identity_and_nested_bind_alias_refuse(self):
        public=self.root/'public';public.mkdir();alias=public/'bind-alias';alias.mkdir()
        own=self.policy.stat();original=Path.stat
        def identity(path,*args,**kwargs):
            return own if path==alias else original(path,*args,**kwargs)
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(alias)}]
        # Negative manager metadata fixture; no privileged mount is performed.
        with patch.object(Path,'stat',identity):
            with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'private-config-exposed')
        self.rows[0]['mounts']=[{'Type':'bind','Source':str(public)}]
        with patch.object(Path,'stat',identity),patch.object(WorkerImageUpdate,'_mount_table',return_value=(b'stable',[alias])):
            with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'private-config-exposed')

    def test_interrupted_prepared_journal_blocks_fresh_plan_without_effect(self):
        before=self.path.read_bytes();transaction='e'*32
        with PrivateConfig(self.path) as guard:
            audit=Audit(guard);audit.write(transaction+'.before.json',before)
            audit.write(transaction+'.prepared.json',b'{"state":"prepared"}');audit.close()
        self.calls.clear()
        with self.assertRaises(ImageRefused) as caught:self.plan()
        self.assertEqual(caught.exception.code,'previous-update-unconfirmed')
        self.assertEqual(self.calls,[]);self.assertEqual(self.path.read_bytes(),before)

    def test_unconfirmed_journal_blocks_reverse_writer_and_new_plan(self):
        p=self.plan();replace=os.replace
        def interrupted(*args,**kwargs):replace(*args,**kwargs);raise OSError('synthetic uncertain publication')
        with patch('reverie.worker_image.os.replace',side_effect=interrupted):
            with self.assertRaises(ImageUpdateUnconfirmed):self.apply(p)
        self.calls.clear()
        with self.assertRaises(ImageRefused) as caught:self.updater.plan(NEW,OLD)
        self.assertEqual(caught.exception.code,'previous-update-unconfirmed');self.assertEqual(self.calls,[])
        self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)

    def test_post_commit_cleanup_failure_never_claims_no_effect(self):
        p=self.plan();unlink=os.unlink
        def failure(path,*args,**kwargs):
            if str(path).startswith('.worker-image-new-'):raise OSError('synthetic cleanup uncertainty')
            return unlink(path,*args,**kwargs)
        with patch('reverie.worker_image.os.unlink',side_effect=failure):
            with self.assertRaises(ImageUpdateUnconfirmed) as caught:self.apply(p)
        self.assertEqual(caught.exception.result['state'],'unconfirmed')
        self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
        self.assertTrue(list(self.audit().glob('*.unconfirmed.json')))

    def test_config_replaced_by_fifo_during_shared_policy_validation_refuses_without_read(self):
        from reverie.worker import validate_config
        before=self.path.read_bytes();seen=[]
        def swap(document):
            seen.append(document);self.path.unlink();os.mkfifo(self.path,0o600)
            return validate_config(document)
        start=time.monotonic()
        with patch('reverie.worker_image.validate_config',side_effect=swap):
            with self.assertRaises(ImageRefused):self.plan()
        self.assertLess(time.monotonic()-start,1);self.assertEqual(len(seen),1)
        self.assertEqual(self.calls,[]);self.assertTrue(__import__('stat').S_ISFIFO(self.path.lstat().st_mode))
        self.path.unlink();self.path.write_bytes(before);self.path.chmod(0o600)

    def test_outer_lock_or_config_exit_after_commit_is_unconfirmed_and_durable_hold(self):
        from reverie.worker_image import UpdateLock
        for kind in ('lock','config'):
            with self.subTest(kind=kind):
                p=self.plan()
                cls=UpdateLock if kind=='lock' else PrivateConfig
                original=cls.__exit__
                def failure(instance,*args):
                    original(instance,*args)
                    raise OSError('PRIVATE_OUTER_CLOSE_SENTINEL')
                with patch.object(cls,'__exit__',failure):
                    with self.assertRaises(ImageUpdateUnconfirmed) as caught:self.apply(p)
                result=caught.exception.result;self.assertEqual(result['state'],'unconfirmed')
                self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
                self.assertNotIn('PRIVATE_OUTER_CLOSE',str(caught.exception))
                self.assertTrue((self.audit()/(result['transactionId']+'.unconfirmed.json')).is_file())
                self.calls.clear()
                with self.assertRaises(ImageRefused) as refused:self.updater.plan(NEW,OLD)
                self.assertEqual(refused.exception.code,'previous-update-unconfirmed');self.assertEqual(self.calls,[])
                # Separate owned fixture for the next subcase; no product recovery route.
                if kind=='lock':
                    __import__('shutil').rmtree(self.audit());self.write_config()

    def test_audit_parent_reachability_is_fsynced_before_replace_even_after_prior_failure(self):
        p=self.plan();before=self.path.read_bytes();parent=self.policy.stat();fsync=os.fsync;replace=os.replace
        def is_parent(fd):
            info=os.fstat(fd);return (info.st_dev,info.st_ino)==(parent.st_dev,parent.st_ino)
        def fail_parent(fd):
            if is_parent(fd):raise OSError('synthetic audit-parent durability failure')
            return fsync(fd)
        with patch('reverie.worker_image.os.fsync',side_effect=fail_parent):
            with self.assertRaises(ImageRefused):self.apply(p)
        self.assertEqual(self.path.read_bytes(),before);self.assertTrue((self.audit()/'marker.json').is_file())
        seen=[]
        def durable(fd):
            if is_parent(fd):seen.append('parent-durable')
            return fsync(fd)
        def publish(*args,**kwargs):
            self.assertIn('parent-durable',seen)
            self.assertTrue(list(self.audit().glob('*.before.json')))
            self.assertTrue(list(self.audit().glob('*.prepared.json')))
            return replace(*args,**kwargs)
        with patch('reverie.worker_image.os.fsync',side_effect=durable),patch('reverie.worker_image.os.replace',side_effect=publish):
            self.assertEqual(self.apply(p)['state'],'committed')

    def test_partial_mismatched_or_contradictory_terminal_receipts_hold(self):
        result=self.apply();audit=self.audit();transaction=result['transactionId'];terminal=audit/(transaction+'.committed.json')
        valid=terminal.read_bytes();prepared=audit/(transaction+'.prepared.json');valid_prepared=prepared.read_bytes();backup=audit/(transaction+'.before.json');valid_backup=backup.read_bytes()
        malformed=[b'',b'{',b'{"state":"failed","transactionId":"'+b'0'*32+b'"}']
        for field,value in [('version',True),('state','failed'),('transactionId','0'*32),('oldImage',OTHER),('newImage',OTHER),('beforeSha256',OTHER),('afterSha256',OTHER),('engineId','wrong-engine'),('unit','other.service'),('started',True)]:
            item=json.loads(valid);item[field]=value;malformed.append(json.dumps(item).encode())
        item=json.loads(valid);item['extra']='unknown';malformed.append(json.dumps(item).encode())
        for raw in malformed:
            with self.subTest(raw=raw):
                terminal.write_bytes(raw)
                with self.assertRaises(ImageRefused) as caught:self.updater.plan(NEW,OLD)
                self.assertEqual(caught.exception.code,'previous-update-unconfirmed')
        terminal.write_bytes(valid);self.assertEqual(self.updater.plan(NEW,OLD)['oldImage'],NEW)
        for node,raw in [(prepared,b''),(prepared,b'{'),(backup,valid_backup+b'\n')]:
            node.write_bytes(raw)
            with self.assertRaises(ImageRefused) as caught:self.updater.plan(NEW,OLD)
            self.assertEqual(caught.exception.code,'previous-update-unconfirmed')
            prepared.write_bytes(valid_prepared);backup.write_bytes(valid_backup)
        failed=audit/(transaction+'.failed.json');failed.write_bytes(json.dumps({**result,'state':'failed'}).encode());failed.chmod(0o600)
        with self.assertRaises(ImageRefused) as caught:self.updater.plan(NEW,OLD)
        self.assertEqual(caught.exception.code,'previous-update-unconfirmed')
        self.assertEqual(json.loads(self.path.read_bytes())['image'],NEW)
