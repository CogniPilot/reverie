import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from reverie.github_credentials import install

TOKEN = b'SYNTHETIC_GITHUB_CREDENTIAL_FOR_PRIVATE_FIXTURE_ONLY'
SIDS = ['11111111-2222-4333-8444-555555555555', '22222222-2222-4333-8444-555555555555']

class GithubCredentialInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name);self.state = self.root/'runtime/workers'
        self.company = self.root/'company.json';self.company.write_text(json.dumps({'employees': [{'id': 'e'+str(i), 'sessionId': sid} for i,sid in enumerate(SIDS)]}))
        for sid in SIDS:(self.state/sid/'home').mkdir(parents=True)
        config = self.root/'runtime/worker-isolation/broker.json';config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'stateRoot': str(self.state), 'companyFile': str(self.company), 'mounts': [{'source': str(self.root/'shared')}] }));config.chmod(0o600)
        self.source = self.root/'source.token';self.source.write_bytes(TOKEN);self.source.chmod(0o600)
        self.environment = patch.dict(os.environ, {'REVERIE_MUX': '', 'REVERIE_CONTAINER': ''});self.environment.start();self.addCleanup(self.environment.stop)

    def folder(self, index=0):return self.state/SIDS[index]/'home/.config/reverie/credentials/github'
    def run_install(self, **kwargs):return install(self.root, 'cognipilot', self.source, ['e0'], ['ExampleOrg/project'], **kwargs)

    def test_explicit_binding_private_modes_scope_metadata_and_no_other_laptop(self):
        report=self.run_install()
        for folder in (self.root/'credentials/github', self.folder()):
            self.assertEqual((folder/'cognipilot.token').read_bytes(), TOKEN+b'\n')
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
            self.assertEqual((folder/'cognipilot.token').stat().st_mode & 0o777, 0o600)
            metadata=(folder/'cognipilot.json').read_text()
            self.assertIn('ExampleOrg/project', metadata);self.assertNotIn(TOKEN.decode(), metadata)
        self.assertFalse(self.folder(1).exists())
        self.assertNotIn(TOKEN.decode(), json.dumps(report));self.assertFalse(report['tokenPrinted'])

    def test_same_binding_is_idempotent_and_rotation_requires_explicit_replace(self):
        self.run_install();path=self.folder()/'cognipilot.token';inode=path.stat().st_ino
        self.run_install();self.assertEqual(path.stat().st_ino,inode)
        self.source.write_bytes(b'SYNTHETIC_REPLACEMENT_CREDENTIAL_VALUE')
        with self.assertRaises(ValueError):self.run_install()
        self.assertEqual(path.read_bytes(),TOKEN+b'\n')
        self.run_install(replace=True);self.assertIn(b'REPLACEMENT',path.read_bytes())

    def test_alias_source_target_and_parent_refuse_without_external_write(self):
        alias=self.root/'alias.token';alias.symlink_to(self.source)
        with self.assertRaises(OSError):install(self.root,'cognipilot',alias,['e0'],[])
        outside=self.root/'outside';outside.mkdir();(outside/'marker').write_text('preserve')
        (self.state/SIDS[0]/'home/.config').symlink_to(outside)
        with self.assertRaises(OSError):self.run_install()
        self.assertEqual((outside/'marker').read_text(),'preserve');self.assertFalse((outside/'reverie').exists())

    def test_all_existing_targets_preflight_before_any_token_copy(self):
        target=self.folder(1);target.mkdir(mode=0o700,parents=True)
        existing=target/'cognipilot.token';existing.write_bytes(b'DIFFERENT_SYNTHETIC_EXISTING_CREDENTIAL');existing.chmod(0o600)
        with self.assertRaises(ValueError):install(self.root,'cognipilot',self.source,['e0','e1'],[])
        self.assertFalse((self.folder()/'cognipilot.token').exists())
        self.assertFalse((self.root/'credentials/github/cognipilot.token').exists())

    def test_laptop_invocation_and_unknown_employee_refuse(self):
        with patch.dict(os.environ, {'REVERIE_MUX':'1'}):
            with self.assertRaises(ValueError):self.run_install()
        with self.assertRaises(ValueError):install(self.root,'cognipilot',self.source,['missing'],[])
        self.assertFalse((self.root/'credentials').exists())

    def test_unsafe_input_modes_and_shared_home_custody_refuse(self):
        self.source.chmod(0o644)
        with self.assertRaises(ValueError):self.run_install()
        self.source.chmod(0o600)
        config=self.root/'runtime/worker-isolation/broker.json';value=json.loads(config.read_text());value['mounts']=[{'source':str(self.state)}];config.write_text(json.dumps(value))
        with self.assertRaises(ValueError):self.run_install()
        self.assertFalse((self.root/'credentials').exists())
