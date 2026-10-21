import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from cto import image_check

TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'


def _tar(entries):
    """A tar as bytes from (name, bytes or None for a directory) pairs."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            if data is None:
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif isinstance(data, tuple):
                kind, info.linkname = data
                info.type = tarfile.SYMTYPE if kind == 'sym' else tarfile.LNKTYPE
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _image(directory, layers, config=None):
    config = config or {'config': {'Env': ['PATH=/usr/bin'], 'Cmd': ['sleep', 'infinity']},
                        'history': [{'created_by': 'RUN true'}]}
    names = [f'{i}.tar' for i in range(len(layers))]
    entries = [('manifest.json', json.dumps([{'Config': 'config.json', 'Layers': names}]).encode()),
               ('config.json', json.dumps(config).encode())]
    entries += [(name, _tar(layer)) for name, layer in zip(names, layers)]
    path = Path(directory) / 'image.tar'
    path.write_bytes(_tar(entries))
    return str(path)


class ImageCheckTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def run_check(self, layers, config=None, allow=None):
        return image_check.check(_image(self.dir.name, layers, config), allow)

    def test_a_clean_image_passes(self):
        result = self.run_check([[('opt/fleet/cto/a.py', b'print(1)\n'), ('workspace', None), ('scratch', None)]])
        self.assertTrue(result['clean'], result)

    def test_a_credential_in_our_tree_is_named_not_copied(self):
        result = self.run_check([[('opt/fleet/cto/a.py', f'KEY = "{TOKEN}"\n'.encode())]])
        self.assertEqual(result['findings'], [{'where': 'layer 0: /opt/fleet/cto/a.py', 'detector': 'github_token'}])
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_a_file_deleted_by_a_later_layer_is_still_found(self):
        result = self.run_check([[('opt/fleet/cto/a.py', TOKEN.encode())],
                                 [('opt/fleet/cto/.wh.a.py', b'')]])
        self.assertEqual([f['where'] for f in result['findings']], ['layer 0: /opt/fleet/cto/a.py'])

    def test_instance_files_are_refused_anywhere_by_name(self):
        result = self.run_check([[('home/cto/.config/reverie/deploy/github.token', b'x'),
                                  ('usr/lib/x/memory.sqlite', b'x'),
                                  ('opt/fleet/apps/console/node_modules/p/.env', b'x')]])
        self.assertEqual({f['detector'] for f in result['findings']}, {'instance_file'})
        self.assertEqual(len(result['findings']), 3)

    def test_hidden_files_at_the_root_keep_their_name(self):
        result = self.run_check([[('./.env', b'x'), ('./.netrc', b'x')]])
        self.assertEqual([f['where'] for f in result['findings']], ['layer 0: /.env', 'layer 0: /.netrc'])

    def test_mount_points_must_ship_empty(self):
        result = self.run_check([[('workspace', None), ('workspace/notes.md', b'hi')]])
        self.assertEqual(result['findings'], [{'where': 'layer 0: /workspace/notes.md', 'detector': 'mount_point_not_empty'}])

    def test_links_into_instance_data_are_refused(self):
        result = self.run_check([[('opt/fleet/data', ('sym', '/instances/example')),
                                  ('opt/fleet/cto/key', ('sym', '../../../home/user/.config/gh.token')),
                                  ('usr/local/bin/creds', ('lnk', 'root/.git-credentials')),
                                  ('usr/local/bin/reverie', ('sym', '/opt/fleet/apps/console/dist/index.js')),
                                  ('usr/bin/py', ('sym', 'python3'))]])
        self.assertEqual([(f['where'], f['detector']) for f in result['findings']], [
            ('layer 0: /opt/fleet/data', 'link_into_mount_point'),
            ('layer 0: /opt/fleet/cto/key', 'link_to_instance_file'),
            ('layer 0: /usr/local/bin/creds', 'link_to_instance_file'),
        ])

    def test_every_file_outside_third_party_trees_is_read(self):
        # Home directories, binaries and large files are read too, and a key across a chunk boundary is found.
        large = b'x' * (image_check.CHUNK - 10) + b' ' + TOKEN.encode() + b' ' + b'y' * (5 * image_check.CHUNK)
        result = self.run_check([[('home/user/notes.txt', TOKEN.encode()),
                                  ('opt/fleet/bin/tool', b'\x7fELF\0\0' + TOKEN.encode() + b'\0\xff'),
                                  ('opt/fleet/data/big.txt', large)]])
        self.assertEqual([f['where'] for f in result['findings']],
                         ['layer 0: /home/user/notes.txt', 'layer 0: /opt/fleet/bin/tool', 'layer 0: /opt/fleet/data/big.txt'])

    def test_unread_third_party_files_are_counted(self):
        result = self.run_check([[('usr/lib/x/a.js', b'abc'), ('usr/share/doc/b', b'de'),
                                  ('opt/fleet/apps/console/node_modules/p/c.js', b'f')]])
        self.assertEqual(result['unread_third_party'], {'usr/': {'files': 2, 'bytes': 5},
                                                        'opt/fleet/apps/console/node_modules/': {'files': 1, 'bytes': 1}})

    def test_third_party_contents_are_not_read(self):
        result = self.run_check([[('opt/fleet/apps/console/node_modules/p/test.js', TOKEN.encode()),
                                  ('usr/lib/node_modules/q/fixture.js', TOKEN.encode())]])
        self.assertTrue(result['clean'], result)

    def test_dotenv_templates_pass_by_name_but_are_read(self):
        result = self.run_check([[('opt/fleet/apps/console/docker/.env.example', b'PUID=1000'),
                                  ('opt/fleet/a/.env.sample', TOKEN.encode()), ('opt/fleet/b/.env.local', b'x'),
                                  ('opt/fleet/c/.env.example.bak', b'x')]])
        self.assertEqual([(f['where'], f['detector']) for f in result['findings']],
                         [('layer 0: /opt/fleet/a/.env.sample', 'github_token'),
                          ('layer 0: /opt/fleet/b/.env.local', 'instance_file'),
                          ('layer 0: /opt/fleet/c/.env.example.bak', 'instance_file')])

    def test_our_scripts_inside_third_party_trees_are_read(self):
        result = self.run_check([[('usr/local/bin/start', f'#!/bin/sh\nGH={TOKEN}\n'.encode()),
                                  ('usr/local/lib/node_modules/q/fixture.js', TOKEN.encode())]])
        self.assertEqual([f['where'] for f in result['findings']], ['layer 0: /usr/local/bin/start'])
        self.assertEqual(result['unread_third_party'], {'usr/': {'files': 1, 'bytes': len(TOKEN)}})

    def test_config_env_labels_and_history_are_checked(self):
        config = {'config': {'Env': [f'GH={TOKEN}'], 'Labels': {'k': TOKEN}},
                  'history': [{'created_by': f'RUN echo {TOKEN}'}]}
        result = self.run_check([[('opt/fleet/cto/a.py', b'')]], config)
        self.assertEqual([f['where'] for f in result['findings']], ['config.Env', 'config.Labels', 'config.history'])

    def test_allowed_fixtures_pass_only_for_their_detector(self):
        layers = [[('opt/fleet/apps/console/test/k.ts', f'"{TOKEN}" -----BEGIN ' 'PRIVATE KEY-----'.encode())]]
        result = self.run_check(layers, allow={('opt/fleet/apps/console/test/k.ts', 'private_key')})
        self.assertEqual([f['detector'] for f in result['findings']], ['github_token'])

    def test_the_command_line_exit_status(self):
        clean = _image(self.dir.name, [[('opt/fleet/cto/a.py', b'')]])
        self.assertEqual(image_check.main([clean]), 0)
        dirty = _image(self.dir.name, [[('opt/fleet/cto/a.py', TOKEN.encode())]])
        self.assertEqual(image_check.main([dirty]), 1)
        bad = Path(self.dir.name) / 'bad.tar'
        bad.write_bytes(_tar([('manifest.json', b'[]')]))
        self.assertEqual(image_check.main([str(bad)]), 2)


if __name__ == '__main__':
    unittest.main()
