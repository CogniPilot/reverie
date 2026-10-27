import json
import os
from pathlib import Path
import tempfile
import unittest

from model_events import TraceReader, TraceWriter


class ModelEventTests(unittest.TestCase):
    def test_reader_tails_new_events_and_never_replays_earlier_reasoning(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            writer = TraceWriter(path)
            writer.write('thinking', 'old private thought')
            reader = TraceReader(path)
            self.assertEqual(reader.poll(), [])
            writer.write('thinking', 'new thought')
            writer.write('answer', 'answer')
            self.assertEqual(reader.poll(), [{'kind': 'thinking', 'text': 'new thought'},
                                             {'kind': 'answer', 'text': 'answer'}])
            self.assertEqual(reader.poll(), [])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_reader_started_before_file_reads_first_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            reader = TraceReader(path)
            self.assertEqual(reader.poll(), [])
            TraceWriter(path).write('answer', 'first answer')
            self.assertEqual(reader.poll(), [{'kind': 'answer', 'text': 'first answer'}])

    def test_split_credentials_and_terminal_controls_never_reach_display_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            secret = 'synthetic-secret-token'
            writer = TraceWriter(path, secrets=[secret])
            writer.write('thinking', 'hello\x1b[31m\x00 ' + secret[:9])
            writer.write('thinking', secret[9:] + ' done')
            writer.write('answer', 'Authorization: Bearer another-token\r\x07')
            writer.flush()
            raw = path.read_text()
            self.assertNotIn(secret, raw)
            events = TraceReader(path, from_end=False).poll()
            text = ''.join(event['text'] for event in events)
            self.assertNotIn(secret, text)
            self.assertNotIn('another-token', text)
            self.assertNotIn('\x1b', text)
            self.assertNotIn('\x00', text)
            self.assertNotIn('\r', text)
            self.assertIn('[redacted]', text)

    def test_wrap_is_bounded_and_reader_detects_generation_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            writer = TraceWriter(path, max_bytes=1024)
            writer.write('answer', 'initial')
            reader = TraceReader(path)
            for index in range(30):
                writer.write('answer', str(index) + 'x' * 100)
                self.assertLessEqual(path.stat().st_size, 1024)
            events = reader.poll()
            self.assertTrue(events)
            self.assertTrue(events[-1]['text'].startswith('29'))
            self.assertEqual(reader.poll(), [])

    def test_unsafe_paths_and_files_are_refused_without_changing_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'; target.write_text('private'); target.chmod(0o600)
            alias = root / 'alias'; alias.symlink_to(target)
            for constructor in (TraceWriter, TraceReader):
                with self.assertRaises((ValueError, OSError)):
                    constructor(alias)
            target.chmod(0o644)
            for constructor in (TraceWriter, TraceReader):
                with self.assertRaises(ValueError):
                    constructor(target)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            target.chmod(0o600)
            hardlink = root / 'hardlink'; os.link(target, hardlink)
            with self.assertRaises(ValueError):
                TraceWriter(target)
            fifo = root / 'fifo'; os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError):
                TraceWriter(fifo)
            shared = root / 'shared'; shared.mkdir(mode=0o755)
            shared.chmod(0o755)  # Make the unsafe fixture explicit even under an owner-private umask.
            with self.assertRaises(ValueError):
                TraceWriter(shared / 'events')

    def test_reader_waits_for_complete_lines_and_ignores_other_event_types(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            writer = TraceWriter(path)
            reader = TraceReader(path)
            first = json.dumps({'kind': 'thinking', 'text': 'partial'})
            with path.open('a') as stream:
                stream.write(first)
            self.assertEqual(reader.poll(), [])
            with path.open('a') as stream:
                stream.write('\n' + json.dumps({'kind': 'command', 'text': 'never a command'}) + '\n')
            self.assertEqual(reader.poll(), [{'kind': 'thinking', 'text': 'partial'}])
