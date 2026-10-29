"""Owned source controls, not installed engine/website/PTY acceptance."""
import copy
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from reverie import owner_terminal_native as N
from reverie import owner_terminal_pty as H
from reverie import website_peer_facts as F
from reverie import human_terminal_protocol as P
from reverie.owner_terminal_install import quoted, unit_text

EID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
TARGET = dict(employeeId=EID, sessionId=SID, sessionGeneration=2, containerId='c'*64,
              imageId='sha256:'+'d'*64, policyDigest='e'*64, running=True,
              desiredRunning=True, onVacation=False, humanTerminalEntitled=True)


class PrivatePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.file = self.root/'policy.json'
        self.file.write_text('{"version":1}')
        self.file.chmod(0o600)

    def test_bounded_private_bytes_and_exact_hash(self):
        raw, identity = N.private_bytes(self.file)
        self.assertEqual(raw, b'{"version":1}')
        self.assertEqual(N.private_document(self.file, hashlib.sha256(raw).hexdigest()), ({'version':1}, identity))
        with self.assertRaisesRegex(ValueError, 'INSTALLATION_BYTES_CHANGED'):
            N.private_document(self.file, '0'*64)

    def test_unknown_permissions_symlink_hardlink_duplicate_and_oversize_refuse(self):
        self.file.chmod(0o644)
        with self.assertRaises(ValueError): N.private_document(self.file)
        self.file.chmod(0o600)
        alias = self.root/'alias'; alias.symlink_to(self.file)
        with self.assertRaises(OSError): N.private_document(alias)
        alias.unlink(); os.link(self.file, alias)
        with self.assertRaises(ValueError): N.private_document(self.file)
        alias.unlink()
        self.file.write_text('{"version":1,"version":2}')
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_INSTALLATION_KEY'): N.private_document(self.file)
        self.file.write_bytes(b' '*131073)
        with self.assertRaises(ValueError): N.private_document(self.file)

    def test_no_follow_parent_and_noncanonical_path(self):
        alias = self.root/'parent'; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError): N.private_document(alias/self.file.name)
        with self.assertRaises(ValueError): N.physical(alias)

    def test_fixed_unit_no_automatic_start_or_restart(self):
        policy = type('Policy', (), {'path': self.file, 'roots': {'control':self.root/'control', 'ledger':self.root/'ledger'}})()
        raw = unit_text(policy, Path('/nix/store/fixed-host/bin/host'))
        self.assertIn('Restart=no\n',raw)
        self.assertIn('MemoryMax=256M\nMemorySwapMax=0\nTasksMax=64',raw)
        self.assertIn('RestrictAddressFamilies=AF_UNIX',raw)
        with self.assertRaises(ValueError): quoted('/private/%n')
        with self.assertRaises(ValueError): quoted('/private/x\nExecStart=/bad')


class FullWebsiteTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')); self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name).resolve()
        self.roots={name:root/name for name in ('controlRoot','bootstrapRoot','ledgerRoot')}
        for path in self.roots.values(): path.mkdir(mode=0o700)
        self.item={'Id':'c'*64,'Image':'sha256:'+'d'*64,'State':{'Running':True,'Pid':4321},
                   'Config':{'User':str(os.getuid())+':'+str(os.getgid()),'Env':['PATH=/bin']},
                   'HostConfig':{'ReadonlyRootfs':True,'Memory':123,'SecurityOpt':['no-new-privileges:true'],'OomKillDisable':False,
                                 'Privileged':False,'PidMode':'','CapDrop':['ALL'],'CapAdd':None},
                   'Mounts':[{'Type':'bind','Source':str(self.roots['bootstrapRoot']),
                              'Destination':'/run/reverie-owner-terminal','RW':False,'Propagation':'rprivate'}]}
        self.installation=N.Installation.__new__(N.Installation)
        config=root/'worker.json';config.write_text('{}');config.chmod(0o600)
        self.installation.value={'workerConfig':str(config)}
        self.installation.roots=self.roots
        self.installation.runtime_website={'containerId':self.item['Id'],'imageId':self.item['Image'],
            'uid':os.getuid(),'gid':os.getgid(),
            'initPid':4321,'initStart':23,'configDigest':N.digest(self.item['Config']),
            'hostConfigDigest':N.digest(self.item['HostConfig']),'mountsDigest':N.digest(N.mounts(self.item['Mounts']))}
        self.installation.guard=lambda:None
        test=self
        class Engine:
            def guard(self):pass
            def get(self, route):
                test.assertEqual(route,'/containers/'+'c'*64+'/json')
                return copy.deepcopy(test.item)
        self.installation.engine=Engine()
        self.installation.facts=F.WebsiteFacts.__new__(F.WebsiteFacts)
        self.installation.facts.engine=self.installation.engine
        self.installation.facts.selection=copy.deepcopy(self.installation.runtime_website)
        self.installation.facts.binding=copy.deepcopy(self.installation.runtime_website)
        self.installation.facts.initial={'pid':4321,'start':23}

    def observe(self):
        with patch.object(F,'read_proc',return_value={'pid':4321,'start':23}):return self.installation.assert_website()

    def test_full_config_hostconfig_and_complete_mount_dictionary_bound(self):
        self.assertEqual(self.observe(),self.item)
        for section,key,value in [('Config','User','0:0'),('HostConfig','Memory',124),('HostConfig','Privileged',True)]:
            previous=copy.deepcopy(self.item)
            self.item[section][key]=value
            with self.subTest(section=section,key=key),self.assertRaisesRegex(ValueError,'WEBSITE_FULL_SPEC_CHANGED'):self.observe()
            self.item=previous
        self.item['Mounts'][0]['Propagation']='rshared'
        with self.assertRaisesRegex(ValueError,'WEBSITE_FULL_SPEC_CHANGED'):self.observe()

    def test_order_normalizes_but_duplicate_destination_or_unknown_field_drift_does_not(self):
        a={'Destination':'/a','Type':'bind','Source':'/a','RW':False,'arbitrary':'kept'}
        b={'Destination':'/b','Type':'bind','Source':'/b','RW':False}
        self.assertEqual(N.mounts([b,a]),[a,b])
        with self.assertRaises(ValueError):N.mounts([a,dict(a)])
        self.assertNotEqual(N.digest(N.mounts([a,b])),N.digest(N.mounts([{**a,'arbitrary':'changed'},b])))

    def test_pid_reuse_or_rw_bootstrap_refuses(self):
        with patch.object(F,'read_proc',return_value={'pid':4321,'start':24}),self.assertRaisesRegex(ValueError,'WEBSITE_INIT_CHANGED'):
            self.installation.assert_website()
        self.item['Mounts'][0]['RW']=True
        self.installation.facts.selection['mountsDigest']=N.digest(N.mounts(self.item['Mounts']))
        with self.assertRaisesRegex(ValueError,'BOOTSTRAP_MOUNT_REQUIRED'):self.observe()

    def test_only_enabled_oom_semantic_normalization(self):
        self.item['HostConfig']['OomKillDisable']=None
        self.assertEqual(self.observe(),self.item)
        for value in (True,0,1,'false'):
            self.item['HostConfig']['OomKillDisable']=value
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'OOM_KILLER_MUST_REMAIN_ENABLED'):self.observe()


class ToolkitFactTests(unittest.TestCase):
    def test_missing_or_nonlist_capabilities_refuse_before_any_kernel_read(self):
        for host in ({},{'CapAdd':False},{'CapAdd':()},{'CapAdd':'SETUID'}):
            with self.subTest(host=host),patch.object(N.toolkit,'read_proc',side_effect=AssertionError('No kernel read')):
                with self.assertRaisesRegex(ValueError,'TOOLKIT_CAPABILITIES_UNKNOWN'):
                    N.toolkit.qualify({'HostConfig':host},{},uid=os.getuid(),gid=os.getgid())


class CurrentTargetTests(unittest.TestCase):
    def setUp(self):
        from tests.test_worker import WorkerTests
        fixture=WorkerTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        self.root,self.config=fixture.root,fixture.config
        self.employee={'id':EID,'owner':'fixture-owner','sessionId':SID,'sessionGeneration':2,
                       'desiredRunning':True,'onVacation':False}
        self.company()
        paths=N.storage_paths(self.config,SID)
        for path in (paths.home,paths.nix):path.mkdir(mode=0o700,parents=True)
        self.initial={'pid':4242,'start':29,'namespaces':[1,2,3]}
        self.item={'Id':'c'*64,'Name':'/'+self.config['deployment']+'-agent-'+SID,'Image':self.config['image'],
          'Config':{'Labels':{'reverie.worker':self.config['deployment'],'reverie.session':SID,
             'reverie.employee':EID,'reverie.worker-policy':N.policy_digest(self.config,SID)}},
          'HostConfig':{'ReadonlyRootfs':True},'State':{'Running':True,'Pid':4242},
          'Mounts':[{'Type':'bind','Source':str(paths.home),'Destination':'/home/agent','RW':True},
                    {'Type':'bind','Source':str(paths.nix),'Destination':'/nix','RW':True}]}
        self.installation=N.Installation.__new__(N.Installation)
        self.installation.value={'entitlements':{EID:{'sessionId':SID,'generation':2}}}
        self.installation.config=self.config;self.installation.toolkit={};self.installation.toolkit_cache={}
        self.installation.assert_website=lambda:None
        test=self
        class Engine:
            def get(self,route):
                if route=='/containers/json?all=1':
                    return [{'Id':test.item['Id'],'ImageID':test.item['Image'],'Names':[test.item['Name']],
                       'Labels':test.item['Config']['Labels'],'State':'running','Mounts':copy.deepcopy(test.item['Mounts'])}]
                test.assertEqual(route,'/containers/'+'c'*64+'/json');return copy.deepcopy(test.item)
        self.installation.engine=Engine()
        self.addCleanup(patch.stopall)
        patch.object(N,'read_proc',side_effect=lambda _:copy.deepcopy(self.initial)).start()
        patch.object(N.toolkit,'qualify',side_effect=lambda *_a,**_k:copy.deepcopy(self.initial)).start()
        patch.object(N.toolkit,'read_proc',side_effect=lambda _:copy.deepcopy(self.initial)).start()
        original_open=os.open
        def open_root(path,*args,**kwargs):
            if os.fspath(path)=='/proc/4242/root':return original_open(self.root,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            return original_open(path,*args,**kwargs)
        self.guest_roots={'/home/agent':original_open(paths.home,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC),
                          '/nix':original_open(paths.nix,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)}
        self.addCleanup(lambda:[os.close(fd) for fd in self.guest_roots.values()])
        patch.object(N.toolkit.os,'open',side_effect=open_root).start()
        patch.object(N.toolkit,'open_in_root',side_effect=lambda _root,path:os.dup(self.guest_roots[path])).start()
        self.addCleanup(self.installation.close)

    def company(self):
        Path(self.config['companyFile']).write_text(json.dumps({'employees':[self.employee]}))

    def test_explicit_current_entitlement_and_physical_employee_roots_required(self):
        value=self.installation.target_binding(EID)
        self.assertEqual(value['target']['sessionId'],SID);self.assertEqual(value['binding']['init'],self.initial)
        self.installation.value['entitlements']={}
        with self.assertRaisesRegex(ValueError,'EXPLICIT_TERMINAL_ENTITLEMENT_REQUIRED'):self.installation.observe(EID)

    def test_owner_off_vacation_generation_and_foreign_root_refuse(self):
        for key,value in [('desiredRunning',False),('onVacation',True),('sessionGeneration',3)]:
            old=self.employee[key];self.employee[key]=value;self.company()
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'CURRENT_INTENT_REQUIRED'):self.installation.observe(EID)
            self.employee[key]=old;self.company()
        wrong=self.root/'foreign';wrong.mkdir();self.item['Mounts'][0]['Source']=str(wrong)
        with self.assertRaisesRegex(ValueError,'NATIVE_EMPLOYEE_ROOTS_CHANGED'):self.installation.observe(EID)

    def test_canonical_image_and_all_native_identity_labels_are_required(self):
        for key,value in [('reverie.employee','f'*36),('reverie.session',EID),('reverie.worker-policy','0'*64)]:
            old=self.item['Config']['Labels'][key];self.item['Config']['Labels'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.installation.observe(EID)
            self.item['Config']['Labels'][key]=old
        self.item['Image']='sha256:'+'0'*64
        with self.assertRaisesRegex(ValueError,'NATIVE_LAPTOP_POLICY_CHANGED'):self.installation.observe(EID)

    def test_final_same_cid_new_init_during_qualification_refuses(self):
        def change(*_a,**_k):
            previous=copy.deepcopy(self.initial);self.initial['start']+=1;return previous
        with patch.object(N.toolkit,'qualify',side_effect=change),self.assertRaisesRegex(ValueError,'H_STORAGE_INIT_CHANGED'):
            self.installation.observe(EID)
        self.assertEqual(self.installation.toolkit_cache,{})

    def test_held_host_and_guest_root_fds_remain_exact_and_cloexec(self):
        first=self.installation.target_binding(EID)
        cached=next(iter(self.installation.toolkit_cache.values()))['storage']
        for fd in [cached.root,*cached.hosts.values(),*cached.guests.values()]:
            self.assertTrue(fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC)
        paths=N.storage_paths(self.config,SID)
        (paths.home/'ordinary-fixture-data').write_text('owned synthetic activity')
        self.installation.assert_human_binding(first['binding'])
        self.assertEqual(self.installation.target_binding(EID),first)
        closed=[cached.root,*cached.hosts.values(),*cached.guests.values()]
        self.installation.close();self.assertFalse(self.installation.toolkit_cache)
        for fd in closed:
            with self.assertRaises(OSError):os.fstat(fd)

    def test_home_and_nix_path_replacements_refuse_without_rebasing_held_bindings(self):
        first=self.installation.target_binding(EID)
        paths=N.storage_paths(self.config,SID)
        for name in ('home','nix'):
            path=getattr(paths,name);old=path.with_name(name+'-preserved')
            path.rename(old);path.mkdir(mode=0o700)
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):self.installation.target_binding(EID)
                with self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):self.installation.assert_human_binding(first['binding'])
            path.rmdir();old.rename(path)
            self.installation.assert_human_binding(first['binding'])
            self.assertEqual(self.installation.target_binding(EID),first)

    def test_changed_guest_bind_or_init_root_is_not_a_matching_source_spelling(self):
        first=self.installation.target_binding(EID)
        foreign=self.root/'foreign-guest';foreign.mkdir()
        for destination in ('/home/agent','/nix'):
            saved=self.guest_roots[destination]
            self.guest_roots[destination]=os.open(foreign,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            try:
                with self.subTest(destination=destination),self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):
                    self.installation.assert_human_binding(first['binding'])
            finally:
                os.close(self.guest_roots[destination]);self.guest_roots[destination]=saved
        original_open=os.open
        def different_root(path,*args,**kwargs):
            if os.fspath(path)=='/proc/4242/root':return original_open(foreign,os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
            return original_open(path,*args,**kwargs)
        with patch.object(N.toolkit.os,'open',side_effect=different_root),self.assertRaisesRegex(ValueError,'H_STORAGE_INIT_ROOT_CHANGED'):
            self.installation.assert_human_binding(first['binding'])

    def test_last_pid_producer_cannot_hide_a_replaced_canonical_home(self):
        first=self.installation.target_binding(EID)
        paths=N.storage_paths(self.config,SID);old=paths.home.stat();reads=[0]
        def late_pid(_pid):
            reads[0]+=1
            if reads[0]==4:
                paths.home.rename(paths.home.with_name('home-preserved'));paths.home.mkdir(mode=0o700)
            return copy.deepcopy(self.initial)
        with patch.object(N.toolkit,'read_proc',side_effect=late_pid):
            with self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):
                self.installation.assert_human_binding(first['binding'])
        self.assertEqual(reads,[4])
        self.assertNotEqual((old.st_dev,old.st_ino),(paths.home.stat().st_dev,paths.home.stat().st_ino))

    def test_unknown_guest_root_metadata_refuses_and_does_not_cache_partial_custody(self):
        with patch.object(N.toolkit,'open_in_root',side_effect=PermissionError(errno.EACCES,'owned fixture refusal')):
            with self.assertRaises(PermissionError):self.installation.target_binding(EID)
        self.assertEqual(self.installation.toolkit_cache,{})

    def test_changed_roots_block_input_and_prevent_a_false_settlement_marker(self):
        first=self.installation.target_binding(EID)
        paths=N.storage_paths(self.config,SID);paths.home.rename(paths.home.with_name('home-preserved'));paths.home.mkdir()
        shell='11111111-1111-4111-8111-111111111111'
        terminal=H.HumanTerminal.__new__(H.HumanTerminal)
        terminal.installation=self.installation;terminal.digest='f'*64;terminal.assert_current_peer=lambda _:None
        terminal.unknown={shell};terminal.marker=lambda *_:self.fail('Unknown roots cannot publish SETTLED')
        channel=type('Channel',(),{'closed':False,'close':lambda self:setattr(self,'closed',True),'_check':lambda *_:None})()
        child=type('Child',(),{'pid':42,'stdin':None,'stdout':None,'returncode':0,'poll':lambda _:0})()
        terminal.sessions={shell:{'child':child,'pidfd':os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC),
            'channel':channel,'settled':True,'buffer':bytearray(),'target':first['binding'],'ready':{'controlled':'not a proof'},'binding':{'start':1}}}
        cap=type('Cap',(),{'request':{'shellId':shell,'employeeId':EID}})()
        with patch.object(H.os,'write',side_effect=AssertionError('No input may be written')):
            with self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):
                terminal.handle('input',cap,first['target'],'YQ==')
        with patch.object(N.toolkit,'guest_gone',side_effect=AssertionError('Unknown roots precede guest absence')):
            with self.assertRaisesRegex(ValueError,'H_STORAGE_ROOT_CHANGED'):terminal.finish(shell)
        self.assertEqual(terminal.unknown,{shell});self.assertEqual(terminal.sessions,{})
        self.assertTrue(channel.closed)


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.h=H.HumanTerminal.__new__(H.HumanTerminal)
        self.h.installation=type('Install',(),{'roots':{'ledgerRoot':self.root,'controlRoot':self.root},
            'value':{'engineSocket':'/unavailable'},'assert_website':lambda _:None,
            'observe':lambda _,eid:copy.deepcopy(TARGET),'human_binding':lambda _,request:{'init':{}},'assert_human_binding':lambda _,binding:None})()
        (self.root/'docker').mkdir(mode=0o700)
        self.h.sessions={};self.h.unknown=set();self.h.digest='f'*64
        info=self.root.stat();self.h.root_identity=(info.st_dev,info.st_ino,info.st_uid,info.st_mode&0o777)
        self.h.assert_current_peer=lambda _:None
        # Existing transport controls do not exercise live kernel cgroups.
        # The lifecycle suite separately qualifies that fixed observation port.
        self.enterContext(patch.object(H,'_capture_target_group',return_value={'controlled':'not native proof'}))
        self.h.engine=str(Path(sys.executable).resolve())
        # Popen is controlled below; these tests exercise consumed-intent and
        # final guards, not native engine provenance. Model only this fixed
        # interpreter's mapped Nix owner; all other stat facts remain actual.
        self.actual_stat = Path.stat
        if os.environ.get('NIX_BUILD_TOP'):
            mapped_root = self.actual_stat(Path('/')).st_uid
            def engine_stat(path, *args, **kwargs):
                info = self.actual_stat(path, *args, **kwargs)
                if path == Path(self.h.engine) and info.st_uid == mapped_root:
                    values = list(info); values[4] = 0
                    return os.stat_result(values)
                return info
            self.enterContext(patch.object(Path, 'stat', engine_stat))
        self.request=dict(TARGET,schema='reverie-human-shell-v2',shellId='11111111-1111-4111-8111-111111111111',
            requestId='22222222-2222-4222-8222-222222222222',authorizationRef='33333333-3333-4333-8333-333333333333',
            cols=80,rows=24,expiresAtEpochMs=__import__('time').time_ns()//1000000+30000)
        for key in ('running','desiredRunning','onVacation','humanTerminalEntitled'):self.request.pop(key)

    def test_launch_failure_retains_durable_consumed_intent_and_never_replays(self):
        test=self
        class Cap:
            request=test.request
            consumed=0
            def consume(self,value):self.consumed+=1
            def recheck(self,value):pass
        cap=Cap()
        with patch.object(H.subprocess,'Popen',side_effect=OSError('owned launch failure'))as spawn:
            with self.assertRaises(OSError):self.h.open(cap,TARGET)
            self.assertEqual(cap.consumed,1)
            args=spawn.call_args.args[0]
            self.assertEqual(args[0],self.h.engine)
            self.assertEqual(args[-1],P.HUMAN_LAUNCHER)
            self.assertIn(TARGET['containerId'],args)
            self.assertNotIn('sh',args)
            with self.assertRaises(ValueError):self.h.open(cap,TARGET)
            self.assertEqual(spawn.call_count,1)
        self.assertIn(self.request['shellId'],self.h.unknown)
        self.assertTrue((self.root/('shell-'+self.request['shellId']+'.json')).is_file())

    def test_missing_capability_or_current_entitlement_refuses_before_engine(self):
        with patch.object(H.subprocess,'Popen')as spawn:
            with self.assertRaises(AttributeError):self.h.open(None,TARGET)
            class Cap:
                request=self.request
                def consume(self,value):raise AssertionError('must not consume')
            with self.assertRaises(ValueError):self.h.open(Cap(),dict(TARGET,humanTerminalEntitled=False))
            spawn.assert_not_called()

    def test_untrusted_engine_owner_still_refuses_before_controlled_launch(self):
        class Cap:
            request=self.request
            def consume(self,value):pass
            def recheck(self,value):pass
        def untrusted(path, *args, **kwargs):
            info = self.actual_stat(path, *args, **kwargs)
            if path == Path(self.h.engine):
                values = list(info); values[4] = os.getuid()+1
                return os.stat_result(values)
            return info
        with patch.object(Path,'stat',untrusted),patch.object(H.subprocess,'Popen')as spawn:
            with self.assertRaisesRegex(ValueError,'IMMUTABLE_ENGINE_REQUIRED'):
                self.h.open(Cap(),TARGET)
            spawn.assert_not_called()

    def test_last_current_guard_after_native_work_refuses_before_spawn(self):
        class Cap:
            request=self.request
            calls=0
            def consume(self,value):pass
            def recheck(self,value):
                self.calls+=1
                if self.calls==2:raise ValueError('owned final owner expiry')
        with patch.object(H.subprocess,'Popen')as spawn:
            with self.assertRaisesRegex(ValueError,'owned final owner expiry'):self.h.open(Cap(),TARGET)
            spawn.assert_not_called()
        self.assertIn(self.request['shellId'],self.h.unknown)

    def test_root_change_during_last_owner_check_refuses_before_spawn(self):
        changed=[False]
        class Cap:
            request=self.request
            calls=0
            def consume(self,value):pass
            def recheck(self,value):
                self.calls+=1
                if self.calls==2:changed[0]=True
        def root_fence(_binding):
            if changed[0]:raise ValueError('OWNED_ROOT_CHANGED_AFTER_OWNER_CHECK')
        self.h.installation.assert_human_binding=root_fence
        with patch.object(H.subprocess,'Popen')as spawn:
            with self.assertRaisesRegex(ValueError,'OWNED_ROOT_CHANGED_AFTER_OWNER_CHECK'):self.h.open(Cap(),TARGET)
            spawn.assert_not_called()
        self.assertEqual(self.h.unknown,{self.request['shellId']})

    def test_other_shell_frames_and_output_without_nonce_never_prove_settlement(self):
        read,write=os.pipe();self.addCleanup(os.close,read);self.addCleanup(os.close,write)
        os.write(write,b'X'+(2).to_bytes(4,'big')+b'{}')
        stream=os.fdopen(os.dup(read),'rb');self.addCleanup(stream.close)
        child=type('Child',(),{'stdout':stream,'poll':lambda _:None})()
        record={'child':child,'buffer':bytearray(),'nonce':'a'*64,'settled':False}
        with self.assertRaises(ValueError):self.h.read(record)
        self.assertFalse(record['settled'])


if __name__=='__main__':unittest.main()
