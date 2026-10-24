import io
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import agent_loop as loop
import launcher
from debug_terminal import DebugTerminal
from model_events import TraceWriter
from test_coding_support import FakeChat, cfg_for


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = cfg_for(self.tmp.name)
        self.output = io.StringIO()
        self.view = DebugTerminal(self.cfg, output=self.output, interactive=False).start()
        self.cfg['_terminal'] = self.view

    def test_shows_running_harness_and_distinguishes_configured_and_reported_model(self):
        self.assertIn('Reverie Harness / Python PID', self.output.getvalue())
        self.assertIn('configured model: configured-model', self.output.getvalue())
        self.assertIn('API-reported model: unverified', self.output.getvalue())
        self.assertIn('60000 characters', self.output.getvalue())
        self.view.event('model_done', seconds=0.125, model='server-model',
                        usage={'prompt_tokens': 10, 'completion_tokens': 3, 'extra': 'ignored'})
        self.assertIn('API-reported model: server-model', self.view.summary())
        self.assertIn('prompt_tokens=10', self.view.summary())
        self.assertNotIn('extra', self.view.summary())

    def test_trace_is_coalesced_bounded_and_drained_before_model_done(self):
        path = Path(self.tmp.name) / 'events.jsonl'
        view = DebugTerminal(dict(self.cfg, model_events_file=str(path)), output=self.output, interactive=False)
        writer = TraceWriter(path)
        writer.write('thinking', 'first ')
        view.poll_trace()
        writer.write('thinking', 'second')
        writer.write('answer', 'final answer')
        view.event('model_done', seconds=0.1)
        self.assertEqual([record[1] for record in view.records], ['thinking', 'answer', 'model_done'])
        self.assertEqual(view.records[0][2], 'Thinking\nfirst second')
        self.assertEqual(view.records[1][2], 'Answer stream\nfinal answer')
        for _ in range(10):
            writer.write('thinking', 'x' * 4096); view.poll_trace()
        self.assertLessEqual(len(view.records[-1][2]), 12009)
        self.assertIn('earlier trace text omitted', view.records[-1][2])
        self.assertEqual(view.replies, 0)

    def test_terminal_prompt_preempts_background_model_before_inference(self):
        observed = []
        class Manager:
            def before_chat(self): observed.append('preempted')
        self.cfg['_coding_manager'] = Manager()
        def model(*args):
            self.assertEqual(observed, ['preempted'])
            return {'content': 'local answer'}
        loop.terminal_prompt(self.cfg, 'local question', [], model=model)

    def test_redacts_credentials_and_prevents_terminal_escape_injection(self):
        with patch.dict(os.environ, {'FIXTURE_KEY': 'fixture-private-key', 'REVERIE_PASSWORD': 'fixture-password'}):
            cfg = dict(self.cfg, model_key_env='FIXTURE_KEY',
                       api_base='https://person:secret@model.invalid/v1?token=another-secret')
            view = DebugTerminal(cfg, output=self.output, interactive=False).start()
        view.event('error', text='fixture-private-key fixture-password Bearer abc123 token=hidden '
                   '\x1b]52;c;clipboard-content\x07\x1b[31mRED\x1b[0m')
        text = self.output.getvalue()
        for secret in ('fixture-private-key', 'fixture-password', 'person:secret', 'another-secret', 'abc123',
                       'token=hidden', '\x1b', 'clipboard-content'):
            self.assertNotIn(secret, text)
        self.assertIn('https://model.invalid/v1', text)
        self.assertIn('RED', text)
        self.assertEqual(view.errors, 1)

    def test_terminal_conversation_is_bounded_and_does_not_post_to_chat(self):
        calls, history = [], []
        def model(cfg, messages, tools):
            calls.append(messages)
            return {'content': 'A local answer.', '_model': 'server-model'}
        with patch.object(FakeChat, 'say', side_effect=AssertionError('terminal must not post')):
            loop.terminal_prompt(self.cfg, 'first question', history, model=model)
            loop.terminal_prompt(self.cfg, 'second question', history, model=model)
        self.assertIn('first question', calls[1][1]['content'])
        self.assertIn('second question', calls[1][1]['content'])
        self.assertEqual(self.view.replies, 0)
        self.assertIn('Worker [terminal; terminal]', self.output.getvalue())
        state = Path(self.cfg['state_file'])
        state.write_text('{"room": "keep"}')
        loop.terminal_prompt(self.cfg, '/clear', history, model=model)
        self.assertEqual(history, [])
        self.assertEqual(state.read_text(), '{"room": "keep"}')
        loop.terminal_prompt(self.cfg, '/quit', history, model=model)
        self.assertTrue(self.view.quit_requested)

    def test_debug_commands_do_not_call_model_or_enable_coding(self):
        def forbidden(*args):
            raise AssertionError('debug commands must not invoke inference')
        history = []
        for text in ('/help', '/status', '/not-a-command'):
            loop.terminal_prompt(self.cfg, text, history, model=forbidden)
        self.assertEqual(history, [])
        self.assertIn('Unknown terminal command', self.output.getvalue())
        self.assertIn('Coding: off', self.output.getvalue())
        for _ in range(300):
            self.view.event('note', text='bounded')
        self.assertEqual(len(self.view.records), 200)

    def test_room_transcript_is_linked_and_only_counts_confirmed_posts(self):
        chat = FakeChat()
        state = {}
        loop.tick(self.cfg, chat, state)
        msg = chat.add('room', {'kind': 'user', 'name': 'Owner'}, 'Please answer.')
        loop.tick(self.cfg, chat, state, model=lambda *a: {'content': 'Confirmed answer.'})
        self.assertEqual(chat.ours('room')[0]['replyTo'], msg['id'])
        self.assertEqual(self.view.replies, 1)
        self.assertIn('Please answer.', self.output.getvalue())
        self.assertIn('Confirmed answer.', self.output.getvalue())

    def test_display_failure_cannot_prevent_a_room_reply(self):
        class BrokenView:
            def event(self, *args, **kwargs):
                raise RuntimeError('synthetic display failure')
        self.cfg['_terminal'] = BrokenView()
        chat, state = FakeChat(), {}
        loop.tick(self.cfg, chat, state)
        chat.add('room', {'kind': 'user', 'name': 'Owner'}, 'Please answer.')
        self.assertEqual(loop.tick(self.cfg, chat, state, model=lambda *a: 'Still answered.'), 1)

    def test_launcher_forwards_terminal_options(self):
        previous = os.umask(0o077)
        try:
            with patch.object(sys, 'argv', ['reverie-harness', '--no-tui', '--once']), \
                    patch.object(launcher, 'prepare', return_value=Path('/fixture/agent.json')), \
                    patch.object(loop, 'main', return_value=0) as run:
                self.assertEqual(launcher.main(), 0)
                run.assert_called_once_with(['hands', '/fixture/agent.json', '--no-tui', '--once'])
        finally:
            os.umask(previous)


@unittest.skipUnless(os.name == 'posix', 'real PTY test needs POSIX')
class TerminalPTYTests(unittest.TestCase):
    def test_ctrl_c_during_model_request_restores_the_terminal(self):
        import fcntl
        import pty
        import termios
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'model-started'
            config = root / 'agent.json'
            config.write_text(json.dumps(cfg_for(directory, poll_s=1)))
            driver = root / 'driver.py'
            driver.write_text(
                f'import sys,time\nfrom pathlib import Path\nsys.path.insert(0,{str(Path(loop.__file__).parent)!r})\n'
                'import agent_loop as loop\noriginal=loop.terminal_prompt\n'
                'def slow(*args):\n'
                f' Path({str(marker)!r}).touch()\n time.sleep(60)\n return {{"content":"late"}}\n'
                'loop.tick=lambda *args,**kwargs: 0\n'
                'loop.terminal_prompt=lambda cfg,text,history: original(cfg,text,history,model=slow)\n'
                f'raise SystemExit(loop.main(["reverie-harness",{str(config)!r}]))\n')
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
            process = subprocess.Popen([sys.executable, str(driver)], stdin=slave, stdout=slave, stderr=slave,
                                       start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color'})
            os.close(slave)
            data = bytearray()
            try:
                os.write(master, b'wait for cancellation\n')
                until = time.monotonic() + 8
                while not marker.exists() and time.monotonic() < until:
                    if select.select([master], [], [], 0.1)[0]:
                        data.extend(os.read(master, 65536))
                self.assertTrue(marker.exists(), data.decode(errors='replace'))
                process.send_signal(signal.SIGINT)
                self.assertEqual(process.wait(timeout=3), 0)
                flags = termios.tcgetattr(master)[3]
                self.assertTrue(flags & termios.ECHO)
                self.assertTrue(flags & termios.ICANON)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3)
                os.close(master)

    def test_real_terminal_room_polling_local_input_resize_and_clean_exit(self):
        import curses
        import fcntl
        import pty
        import termios
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requests = []
            release = threading.Event()
            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):
                    requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    first = {'choices': [{'delta': {'reasoning_content': 'Checking the fixture before answering.'}}]}
                    self.wfile.write(b'data: ' + json.dumps(first).encode() + b'\n\n'); self.wfile.flush()
                    if len(requests) == 1: release.wait(4)
                    final = {'model': 'fixture-served-model',
                             'choices': [{'delta': {'content': 'Synthetic model reply.'}, 'finish_reason': 'stop'}],
                             'usage': {'prompt_tokens': 12, 'completion_tokens': 4}}
                    self.wfile.write(b'data: ' + json.dumps(final).encode() + b'\n\ndata: [DONE]\n\n'); self.wfile.flush()
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            history_file, posts = root / 'messages.json', root / 'posts.jsonl'
            history_file.write_text('[]')
            cli = root / 'chat.py'
            cli.write_text(
                'import json,sys\nfrom pathlib import Path\n'
                f'history=Path({str(history_file)!r}); posts=Path({str(posts)!r})\n'
                'if sys.argv[1]=="read":\n'
                ' print(json.dumps({"messages":json.loads(history.read_text()),'
                '"members":[{"sessionId":"session-worker","name":"Worker"}]}))\n'
                'elif sys.argv[1]=="say":\n'
                ' with posts.open("a") as f:f.write(json.dumps(sys.argv[2:])+"\\n")\n'
                ' print(json.dumps({"message":{"id":"confirmed-reply"}}))\n')
            cfg = cfg_for(directory, poll_s=1, api_base=f'http://127.0.0.1:{server.server_port}/v1',
                          model_events_file=str(root / 'model-events.jsonl'),
                          cli=[sys.executable, str(cli)])
            cfg_path = root / 'agent.json'
            cfg_path.write_text(json.dumps(cfg))
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 110, 0, 0))
            process = subprocess.Popen([sys.executable, '-u', loop.__file__, str(cfg_path)],
                                       stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                       env={**os.environ, 'TERM': 'xterm-256color'})
            os.close(slave)
            data = bytearray()
            def collect_until(predicate, seconds=12):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            data.extend(os.read(master, 65536))
                        except OSError:
                            time.sleep(0.01)  # PTY may close just before the child is reaped.
                    if predicate():
                        return
                self.fail('terminal condition timed out: ' + data.decode(errors='replace')[-2000:])
            try:
                collect_until(lambda: Path(cfg['state_file']).exists())
                history_file.write_text(json.dumps([{'id': 'room-turn', 'at': time.time() * 1000,
                                                      'from': {'kind': 'user', 'name': 'Owner'},
                                                      'text': 'A room question.'}]))
                collect_until(lambda: b'Checking the fixture' in data)
                self.assertFalse(posts.exists())  # Reasoning is visible while inference is still running.
                release.set()
                collect_until(lambda: posts.exists())
                posted = json.loads(posts.read_text().splitlines()[0])
                self.assertEqual(posted[posted.index('--reply-to') + 1], 'room-turn')
                os.write(master, b'hello from the terminal\n')
                collect_until(lambda: len(requests) >= 2)
                self.assertIn('hello from the terminal', requests[1]['messages'][1]['content'])
                self.assertEqual(len(posts.read_text().splitlines()), 1)
                self.assertEqual(requests[1]['model'], 'configured-model')
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 50, 0, 0))
                process.send_signal(signal.SIGWINCH)
                os.write(master, b'/status\n')
                collect_until(lambda: b'fixture-served-model' in data)
                os.write(master, b'/quit\n')
                collect_until(lambda: process.poll() is not None)
                self.assertEqual(process.returncode, 0)
                output = data.decode(errors='replace')
                self.assertIn('Reverie Harness', output)
                self.assertIn('Synthetic model reply.', output)
                self.assertIn('Reverie Harness stopped.', output)
                self.assertNotIn('Traceback', output)
            finally:
                release.set()
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                os.close(master)


if __name__ == '__main__':
    unittest.main()
