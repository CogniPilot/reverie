import json
import queue
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock

import agent_loop as loop
from attention_wake import AttentionWake, OFFICE_DISABLED_STATUS, OfficePhoneDisabled, wait_for_scan
from test_coding_support import FakeChat, SELF, cfg_for


class AttentionWakeTests(unittest.TestCase):
    def env(self, port=8093):
        return dict(REVERIE_WORKER='1', REVERIE_API_URL=f'http://127.0.0.1:{port}',
                    REVERIE_SESSION_ID='session-worker')

    def test_requires_the_exact_scoped_laptop_phone_and_never_forwards_credentials(self):
        cfg = cfg_for('/unused', phone_wake=True)
        for env in ({}, self.env() | {'REVERIE_SESSION_ID': 'another-session'},
                    self.env() | {'REVERIE_API_URL': 'https://example.invalid'},
                    self.env() | {'REVERIE_API_URL': 'http://user:password@127.0.0.1:8093'},
                    self.env() | {'REVERIE_API_URL': 'http://[bad'}):
            wake = AttentionWake(cfg, env=env).start()
            self.assertIsNone(wake.thread)
            self.assertIn('unavailable', wake.status)
        response = Mock(status=200)
        response.read.return_value = b'{"success":true,"data":{"event":null}}'
        connection = Mock()
        connection.getresponse.return_value = response
        factory = Mock(return_value=connection)
        wake = AttentionWake(cfg, env=self.env() | {'REVERIE_PASSWORD': 'do-not-send'}, connection=factory)
        wake._poll()
        self.assertEqual(connection.request.call_args.args, ('GET', '/api/chatrooms/attention'))
        self.assertEqual(connection.request.call_args.kwargs['headers'], {
            'X-Reverie-Parent-Session': SELF['sessionId'], 'Accept': 'application/json'})
        self.assertNotIn('do-not-send', str(connection.mock_calls))
        connection.close.assert_called_once()

    def test_explicit_office_disabled_response_reports_blocked_replies_and_recovers_without_spam(self):
        disabled = Mock(status=503)
        disabled.read.return_value = json.dumps({
            'success': False, 'error': 'Admin phone wake is not enabled for this instance'}).encode()
        active = Mock(status=200)
        active.read.return_value = b'{"success":true,"data":{"event":null}}'
        connections = [Mock(), Mock(), Mock()]
        for connection, response in zip(connections, [disabled, disabled, active]):
            connection.getresponse.return_value = response
        reports = []
        def report(text):
            reports.append(text)
            if wake.status == 'active':
                wake.stopped.set()
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), report, env=self.env(),
                             connection=Mock(side_effect=connections))
        wake.stopped.wait = Mock(return_value=False)
        wake._run()
        self.assertEqual(len(reports), 2)
        self.assertIn(OFFICE_DISABLED_STATUS, reports[0])
        self.assertNotIn('normal scan', reports[0])
        self.assertNotIn('polling fallback', reports[0])
        self.assertIn('Manual reads and terminal prompts remain available', reports[0])
        self.assertIn('active', reports[1])
        self.assertEqual([call.args[0] for call in wake.stopped.wait.call_args_list], [1, 2, 0.1])
        self.assertFalse(wake.signal.is_set())
        for connection in connections:
            connection.close.assert_called_once()

    def test_other_503_responses_remain_generic_and_never_expose_response_bodies(self):
        response = Mock(status=503)
        connection = Mock()
        connection.getresponse.return_value = response
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), env=self.env(),
                             connection=lambda *a, **k: connection)
        for raw in (b'private backend diagnostic', b'x' * 4097,
                    b'{"success":false,"error":"private backend diagnostic"}',
                    b'{"success":true,"error":"Admin phone wake is not enabled for this instance"}'):
            response.read.return_value = raw
            with self.assertRaises(ValueError) as caught:
                wake._poll()
            self.assertNotIsInstance(caught.exception, OfficePhoneDisabled)
            self.assertNotIn('private backend diagnostic', str(caught.exception))
        self.assertFalse(wake.signal.is_set())

    def test_metadata_is_bounded_validated_and_duplicate_signals_are_coalesced(self):
        response = Mock(status=200)
        connection = Mock()
        connection.getresponse.return_value = response
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), env=self.env(), connection=lambda *a, **k: connection)
        def poll(event):
            response.read.return_value = json.dumps(dict(success=True, data=dict(event=event))).encode()
            wake._poll()
        poll(dict(roomId='room', messageId='message'))
        self.assertTrue(wake.signal.is_set())
        wake.signal.clear()
        poll(dict(roomId='room', messageId='message'))
        self.assertFalse(wake.signal.is_set())
        for event in ({'roomId': 'room', 'messageId': 'other', 'text': 'untrusted'},
                      {'roomId': '../escape', 'messageId': 'other'}):
            with self.assertRaises(ValueError): poll(event)
        response.read.return_value = b'x' * 4097
        with self.assertRaises(ValueError): wake._poll()
        self.assertFalse(wake.signal.is_set())

    def test_real_long_poll_reconnects_after_outage_without_log_spam_and_closes(self):
        ready, finish = threading.Event(), threading.Event()
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                requests.append(self.path)
                if len(requests) == 1:
                    self.send_response(503); self.end_headers(); return
                ready.set()
                finish.wait(2)
                raw = b'{"success":true,"data":{"event":{"roomId":"room","messageId":"message"}}}'
                try:
                    self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers()
                    self.wfile.write(raw)
                except OSError: pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        reports = []
        wake = AttentionWake(cfg_for('/unused', phone_wake=True), reports.append,
                             env=self.env(server.server_port)).start()
        try:
            self.assertTrue(ready.wait(3))
            self.assertEqual(len(reports), 1)
            finish.set()
            self.assertTrue(wake.signal.wait(1))
            deadline = time.monotonic() + 1
            while wake.status != 'active' and time.monotonic() < deadline: time.sleep(0.01)
            self.assertEqual(wake.status, 'active')
            self.assertEqual(len(reports), 2)
            self.assertTrue(all(path == '/api/chatrooms/attention' for path in requests))
        finally:
            wake.close(); finish.set(); server.shutdown(); server.server_close(); thread.join(1)
        self.assertFalse(wake.thread.is_alive())

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
