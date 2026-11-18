import queue
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock

import agent_loop as loop
from agent_loop import AttentionWake, OFFICE_DISABLED_STATUS, wait_for_scan
from test_coding_support import FakeChat, SELF, cfg_for


class AttentionWakeTests(unittest.TestCase):
    def env(self, port=8093):
        return dict(REVERIE_WORKER='1', REVERIE_API_URL=f'http://127.0.0.1:{port}',
                    REVERIE_SESSION_ID='session-worker')

    def test_wrong_parent_session_reports_unscoped(self):
        cfg = cfg_for('/unused', phone_wake=True)
        reports = []
        wake = AttentionWake(cfg, reports.append, env=self.env() | {'REVERIE_SESSION_ID': 'another-session'}).start()
        try:
            wake.thread.join(2)
            self.assertFalse(wake.thread.is_alive())
            self.assertEqual(wake.status, 'unavailable (no scoped laptop phone)')
            self.assertEqual(len(reports), 1)
            self.assertFalse(wake.signal.is_set())
        finally:
            wake.close()

    def test_real_long_poll_handles_oversize_disabled_recovery_and_duplicate_events(self):
        first_event, duplicates_seen, release = (threading.Event() for _ in range(3))
        requests = []
        disabled = b'{"success":false,"error":"Admin phone wake is not enabled for this instance"}'
        event = b'{"success":true,"data":{"event":{"roomId":"room","messageId":"message"}}}'
        oversized = b' ' * (4097 - len(event)) + event
        responses = [(200, oversized), (503, disabled), (503, disabled), (200, event), (200, event)]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                index = len(requests)
                requests.append((self.path, dict(self.headers)))
                if index >= len(responses):
                    duplicates_seen.set()
                    release.wait(2)
                    return
                if index == 4:
                    first_event.wait(2)
                status, raw = responses[index]
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        reports = []
        env = self.env(server.server_port) | {'REVERIE_PASSWORD': 'do-not-send'}
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), reports.append, env=env).start()
        try:
            self.assertTrue(wake.signal.wait(10))
            wake.signal.clear()
            first_event.set()
            self.assertTrue(duplicates_seen.wait(2))
            self.assertFalse(wake.signal.is_set())
            self.assertEqual(wake.status, 'active')
            self.assertEqual(reports, [
                'Phone wake: unavailable; polling fallback; general messages use the normal scan.',
                f'Phone wake: {OFFICE_DISABLED_STATUS}. Manual reads and terminal prompts remain available.',
                'Phone wake: active; general messages use the normal scan.',
            ])
            for path, headers in requests:
                self.assertEqual(path, '/api/chatrooms/attention')
                headers = {key.lower(): value for key, value in headers.items()}
                self.assertEqual(headers['x-reverie-parent-session'], SELF['sessionId'])
                self.assertEqual(headers['accept'], 'application/json')
                self.assertNotIn('authorization', headers)
                self.assertNotIn('cookie', headers)
                self.assertNotIn('do-not-send', str(headers))
        finally:
            wake.close()
            first_event.set()
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(1)

    def test_close_interrupts_a_pending_phone_request(self):
        ready, release = threading.Event(), threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self): ready.set(); release.wait(2)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), env=self.env(server.server_port)).start()
        try:
            self.assertTrue(ready.wait(1))
            started = time.monotonic(); wake.close()
            self.assertLess(time.monotonic() - started, 1)
            self.assertFalse(wake.thread.is_alive())
        finally:
            release.set(); server.shutdown(); server.server_close(); thread.join(1)

    def test_mentions_wake_the_serial_loop_while_the_coding_pump_remains_responsive(self):
        wake = AttentionWake(cfg_for('/unused'))
        view = SimpleNamespace(inputs=queue.Queue(), quit_requested=False)
        manager = SimpleNamespace(active=True, pump=Mock())
        timer = threading.Timer(0.06, wake.signal.set); timer.start()
        started = time.monotonic()
        wait_for_scan(15, wake, view, manager)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertGreater(manager.pump.call_count, 0)
        timer.join()
        wake.signal.clear(); view.inputs.put('terminal prompt')
        started = time.monotonic(); wait_for_scan(15, wake, view, manager)
        self.assertLess(time.monotonic() - started, 0.1)

    def test_signal_and_general_scan_share_the_existing_durable_dedup(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory)
            chat = FakeChat()
            state = {}
            loop.tick(cfg, chat, state, model=lambda *a: {'content': 'reply'})
            chat.add('room', {'kind': 'agent', 'sessionId': 'other', 'name': 'Peer'}, '@Worker help')
            model = Mock(return_value={'content': 'reply'})
            self.assertEqual(loop.tick(cfg, chat, state, model=model), 1)  # event-triggered pass
            self.assertEqual(loop.tick(cfg, chat, state, model=model), 0)  # fallback/duplicate pass
            model.assert_called_once()

    def test_addressed_messages_and_replies_use_the_normal_answer_path(self):
        cfg = cfg_for('/unused')
        message = {'id': 'reply', 'from': {'kind': 'agent', 'sessionId': 'other'}, 'text': 'question'}
        self.assertTrue(loop.wakes(cfg, 'room', dict(message, to=[SELF['sessionId']])))
        self.assertTrue(loop.wakes(cfg, 'room', dict(message, replyTo='own'), [{'id': 'own', 'from': SELF}]))
        self.assertFalse(loop.wakes(cfg, 'room', dict(message, to=['another'])) )
        self.assertFalse(loop.wakes(cfg, 'room', dict(message, text='@Worker-other email@Worker')))

    def test_general_poll_uses_canonical_phone_acceptance_and_rechecks_before_reply(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory)
            chat, state = FakeChat(), {}
            chat.phone_allows = Mock(return_value=True)
            loop.tick(cfg, chat, state)
            muted = chat.add('room', {'kind': 'user', 'name': 'Owner'}, '/code fixture MUTED_HISTORY')
            muted['phoneWake'] = False
            model = Mock(return_value={'content': 'reply'})
            self.assertEqual(loop.tick(cfg, chat, state, model=model), 0)
            model.assert_not_called()
            ordinary = chat.add('room', {'kind': 'agent', 'sessionId': 'peer'}, 'Ring accepts general traffic')
            ordinary['phoneWake'] = True
            self.assertEqual(loop.tick(cfg, chat, state, model=model), 1)
            model.assert_called_once()
            self.assertIn('MUTED_HISTORY', str(model.call_args))  # Normal joined-channel history remains available.
            changed = chat.add('room', {'kind': 'user', 'name': 'Owner'}, '@Worker accepted before phone change')
            changed['phoneWake'] = True
            chat.phone_allows.side_effect = [True, False]
            self.assertEqual(loop.tick(cfg, chat, state, model=model), 0)
            self.assertEqual(len(chat.ours('room')), 1)  # Muted during inference: nothing posted.

    def test_production_phone_metadata_failure_is_closed_instead_of_a_local_policy_guess(self):
        chat = loop.Chat(['unused'], 1)
        chat._run = Mock(return_value='{"messages":[{"id":"message","text":"@Worker guessed"}]}')
        with self.assertRaises(ValueError): chat.read('room', 30)
        cfg = cfg_for('/unused')
        self.assertFalse(loop.alert_allows(cfg, chat, 'room', {'id': 'message'}))
        chat._run.return_value = '{"message":{"id":"message","roomId":"room","phoneWake":false}}'
        self.assertFalse(loop.alert_allows(cfg, chat, 'room', {'id': 'message'}))
        chat._run.return_value = '{"message":{"id":"message","roomId":"room","phoneWake":true}}'
        self.assertTrue(loop.alert_allows(cfg, chat, 'room', {'id': 'message'}))
        self.assertIn('--message', chat._run.call_args.args[0])
