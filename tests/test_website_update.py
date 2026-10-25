"""Pinned website stage: fake engine plus real owned private filesystem only."""
import tests
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import socket
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit, parse_qs

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('website_stage_tests',ROOT/'apps/host/website-update.py')
website=importlib.util.module_from_spec(spec);spec.loader.exec_module(website)
OLD='1'*64
NEW='2'*64
OLD_IMAGE='sha256:'+'a'*64
NEW_IMAGE='sha256:'+'b'*64

class Guard:
    def __init__(self):self.value={'brokerConfig':'original','workerImages':['retained-image'],'intents':[{'desiredRunning':True,'onVacation':False,'session':'retained','recipe':'retained'}]}
    def snapshot(self):return deepcopy(self.value)
    def admit_control_custody(self,binding,paths,sources):
        return {**website.custody_digests(binding,paths,sources),'evidenceDigest':website.digest('FAKE owned fixture custody; not production qualification')}

class FakeEngine:
    def __init__(self,old,previous,target):
        self.containers={OLD:deepcopy(old)};self.images={OLD_IMAGE:deepcopy(previous),NEW_IMAGE:deepcopy(target)};self.calls=[];self.before_create=lambda spec:None;self.after_create=lambda new:None;self.start_hook=lambda new:None;self.create_timeout=False;self.start_timeout=False;self.fail_rename=False;self.recreate_attempts=0
    def container(self,selector):
        for value in self.containers.values():
            if value['Id']==selector or value['Name']=='/'+selector:return value
        raise website.WebsiteRefusal('Not found')
    def __call__(self,method,path,data=None):
        self.calls.append((method,path,deepcopy(data)));parsed=urlsplit(path);parts=parsed.path.split('/');query=parse_qs(parsed.query)
        if method=='GET' and parts[1]=='images':return deepcopy(self.images[unquote(parts[2])])
        if method=='GET' and parts[1]=='containers' and parts[-1]=='json':return deepcopy(self.container(unquote(parts[2])))
        if method=='POST' and parsed.path=='/containers/create':
            self.before_create(data)
            for mount in data['HostConfig']['Mounts']:
                if not Path(mount['Source']).exists():
                    if mount['BindOptions'].get('CreateMountpoint',False):self.recreate_attempts+=1;Path(mount['Source']).mkdir(parents=True)
                    else:raise website.WebsiteRefusal('Missing bind; no create')
            old=self.containers[OLD]
            new={'Id':NEW,'Name':'/'+query['name'][0],'Image':data['Image'],'Config':{k:deepcopy(v) for k,v in data.items() if k!='HostConfig'},'HostConfig':deepcopy(data['HostConfig']),'Mounts':deepcopy(old['Mounts']),'State':{'Running':False,'Paused':False,'Restarting':False,'Dead':False,'Pid':0,'StartedAt':''},'NetworkSettings':{'Networks':{'bridge':{}}}}
            self.containers[NEW]=new;self.after_create(new)
            if self.create_timeout:raise TimeoutError('create response lost')
            return {'Id':NEW}
        if method=='POST' and parts[1]=='containers':
            value=self.container(parts[2]);verb=parts[3]
            if verb=='stop':value['State']['Running']=False;value['State']['Pid']=0;value['_manuallyStopped']=True;return None
            if verb=='rename':
                if self.fail_rename:raise TimeoutError('rename ambiguous')
                value['Name']='/'+query['name'][0];return None
            if verb=='start':
                assert value['Id']==NEW,'FORBIDDEN_OLD_START'
                value['_manuallyStopped']=False;value['State']['Running']=True;value['State']['Pid']=12345;value['State']['StartedAt']='candidate-start'
                self.start_hook(value)
                if self.start_timeout:raise TimeoutError('start response lost')
                return None
        raise AssertionError('UNEXPECTED_ENGINE_MUTATION_OR_PATH '+repr((method,path)))
    def daemon_restart(self):
        for value in self.containers.values():
            policy=value['HostConfig']['RestartPolicy']['Name']
            if policy=='always' or policy=='unless-stopped' and not value.get('_manuallyStopped'):value['State']['Running']=True
    def mutations(self):return [(m,p,d) for m,p,d in self.calls if m!='GET']

class WebsiteStageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='website-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.data=self.root/'data';self.console=self.data/'console';self.console.mkdir(parents=True,mode=0o700);self.data.chmod(0o700)
        for name,value in [('company.json','{"version":1,"employees":[]}'),('settings.json','{"owner":true}'),('state.json','{"sessions":{}}'),('owner-auth.json','{"claimed":true}'),('.env','PRIVATE_AUTH_FIXTURE')]:
            p=self.console/name;p.write_text(value);p.chmod(0o600)
        self.password=self.data/'owner-password';self.password.write_text('PRIVATE_OWNER_FIXTURE');self.password.chmod(0o600)
        accounts=self.console/'accounts';accounts.mkdir(mode=0o700);(accounts/'live-provider-log').write_text('must not copy')
        self.workspace=self.root/'workspace';self.workspace.mkdir();self.sockets=self.root/'worker-control';self.sockets.mkdir()
        previous={'Id':OLD_IMAGE,'Os':'linux','Architecture':'amd64','RootFS':{'Layers':['old']},'Config':{'Env':['PATH=/nix/store/old/bin','REVERIE_VERSION=old','HOME=/home/agent'],'Cmd':['reverie','web','--port','3000'],'Entrypoint':['/bin/tini','-g','-s','--','/usr/local/bin/reverie-start'],'Labels':{'reverie.worker.nix-store':'0','image-default':'old'}}}
        target={'Id':NEW_IMAGE,'Os':'linux','Architecture':'amd64','RootFS':{'Layers':['new']},'Config':{'Env':['PATH=/nix/store/new/bin','REVERIE_VERSION=new','HOME=/home/agent'],'Cmd':['reverie','web','--port','3000'],'Entrypoint':['/bin/tini','-g','-s','--','/usr/local/bin/reverie-start'],'Labels':{'reverie.worker.nix-store':'0','image-default':'new'}}}
        old_mounts=[{'Type':'bind','Source':str(path),'Destination':target,'RW':rw,'Propagation':'rprivate','Mode':'rw' if rw else 'ro'} for path,target,rw in [(self.data,'/instances/default',True),(self.workspace,'/reverie_workspace',True),(self.sockets,'/run/reverie-workers',False)]]
        old={'Id':OLD,'Name':'/reverie','Image':OLD_IMAGE,'Config':{**deepcopy(previous['Config']),'Image':'reverie:latest','User':str(os.getuid())+':'+str(os.getgid()),'WorkingDir':'/reverie_workspace','Env':previous['Config']['Env']+['OWNER_OVERRIDE=kept','REVERIE_WORKER_SOCKET=/run/reverie-workers/broker.sock','REVERIE_ADMIN_PHONE_WAKE=enabled'],'Labels':{'reverie.worker.nix-store':'0','image-default':'old','owner-label':'kept'}},'HostConfig':{'NetworkMode':'bridge','AutoRemove':False,'Binds':[m['Source']+':'+m['Destination']+':'+m['Mode'] for m in old_mounts],'Mounts':[],'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},'Memory':123456789,'MemorySwap':123456789,'PidsLimit':321,'NanoCpus':0,'PortBindings':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3000'}]},'SecurityOpt':['no-new-privileges'],'ReadonlyRootfs':False},'Mounts':old_mounts,'State':{'Running':True,'Paused':False,'Restarting':False,'Dead':False,'Pid':9876,'StartedAt':'old-start'},'NetworkSettings':{'Networks':{'bridge':{'IPAddress':'172.17.0.42','IPAMConfig':None}}}}
        self.engine=FakeEngine(old,previous,target);self.guard=Guard();self.deployment=self.root/'deployment.json';self.policy=self.root/'schema-policy.json';self.state=self.root/'journal'
        self.deployment.write_text(json.dumps({'version':1,'containerName':'reverie','adminPhoneWake':False}));self.deployment.chmod(0o600)
        review={'version':1,'reviewId':'owner-reviewed-goal-auth','oldImage':OLD_IMAGE,'newImage':NEW_IMAGE,'adoption':'forward-only','schemaFloors':['GOAL','AUTH'],'approvedSpecDigest':None,'backupScopes':[{'containerPath':'/instances/default/console','exclude':['accounts']},{'containerPath':'/instances/default/owner-password','exclude':[]}]}
        self.policy.write_text(json.dumps(review));self.policy.chmod(0o600)
        self.guard.value['workerBindSources']=[str(self.workspace)]
        self.guard.value['websiteControlBinding']={'resourceId':'website','containerName':'reverie','stateDirectory':str(self.state),'deploymentPath':str(self.deployment),'policyPath':str(self.policy),'maintenanceLockDirectory':str(self.deployment.parent/'runtime/update-state'),'generation':'sha256:'+'c'*64}
        self.stage=website.WebsiteStage(self.engine,self.state,self.deployment,self.policy,guard=self.guard,ready=lambda cid,spec:True)
        self.approve()
    def approve(self):
        draft=self.stage.plan('reverie',NEW_IMAGE,OLD,OLD_IMAGE);review=json.loads(self.policy.read_text());review['approvedSpecDigest']=draft['specPin'];self.policy.write_text(json.dumps(review))
        return self.stage.plan('reverie',NEW_IMAGE,OLD,OLD_IMAGE)
    def plan(self):return self.stage.plan('reverie',NEW_IMAGE,OLD,OLD_IMAGE)
    def apply(self,plan=None):
        plan=self.plan() if plan is None else plan
        return self.stage.apply(plan,website.digest(plan))
    def assert_no_old_restore(self):
        self.assertFalse(any(m=='DELETE' or '/images/create' in p or '/images/load' in p or '/tag' in p or p=='/containers/'+OLD+'/start' for m,p,d in self.engine.calls))
    def receipt(self):return json.loads((self.state/'website-active.json').read_text())
    def test_plan_is_read_only_and_exact_loaded_ids(self):
        plan=self.plan();self.assertEqual(plan['newImage'],NEW_IMAGE);self.assertFalse(self.state.exists());self.assertFalse(self.engine.mutations())
        self.assertTrue(all('/images/sha256:' in p for m,p,d in self.engine.calls if '/images/' in p))
    def test_replacement_refreshes_new_image_defaults_and_keeps_owner_overrides(self):
        plan=self.plan();cfg=plan['spec'];env=website.environment(cfg['Env'])
        self.assertEqual(env['PATH'],'PATH=/nix/store/new/bin');self.assertEqual(env['OWNER_OVERRIDE'],'OWNER_OVERRIDE=kept');self.assertEqual(env['REVERIE_ADMIN_PHONE_WAKE'],'REVERIE_ADMIN_PHONE_WAKE=disabled')
        self.assertEqual(cfg['Entrypoint'],['/bin/tini','-g','-s','--','/usr/local/bin/reverie-start']);self.assertEqual(cfg['User'],self.engine.containers[OLD]['Config']['User']);self.assertEqual(cfg['Labels']['owner-label'],'kept')
        for key in ('Memory','MemorySwap','PidsLimit','PortBindings','NetworkMode','SecurityOpt'):self.assertEqual(cfg['HostConfig'][key],self.engine.containers[OLD]['HostConfig'][key])
        self.assertNotIn('Binds',cfg['HostConfig']);self.assertTrue(all(x['BindOptions']['CreateMountpoint'] is False for x in cfg['HostConfig']['Mounts']))
    def test_explicit_owner_phone_true_replaces_stale_disabled_environment(self):
        self.deployment.write_text(json.dumps({'containerName':'reverie','adminPhoneWake':True}))
        self.engine.containers[OLD]['Config']['Env'][-1]='REVERIE_ADMIN_PHONE_WAKE=disabled'
        self.assertEqual(website.environment(self.plan()['spec']['Env'])['REVERIE_ADMIN_PHONE_WAKE'],'REVERIE_ADMIN_PHONE_WAKE=enabled')
    def test_missing_or_nonboolean_phone_choice_refuses_before_effects(self):
        for value in ({'containerName':'reverie'},{'containerName':'reverie','adminPhoneWake':'true'}):
            self.deployment.write_text(json.dumps(value))
            with self.assertRaises(Exception):self.plan()
        self.assertFalse(self.engine.mutations())
    def test_tags_short_ids_stopped_or_stale_container_refuse(self):
        for image in ('reverie:latest','b'*12,'https://registry/image'):
            with self.assertRaises(Exception):self.stage.plan('reverie',image,OLD,OLD_IMAGE)
        with self.assertRaises(Exception):self.stage.plan('reverie',NEW_IMAGE,'bad',OLD_IMAGE)
        self.engine.containers[OLD]['State']['Running']=False
        with self.assertRaises(Exception):self.plan()
        self.assertFalse(self.engine.mutations())
    def test_moved_latest_does_not_change_target_or_admission(self):
        plan=self.plan();self.engine.images[NEW_IMAGE]['RepoTags']=['other:moved'];self.engine.images[OLD_IMAGE]['RepoTags']=[]
        result=self.apply(plan);self.assertEqual(result['newImage'],NEW_IMAGE);self.assertEqual(self.engine.containers[NEW]['Image'],NEW_IMAGE)
        self.assertFalse(any('latest' in path for method,path,data in self.engine.calls))
    def test_success_checkpoint_and_fence_precede_only_new_start(self):
        plan=self.plan();original_inputs=(self.deployment.read_bytes(),self.policy.read_bytes());guard=deepcopy(self.guard.value)
        def started(new):
            record=self.receipt();self.assertTrue(record['newStartAttempted']);self.assertEqual(record['schemaState'],'unknown');self.assertFalse(self.engine.containers[OLD]['State']['Running'])
            folder=self.state/('website-'+plan['operationId']);self.assertTrue((folder/'checkpoint.private.json').exists());self.assertTrue((folder/'website-state.private.tar').exists())
        self.engine.start_hook=started;result=self.apply(plan)
        self.assertEqual(result['state'],'adopted');self.assertFalse(self.engine.containers[OLD]['State']['Running']);self.assertIn('-before-',self.engine.containers[OLD]['Name']);self.assertEqual(self.engine.containers[NEW]['Name'],'/reverie')
        self.assertEqual(original_inputs,(self.deployment.read_bytes(),self.policy.read_bytes()));self.assertEqual(self.guard.value,guard);self.assert_no_old_restore()
        mutations=self.engine.mutations();self.assertEqual([p for m,p,d in mutations if p.endswith('/start')],['/containers/'+NEW+'/start'])
    def test_scoped_backup_covers_auth_state_and_excludes_live_accounts(self):
        plan=self.plan();self.apply(plan);folder=self.state/('website-'+plan['operationId'])
        with tarfile.open(folder/'website-state.private.tar') as archive:
            names=archive.getnames();self.assertTrue(any(name.endswith('/company.json') for name in names));self.assertTrue(any(name.endswith('/owner-auth.json') for name in names));self.assertFalse(any('accounts' in name for name in names));self.assertIn('scope-1',names)
            self.assertEqual(archive.extractfile('scope-1').read(),b'PRIVATE_OWNER_FIXTURE')
        self.assertEqual((folder/'website-state.private.tar').stat().st_mode&0o777,0o600)
    def test_post_start_failure_preserves_new_schema_stops_only_new_and_fences_retry(self):
        def started(new):(self.console/'company.json').write_text('{"version":1,"newAuthSchema":true}')
        self.engine.start_hook=started;self.stage.ready=lambda cid,spec:False;plan=self.plan()
        with self.assertRaises(website.WebsiteRefusal):self.apply(plan)
        self.assertTrue(json.loads((self.console/'company.json').read_text())['newAuthSchema']);self.assertFalse(self.engine.containers[OLD]['State']['Running']);self.assertFalse(self.engine.containers[NEW]['State']['Running']);self.assertEqual(self.receipt()['schemaState'],'unknown');self.assert_no_old_restore()
        count=len(self.engine.mutations())
        with self.assertRaises(Exception):self.apply(plan)
        self.assertEqual(len(self.engine.mutations()),count)
    def test_lost_start_response_keeps_unknown_fence_and_never_restarts_old(self):
        self.engine.start_timeout=True
        with self.assertRaises(Exception):self.apply()
        self.assertEqual(self.receipt()['state'],'unconfirmed');self.assertTrue(self.receipt()['newStartAttempted']);self.assert_no_old_restore()
    def test_lost_create_response_retains_candidate_and_old_live(self):
        self.engine.create_timeout=True
        with self.assertRaises(Exception):self.apply()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(self.engine.containers[NEW]['State']['Running']);self.assertFalse(self.receipt()['newStartAttempted']);self.assert_no_old_restore()
    def test_pre_stop_guard_drift_leaves_old_live(self):
        self.engine.after_create=lambda new:self.guard.value.update(brokerConfig='changed')
        with self.assertRaises(Exception):self.apply()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(any('/stop?' in p for m,p,d in self.engine.calls));self.assert_no_old_restore()
    def test_owner_input_drift_after_new_start_is_not_overwritten(self):
        self.engine.start_hook=lambda new:self.deployment.write_text(json.dumps({'containerName':'reverie','adminPhoneWake':True}))
        with self.assertRaises(Exception):self.apply()
        self.assertTrue(json.loads(self.deployment.read_text())['adminPhoneWake']);self.assertEqual(self.receipt()['state'],'unconfirmed');self.assert_no_old_restore()
    def test_same_instance_outer_lock_is_reentrant_other_writer_refuses(self):
        plan=self.plan();other=website.WebsiteStage(self.engine,self.state,self.deployment,self.policy,guard=self.guard,ready=lambda cid,spec:True)
        with self.stage.maintenance_lock():
            with self.assertRaises(Exception):
                with other.maintenance_lock():pass
            self.apply(plan)
        self.assertEqual(self.receipt()['state'],'adopted')
    def test_known_unsafe_restart_policy_refuses_before_effects(self):
        for policy in ('always','on-failure'):
            self.engine.containers[OLD]['HostConfig']['RestartPolicy']['Name']=policy
            with self.assertRaises(website.WebsiteRefusal):self.plan()
        self.assertFalse(self.engine.mutations())
    def test_no_restart_policy_preserved_and_retired_old_remains_stopped(self):
        self.engine.containers[OLD]['HostConfig']['RestartPolicy']['Name']='no';self.approve();self.apply()
        self.assertEqual(self.engine.containers[OLD]['HostConfig']['RestartPolicy']['Name'],'no');self.assertFalse(self.engine.containers[OLD]['State']['Running']);self.assert_no_old_restore()
    def test_missing_bind_during_create_is_not_recreated_and_old_stays_live(self):
        self.engine.before_create=lambda spec:self.workspace.rename(self.root/'workspace-preserved')
        with self.assertRaises(Exception):self.apply()
        self.assertFalse(self.workspace.exists());self.assertEqual(self.engine.recreate_attempts,0);self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(any('/stop?' in p for m,p,d in self.engine.calls))
    def test_replaced_bind_after_unstarted_create_refuses_before_old_stop(self):
        def replace(new):self.workspace.rename(self.root/'workspace-preserved');self.workspace.mkdir()
        self.engine.after_create=replace
        with self.assertRaises(Exception):self.apply()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(any('/stop?' in p for m,p,d in self.engine.calls))
    def test_static_ip_extra_network_and_coupled_layouts_refuse_before_effects(self):
        network=self.engine.containers[OLD]['NetworkSettings']['Networks']['bridge'];network['IPAMConfig']={'IPv4Address':'172.17.0.42'}
        with self.assertRaises(Exception):self.plan()
        network['IPAMConfig']=None;self.engine.containers[OLD]['HostConfig']['NetworkMode']='container:other'
        with self.assertRaises(Exception):self.plan()
        self.assertFalse(self.engine.mutations())
    def test_real_literal_goal_binding_fixture_refuses_without_mutations(self):
        p=self.console/'goal-private.json';p.write_text(json.dumps({'version':1,'serverContainerId':OLD}));p.chmod(0o600)
        self.engine.containers[OLD]['Config']['Cmd'] += ['--goal-private-config','/instances/default/console/goal-private.json']
        with self.assertRaisesRegex(website.WebsiteRefusal,'serverContainerId'):self.plan()
        self.assertFalse(self.engine.mutations());self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertEqual(json.loads(p.read_text())['serverContainerId'],OLD)
    def test_symlink_fifo_hardlink_and_broad_state_scopes_refuse_before_effects(self):
        for kind in ('symlink','fifo','hardlink'):
            path=self.console/'unsafe'
            if kind=='symlink':path.symlink_to(self.root/'outside')
            elif kind=='fifo':os.mkfifo(path)
            else:os.link(self.console/'settings.json',path)
            try:
                started=time.monotonic()
                with self.assertRaises(Exception):self.plan()
                self.assertLess(time.monotonic()-started,2)
            finally:path.unlink()
        self.assertFalse(self.engine.mutations())
    def test_forged_plan_cannot_change_host_backup_path_or_process_spec(self):
        plan=self.plan();plan['backupScopes'][0]['hostPath']=str(self.root)
        with self.assertRaises(Exception):self.apply(plan)
        self.assertFalse(self.engine.mutations())
    def test_plan_digest_and_schema_policy_exact_floors_are_required(self):
        plan=self.plan()
        with self.assertRaises(Exception):self.stage.apply(plan,'sha256:'+'0'*64)
        value=json.loads(self.policy.read_text());value['schemaFloors']=[];self.policy.write_text(json.dumps(value))
        with self.assertRaises(Exception):self.plan()
        self.assertFalse(self.engine.mutations())

    def test_target_default_enabled_cannot_override_explicit_owner_false(self):
        self.engine.images[NEW_IMAGE]['Config']['Env'].append('REVERIE_ADMIN_PHONE_WAKE=enabled')
        plan=self.approve();self.apply(plan)
        actual=website.environment(self.engine.containers[NEW]['Config']['Env'])
        self.assertEqual(actual['REVERIE_ADMIN_PHONE_WAKE'],'REVERIE_ADMIN_PHONE_WAKE=disabled')
    def test_equal_old_default_owner_value_requires_exact_spec_approval(self):
        self.engine.images[OLD_IMAGE]['Config']['Env'].append('OWNER_COLLISION=old')
        self.engine.containers[OLD]['Config']['Env'].append('OWNER_COLLISION=old')
        self.engine.images[NEW_IMAGE]['Config']['Env'].append('OWNER_COLLISION=new')
        policy=json.loads(self.policy.read_text());policy['approvedSpecDigest']=None;self.policy.write_text(json.dumps(policy))
        draft=self.plan();self.assertEqual(draft['finalSpecApproval'],'required');self.assertIn('OWNER_COLLISION',draft['environmentInference']['equalOldImageDefaults'])
        self.assertEqual(website.environment(draft['spec']['Env'])['OWNER_COLLISION'],'OWNER_COLLISION=new')
        with self.assertRaisesRegex(website.WebsiteRefusal,'final-spec'):self.apply(draft)
        self.assertFalse(self.engine.mutations())
        approved=self.approve();self.assertEqual(approved['specPin'],draft['specPin']);self.assertEqual(approved['operationId'],draft['operationId']);self.apply(approved)
    def test_control_state_outside_all_worker_and_website_grants(self):
        for exposed in (self.workspace/'control',self.data/'control'):
            self.guard.value['websiteControlBinding']['stateDirectory']=str(exposed)
            other=website.WebsiteStage(self.engine,exposed,self.deployment,self.policy,guard=self.guard,ready=lambda cid,spec:True)
            with self.assertRaisesRegex(website.WebsiteRefusal,'overlaps'):other.plan('reverie',NEW_IMAGE,OLD,OLD_IMAGE)
        self.assertFalse(self.engine.mutations())
    def test_new_state_directory_cannot_bypass_registered_resource_fence(self):
        other=website.WebsiteStage(self.engine,self.root/'other-state',self.deployment,self.policy,guard=self.guard,ready=lambda cid,spec:True)
        with self.assertRaisesRegex(website.WebsiteRefusal,'canonical resource'):other.plan('reverie',NEW_IMAGE,OLD,OLD_IMAGE)
        self.assertFalse(self.engine.mutations())
    def test_missing_qualified_grant_registration_refuses_before_lock_or_effect(self):
        self.guard.value.pop('websiteControlBinding')
        with self.assertRaises(website.WebsiteRefusal):self.plan()
        with self.assertRaises(website.WebsiteRefusal):
            with self.stage.maintenance_lock():pass
        self.assertFalse((self.root/'runtime').exists());self.assertFalse(self.engine.mutations())
    def test_autoremove_refuses_before_any_website_stop(self):
        self.engine.containers[OLD]['HostConfig']['AutoRemove']=True
        with self.assertRaises(website.WebsiteRefusal):self.plan()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(self.engine.mutations())
    def test_supported_restart_policy_keeps_retired_image_down_after_daemon_restart(self):
        self.apply();self.engine.daemon_restart();self.assertFalse(self.engine.containers[OLD]['State']['Running']);self.assertTrue(self.engine.containers[NEW]['State']['Running'])
        # Independent negative model: always would revive the manually stopped old.
        self.engine.containers[OLD]['HostConfig']['RestartPolicy']['Name']='always';self.engine.daemon_restart();self.assertTrue(self.engine.containers[OLD]['State']['Running'])
    def test_mount_readback_default_false_fields_are_safe_but_create_true_is_not(self):
        def normalized(new):
            for mount in new['HostConfig']['Mounts']:mount['BindOptions'].pop('CreateMountpoint')
        self.engine.after_create=normalized;self.apply()
        self.assertFalse(self.engine.containers[OLD]['State']['Running'])
    def test_mount_readback_cannot_enable_source_creation(self):
        self.engine.after_create=lambda new:new['HostConfig']['Mounts'][0]['BindOptions'].update(CreateMountpoint=True)
        with self.assertRaises(website.WebsiteRefusal):self.apply()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(any('/stop?' in p for m,p,d in self.engine.calls))
    def test_effective_goal_forms_and_unknown_wrapper_refuse(self):
        path=self.console/'goal-private.json';path.write_text(json.dumps({'version':1,'serverContainerId':OLD}));path.chmod(0o600)
        original=deepcopy(self.engine.containers[OLD]['Config'])
        variants=[('equals',None),('environment',None),('shell',None),('old-default-dropped',None)]
        for kind,_ in variants:
            self.engine.containers[OLD]['Config']=deepcopy(original)
            old=self.engine.containers[OLD]['Config']
            if kind=='equals':old['Cmd']+=['--goal-private-config=/instances/default/console/goal-private.json']
            elif kind=='environment':old['Env']+=['REVERIE_GOAL_PRIVATE_CONFIG=/instances/default/console/goal-private.json']
            elif kind=='shell':old['Cmd']=['/bin/sh','-c','reverie web --goal-private-config /instances/default/console/goal-private.json']
            else:
                old['Cmd']+=['--goal-private-config','/instances/default/console/goal-private.json'];self.engine.images[OLD_IMAGE]['Config']['Cmd']=deepcopy(old['Cmd'])
            with self.subTest(kind=kind),self.assertRaises(website.WebsiteRefusal):self.plan()
        self.assertFalse(self.engine.mutations());self.assertTrue(self.engine.containers[OLD]['State']['Running'])
    def test_actual_public_old_and_w2_image_defaults_are_supported(self):
        public=json.loads((ROOT/'tests/fixtures/website-image-defaults.json').read_text())
        self.engine.images[OLD_IMAGE]['Config']=deepcopy(public['oldConfig']);self.engine.images[NEW_IMAGE]['Config']=deepcopy(public['targetConfig'])
        owner=deepcopy(self.engine.containers[OLD]['Config']);cfg=deepcopy(public['oldConfig'])
        cfg.update(User=owner['User'],WorkingDir=owner['WorkingDir'],Image='reverie:latest')
        cfg['Env']+=['OWNER_OVERRIDE=kept','REVERIE_WORKER_SOCKET=/run/reverie-workers/broker.sock'];self.engine.containers[OLD]['Config']=cfg
        plan=self.approve();self.apply(plan)
        self.assertEqual(self.engine.containers[NEW]['Config']['Cmd'],public['targetConfig']['Cmd']);self.assertEqual(self.engine.containers[NEW]['Config']['Entrypoint'],public['targetConfig']['Entrypoint'])
        self.assert_no_old_restore()
    def test_selected_service_auth_and_keys_need_complete_explicit_backup(self):
        auth=self.root/'auth';auth.mkdir(mode=0o700);cfg=auth/'service-auth.json';key=auth/'key';key.write_text('SYNTHETIC_SERVICE_KEY');key.chmod(0o600)
        cfg.write_text(json.dumps({'version':1,'purposes':{},'principals':[{'principal':'ops','epoch':'fixture','key':'/auth/key'}]}));cfg.chmod(0o600)
        mount={'Type':'bind','Source':str(auth),'Destination':'/auth','RW':False,'Propagation':'rprivate','Mode':'ro'}
        old=self.engine.containers[OLD];old['Mounts'].append(mount);old['HostConfig']['Binds'].append(str(auth)+':/auth:ro');old['Config']['Cmd']+=['--service-auth-config','/auth/service-auth.json']
        with self.assertRaises(website.WebsiteRefusal):self.plan()
        policy=json.loads(self.policy.read_text());policy['backupScopes'] += [{'containerPath':'/auth/service-auth.json','exclude':[]},{'containerPath':'/auth/key','exclude':[]}];self.policy.write_text(json.dumps(policy))
        plan=self.approve();self.apply(plan)
        folder=self.state/('website-'+plan['operationId'])
        with tarfile.open(folder/'website-state.private.tar') as archive:self.assertEqual(archive.extractfile('scope-3').read(),b'SYNTHETIC_SERVICE_KEY')


    def next_plan(self):
        target='sha256:'+'d'*64
        self.engine.images[target]=deepcopy(self.engine.images[NEW_IMAGE]);self.engine.images[target]['Id']=target
        review=json.loads(self.policy.read_text());review.update(reviewId='next-forward-review',oldImage=NEW_IMAGE,newImage=target,approvedSpecDigest=None);self.policy.write_text(json.dumps(review))
        draft=self.stage.plan('reverie',target,NEW,NEW_IMAGE);review['approvedSpecDigest']=draft['specPin'];self.policy.write_text(json.dumps(review))
        return self.stage.plan('reverie',target,NEW,NEW_IMAGE)

    def test_partial_contradictory_active_history_refuses_before_engine_effect(self):
        self.state.mkdir(mode=0o700);active=self.state/'website-active.json'
        for value in ({'state':'adopted','newId':OLD,'newImage':OLD_IMAGE},{'state':'adopted','newId':OLD,'newImage':OLD_IMAGE,'schemaState':'unknown','automaticOldImageRollback':True}):
            active.write_text(json.dumps(value));active.chmod(0o600)
            with self.assertRaises(website.WebsiteRefusal):self.plan()
        self.assertFalse(self.engine.mutations());self.assertTrue(self.engine.containers[OLD]['State']['Running'])

    def test_valid_complete_adopted_history_allows_next_reviewed_candidate(self):
        self.apply();plan=self.next_plan()
        with patch(__name__+'.NEW','3'*64):result=self.stage.apply(plan,website.digest(plan))
        self.assertEqual(result['state'],'adopted');self.assertEqual(result['newImage'],plan['newImage']);self.assert_no_old_restore()

    def test_historical_plan_receipt_manifest_archive_tampering_all_hold(self):
        kinds=('operation-receipt','boolean-operation-version','plan','checkpoint','archive','schema','unknown-field')
        for kind in kinds:
            with self.subTest(kind=kind):
                fixture=WebsiteStageTests();fixture.setUp()
                try:
                    receipt=fixture.apply();op=fixture.state/('website-'+receipt['operationId']);active=fixture.state/'website-active.json'
                    if kind=='operation-receipt':(op/'receipt.private.json').write_text('{}')
                    elif kind=='boolean-operation-version':
                        value=dict(receipt,version=True);(op/'receipt.private.json').write_text(json.dumps(value))
                    elif kind=='plan':(op/'plan.private.json').write_text('{}')
                    elif kind=='checkpoint':(op/'checkpoint.private.json').write_text('{}')
                    elif kind=='archive':(op/'website-state.private.tar').write_bytes(b'partial')
                    elif kind=='schema':
                        value=dict(receipt,schemaState='unknown');active.write_text(json.dumps(value));(op/'receipt.private.json').write_text(json.dumps(value))
                    else:
                        value=dict(receipt,unknown='field');active.write_text(json.dumps(value));(op/'receipt.private.json').write_text(json.dumps(value))
                    fixture.engine.calls.clear()
                    with self.assertRaises(website.WebsiteRefusal):fixture.next_plan()
                    self.assertFalse(fixture.engine.mutations())
                finally:fixture.doCleanups()

    def test_checkpoint_global_snapshot_refuses_earlier_file_changed_after_copy(self):
        plan=self.plan();a=self.console/'.env';b=self.console/'state.json';a.write_text('A0');b.write_text('B0');original=os.open;changed=[False]
        def mutate(path,*args,**kwargs):
            if path=='company.json' and kwargs.get('dir_fd') is not None and not changed[0]:changed[0]=True;a.write_text('A1');b.write_text('B1')
            return original(path,*args,**kwargs)
        with patch.object(website.os,'open',mutate),self.assertRaises(website.WebsiteRefusal):website.checkpoint(plan['backupScopes'],self.root/'mixed.tar')
        self.assertTrue(changed[0])

    def test_checkpoint_final_global_snapshot_refuses_mutation_after_earlier_copy(self):
        plan=self.plan();a=self.console/'.env';a.write_text('A0');original=os.open;count=[0]
        def mutate(path,*args,**kwargs):
            if path=='company.json' and kwargs.get('dir_fd') is not None:
                count[0]+=1
                if count[0]==2:a.write_text('A1')  # After the complete initial scan and .env copy.
            return original(path,*args,**kwargs)
        with patch.object(website.os,'open',mutate),self.assertRaises(website.WebsiteRefusal):website.checkpoint(plan['backupScopes'],self.root/'mixed-after-copy.tar')
        self.assertGreaterEqual(count[0],2)

    def test_checkpoint_directory_and_root_replacement_refuse(self):
        plan=self.plan();initial=website.tree_snapshot;calls=[0]
        def mutate(scopes,**kwargs):
            calls[0]+=1
            if calls[0]==2:(self.console/'added').write_text('new')
            return initial(scopes,**kwargs)
        with patch.object(website,'tree_snapshot',mutate),self.assertRaises(website.WebsiteRefusal):website.checkpoint(plan['backupScopes'],self.root/'directory-change.tar')

    def test_directory_inventory_bound_applies_before_sorting_or_copy(self):
        plan=self.plan()
        for i in range(30):(self.console/('extra-'+str(i))).write_text('x')
        with patch.object(website,'MAX_FILES',10):
            with self.assertRaises(website.WebsiteRefusal):website.validate_layout(plan['backupScopes'])
            with self.assertRaises(website.WebsiteRefusal):website.checkpoint(plan['backupScopes'],self.root/'bounded.tar')
        self.assertFalse(self.engine.mutations())

    def test_custody_port_is_required_and_exactly_bound_not_boolean(self):
        original=self.guard.admit_control_custody
        for port in (None,lambda *a:True,lambda *a:None,lambda *a:{'bindingDigest':'sha256:'+'0'*64,'controlPathsDigest':'sha256:'+'0'*64,'sourcePathsDigest':'sha256:'+'0'*64,'evidenceDigest':'sha256:'+'0'*64}):
            self.guard.admit_control_custody=port
            with self.assertRaises(website.WebsiteRefusal):self.plan()
        self.guard.admit_control_custody=original;self.assertEqual(self.plan()['finalSpecApproval'],'approved');self.assertFalse(self.engine.mutations())

    def test_empty_data_environment_uses_tracked_shell_default(self):
        self.engine.containers[OLD]['Config']['Env']+=['REVERIE_DATA=','REVERIE_DATA_DIR=']
        plan=self.approve();self.assertEqual(plan['backupScopes'][0]['containerPath'],'/instances/default/console');self.apply(plan)


    def test_checkpoint_global_root_inode_replacement_refuses(self):
        plan=self.plan();original=website.tree_snapshot;calls=[0]
        def replace_root(scopes,**kwargs):
            calls[0]+=1
            if calls[0]==2:
                self.console.rename(self.data/'retained-console');self.console.mkdir(mode=0o700)
            return original(scopes,**kwargs)
        with patch.object(website,'tree_snapshot',replace_root),self.assertRaises(website.WebsiteRefusal):website.checkpoint(plan['backupScopes'],self.root/'root-change.tar')

    def test_custody_provider_is_rechecked_before_old_stop(self):
        original=self.guard.admit_control_custody;blocked=[False]
        def admit(*args):
            if blocked[0]:raise website.WebsiteRefusal('Fixture topology admission unavailable')
            return original(*args)
        self.guard.admit_control_custody=admit;self.engine.after_create=lambda candidate:blocked.__setitem__(0,True)
        with self.assertRaises(website.WebsiteRefusal):self.apply()
        self.assertTrue(self.engine.containers[OLD]['State']['Running']);self.assertFalse(any('/stop?' in path for _,path,_ in self.engine.calls))


    def test_missing_shared_custody_codec_is_explicitly_unavailable(self):
        with patch.object(website,'custody_digests',None),self.assertRaisesRegex(website.WebsiteRefusal,'codec unavailable'):self.plan()
        self.assertFalse(self.engine.mutations());self.assertFalse(self.state.exists())


    def test_control_parent_durability_failure_keeps_old_live_before_create(self):
        original=os.fsync;parent=self.state.parent.stat()
        def fail_parent(fd):
            info=os.fstat(fd)
            if (info.st_dev,info.st_ino)==(parent.st_dev,parent.st_ino):raise OSError('Owned parent durability failure')
            return original(fd)
        with patch.object(website.os,'fsync',fail_parent),self.assertRaises(OSError):self.apply()
        self.assertFalse(self.engine.mutations());self.assertTrue(self.engine.containers[OLD]['State']['Running'])


    def test_historical_archive_is_pinned_across_hash_and_member_validation(self):
        receipt=self.apply();plan=self.next_plan();archive=self.state/('website-'+receipt['operationId'])/'website-state.private.tar';identity=archive.stat();original=website.hash_fd;changed=[False]
        def mutate_after_hash(fd,**kwargs):
            value=original(fd,**kwargs);info=os.fstat(fd)
            if (info.st_dev,info.st_ino)==(identity.st_dev,identity.st_ino) and not changed[0]:
                raw=bytearray(archive.read_bytes());raw[100:108]=b'0000600\0';raw[148:156]=b'        ';raw[148:156]=(format(sum(raw[:512]),'06o')+'\0 ').encode();archive.write_bytes(raw);changed[0]=True
            return value
        self.engine.calls.clear()
        with patch.object(website,'hash_fd',mutate_after_hash),self.assertRaises(website.WebsiteRefusal):self.stage.apply(plan,website.digest(plan))
        self.assertTrue(changed[0]);self.assertFalse(self.engine.mutations())
