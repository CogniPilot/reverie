"""Release reference/ordering controls using an empty, owned fake image store."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tests import executable_script

ROOT=Path(__file__).resolve().parents[1]
HELPER=ROOT/'scripts/release-image.sh'
SETUP=ROOT/'scripts/setup.sh'
IMAGE='sha256:'+'a'*64
COMMIT='b'*40


class ReleaseImage(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.bundle=self.root/'bundle';self.bundle.mkdir()
        (self.bundle/'reverie-image.tar').write_bytes(b'owned synthetic archive')
        self.log=self.root/'calls.jsonl';self.state=self.root/'state.json'
        self.engine=self.root/'engine'
        self.engine.write_text(executable_script('''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:];p=Path(os.environ['TEST_ENGINE_STATE'])
s=json.loads(p.read_text()) if p.exists() else {}
with open(os.environ['TEST_ENGINE_LOG'],'a') as f:f.write(json.dumps(a)+'\\n')
if a[0]=='load':
 i=os.environ['LOADED_ID'];s[i]=i;s['ghcr.io/jgoppert/reverie:latest']=i
elif a==['image','ls','--all','--quiet','--no-trunc']:
 if os.environ.get('INVENTORY_FAIL'):sys.exit(1)
 print(os.environ.get('INVENTORY_OUTPUT','\\n'.join(sorted(set(s.values())))))
elif a[:2]==['image','inspect']:
 if a[-1] not in s:sys.exit(1)
 print(s[a[-1]])
elif a[0]=='tag':
 if a[1] not in s:sys.exit(1)
 s[a[2]]=s[a[1]]
else:raise AssertionError('Forbidden engine operation')
p.write_text(json.dumps(s))
'''));self.engine.chmod(0o755)
        self.metadata()

    def run_script(self,script,*args,values=None):
        env={**os.environ,'TEST_ENGINE_LOG':str(self.log),'TEST_ENGINE_STATE':str(self.state),'LOADED_ID':IMAGE,**(values or {})}
        return subprocess.run(['bash',str(script),*map(str,args)],env=env,text=True,capture_output=True,timeout=10)

    def metadata(self,owner='CogniPilot'):
        result=self.run_script(HELPER,'metadata',owner,'0.3.0',COMMIT,IMAGE)
        self.assertEqual(result.returncode,0,result.stderr)
        (self.bundle/'IMAGE-REF.txt').write_text(result.stdout)
        return result.stdout

    def load(self,script=HELPER,**kwargs):
        return self.run_script(script,'load',self.engine,self.bundle,'CogniPilot','0.3.0',COMMIT,**kwargs)

    def calls(self):return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_single_policy_normalizes_owner_and_is_standalone(self):
        for args in [[],['CogniPilot'],['COGNIPILOT']]:
            result=self.run_script(SETUP,'--print-image-repository',*args)
            self.assertEqual((result.returncode,result.stdout),(0,'ghcr.io/cognipilot/reverie\n'))
        standalone=self.root/'setup.sh';shutil.copyfile(SETUP,standalone)
        self.assertEqual(self.run_script(standalone,'--print-image-repository','Other-Owner').stdout,
                         'ghcr.io/other-owner/reverie\n')
        for owner in ['','-bad','a/b','a b','$(false)','A'*40]:
            self.assertNotEqual(self.run_script(SETUP,'--print-image-repository',owner).returncode,0)
        self.assertEqual(self.calls(),[])

    def test_metadata_binds_namespace_version_commit_and_immutable_id(self):
        self.assertEqual(self.metadata(),'Version: 0.3.0\nCommit: '+COMMIT+'\nImage-ID: '+IMAGE+
            '\nRepository: ghcr.io/cognipilot/reverie\nTags: ghcr.io/cognipilot/reverie:latest ghcr.io/cognipilot/reverie:0.3.0\n')

    def test_clean_store_verifies_id_then_explicit_aliases_before_name_inspect(self):
        result=self.load();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),IMAGE)
        calls=self.calls();self.assertEqual(calls[0],['image','ls','--all','--quiet','--no-trunc'])
        self.assertEqual(calls[1][0],'load')
        self.assertEqual(calls[2],['image','inspect','--format','{{.Id}}',IMAGE])
        for ref in ['ghcr.io/cognipilot/reverie:latest','ghcr.io/cognipilot/reverie:0.3.0']:
            tag=calls.index(['tag',IMAGE,ref]);inspect=calls.index(['image','inspect','--format','{{.Id}}',ref])
            self.assertLess(2,tag);self.assertLess(tag,inspect)
        self.assertEqual(set(c[0] for c in calls),{'load','image','tag'})

    def test_cached_expected_id_and_different_archive_refuse_before_load_or_retag(self):
        self.state.write_text(json.dumps({IMAGE:IMAGE}))
        result=self.load(values={'LOADED_ID':'sha256:'+'c'*64})
        self.assertNotEqual(result.returncode,0)
        self.assertIn('clean-loader precondition refused',result.stderr)
        self.assertEqual(self.calls(),[['image','ls','--all','--quiet','--no-trunc']])
        self.assertEqual(json.loads(self.state.read_text()),{IMAGE:IMAGE})

    def test_failed_or_malformed_inventory_never_means_absent(self):
        for values in [{'INVENTORY_FAIL':'1'},{'INVENTORY_OUTPUT':'unqualified'}]:
            self.log.unlink(missing_ok=True)
            self.assertNotEqual(self.load(values=values).returncode,0)
            self.assertEqual(self.calls(),[['image','ls','--all','--quiet','--no-trunc']])

    def test_split_namespace_metadata_mutant_refuses_before_load(self):
        self.metadata('jgoppert');result=self.load()
        self.assertNotEqual(result.returncode,0);self.assertIn('repository mismatch',result.stderr)
        self.assertEqual(self.calls(),[])

    def test_wrong_loaded_id_never_creates_aliases(self):
        result=self.load(values={'LOADED_ID':'sha256:'+'c'*64})
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(c[0]=='tag' for c in self.calls()))

    def test_incoherent_version_commit_tags_or_duplicate_field_refuse_before_load(self):
        original=self.metadata()
        for modified in [original.replace('Version: 0.3.0','Version: 0.2.0'),
                         original.replace(COMMIT,'d'*40),
                         original.replace('Tags: ghcr.io/cognipilot','Tags: ghcr.io/other'),
                         original+'Repository: ghcr.io/cognipilot/reverie\n']:
            with self.subTest(metadata=modified):
                (self.bundle/'IMAGE-REF.txt').write_text(modified)
                self.assertNotEqual(self.load().returncode,0);self.assertEqual(self.calls(),[])

    def test_inspect_before_alias_mutant_is_caught_on_clean_store(self):
        mutant=self.root/'release-image.sh';shutil.copyfile(SETUP,self.root/'setup.sh')
        text=HELPER.read_text();needle='      "$engine" tag "$image_id" "$reference"'
        self.assertIn(needle,text)
        mutant.write_text(text.replace(needle,'      "$engine" image inspect --format \'{{.Id}}\' "$reference"\n'+needle))
        self.assertNotEqual(self.load(mutant).returncode,0)
        self.assertFalse(any(c[0]=='tag' for c in self.calls()))

    def test_workflow_uses_policy_for_all_artifact_consumers_and_keeps_outcomes_separate(self):
        workflow=(ROOT/'.github/workflows/image.yml').read_text()
        self.assertNotIn('ghcr.io/jgoppert/reverie',workflow)
        self.assertNotIn('IMAGE: ghcr.io/${{ github.repository_owner }}',workflow)
        self.assertEqual(workflow.count('bash scripts/release-image.sh load docker'),2)
        self.assertIn('bash scripts/release-image.sh metadata "$GITHUB_REPOSITORY_OWNER"',workflow)
        self.assertIn('docker save "$image:latest" "$image:$version"',workflow)
        publisher=workflow.split('\n  publish-image:',1)[1].split('\n  release-assets:',1)[0]
        assets=workflow.split('\n  release-assets:',1)[1]
        self.assertIn('Image publication verified:',publisher)
        self.assertIn('needs: [image, debian-install, worker-browser]',assets)
        self.assertNotIn('needs: [publish-image',assets)
        self.assertIn('see publish-image separately for GHCR status',assets)

    def test_current_guides_match_standalone_policy_and_preserve_explicit_legacy_scope(self):
        repository=self.run_script(SETUP,'--print-image-repository').stdout.strip()
        for name in ['docs/INSTALL.md','docs/image.md','docs/offline-install.md']:
            self.assertIn(repository,(ROOT/name).read_text())
        install=(ROOT/'docs/INSTALL.md').read_text()
        self.assertEqual(install.count('```bash\n'),2)  # Debian CI runs these actual blocks.
        self.assertIn('Repository: //p',install)
        current,historical=install.split('Older released bundles',1)
        self.assertNotIn('ghcr.io/jgoppert/reverie',current)
        self.assertIn('--image ghcr.io/jgoppert/reverie',historical)
        self.assertIn('--version 0.3.0',(ROOT/'README.md').read_text())
