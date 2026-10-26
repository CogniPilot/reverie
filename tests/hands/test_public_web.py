import json
from pathlib import Path
import socket
import ssl
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import agent_loop as loop
import public_web as web
from reverie.hands.launcher import runtime_settings
from test_coding_support import cfg_for


PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.215.14', 443))]


class PublicWebTests(unittest.TestCase):
    def response(self, body=b'<p>News</p>', status=200, headers=None):
        response = Mock(status=status)
        values = {'Content-Type': 'text/html', **(headers or {})}
        response.getheader.side_effect = lambda key, default=None: values.get(key, default)
        response.read.return_value = body
        connection = Mock(); connection.getresponse.return_value = response
        return connection, response

    def test_public_only_including_transition_and_multicast_addresses(self):
        for address in ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
                        '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fc00::1', 'ff02::1',
                        '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1']:
            self.assertFalse(web.public_address(address), address)
        self.assertTrue(web.public_address('93.184.215.14'))
        self.assertTrue(web.public_address('2606:4700:4700::1111'))

    def test_url_refuses_auth_private_protocol_ports_controls_and_fragments(self):
        for value in ['file:///etc/passwd', 'http://example.com', 'https://u:p@example.com', 'https://example.com:444/',
                      'https://example.com/#fragment', 'https://example.com/\r\nHeader:x', 'https://example.com\\x', 'x' * 2049]:
            with self.assertRaises((ValueError, UnicodeError)): web.target(value)

    def test_mixed_dns_and_private_literal_refuse_before_connect(self):
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1']:
            with patch.object(web, '_resolve', return_value=PUBLIC + [(socket.AF_INET, 1, 6, '', (address, 443))]), \
                    patch.object(web, '_PinnedHTTPS') as connection:
                with self.assertRaises(ValueError): web.fetch('https://example.com/')
                connection.assert_not_called()

    def test_checked_address_is_pinned_and_tls_keeps_hostname_verification(self):
        connection = web._PinnedHTTPS('example.com', socket.AF_INET, ('93.184.215.14', 443))
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        raw, tls = Mock(), Mock()
        with patch.object(web.socket, 'socket', return_value=raw), patch.object(connection._context, 'wrap_socket', return_value=tls) as wrap:
            connection.connect()
        raw.connect.assert_called_once_with(('93.184.215.14', 443))
        wrap.assert_called_once_with(raw, server_hostname='example.com')
        self.assertIs(connection.sock, tls)

    def test_bounded_get_has_no_proxy_cookie_auth_or_redirect_and_drops_scripts(self):
        connection, response = self.response(b'<script>EVIL()</script><h1>Public news</h1><p>Current facts</p>')
        with patch.object(web, '_resolve', return_value=PUBLIC), patch.object(web, '_PinnedHTTPS', return_value=connection) as factory:
            result = web.fetch('https://example.com/news')
        factory.assert_called_once_with('example.com', socket.AF_INET, ('93.184.215.14', 443))
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ('GET', '/news'))
        self.assertEqual(set(kwargs['headers']), {'Accept', 'Accept-Encoding', 'User-Agent'})
        response.read.assert_called_once_with(web.BYTE_CAP + 1)
        self.assertIn('Untrusted public web text', result)
        self.assertIn('Public news', result); self.assertNotIn('EVIL', result)
        connection.close.assert_called_once()

    def test_redirect_encoded_and_binary_responses_are_refused(self):
        for status, headers, body in [(302, {}, b''), (200, {'Content-Type': 'application/pdf'}, b'pdf'),
                (200, {'Content-Encoding': 'gzip'}, b'compressed')]:
            connection, _ = self.response(body, status, headers)
            with patch.object(web, '_resolve', return_value=PUBLIC), patch.object(web, '_PinnedHTTPS', return_value=connection):
                with self.assertRaises(ValueError): web.fetch('https://example.com/')
            connection.close.assert_called_once()

    def test_large_page_is_a_bounded_explicit_partial_not_a_complete_page_claim(self):
        connection, response = self.response(b'x' * (web.BYTE_CAP + 1), headers={'Content-Length': str(web.BYTE_CAP + 1000)})
        with patch.object(web, '_resolve', return_value=PUBLIC), patch.object(web, '_PinnedHTTPS', return_value=connection):
            text = web.fetch('https://example.com/')
        response.read.assert_called_once_with(web.BYTE_CAP + 1)
        self.assertIn('Partial page', text)
        self.assertLess(len(text), web.TEXT_CAP + web.URL_CAP + 256)

    def test_whole_deadline_includes_dns(self):
        with patch.object(web, 'TIMEOUT', .03), patch.object(web, '_resolve', side_effect=lambda *a, **k: time.sleep(.2)):
            before = time.monotonic()
            with self.assertRaises(TimeoutError): web.fetch('https://example.com/')
            self.assertLess(time.monotonic() - before, .15)

    def test_dns_child_is_fixed_bounded_and_does_not_inherit_credentials_or_proxies(self):
        result = Mock(returncode=0, stdout=json.dumps(PUBLIC).encode())
        with patch.object(web.subprocess, 'run', return_value=result) as run:
            self.assertEqual(web._resolve('example.com')[0][-1], ['93.184.215.14', 443])
        args, kwargs = run.call_args
        self.assertEqual(args[0][-1], 'example.com'); self.assertEqual(args[0][1:4], ['-I', '-B', '-c'])
        self.assertEqual(set(kwargs['env']), {'PATH', 'LANG'}); self.assertEqual(kwargs['timeout'], web.TIMEOUT)

    def test_managed_settings_persist_explicit_endpoint_and_default_off(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runtime-settings.json'
            settings = {'search': True, 'search_url': 'http://127.0.0.1:8080', 'web_fetch': True, 'search_max_calls': 2}
            path.write_text(json.dumps(settings)); path.chmod(0o600)
            self.assertEqual(runtime_settings(path), settings)
            for invalid in [{'search': True}, {'web_fetch': 1}, {'search_url': 'https://user:secret@example.com'},
                            {'search_max_calls': 100}, {'search_timeout_s': 0}, {'search_max_bytes': 99999999}]:
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError): runtime_settings(path)
        self.assertFalse(loop.DEFAULTS['search']); self.assertFalse(loop.DEFAULTS['web_fetch'])

    def test_web_fetch_is_offered_without_workspace_authority_and_stops_at_budget(self):
        cfg = cfg_for('/unused', web_fetch=True, search=False, search_max_calls=1, cli=[])
        cfg['_turn_summary'] = lambda: ''
        seen = []
        outputs = iter([{'tool_calls': [{'id': 'fetch', 'function': {'name': 'web_fetch', 'arguments': '{"url":"https://example.com/news"}'}}]},
                        {'content': 'News answer.'}])
        def model(config, messages, tools):
            seen.append((messages, tools)); return next(outputs)
        fetch = Mock(return_value='Public result')
        answer, size, count = loop.answer(cfg, 'room', [], {'id': 'q', 'at': 1, 'text': 'News?', 'from': {'kind': 'user'}},
                                          model, Mock(side_effect=AssertionError('search must stay off')), fetch=fetch)
        self.assertEqual([x['function']['name'] for x in seen[0][1]], ['web_fetch'])
        self.assertIsNone(seen[1][1]); fetch.assert_called_once_with('https://example.com/news')
        self.assertEqual(count, 1); self.assertEqual(answer, '[web] News answer.')
        self.assertLessEqual(size, cfg['prompt_cap_chars'])
