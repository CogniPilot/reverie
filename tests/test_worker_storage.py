"""Tiny trusted company/FD/lock fixtures; no engine, provider or real instance."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess
from unittest.mock import Mock

from reverie.worker_storage import (storage_paths,prepare_storage,storage_guard,lock_paths,
                                   read_metadata,company_records,record_storage_binding,storage_start_allowed)

EMPLOYEE='11111111-2222-4333-8444-555555555555'
OLD='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
NEW='99999999-8888-4777-8666-555555555555'
PEER='12345678-1234-4234-8234-123456789abc'


class EmployeeStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='employee-store-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.scratch=self.root/'scratch';self.scratch.mkdir(mode=0o700)
        self.public=self.root/'public';self.public.mkdir()
        self.file=self.root/'company.json'
        self.employee={'id':EMPLOYEE,'sessionId':OLD,'name':'Kit','owner':'owner-a',
                       'desiredRunning':False,'onVacation':True}
        self.company={'employees':[self.employee],'retired':[]}
        self.config={'stateRoot':str(self.state),'scratchRoot':str(self.scratch),
                     'companyFile':str(self.file),'uid':os.getuid(),
                     'mounts':[{'source':str(self.public),'destination':'/workspace','readOnly':False}]}
        self.write(self.file,self.company)

    def write(self,path,value):
        path.write_text(json.dumps(value));path.chmod(0o600)

    def move(self,phase='starting'):
        self.employee['sessionId']=NEW
        self.write(self.file,self.company)
        self.write(self.file.with_name('plan-moves.json'),[{'employeeId':EMPLOYEE,'owner':'owner-a',
                   'oldSession':OLD,'newSession':NEW,'phase':phase}])

    def test_identity_and_data_survive_rename_model_account_and_session_change(self):
        before=storage_paths(self.config,OLD)
        self.employee.update(name='New human label',runtimeRecipe={'mode':'other','subscriptionProfile':{'id':'other'}})
        self.write(self.file,self.company)
        self.assertEqual(storage_paths(self.config,OLD),before)
        self.move();after=storage_paths(self.config,NEW);historic=storage_paths(self.config,OLD)
        self.assertEqual((after.identity,after.root,after.home,after.nix,after.scratch),
                         (before.identity,before.root,before.home,before.nix,before.scratch))
        self.assertEqual(historic.identity,EMPLOYEE)
        self.assertEqual(after.home,self.state/'employees'/EMPLOYEE/'home')
        self.assertEqual(after.scratch,self.scratch/'employees'/EMPLOYEE)

    def test_off_vacation_and_retired_resolution_grants_no_running_intent(self):
        original=deepcopy(self.company)
        storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):pass
        self.assertEqual(read_metadata(self.file,os.getuid()),original)
        self.company={'employees':[],'retired':[self.employee]};self.write(self.file,self.company)
        self.assertEqual(storage_paths(self.config,OLD).identity,EMPLOYEE)
        self.assertEqual(read_metadata(self.file,os.getuid()),self.company)

    def test_unbound_adhoc_session_is_explicitly_separate_not_fake_employee(self):
        paths=storage_paths(self.config,PEER)
        self.assertEqual((paths.kind,paths.identity),('session',PEER))
        self.assertEqual(paths.home,self.state/PEER/'home')
        self.assertNotEqual(paths.root,storage_paths(self.config,OLD).root)

    def test_duplicate_current_binding_or_employee_identity_refuses(self):
        for row in ({**self.employee,'id':PEER},{**self.employee,'sessionId':PEER}):
            with self.subTest(row=row):
                self.write(self.file,{'employees':[self.employee,row]})
                with self.assertRaisesRegex(ValueError,'Ambiguous'):storage_paths(self.config,OLD)

    def test_name_or_invalid_ids_cannot_select_employee_storage(self):
        for value in ('Kit','../Kit','/tmp','','AAAAAAAA-2222-4333-8444-555555555555'):
            with self.subTest(value=value):
                self.employee['id']=value;self.write(self.file,self.company)
                with self.assertRaises(ValueError):storage_paths(self.config,OLD)

    def test_journal_cannot_claim_another_owner_or_unknown_employee(self):
        self.move()
        for field,value in (('owner','owner-b'),('employeeId',PEER),('phase','invented')):
            moves=[{'employeeId':EMPLOYEE,'owner':'owner-a','oldSession':OLD,'newSession':NEW,'phase':'starting'}]
            moves[0][field]=value;self.write(self.file.with_name('plan-moves.json'),moves)
            with self.subTest(field=field),self.assertRaises(ValueError):storage_paths(self.config,OLD)

    def test_missing_or_writable_or_symlinked_company_fails_closed(self):
        self.file.chmod(0o666)
        with self.assertRaises(ValueError):company_records(self.config)
        self.file.chmod(0o600);other=self.file.with_name('actual.json');self.file.rename(other);self.file.symlink_to(other)
        with self.assertRaises(ValueError):storage_paths(self.config,OLD)
        self.file.unlink()
        with self.assertRaises(FileNotFoundError):storage_paths(self.config,OLD)

    def test_employee_lock_spans_sessions_and_blocks_migration_until_release(self):
        first=storage_guard(self.config,OLD);paths=first.__enter__()
        try:
            self.move()
            with self.assertRaises(BlockingIOError):
                with storage_guard(self.config,NEW):pass
            with self.assertRaises(BlockingIOError):
                with storage_guard(self.config,NEW,migration=True):pass
            # Different genuine/ad-hoc identity remains independent.
            with storage_guard(self.config,PEER):pass
        finally:first.__exit__(None,None,None)
        with storage_guard(self.config,NEW) as after:self.assertEqual(after.identity,paths.identity)

    def test_employee_migration_fence_blocks_both_session_aliases(self):
        with storage_guard(self.config,OLD,migration=True) as paths:
            _lock,fence=lock_paths(self.config,paths);self.write(fence,{'fixture':'held migration'})
        self.move()
        for sid in (OLD,NEW):
            with self.subTest(sid=sid),self.assertRaisesRegex(RuntimeError,'fenced'):
                with storage_guard(self.config,sid):pass
        with storage_guard(self.config,NEW,migration=True):pass

    def test_symlink_lock_or_shared_state_root_cannot_redirect_writes(self):
        paths=storage_paths(self.config,OLD)
        lock,_=lock_paths(self.config,paths,create=True)
        sentinel=self.root/'unrelated';sentinel.write_text('untouched');lock.symlink_to(sentinel)
        with self.assertRaises(OSError):
            with storage_guard(self.config,OLD):pass
        self.assertEqual(sentinel.read_text(),'untouched')
        config={**self.config,'stateRoot':str(self.public/'state')}
        with self.assertRaisesRegex(ValueError,'outside'):
            with storage_guard(config,OLD):pass

    def test_new_employee_prepares_once_without_names_in_paths(self):
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):prepare_storage(self.config,paths)
        marker=read_metadata(paths.root/'storage.json',os.getuid())
        self.assertEqual(marker,{'version':1,'kind':'employee','identity':EMPLOYEE,'state':'ready'})
        (paths.home/'installed').write_text('keep latest home')
        self.move()
        with storage_guard(self.config,NEW):prepare_storage(self.config,storage_paths(self.config,NEW))
        self.assertEqual((paths.home/'installed').read_text(),'keep latest home')
        self.assertFalse((self.state/'Kit').exists())

    def test_existing_home_and_either_old_nix_source_require_paired_migration(self):
        old=self.state/OLD;old.mkdir(mode=0o700);(old/'home').mkdir(mode=0o700)
        paths=storage_paths(self.config,OLD)
        with self.assertRaisesRegex(RuntimeError,'paired offline migration'):
            with storage_guard(self.config,OLD):prepare_storage(self.config,paths)
        self.assertFalse(paths.home.exists())
        # A newly rebound SID cannot hide the source employee's older home.
        self.move();new=storage_paths(self.config,NEW)
        with self.assertRaisesRegex(RuntimeError,'paired offline migration'):
            with storage_guard(self.config,NEW):prepare_storage(self.config,new)
        self.assertFalse(paths.home.exists())

    def test_ready_marker_cannot_substitute_for_missing_or_foreign_data(self):
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):prepare_storage(self.config,paths)
        (paths.root/'storage.json').write_text(json.dumps({'version':1,'kind':'employee','identity':PEER,'state':'ready'}))
        with self.assertRaisesRegex(ValueError,'identity'):
            with storage_guard(self.config,OLD):prepare_storage(self.config,paths)

    def test_historical_and_failed_sessions_never_gain_new_process_eligibility(self):
        paths=storage_paths(self.config,OLD)
        self.assertFalse(storage_start_allowed(self.config,paths))
        self.employee.update(desiredRunning=True,onVacation=False);self.write(self.file,self.company)
        self.assertTrue(storage_start_allowed(self.config,paths))
        self.move('completed')
        self.assertEqual(storage_paths(self.config,OLD).identity,EMPLOYEE)
        self.assertFalse(storage_start_allowed(self.config,storage_paths(self.config,OLD)))
        self.assertTrue(storage_start_allowed(self.config,storage_paths(self.config,NEW)))
        self.move('failed')
        self.assertFalse(storage_start_allowed(self.config,storage_paths(self.config,OLD)))

    def test_host_private_lineage_survives_journal_pruning_without_adhoc_fallback(self):
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):
            prepare_storage(self.config,paths);record_storage_binding(self.config,paths)
        self.move();self.file.with_name('plan-moves.json').unlink()
        historical=storage_paths(self.config,OLD)
        self.assertEqual(historical.identity,EMPLOYEE)
        self.assertFalse(storage_start_allowed(self.config,historical))
        with self.assertRaisesRegex(ValueError,'Current employee binding'):
            record_storage_binding(self.config,historical)
        with self.assertRaises(FileNotFoundError):
            (paths.home/'storage-owner.json').read_text()

    def test_lineage_cannot_conflict_with_reassigned_employee_or_owner(self):
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):
            prepare_storage(self.config,paths);record_storage_binding(self.config,paths)
        self.employee['owner']='owner-b';self.write(self.file,self.company)
        with self.assertRaisesRegex(ValueError,'conflicts'):storage_paths(self.config,OLD)


class BrokerEmployeeLeaseTests(unittest.TestCase):
    """Actual FD leases and synthetic engine metadata; never model/provider calls."""
    setUp=EmployeeStorageTests.setUp
    write=EmployeeStorageTests.write
    move=EmployeeStorageTests.move
    def broker(self, items=()):
        from reverie.worker import Broker
        config={**self.config,'deployment':'test','maxWorkers':4,'version':1,'image':'sha256:'+'c'*64,
                'serverContainer':'test-console','socket':str(self.root/'control.sock'),'gid':os.getgid(),
                'companyRoot':str(self.root),'apiSocketRoot':str(self.root/'api'),
                'budgetMode':'admission','memoryMiB':512,'poolMemoryMiB':4096,'poolTasksMax':512,
                'pidsLimit':128,'cpus':0,'cgroupParent':'reverie-workers.slice','maintenanceSessions':[]}
        broker=Broker(config)
        def engine(args,optional=False):
            if args[:3]==['ps','--quiet','--no-trunc']:
                return subprocess.CompletedProcess(args,0,'\n'.join(item['Id'] for item in items),'')
            if args[0]=='ps':return subprocess.CompletedProcess(args,0,'\n'.join(item['Name'].removeprefix('/') for item in items),'')
            if args[0]=='inspect':
                if not items:return subprocess.CompletedProcess(args,1,'','')
                return subprocess.CompletedProcess(args,0,json.dumps(list(items)),'')
            raise AssertionError('Unexpected effect in readonly lease fixture')
        broker.run_engine=Mock(side_effect=engine)
        self.addCleanup(lambda:[broker.release_storage(sid) for sid in list(broker.storage_leases)])
        return broker

    def item(self,sid=OLD,*,name=None,home=None,employee=EMPLOYEE):
        paths=storage_paths(self.config,sid)
        return {'Id':('a' if sid==OLD else 'b')*64,'Name':name or '/test-agent-'+sid,
                'State':{'Running':True},'Config':{'Labels':{'reverie.worker':'test','reverie.session':sid,'reverie.employee':employee}},
                'Mounts':[{'Type':'bind','Source':str(home or paths.home),'Destination':'/home/agent','RW':True},
                          {'Type':'bind','Source':str(paths.nix),'Destination':'/nix','RW':True}]}

    def test_detached_laptop_lease_is_not_a_viewer_lifetime_lock(self):
        broker=self.broker();paths,created=broker.claim_storage(OLD)
        self.assertTrue(created);self.assertFalse(broker.active)
        self.move()
        with self.assertRaises(BlockingIOError):broker.claim_storage(NEW)
        self.assertEqual(broker.storage_leases[OLD][1].identity,EMPLOYEE)
        broker.release_storage(OLD)
        self.assertEqual(broker.claim_storage(NEW)[0].home,paths.home)

    def test_actual_writer_inventory_blocks_old_sid_after_broker_fd_loss(self):
        paths=storage_paths(self.config,OLD);old=self.item()
        broker=self.broker([old]);broker.claim_storage(OLD)
        broker.release_storage(OLD)  # Simulate process death closing its held FD.
        self.move()
        recovered=self.broker([old])
        with self.assertRaisesRegex(RuntimeError,'Another running container'):
            recovered.claim_storage(NEW)
        self.assertFalse(recovered.storage_leases)

    def test_recovery_refuses_duplicate_or_broader_writers_before_adoption(self):
        paths=storage_paths(self.config,OLD)
        duplicate=self.item(name='/duplicate-name');duplicate['Id']='b'*64
        for items in ([self.item(),duplicate],[self.item(home=paths.root)]):
            with self.subTest(items=items):
                broker=self.broker(items)
                with self.assertRaises(RuntimeError):broker.claim_storage(OLD)
                self.assertFalse(broker.storage_leases)

    def test_named_legacy_or_misbound_container_is_never_adopted(self):
        for item in (self.item(employee=PEER),self.item(home=self.state/OLD/'home')):
            broker=self.broker([item])
            with self.assertRaisesRegex(RuntimeError,'canonical-storage recreation'):
                broker.claim_storage(OLD)
            self.assertFalse(broker.storage_leases)

    def test_restart_reacquires_running_employee_lease_before_phone(self):
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):prepare_storage(self.config,paths)
        old=self.broker([self.item()]);old.claim_storage(OLD)
        old.release_storage(OLD)  # An old process exit closes its FD; laptop survives.
        replacement=self.broker([self.item()]);replacement.office=Mock()
        replacement.recover()
        self.assertIn(OLD,replacement.storage_leases)
        self.assertIn(OLD,replacement.laptops)
        replacement.office.assert_called_once_with(OLD)
        with self.assertRaises(BlockingIOError):
            with storage_guard(self.config,OLD,migration=True):pass

    def test_duplicate_writers_block_recovery_before_any_phone(self):
        duplicate=self.item(name='/test-agent-'+NEW);duplicate['Id']='b'*64
        broker=self.broker([self.item(),duplicate]);broker.office=Mock()
        with self.assertRaises(RuntimeError):broker.recover()
        broker.office.assert_not_called();self.assertFalse(broker.storage_leases)
        self.assertFalse(broker.laptops)

    def test_historical_transport_request_cannot_start_or_create_employee_laptop(self):
        import socket
        from reverie.worker import send_frame,receive_frame
        paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD):
            prepare_storage(self.config,paths);record_storage_binding(self.config,paths)
        self.employee.update(desiredRunning=True,onVacation=False);self.move('creating')
        broker=self.broker();self.assertTrue(broker.allowed(OLD))  # Legacy grace is not NEWstart authority.
        server,client=socket.socketpair();client.settimeout(2);broker.connections.acquire()
        try:
            request={'sessionId':OLD,'cwd':'/workspace/project','command':'must-not-execute','env':{},'cols':80,'rows':24}
            send_frame(client,b'J',json.dumps(request).encode());broker.handle(server)
            kind,error=receive_frame(client)
            self.assertEqual(kind,b'E');self.assertIn(b'current employee session',error)
        finally:client.close()
        self.assertTrue(all(call.args[0][0] in ('ps','inspect') for call in broker.run_engine.call_args_list))
        self.assertFalse(broker.storage_leases)


if __name__=='__main__':unittest.main()
