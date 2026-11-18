import base64
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import agent_loop as loop
from test_coding_support import cfg_for, without_seat_environment

SESSION = '11111111-2222-3333-4444-555555555555'
ROOM = '12345678-1234-1234-1234-123456789abc'
FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PNG = b'\x89PNG\r\n\x1a\nfixture'


class FilesystemVisionTests(unittest.TestCase):
    def setUp(self):
        without_seat_environment(self)  # a seat's REVERIE_WORKER would switch load_images to scoped reads

    def test_reads_shared_room_image_without_an_attachment_api(self):
        with tempfile.TemporaryDirectory() as directory:
            room = '12345678-1234-1234-1234-123456789abc'
            root = Path(directory) / 'attachments'
            folder = root / room; folder.mkdir(parents=True)
            image = folder / 'image.png'; image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            message = {'id': 'message', 'roomId': room, 'attachments': [
                {'path': str(image), 'type': 'image/png', 'name': 'image.png'}]}
            cfg = cfg_for(directory, vision=True, attachments_root=str(root))
            with patch.object(loop, 'fetch_scoped_image', side_effect=AssertionError('no attachment API')):
                parts, notes = loop.load_images(cfg, room[:8], message)
            self.assertEqual(notes, [])
            self.assertEqual(base64.b64decode(parts[0]['image_url']['url'].split(',', 1)[1]), image.read_bytes())
            # Room symlinks and attachment paths into another room remain denied.
            other = root / 'another-room'; other.mkdir()
            elsewhere = other / 'elsewhere.png'; elsewhere.write_bytes(image.read_bytes())
            for path in (elsewhere, folder / 'alias.png'):
                if path.name == 'alias.png': path.symlink_to(elsewhere)
                message['attachments'][0]['path'] = str(path)
                self.assertEqual(loop.load_images(cfg, room, message)[0], [])
            image.unlink(); (folder / 'alias.png').unlink(); folder.rmdir(); folder.symlink_to(other, target_is_directory=True)
            message['attachments'][0]['path'] = str(folder / 'elsewhere.png')
            self.assertEqual(loop.load_images(cfg, room, message)[0], [])

    def test_image_count_content_and_byte_limits_still_apply(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); folder = root / 'room'; folder.mkdir()
            image = folder / 'image.png'; image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            entry = {'path': str(image), 'name': 'image.png', 'type': 'image/png'}
            cfg = cfg_for(directory, vision=True, attachments_root=str(root), max_images=1)
            parts, notes = loop.load_images(cfg, 'room', {'attachments': [entry, entry]})
            self.assertEqual(len(parts), 1)
            self.assertIn('more than 1 images', notes[0])
            for content in (b'not a PNG', b'\x89PNG\r\n\x1a\n' + b'x' * 200):
                image.write_bytes(content)
                self.assertEqual(loop.load_images(dict(cfg, max_image_bytes=100), 'room', {'attachments': [entry]})[0], [])


class ScopedVisionTests(unittest.TestCase):
    def setUp(self):
        scope = patch.dict(os.environ, REVERIE_WORKER='1', REVERIE_SESSION_ID=SESSION)
        scope.start()
        self.addCleanup(scope.stop)
        self.cfg = cfg_for('/unused', self_session_id=SESSION, vision=True, max_images=1, max_image_bytes=32)
        self.attachment = {'id': FILE, 'type': 'image/png', 'path': '/unused/server-file'}

    def test_worker_uses_native_download_and_preserves_full_room_identity(self):
        message = {'roomId': ROOM, 'attachments': [self.attachment]}
        with patch.object(loop.subprocess, 'run', return_value=SimpleNamespace(stdout=PNG)) as run, \
                patch.object(loop, 'open', create=True, side_effect=AssertionError('no server filesystem')):
            parts, notes = loop.load_images(self.cfg, ROOM[:8], message)
        self.assertEqual(notes, [])
        self.assertEqual(base64.b64decode(parts[0]['image_url']['url'].split(',', 1)[1]), PNG)
        command, = run.call_args.args
        options = run.call_args.kwargs
        self.assertEqual(command[-1], f'--scoped-image-worker={os.getpid()}')
        self.assertTrue(options['start_new_session'])
        self.assertTrue(options['check'])
        self.assertEqual(json.loads(options['input']), {
            'cli': self.cfg['cli'], 'session': SESSION, 'room': ROOM,
            'attachment': FILE, 'max_bytes': 32, 'timeout': self.cfg['cli_timeout_s'],
        })

    def test_download_refusal_does_not_fall_back_to_a_local_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / ROOM / 'image.png'
            image.parent.mkdir()
            image.write_bytes(PNG)
            self.attachment['path'] = str(image)
            self.cfg['attachments_root'] = str(root)
            message = {'roomId': ROOM, 'attachments': [self.attachment]}
            with patch.object(loop, 'fetch_scoped_image', side_effect=ValueError('native refusal')):
                parts, notes = loop.load_images(self.cfg, ROOM, message)
            self.assertEqual(parts, [])
            self.assertIn('could not be read', notes[0])
            self.assertEqual(image.read_bytes(), PNG)

    def test_native_download_still_obeys_prompt_image_limits(self):
        message = {'roomId': ROOM, 'attachments': [self.attachment] * 2}
        for data in (b'wrong image', PNG + b'x' * 40):
            with patch.object(loop, 'fetch_scoped_image', return_value=data):
                self.assertEqual(loop.load_images(self.cfg, ROOM, message)[0], [])
        with patch.object(loop, 'fetch_scoped_image', return_value=PNG) as download:
            parts, notes = loop.load_images(self.cfg, ROOM, message)
        self.assertEqual(len(parts), 1)
        download.assert_called_once()
        self.assertIn('more than 1 images', notes[0])
