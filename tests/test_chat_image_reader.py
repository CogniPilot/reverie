import copy
import json
from pathlib import Path
import unittest

from reverie.chat_image_paths import ImagePathRefused
from reverie.chat_image_reader import OfficeImageReader


class Response:
    def __init__(self, body, *, status=200, headers=None):
        self.body = body
        self.status = status
        self.headers = headers if headers is not None else [('Content-Length', str(len(body)))]

    def getheaders(self):
        return self.headers

    def read1(self, size):
        part, self.body = self.body[:size], self.body[size:]
        return part


class OfficeImageReaderTests(unittest.TestCase):
    def setUp(self):
        self.scope = {'version': 1, 'sessionId': '11111111-1111-4111-8111-111111111111',
                      'roomId': '22222222-2222-4222-8222-222222222222',
                      'messageId': '33333333-3333-4333-8333-333333333333',
                      'generation': 'a' * 64, 'fileIds': ['44444444-4444-4444-8444-444444444444']}
        self.data = b'\x89PNG\r\n\x1a\nimage fixture'
        self.message = {'success': True, 'data': {'message': {'id': self.scope['messageId'],
                        'attachments': [{'id': self.scope['fileIds'][0], 'type': 'image/png',
                                         'path': '/arbitrary/server/backing/path', 'name': '../../image.exe'}]}}}
        self.responses = []
        self.requests = []
        self.closed = 0
        self.now = 100.0
        owner = self
        class Connection:
            sock = None
            def request(self, method, endpoint, headers):
                owner.requests.append((method, endpoint, headers))
            def getresponse(self):
                return owner.responses.pop(0)
            def close(self):
                owner.closed += 1
        self.reader = OfficeImageReader(Path('/synthetic/office.sock'), self.scope['sessionId'],
                                       connect=lambda *args: Connection(), clock=lambda: self.now)
        self.reader._socket_identity = lambda: (1, 2)

    def metadata(self, message=None, **kwargs):
        return Response(json.dumps(message if message is not None else self.message).encode(), **kwargs)

    def image(self, body=None, **kwargs):
        data = self.data if body is None else body
        kwargs.setdefault('headers', [('Content-Length', str(len(data))), ('Content-Type', 'image/png')])
        return Response(data, **kwargs)

    def fetch(self):
        return self.reader.fetch(self.scope, self.scope['fileIds'][0], 8 * 1024 * 1024)

    def test_exact_message_then_file_then_message_use_only_fixed_scoped_endpoints(self):
        self.responses = [self.metadata(), self.image(), self.metadata()]
        self.assertEqual(self.fetch(), self.data)
        base = '/api/v1/chatrooms/' + self.scope['roomId']
        self.assertEqual([row[1] for row in self.requests],
                         [base + '/messages/' + self.scope['messageId'],
                          base + '/files/' + self.scope['fileIds'][0],
                          base + '/messages/' + self.scope['messageId']])
        self.assertTrue(all(row[0] == 'GET' for row in self.requests))
        self.assertTrue(all(set(row[2]) == {'Accept-Encoding', 'Connection'} for row in self.requests))
        self.assertEqual(self.closed, 3)

    def test_other_session_is_refused_before_any_http(self):
        self.scope['sessionId'] = '55555555-5555-4555-8555-555555555555'
        with self.assertRaises(ImagePathRefused):
            self.fetch()
        self.assertEqual(self.requests, [])

    def test_foreign_file_id_is_refused_before_http(self):
        with self.assertRaises(ImagePathRefused):
            self.reader.fetch(self.scope, '55555555-5555-4555-8555-555555555555', 100)
        self.assertEqual(self.requests, [])

    def test_initial_nonmember_refusal_does_not_fetch_bytes(self):
        self.responses = [self.metadata(status=403)]
        with self.assertRaises(ImagePathRefused):
            self.fetch()
        self.assertEqual(len(self.requests), 1)

    def test_wrong_message_deleted_or_unlinked_file_refuses(self):
        for field, value in (('id', self.scope['roomId']), ('deleted', True), ('attachments', [])):
            with self.subTest(field=field):
                message = copy.deepcopy(self.message)
                message['data']['message'][field] = value
                self.responses = [self.metadata(message)]
                with self.assertRaises(ImagePathRefused):
                    self.fetch()

    def test_duplicate_reference_refuses(self):
        self.message['data']['message']['attachments'] *= 2
        self.responses = [self.metadata()]
        with self.assertRaises(ImagePathRefused):
            self.fetch()

    def test_revoke_after_binary_fetch_refuses(self):
        self.responses = [self.metadata(), self.image(), self.metadata(status=403)]
        with self.assertRaises(ImagePathRefused):
            self.fetch()
        self.assertEqual(len(self.requests), 3)

    def test_delete_after_binary_fetch_refuses(self):
        removed = copy.deepcopy(self.message)
        removed['data']['message']['deleted'] = True
        self.responses = [self.metadata(), self.image(), self.metadata(removed)]
        with self.assertRaises(ImagePathRefused):
            self.fetch()

    def test_redirect_refuses_without_following_location(self):
        self.responses = [self.metadata(), self.image(status=302, headers=[('Location', 'https://foreign.invalid')])]
        with self.assertRaises(ImagePathRefused):
            self.fetch()
        self.assertEqual(len(self.requests), 2)

    def test_binary_length_encoding_and_duplicate_headers_refuse(self):
        for headers in ([('Content-Type', 'image/png')],
                        [('Content-Length', '100'), ('Content-Type', 'image/png')],
                        [('Content-Length', str(len(self.data))), ('Content-Encoding', 'gzip')],
                        [('Content-Length', '1'), ('Content-Length', '1')],
                        [('Content-Length', str(len(self.data))), ('Transfer-Encoding', 'chunked')]):
            with self.subTest(headers=headers):
                self.responses = [self.metadata(), self.image(headers=headers)]
                with self.assertRaises(ImagePathRefused):
                    self.fetch()

    def test_disguised_svg_or_mismatched_mime_refuses(self):
        for data in (b'<svg></svg>', b'GIF89a rest'):
            with self.subTest(data=data):
                self.responses = [self.metadata(), self.image(data)]
                with self.assertRaises(ImagePathRefused):
                    self.fetch()

    def test_socket_binding_change_refuses_body(self):
        calls = 0
        def identity():
            nonlocal calls
            calls += 1
            return (1, calls)
        self.reader._socket_identity = identity
        self.responses = [self.metadata()]
        with self.assertRaises(ImagePathRefused):
            self.fetch()

    def test_total_deadline_refuses_even_when_small_chunks_arrive(self):
        owner = self
        class Slow(Response):
            def read1(self, size):
                owner.now += 6
                return super().read1(1)
        raw = json.dumps(self.message).encode()
        self.responses = [Slow(raw)]
        with self.assertRaisesRegex(ImagePathRefused, 'timeout'):
            self.fetch()


if __name__ == '__main__':
    unittest.main()
