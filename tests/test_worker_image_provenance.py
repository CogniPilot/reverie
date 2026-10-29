"""Actual tiny archive/ELF bytes; no image load, command execution or native authority."""
import copy
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from reverie import worker_image_provenance as P


class WorkerImageProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='worker-provenance-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        for name in P.SOURCE_FILES:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('owned fixed source: ' + name).encode())
        self.factory = {'name': 'lib.workerDockerImage', 'system': 'x86_64-linux',
                        'uid': 1200, 'gid': 1300, 'subuidStart': 100000,
                        'subgidStart': 200000, 'subidCount': 65536, 'browser': False}
        self.profile = self.root / 'profile.json'
        self.toolkit_root = self.root / 'toolkit'
        self.manifest = self.toolkit_root / 'share/reverie-human-terminal/manifest.json'
        self.host_files = {name: self.elf() for name in P.TARGETS}
        self.write_inputs()

    @staticmethod
    def elf(machine=62, *, interpreter=False, needed=False):
        count = 2 if interpreter or needed else 1
        length = 64 + count * 56 + (32 if needed else 0)
        raw = bytearray(length)
        ident = b'\x7fELF\x02\x01\x01' + b'\0' * 9
        struct.pack_into('<16sHHIQQQIHHHHHH', raw, 0,
                         ident, 2, machine, 1, 0, 64, 0, 0, 64, 56, count, 0, 0, 0)
        struct.pack_into('<IIQQQQQQ', raw, 64, 1, 5, 0, 0, 0, length, length, 4096)
        if interpreter:
            struct.pack_into('<IIQQQQQQ', raw, 120, 3, 0, 0, 0, 0, 0, 0, 1)
        if needed:
            struct.pack_into('<IIQQQQQQ', raw, 120, 2, 0, 176, 0, 0, 32, 32, 8)
            struct.pack_into('<qQqQ', raw, 176, 1, 0, 0, 0)
        return bytes(raw)

    def write_inputs(self):
        self.profile.write_text(json.dumps(self.factory))
        self.manifest.parent.mkdir(parents=True, exist_ok=True)
        for name, raw in self.host_files.items():
            p = self.toolkit_root / name.lstrip('/')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(raw)
        self.manifest.write_text(json.dumps({'version': 1, 'static': True,
                                            'files': {k: P.pin(v) for k, v in self.host_files.items()}}))

    @staticmethod
    def input_custody(path, maximum, *, allow_empty=False):
        # Only this owned fixture's file-custody port differs from a Nix build.
        # No archive/profile/hash/ELF/final-state or returned qualification is mocked.
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or not (0 if allow_empty else 1) <= info.st_size <= maximum:
            raise ValueError('owned bounded fixture input required')
        return path

    def entries(self):
        rows = [{'name': name, 'type': 'dir', 'mode': 0o755} for name in
                ('opt', 'opt/reverie', 'opt/reverie/human', 'opt/reverie/human/bin')]
        rows += [{'name': name.lstrip('/'), 'type': 'file', 'mode': 0o555, 'data': raw}
                 for name, raw in self.host_files.items()]
        return rows

    @staticmethod
    def layer(rows):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for row in rows:
                member = tarfile.TarInfo(row['name'])
                member.uid = row.get('uid', 0); member.gid = row.get('gid', 0)
                member.mode = row.get('mode', 0o755)
                kind = row.get('type', 'file'); raw = row.get('data', b'')
                if kind == 'dir': member.type = tarfile.DIRTYPE
                elif kind in ('symlink', 'hardlink'):
                    member.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                    member.linkname = row.get('target', '/outside')
                else:
                    member.type = tarfile.REGTYPE; member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw) if kind == 'file' else None)
        return stream.getvalue()

    def archive(self, layers=None, *, change_config=None, wrong_diffid=False, extra_layer=False):
        data = [self.layer(rows) for rows in (layers if layers is not None else [self.entries()])]
        labels = {'org.reverie.worker.uid': str(self.factory['uid']),
                  'org.reverie.worker.gid': str(self.factory['gid']),
                  'org.reverie.worker.rootless-docker': '1',
                  'org.reverie.worker.rootless-docker.mount-layout': '1',
                  'org.reverie.worker.subuid-start': str(self.factory['subuidStart']),
                  'org.reverie.worker.subgid-start': str(self.factory['subgidStart']),
                  'org.reverie.worker.subid-count': str(self.factory['subidCount']),
                  'reverie.worker.nix-store': '1'}
        if self.factory['browser']: labels['org.reverie.worker.browser'] = '1'
        config = {'architecture': {'x86_64-linux': 'amd64', 'aarch64-linux': 'arm64'}[self.factory['system']],
                  'os': 'linux', 'created': '1970-01-01T00:00:01Z',
                  'config': {'User': f"{self.factory['uid']}:{self.factory['gid']}", 'Labels': labels,
                             'Entrypoint': ['/bin/sleep'], 'Cmd': ['infinity'], 'WorkingDir': '/reverie_workspace'},
                  'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + hashlib.sha256(v).hexdigest() for v in data]}}
        if change_config: change_config(config)
        if wrong_diffid: config['rootfs']['diff_ids'][0] = 'sha256:' + 'a' * 64
        raw = json.dumps(config).encode(); identity = hashlib.sha256(raw).hexdigest() + '.json'
        names = [f'layer-{i}/layer.tar' for i in range(len(data))]
        rows = [(name, value) for name, value in zip(names, data)]
        rows += [(identity, raw), ('manifest.json', json.dumps([{'Config': identity, 'RepoTags': ['owned:fixture'], 'Layers': names}]).encode())]
        if extra_layer: rows.append(('unreferenced/layer.tar', self.layer([])))
        output = self.root / 'worker.tar.gz'
        with tarfile.open(output, 'w:gz') as archive:
            for name, value in rows:
                item = tarfile.TarInfo(name); item.size = len(value)
                archive.addfile(item, io.BytesIO(value))
        return output

    def build(self, archive=None):
        return P.build(archive or self.archive(), self.source, self.profile, self.manifest,
                       input_validator=self.input_custody)

    def test_actual_generated_closed_document_binds_all_inputs_and_real_layers(self):
        archive = self.archive(); result = self.build(archive)
        self.assertEqual(set(result), {'version', 'purpose', 'archiveConfigSHA256', 'imageSpec',
                                       'archive', 'factory', 'source', 'toolkit'})
        self.assertEqual(result['purpose'], P.PURPOSE)
        self.assertEqual(result['factory'], self.factory)
        self.assertEqual(result['archive'], {'path': str(archive), **P.pin(archive.read_bytes())})
        self.assertEqual(set(result['source']['factoryFiles']), set(P.SOURCE_FILES))
        self.assertEqual(result['toolkit']['files'], {k: P.pin(v) for k, v in self.host_files.items()})
        self.assertEqual(result['toolkit']['manifest'], {'path': str(self.manifest), **P.pin(self.manifest.read_bytes())})
        self.assertNotIn('approved', result); self.assertNotIn('imageId', result)
        actual = {**copy.deepcopy(result['imageSpec']), 'Id': 'sha256:' + result['archiveConfigSHA256']}
        self.assertEqual(P.W.verify_image_spec(result, actual), actual['Id'])
        actual['Config']['User'] = '2000:2000'
        with self.assertRaisesRegex(ValueError, 'full image'): P.W.verify_image_spec(result, actual)

    def test_native_default_refuses_mutable_owned_files_instead_of_qualifying_them(self):
        with self.assertRaisesRegex(ValueError, 'immutable'):
            P.build(self.archive(), self.source, self.profile, self.manifest)

    def test_closed_profile_rejects_bool_float_unknown_and_overlapping_identity(self):
        for key, value in [('uid', True), ('gid', 1.0), ('browser', 1), ('uid', 0),
                           ('subidCount', 65535), ('subuidStart', self.factory['uid']),
                           ('subgidStart', 4294967290), ('unknown', 'extra')]:
            with self.subTest(key=key, value=value):
                wrong = {**self.factory, key: value}; self.profile.write_text(json.dumps(wrong))
                with self.assertRaises(ValueError): self.build()

    def test_image_labels_user_program_and_platform_are_verified_from_archive(self):
        def label(key, value): return lambda d: d['config']['Labels'].__setitem__(key, value)
        cases = [(lambda d: d['config'].__setitem__('User', '2000:2000'), 'Worker image program or identity differs'),
                 (lambda d: d['config'].__setitem__('Cmd', ['arbitrary']), 'Worker image program or identity differs'),
                 (lambda d: d.__setitem__('architecture', 'arm64'), 'Worker factory platform differs'),
                 (label('org.reverie.worker.rootless-docker', '0'), 'Worker factory labels differ'),
                 (label('org.reverie.worker.subid-count', '131072'), 'Worker factory labels differ'),
                 (label('org.reverie.worker.browser', '1'), 'Worker factory browser profile differs'),
                 (label('org.reverie.worker.browser', None), 'Worker factory browser profile differs')]
        for change, reason in cases:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, reason):
                self.build(self.archive(change_config=change))

    def test_browser_and_aarch64_profiles_are_explicit_and_portable(self):
        self.factory.update(system='aarch64-linux', browser=True)
        self.host_files = {name: self.elf(machine=183) for name in P.TARGETS}; self.write_inputs()
        result = self.build()
        self.assertEqual(result['imageSpec']['Architecture'], 'arm64')
        self.assertEqual(result['imageSpec']['Config']['Labels']['org.reverie.worker.browser'], '1')

    def test_toolkit_manifest_cannot_assert_static_for_interpreter_or_needed_ELFs(self):
        for options in [{'interpreter': True}, {'needed': True}]:
            with self.subTest(options=options):
                self.host_files = {name: self.elf(**options) for name in P.TARGETS}; self.write_inputs()
                with self.assertRaisesRegex(ValueError, 'interpreter|dependency'): self.build()

    def test_changed_host_toolkit_bytes_do_not_match_immutable_manifest(self):
        (self.toolkit_root / P.TARGETS[0].lstrip('/')).write_bytes(b'not the pinned ELF')
        with self.assertRaisesRegex(ValueError, 'bytes differ'): self.build()

    def test_toolkit_manifest_requires_exact_two_files_and_integer_sizes(self):
        value = json.loads(self.manifest.read_text())
        for change in [lambda v: v['files'].pop(P.TARGETS[0]),
                       lambda v: v['files'][P.TARGETS[0]].__setitem__('bytes', True),
                       lambda v: v['files'][P.TARGETS[0]].__setitem__('bytes', (16 << 20) + 1),
                       lambda v: v.__setitem__('static', False)]:
            wrong = copy.deepcopy(value); change(wrong); self.manifest.write_text(json.dumps(wrong))
            with self.assertRaises(ValueError): self.build()

    def test_actual_raw_layer_DiffID_is_required_not_just_configured_layer_metadata(self):
        with self.assertRaisesRegex(ValueError, 'DiffID'): self.build(self.archive(wrong_diffid=True))

    def test_unreferenced_layer_is_not_silently_accepted(self):
        with self.assertRaisesRegex(ValueError, 'layer order'): self.build(self.archive(extra_layer=True))

    def test_changed_archive_toolkit_bytes_and_regular_modes_or_owner_refuse(self):
        for change in [{'data': b'X' * len(self.elf())}, {'mode': 0o755}, {'uid': 1200}]:
            with self.subTest(change=change):
                rows = self.entries(); rows[-1].update(change)
                with self.assertRaises(ValueError): self.build(self.archive([rows]))

    def test_target_symlink_and_hardlink_are_never_direct_static_toolkit_files(self):
        for kind in ('symlink', 'hardlink'):
            with self.subTest(kind=kind):
                rows = self.entries(); rows[-1].update(type=kind, target=P.TARGETS[0])
                with self.assertRaises(ValueError): self.build(self.archive([rows]))

    def test_later_ancestor_file_symlink_and_hardlink_invalidate_lower_toolkit(self):
        for parent in ('opt', 'opt/reverie', 'opt/reverie/human', 'opt/reverie/human/bin'):
            for kind in ('file', 'symlink', 'hardlink'):
                with self.subTest(parent=parent, kind=kind), self.assertRaises(ValueError):
                    self.build(self.archive([self.entries(), [{'name': parent, 'type': kind, 'data': b'x', 'mode': 0o555}]]))

    def test_whiteout_target_ancestor_and_opaque_directory_remove_lower_toolkit(self):
        for name in ['opt/reverie/human/bin/.wh.bash', 'opt/reverie/.wh.human',
                     'opt/reverie/human/bin/.wh..wh..opq', '.wh..wh..opq']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.build(self.archive([self.entries(), [{'name': name, 'type': 'file', 'data': b''}]]))

    def test_valid_directory_overlay_preserves_lower_files(self):
        later = [{'name': 'opt/reverie/human/bin', 'type': 'dir', 'mode': 0o755}]
        self.assertEqual(self.build(self.archive([self.entries(), later]))['purpose'], P.PURPOSE)

    def test_whiteouts_apply_before_same_layer_replacement_regardless_of_header_order(self):
        later = self.entries()[3:] + [{'name': 'opt/reverie/human/.wh.bin', 'type': 'file', 'data': b''}]
        self.assertEqual(self.build(self.archive([self.entries(), later]))['purpose'], P.PURPOSE)

    def test_member_budget_and_absolute_read_deadline_refuse(self):
        with patch.object(P, 'MAX_MEMBERS', 0), self.assertRaisesRegex(ValueError, 'member bound'):
            self.build()
        with patch.object(P, 'DEADLINE_SECONDS', 0), self.assertRaisesRegex(ValueError, 'deadline'):
            self.build()

    def test_source_code_file_inventory_is_fixed_and_cannot_be_omitted(self):
        (self.source / P.SOURCE_FILES[0]).unlink()
        with self.assertRaises(FileNotFoundError): self.build()

    def test_clean_isolated_cli_help_imports_complete_real_module_without_native_effect(self):
        p = subprocess.run([sys.executable, '-I', '-B', P.__file__, '--help'], capture_output=True,
                           text=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('--toolkit-manifest', p.stdout)


if __name__ == '__main__':
    unittest.main()
