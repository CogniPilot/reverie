import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from reverie import worker_docker as docker
from tests import test_worker as fixture
from reverie.worker import account_mounts

ROOT=Path(__file__).resolve().parents[1]


class WorkerDockerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='docker-policy-');self.root=Path(self.temp.name)
        self.file=self.root/'profile.json';self.file.write_text(json.dumps({'defaultAction':'SCMP_ACT_ERRNO','syscalls':[]}));self.file.chmod(0o444)
        self.cfg={'uid':os.getuid(),'gid':os.getgid(),'rootlessDocker':{'enabled':True,'seccompProfile':'/nix/store/fixture-profile',
            'seccompSha256':hashlib.sha256(self.file.read_bytes()).hexdigest()}}
        target=self.file
        class NixLocation:
            def __init__(self,value):self.value=value
            def is_absolute(self):return self.value.startswith('/')
            def __str__(self):return self.value
            def resolve(self,strict=False):return self
            def __eq__(self,other):return str(self)==str(other)
            def stat(self):return target.stat()
            def read_bytes(self):return target.read_bytes()
        self.location=NixLocation

    def tearDown(self):self.temp.cleanup()

    def test_default_is_exact_existing_no_capability_grant(self):
        self.assertFalse(docker.enabled({}));self.assertEqual(docker.runtime_args({}),[])
        self.assertEqual(docker.security_args({}),['--cap-drop','ALL','--security-opt','no-new-privileges'])

    def test_broker_config_and_create_args_apply_the_explicit_docker_policy(self):
        f=fixture.WorkerTests();f.setUp();self.addCleanup(f.doCleanups)
        config=dict(f.config,rootlessDocker=self.cfg['rootlessDocker'])
        with patch.object(docker,'Path',self.location):
            self.assertEqual(f.load(config),config)
            _,_,args=fixture.create_args(config,fixture.SID,f.root/'home')
        self.assertNotIn('no-new-privileges',args)
        self.assertEqual([args[i+1] for i,value in enumerate(args[:-1]) if value=='--cap-add'],['SETUID','SETGID'])
        self.assertIn('DOCKER_HOST=unix:///run/reverie-docker/docker.sock',args)
        self.assertIn('seccomp=/nix/store/fixture-profile',args)
        config['rootlessDocker']=True
        with self.assertRaises(ValueError):f.load(config)

    def test_invalid_toggle_and_non_nix_path_refuse(self):
        for value in (True,'yes',{'enabled':1},{'enabled':True,'seccompProfile':str(self.file),'seccompSha256':'0'*64}):
            with self.subTest(value=value):self.assertRaises(ValueError,docker.enabled,{'uid':os.getuid(),'gid':os.getgid(),'rootlessDocker':value})

    def test_actual_account_arg_builder_refuses_nested_alias_targets_before_engine_use(self):
        f=fixture.WorkerTests();f.setUp();self.addCleanup(f.doCleanups)
        config=dict(f.config,rootlessDocker=self.cfg['rootlessDocker'])
        account=Path(config['companyRoot'])/'console/accounts/selected'
        (account/'nested').mkdir(parents=True)
        environment={'CODEX_HOME':'/instances/default/console/accounts/selected'}
        with patch.object(docker,'Path',self.location):
            args=account_mounts(config,environment)
            self.assertIn('type=bind,src='+str(account)+',dst='+environment['CODEX_HOME'],args)
            with self.assertRaises(ValueError):
                account_mounts(config,dict(environment,XDG_DATA_HOME=environment['CODEX_HOME']+'/nested'))

    def test_single_user_nix_owner_readonly_profile_accepted_but_write_or_hash_change_refuses(self):
        # Only the store-location mapping is synthetic; actual file ownership,
        # permission changes and bytes/hash are real. No global Nix writes.
        with patch.object(docker,'Path',self.location):
            self.assertTrue(docker.enabled(self.cfg))
            self.file.chmod(0o666);self.assertRaises(ValueError,docker.enabled,self.cfg)
            self.file.chmod(0o600);self.file.write_text('{}');self.file.chmod(0o444);self.assertRaises(ValueError,docker.enabled,self.cfg)

    def test_host_keyring_and_bpf_grants_refuse(self):
        for name in ('keyctl','add_key','request_key','bpf','perf_event_open'):
            self.file.chmod(0o600);self.file.write_text(json.dumps({'defaultAction':'SCMP_ACT_ERRNO','syscalls':[{'names':[name],'action':'SCMP_ACT_ALLOW'}]}));self.file.chmod(0o444)
            self.cfg['rootlessDocker']['seccompSha256']=hashlib.sha256(self.file.read_bytes()).hexdigest()
            with patch.object(docker,'Path',self.location):self.assertRaises(ValueError,docker.enabled,self.cfg)

    def test_nonroot_two_caps_private_runtime_and_no_host_socket(self):
        with patch.object(docker,'enabled',return_value=True):
            args=docker.security_args(self.cfg);runtime=docker.runtime_args(self.cfg)
        self.assertEqual([args[i+1] for i,value in enumerate(args[:-1]) if value=='--cap-add'],['SETUID','SETGID'])
        self.assertNotIn('--privileged',args);self.assertNotIn('SYS_ADMIN',args)
        self.assertIn('/dev/net/tun:/dev/net/tun:rw',args)
        self.assertIn('XDG_RUNTIME_DIR=/run/reverie-docker',runtime)
        self.assertIn('DOCKER_HOST=unix:///run/reverie-docker/docker.sock',runtime)
        self.assertFalse(any('/var/run/docker.sock' in value or '/scratch' in value for value in runtime))

    def test_image_identity_and_actual_host_subordinate_grants_are_mandatory(self):
        labels={docker.FEATURE_LABEL:'1',docker.UID_LABEL:str(os.getuid()),docker.GID_LABEL:str(os.getgid()),
            docker.LAYOUT_LABEL:'1',
            'org.reverie.worker.subuid-start':'100000','org.reverie.worker.subgid-start':'100000','org.reverie.worker.subid-count':'65536'}
        image={'Config':{'User':f'{os.getuid()}:{os.getgid()}','Labels':labels}}
        with patch.object(docker,'enabled',return_value=True),patch.object(docker,'host_grants',return_value=[(100000,65536)]):
            docker.require_image(self.cfg,image)
            image['Config']['User']='0:0';self.assertRaises(ValueError,docker.require_image,self.cfg,image)
            image['Config']['User']=f'{os.getuid()}:{os.getgid()}';labels[docker.FEATURE_LABEL]='0';self.assertRaises(ValueError,docker.require_image,self.cfg,image)
        labels[docker.FEATURE_LABEL]='1'
        with patch.object(docker,'enabled',return_value=True),patch.object(docker,'host_grants',return_value=[]):
            self.assertRaises(ValueError,docker.require_image,self.cfg,image)

    def test_root_and_outside_subordinate_ranges_never_grant(self):
        self.assertFalse(docker.granted([(0,200000)],0,65536))
        self.assertFalse(docker.granted([(100000,65536)],99999,65536))
        self.assertFalse(docker.granted([(100000,65536)],100001,65536))
        self.assertTrue(docker.granted([(100000,131072)],100001,65536))

    def test_absent_host_grants_report_unavailable_without_creating_files(self):
        target=self.root/'absent-subuid'
        with self.assertRaisesRegex(ValueError,'capability unavailable'):
            docker.host_grants(target,os.getuid())
        self.assertFalse(target.exists())

    def test_even_readonly_mounts_cannot_replace_identity_helpers_or_plugin_fallback(self):
        for destination in ('/', '/etc', '/etc/passwd', '/etc/group', '/etc/subuid', '/etc/subgid',
                '/etc/nsswitch.conf', '/etc/ld.so.preload', '/opt', '/opt/reverie-idmap',
                '/opt/reverie-idmap/lib/libc.so.6', '/opt/idmap/fake/lib/gconv', '/bin', '/bin/newuidmap',
                '//etc/passwd', '/etc/../etc/passwd'):
            self.cfg['mounts']=[{'source':'/owner/selected', 'destination':destination, 'readOnly':True}]
            with self.subTest(destination=destination),patch.object(docker,'Path',self.location):
                self.assertRaises(ValueError,docker.enabled,self.cfg)
        self.cfg['mounts']=[{'source':'/owner/selected','destination':'/projects/example','readOnly':False}]
        with patch.object(docker,'Path',self.location):self.assertTrue(docker.enabled(self.cfg))

    def test_aliasing_bind_views_and_image_symlink_targets_refuse(self):
        project=self.root/'project';project.mkdir();(project/'alias').symlink_to('/etc',target_is_directory=True)
        marker=project/'passwd';marker.write_text('synthetic override')
        self.cfg['mounts']=[{'source':str(project),'destination':'/projects','readOnly':False},
            {'source':str(marker),'destination':'/projects/alias/passwd','readOnly':True}]
        with patch.object(docker,'Path',self.location):self.assertRaises(ValueError,docker.enabled,self.cfg)
        # Both slots are individually supported; together the child can follow
        # attacker-controlled aliases in the first mounted view.
        self.cfg['mounts'][1]['destination']='/projects/child'
        with patch.object(docker,'Path',self.location):self.assertRaisesRegex(ValueError,'overlap',docker.enabled,self.cfg)
        for target in ('/etc/ssl/certs/alias','/home/agent/alias','/nix/store/alias','/scratch/alias',
                '/tmp/alias','/opt/reverie-source','/instances/default/accounts/alias'):
            self.cfg['mounts']=[{'source':str(project),'destination':target,'readOnly':True}]
            with self.subTest(target=target),patch.object(docker,'Path',self.location):self.assertRaises(ValueError,docker.enabled,self.cfg)

    def test_current_plain_slots_and_readonly_rules(self):
        readonly=('/host-published','/instances/default/tools','/instances/default/console/statusline-exporter.sh','/run/reverie-model')
        self.cfg['mounts']=[{'source':'/owner/selected','destination':value,'readOnly':True} for value in readonly]
        self.cfg['mounts'] += [{'source':'/owner/project','destination':'/projects/example','readOnly':False},
            {'source':'/owner/shared','destination':'/reverie_workspace','readOnly':False}]
        with patch.object(docker,'Path',self.location):self.assertTrue(docker.enabled(self.cfg))
        for target in readonly:
            self.cfg['mounts']=[{'source':'/owner/selected','destination':target,'readOnly':False}]
            with self.subTest(target=target),patch.object(docker,'Path',self.location):self.assertRaises(ValueError,docker.enabled,self.cfg)

    def test_dynamic_accounts_are_disjoint_plain_slots_not_parent_views(self):
        self.cfg['mounts']=[{'source':'/owner/tools','destination':'/instances/default/tools','readOnly':True}]
        values=['/instances/default/accounts/claude','/instances/default/console/accounts/openai-fixture']
        with patch.object(docker,'Path',self.location):docker.require_account_mounts(self.cfg,values)
        for values in (['/instances/default/accounts'],['/home/agent/.codex'],['//instances/default/accounts/a'],
                ['/instances/default/accounts/a','/instances/default/accounts/a/child'],
                ['/instances/default/accounts/a','/instances/default/accounts/a']):
            with self.subTest(values=values),patch.object(docker,'Path',self.location):self.assertRaises(ValueError,docker.require_account_mounts,self.cfg,values)

    def test_old_capability_image_without_plain_namespace_guarantee_refuses(self):
        labels={docker.FEATURE_LABEL:'1',docker.UID_LABEL:str(os.getuid()),docker.GID_LABEL:str(os.getgid())}
        with patch.object(docker,'enabled',return_value=True):
            self.assertRaises(ValueError,docker.require_image,self.cfg,{'Config':{'User':f'{os.getuid()}:{os.getgid()}','Labels':labels}})

    def test_runc_wrapper_changes_only_create_run_not_argument_values(self):
        capture=self.root/'argv.json'
        fake=self.root/'fake-runc';fake.write_text('#!'+sys.executable+'\nimport json,sys\nfrom pathlib import Path\nPath('+repr(str(capture))+').write_text(json.dumps(sys.argv[1:]))\n');fake.chmod(0o700)
        wrapper=self.root/'runc';wrapper.write_text((ROOT/'scripts/reverie-rootless-runc').read_text().replace('@RUNC@',str(fake)));wrapper.chmod(0o700)
        for args,wanted in [(['--root','/data','run','id'],['--root','/data','run','--no-new-keyring','id']),
            (['--log','run','create','id'],['--log','run','create','--no-new-keyring','id']),(['exec','id','/bin/sh'],['exec','id','/bin/sh'])]:
            subprocess.run(['bash',str(wrapper),*args],check=True,timeout=2)
            self.assertEqual(json.loads(capture.read_text()),wanted)


if __name__=='__main__':unittest.main()
