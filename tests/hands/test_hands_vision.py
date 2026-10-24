import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_loop as loop
from test_coding_support import cfg_for


class FilesystemVisionTests(unittest.TestCase):
    def test_reads_shared_room_image_without_an_attachment_api(self):
        with tempfile.TemporaryDirectory() as directory:
            room = '12345678-1234-1234-1234-123456789abc'
            root = Path(directory) / 'attachments'
            folder = root / room; folder.mkdir(parents=True)
            image = folder / 'image.png'; image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            message = {'id': 'message', 'roomId': room, 'attachments': [
                {'path': str(image), 'type': 'image/png', 'name': 'image.png'}]}
            cfg = cfg_for(directory, vision=True, attachments_root=str(root))
            with patch.object(loop.urllib.request, 'urlopen', side_effect=AssertionError('no attachment API')):
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
