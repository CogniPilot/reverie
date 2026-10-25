import base64
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import agent_loop as loop
import scoped_images
from test_coding_support import cfg_for

SESSION = '11111111-2222-3333-4444-555555555555'
ROOM = '12345678-1234-1234-1234-123456789abc'
FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PNG = b'\x89PNG\r\n\x1a\nfixture'


class ScopedImageTests(unittest.TestCase):
    def test_laptop_uses_normal_bounded_cli_without_reading_server_path(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            command = folder / 'fake-chat.py'
            command.write_text('''import os,sys,pathlib
assert sys.argv[1:4]==['fetch', ''' + repr(ROOM) + ', ' + repr(FILE) + ''']
assert sys.argv[4:]==['--output','image.bin','--max-bytes','5000000','--timeout','10000','--json']
assert os.environ['REVERIE_SESSION_ID']==''' + repr(SESSION) + '''
p=pathlib.Path('image.bin');p.write_bytes(''' + repr(PNG) + ''');p.chmod(0o600)
''')
            cfg = cfg_for(directory, self_session_id=SESSION, vision=True,
                attachments_root='/masked-server-path', cli=[sys.executable, '-I', '-B', str(command)])
            message = {'roomId': ROOM, 'attachments': [
                {'id': FILE, 'path': '/must-never-be-read.png', 'type': 'image/png', 'name': 'picture.png'}]}
            with patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION), \
                    patch.object(scoped_images, 'SCRATCH_TEMP', folder), \
                    patch.object(loop, 'open', create=True, side_effect=AssertionError('no server filesystem')):
                parts, notes = loop.load_images(cfg, ROOM[:8], message)
            self.assertEqual(notes, [])
            self.assertEqual(base64.b64decode(parts[0]['image_url']['url'].split(',', 1)[1]), PNG)
            self.assertFalse(any(p.name.startswith('reverie-image-') for p in folder.iterdir()))

    def test_invalid_scope_does_not_start_a_download(self):
        with patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION), \
                patch.object(scoped_images.subprocess, 'Popen', side_effect=AssertionError('no process')):
            for room, file, session in [(ROOM[:8], FILE, SESSION), (ROOM, '../file', SESSION),
                                        (ROOM, FILE, 'wrong-session')]:
                with self.subTest(room=room, file=file, session=session), self.assertRaises(ValueError):
                    scoped_images.fetch(['unused'], session, room, file, 100, 1)

    def test_membership_refusal_never_falls_back_to_a_readable_local_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / ROOM / 'image.png';image.parent.mkdir();image.write_bytes(PNG)
            cfg = cfg_for(directory, self_session_id=SESSION, vision=True, attachments_root=str(root), cli=['unused'])
            message = {'roomId': ROOM, 'attachments': [dict(id=FILE, path=str(image), type='image/png')]}
            with patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION), \
                    patch.object(scoped_images, 'fetch', side_effect=ValueError('HTTP403')):
                parts, notes = loop.load_images(cfg, ROOM, message)
            self.assertEqual(parts, [])
            self.assertIn('could not be read', notes[0])
            self.assertEqual(image.read_bytes(), PNG)

    def test_downloaded_magic_count_and_byte_limits_are_still_applied(self):
        cfg = cfg_for('/unused', self_session_id=SESSION, vision=True, max_images=1, max_image_bytes=32)
        message = {'roomId': ROOM, 'attachments': [dict(id=FILE, type='image/png')] * 2}
        with patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION):
            for data in (b'wrong image', PNG + b'x' * 40):
                with patch.object(scoped_images, 'fetch', return_value=data):
                    self.assertEqual(loop.load_images(cfg, ROOM, message)[0], [])
            with patch.object(scoped_images, 'fetch', return_value=PNG) as download:
                parts, notes = loop.load_images(cfg, ROOM, message)
            self.assertEqual(len(parts), 1)
            self.assertEqual(download.call_count, 1)
            self.assertIn('more than 1 images', notes[0])

    def test_invalid_cli_output_is_not_read_as_an_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / 'outside.png';external.write_bytes(PNG);external.chmod(0o600)
            for code in ["p.symlink_to(" + repr(str(external)) + ")",
                         "p.write_bytes(b'x'*101);p.chmod(0o600)",
                         "p.write_bytes(b'x');p.chmod(0o644)",
                         "os.link(" + repr(str(external)) + ",p)"]:
                command = root / 'fake.py'
                command.write_text("import pathlib,os\np=pathlib.Path('image.bin')\n" + code + '\n')
                with self.subTest(code=code), patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION), \
                        patch.object(scoped_images, 'SCRATCH_TEMP', root):
                    with self.assertRaises((OSError, ValueError)):
                        scoped_images.fetch([sys.executable, '-I', '-B', str(command)], SESSION, ROOM, FILE, 100, 1)
            self.assertEqual(external.read_bytes(), PNG)

    def test_cli_timeout_stops_its_process_group_and_retains_no_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = root / 'wait.py';command.write_text('import time\ntime.sleep(30)\n')
            with patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION), \
                    patch.object(scoped_images, 'SCRATCH_TEMP', root):
                with self.assertRaisesRegex(ValueError, 'timed out'):
                    scoped_images.fetch([sys.executable, '-I', '-B', str(command)], SESSION, ROOM, FILE, 100, .1)
            self.assertFalse(any(p.name.startswith('reverie-image-') for p in root.iterdir()))
