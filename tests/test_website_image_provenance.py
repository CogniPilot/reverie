"""Synthetic archive controls only; no image load, process launch or host state."""
import hashlib
import copy
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch
from reverie import website_image_provenance as P


class ArchiveProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='image-provenance-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def image(self, *, raw=None, manifest=None, config_name=None, layers=True, duplicate=False,
              config_link=False, unsafe=False):
        raw = raw or json.dumps({'architecture': 'amd64', 'os': 'linux', 'created': '1970-01-01T00:00:01Z',
                                'config': {'User': '2000', 'Cmd': ['fixed']},
                                'rootfs': {'type': 'layers', 'diff_ids': ['sha256:'+'a'*64]}}).encode()
        name = config_name or hashlib.sha256(raw).hexdigest()+'.json'
        manifest = manifest if manifest is not None else [{'Config': name, 'RepoTags': ['synthetic:fixed'], 'Layers': ['layer/layer.tar']}]
        output = self.root/'image.tar'
        with tarfile.open(output, 'w') as archive:
            def add(name, data, link=False):
                item = tarfile.TarInfo(name)
                if link:
                    item.type = tarfile.SYMTYPE; item.linkname = 'outside'
                    archive.addfile(item)
                else:
                    item.size = len(data); archive.addfile(item, io.BytesIO(data))
            if layers: add('layer/layer.tar', b'synthetic inert layer bytes')
            add(name, raw, config_link)
            add('manifest.json', json.dumps(manifest).encode())
            if duplicate: add('manifest.json', b'[]')
            if unsafe: add('../outside', b'no extraction')
        return output, raw

    def test_exact_raw_configuration_binds_identity_and_all_rootfs_layers(self):
        archive, raw = self.image()
        before = sorted(p.name for p in self.root.iterdir())
        value = P.archive_configuration(archive)
        self.assertEqual(value, {'archiveConfigSHA256': hashlib.sha256(raw).hexdigest(),
                                 'imageSpec': {'Config': {'User': '2000', 'Cmd': ['fixed']},
                                  'Architecture': 'amd64', 'Os': 'linux', 'Created': '1970-01-01T00:00:01Z',
                                  'RootFS': {'Type': 'layers', 'Layers': ['sha256:'+'a'*64]}}})
        self.assertNotIn('imageId', value)
        self.assertEqual(before, sorted(p.name for p in self.root.iterdir()))
        self.assertNotIn('owner', value); self.assertNotIn('approved', value)

    def test_changed_configuration_cannot_keep_a_selected_image_identity(self):
        archive, _ = self.image(config_name='b'*64+'.json')
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            P.archive_configuration(archive)

    def test_missing_layers_and_rootfs_count_or_type_mismatch_refuse(self):
        for rootfs in [{'type': 'layers', 'diff_ids': []}, {'type': 'other', 'diff_ids': ['sha256:'+'a'*64]},
                       {'type': 'layers', 'diff_ids': ['sha256:invalid']}]:
            archive, _ = self.image(raw=json.dumps({'config': {}, 'rootfs': rootfs}).encode())
            with self.assertRaises(ValueError): P.archive_configuration(archive)
        archive, _ = self.image(layers=False)
        with self.assertRaises(ValueError): P.archive_configuration(archive)

    def test_multiple_images_duplicate_members_links_and_parent_paths_refuse(self):
        for options in [{'manifest': [{}, {}]}, {'duplicate': True}, {'config_link': True}, {'unsafe': True}]:
            archive, _ = self.image(**options)
            with self.assertRaises(ValueError): P.archive_configuration(archive)

    def test_oversized_metadata_is_rejected_before_json_read(self):
        archive, _ = self.image()
        with patch.object(P, 'MAX_JSON', 8):
            with self.assertRaisesRegex(ValueError, 'bounded regular'):
                P.archive_configuration(archive)

    def test_duplicate_json_keys_and_nonfinite_fields_refuse(self):
        for raw in [b'{"config":{},"config":{},"rootfs":{}}', b'{"config":{},"x":NaN}']:
            archive, _ = self.image(raw=raw)
            with self.assertRaises(ValueError): P.archive_configuration(archive)

    def test_distribution_manifest_and_archive_config_are_distinct_identities(self):
        archive, _ = self.image(); expected = P.archive_configuration(archive)
        actual = {**copy.deepcopy(expected['imageSpec']), 'Id': 'sha256:'+'b'*64,
                  'Descriptor': {'digest': 'sha256:'+'b'*64,
                                 'mediaType': 'application/vnd.docker.distribution.manifest.v2+json'}}
        self.assertNotEqual(actual['Id'], 'sha256:'+expected['archiveConfigSHA256'])
        self.assertEqual(P.verify_image_spec(expected, actual), actual['Id'])
        actual['Config']['Cmd'] = ['different']
        with self.assertRaisesRegex(ValueError, 'full image'): P.verify_image_spec(expected, actual)

    def test_full_layer_fields_manifest_binding_and_legacy_identity_are_checked(self):
        archive, _ = self.image(); expected = P.archive_configuration(archive)
        actual = {**copy.deepcopy(expected['imageSpec']), 'Id': 'sha256:'+expected['archiveConfigSHA256']}
        self.assertEqual(P.verify_image_spec(expected, actual), actual['Id'])
        for key, replacement in [('RootFS', {'Type': 'layers', 'Layers': ['sha256:'+'c'*64]}),
                                 ('Architecture', 'arm64'), ('Created', '1970-01-01T00:00:02Z'),
                                 ('Id', 'sha256:'+'c'*64)]:
            with self.assertRaises(ValueError): P.verify_image_spec(expected, {**actual, key: replacement})
        with self.assertRaises(ValueError):
            P.verify_image_spec(expected, {**actual, 'Descriptor': {'digest': 'sha256:'+'d'*64,
                                          'mediaType': 'application/vnd.oci.image.manifest.v1+json'}})

    def startup(self):
        executable=str(Path(sys.executable).resolve());console='/nix/store/synthetic-console'
        wrapper=console+'/lib/reverie/scripts/owner-terminal-start.mjs';entry=console+'/lib/reverie/dist/index.js'
        python={'invocation':executable,'executable':executable,'entry':'/nix/store/synthetic-start/libexec/reverie',
                'bootstrapModule':'/nix/store/synthetic-memory/bootstrap.py','packageInit':'/nix/store/synthetic-memory/__init__.py',
                'argvPrefix':[executable,'-I','/nix/store/synthetic-start/libexec/reverie','web']}
        names=[executable,wrapper,entry,'/nix/store/synthetic-entrypoint',python['entry'],python['bootstrapModule'],python['packageInit']]
        value={'version':1,'purpose':'owner-terminal-website-program-v1','nodeInvocation':executable,'nodeExecutable':executable,
               'nodeWrapper':wrapper,'applicationEntry':entry,'argvPrefix':[executable,wrapper,'web'],
               'startupPython':python,'normalEntrypoint':'/nix/store/synthetic-entrypoint',
               'codeFiles':{n:{'sha256':'a'*64,'bytes':1}for n in names}}
        path=self.root/'startup.json';path.write_text(json.dumps(value))
        return path,console,executable,value

    def test_optional_startup_metadata_stays_bound_to_selected_console_and_program(self):
        path,console,node,value=self.startup()
        with patch.object(P,'immutable',return_value=path):
            actual,pair=P.startup_program(path,console,node)
        self.assertEqual(actual,value);self.assertEqual(pair['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertNotIn('ownerApproved',actual)

    def test_wrapped_python_graph_requires_both_declared_wrapper_and_real_elf(self):
        import shutil
        path,console,node,value=self.startup()
        invocation=str(Path(shutil.which('python3')))
        wrapper=str(Path(invocation).resolve(strict=True))
        bare=str(Path('/proc/self/exe').resolve(strict=True))
        self.assertNotEqual(wrapper,bare)
        value['startupPython']['invocation']=invocation
        value['startupPython']['executable']=bare
        value['startupPython']['argvPrefix'][0]=invocation
        value['codeFiles'][bare]={'sha256':'c'*64,'bytes':1}
        value['codeFiles'][wrapper]={'sha256':'b'*64,'bytes':1}
        path.write_text(json.dumps(value))
        with patch.object(P,'immutable',return_value=path):
            actual,_=P.startup_program(path,console,node)
        self.assertEqual(actual,value)
        del value['codeFiles'][wrapper];path.write_text(json.dumps(value))
        with patch.object(P,'immutable',return_value=path),self.assertRaisesRegex(ValueError,'Incomplete startup code graph'):
            P.startup_program(path,console,node)

    def test_startup_code_omission_or_different_application_cannot_bind(self):
        path,console,node,value=self.startup()
        for change in ['missing','different']:
            selected=copy.deepcopy(value)
            if change=='missing':del selected['codeFiles'][value['applicationEntry']]
            else:selected['applicationEntry']='/nix/store/unselected-console/index.js'
            path.write_text(json.dumps(selected))
            with patch.object(P,'immutable',return_value=path),self.assertRaises(ValueError):
                P.startup_program(path,console,node)

    def test_build_time_startup_selection_must_verify_actual_declared_file_bytes(self):
        path,console,node,_value=self.startup()
        with patch.object(P,'immutable',return_value=path),patch.object(P,'code',return_value=('synthetic',{'sha256':'b'*64,'bytes':1})):
            with self.assertRaisesRegex(ValueError,'code bytes differ'):
                P.startup_program(path,console,node,verify_files=True)

    def test_build_input_mapping_never_changes_default_native_custody(self):
        target=Path('/nix/store/synthetic-input/file')
        def metadata(path):
            directory=path in (Path('/'),Path('/nix/store'))
            return os.stat_result(((stat.S_IFDIR|0o555)if directory else(stat.S_IFREG|0o444),
                                   1,1,1,65534,65534,16,1,1,1))
        with patch.object(Path,'resolve',lambda path,strict=True:path),patch.object(Path,'stat',metadata), \
             patch.dict(os.environ,{'NIX_BUILD_TOP':'/build','REVERIE_NIX_INPUT_UID':'65534'}):
            self.assertEqual(P.nix_build_input(target,16),target)
            for call in (lambda:P.immutable(target,16),lambda:P.code(target),
                         lambda:P.startup_program(target,'/nix/store/console',target),
                         lambda:P.build(target,'/nix/store/console',target,target)):
                with self.assertRaisesRegex(ValueError,'Immutable artifact custody refused'):call()

    def test_build_input_refuses_foreign_owner_writes_or_unbound_mapping(self):
        target=Path('/nix/store/synthetic-input/file')
        for change in ('owner','writable','oversize','directory','store-owner','outside'):
            def metadata(path):
                directory=path in (Path('/'),Path('/nix/store'))or change=='directory'and path==target
                mode=(stat.S_IFDIR|0o555)if directory else(stat.S_IFREG|0o444)
                uid=65534
                if change=='owner'and path==target:uid=1000
                if change=='writable'and path==target:mode|=0o200
                if change=='store-owner'and path==Path('/nix/store'):uid=1000
                return os.stat_result((mode,1,1,1,uid,65534,17 if change=='oversize'else 16,1,1,1))
            with self.subTest(change=change),patch.object(Path,'resolve',lambda path,strict=True:path), \
                 patch.object(Path,'stat',metadata),self.assertRaises(ValueError):
                P.nix_build_input(Path('/tmp/outside')if change=='outside'else target,16)

    def test_explicit_build_validator_reaches_each_declared_startup_code_file(self):
        path,console,node,value=self.startup();validated=[];hashed=[]
        def validator(selected,maximum,**kwargs):
            validated.append(selected);return path
        def code(selected,*,input_validator=None):
            self.assertIs(input_validator,validator);hashed.append(selected)
            return selected,value['codeFiles'][selected]
        with patch.object(P,'immutable',side_effect=AssertionError('No native validator substitution')), \
             patch.object(P,'code',side_effect=code):
            actual,_=P.startup_program(path,console,node,verify_files=True,input_validator=validator)
        self.assertEqual(actual,value);self.assertEqual(validated,[path])
        self.assertEqual(set(hashed),set(value['codeFiles']))


if __name__ == '__main__':
    unittest.main()
