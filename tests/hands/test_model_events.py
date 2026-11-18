import json
import os
from pathlib import Path
import tempfile
import unittest

from model_events import TraceReader


def append(path, kind, text):
    path.touch(mode=0o600, exist_ok=True)
    with path.open('a') as stream:
        stream.write(json.dumps({'kind': kind, 'text': text}) + '\n')


class ModelEventTests(unittest.TestCase):
    def test_reader_tails_new_events_and_never_replays_earlier_reasoning(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            append(path, 'thinking', 'old private thought')
            reader = TraceReader(path)
            self.assertEqual(reader.poll(), [])
            append(path, 'thinking', 'new thought')
            append(path, 'answer', 'answer')
            self.assertEqual(reader.poll(), [{'kind': 'thinking', 'text': 'new thought'},
                                             {'kind': 'answer', 'text': 'answer'}])
            self.assertEqual(reader.poll(), [])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_reader_started_before_file_reads_first_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            reader = TraceReader(path)
            self.assertEqual(reader.poll(), [])
            append(path, 'answer', 'first answer')
            self.assertEqual(reader.poll(), [{'kind': 'answer', 'text': 'first answer'}])

    def test_reader_removes_credentials_and_terminal_controls_from_old_traces(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            append(path, 'answer', 'Authorization: Bearer another-token\r\x07\x1b\x00')
            events = TraceReader(path, from_end=False).poll()
            text = ''.join(event['text'] for event in events)
            self.assertNotIn('another-token', text)
            self.assertNotIn('\x1b', text)
            self.assertNotIn('\x00', text)
            self.assertNotIn('\r', text)
            self.assertIn('[redacted]', text)

    def test_wrap_is_bounded_and_reader_detects_generation_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            path.touch(mode=0o600)
            path.write_text('{"reset": "initial"}\n')
            append(path, 'answer', 'initial')
            reader = TraceReader(path)
            path.write_text('{"reset": "next"}\n')
            append(path, 'answer', '29' + 'x' * 100)
            events = reader.poll()
            self.assertTrue(events)
            self.assertTrue(events[-1]['text'].startswith('29'))
            self.assertEqual(reader.poll(), [])

    def test_unsafe_paths_and_files_are_refused_without_changing_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'; target.write_text('private'); target.chmod(0o600)
            alias = root / 'alias'; alias.symlink_to(target)
            with self.assertRaises((ValueError, OSError)):
                TraceReader(alias)
            target.chmod(0o644)
            with self.assertRaises(ValueError):
                TraceReader(target)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            target.chmod(0o600)
            hardlink = root / 'hardlink'; os.link(target, hardlink)
            with self.assertRaises(ValueError):
                TraceReader(target)
            fifo = root / 'fifo'; os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError):
                TraceReader(fifo)
            shared = root / 'shared'; shared.mkdir(mode=0o755)
            shared.chmod(0o755)  # Make the unsafe fixture explicit even under an owner-private umask.
            with self.assertRaises(ValueError):
                TraceReader(shared / 'events')

    def test_reader_waits_for_complete_lines_and_ignores_other_event_types(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            path.touch(mode=0o600)
            reader = TraceReader(path)
            first = json.dumps({'kind': 'thinking', 'text': 'partial'})
            with path.open('a') as stream:
                stream.write(first)
            self.assertEqual(reader.poll(), [])
            with path.open('a') as stream:
                stream.write('\n' + json.dumps({'kind': 'command', 'text': 'never a command'}) + '\n')
            self.assertEqual(reader.poll(), [{'kind': 'thinking', 'text': 'partial'}])
