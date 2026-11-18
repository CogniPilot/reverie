import copy
import http.server
import itertools
import json
import os
import queue
import select
import threading
import time
from unittest.mock import patch

import agent_loop


SELF = {'kind': 'agent', 'sessionId': 'session-worker', 'name': 'Worker'}


def without_seat_environment(test):
    """Run `test` without the REVERIE_* a live seat exports, restored afterwards. tests/__init__ strips them only when the
    suite runs as the tests package; run from tests/hands, a seat's own session and worker flags would reach the code."""
    environment = patch.dict(os.environ)
    environment.start()
    test.addCleanup(environment.stop)
    for key in [key for key in os.environ if key.startswith('REVERIE_')]:
        del os.environ[key]


def cfg_for(root, **settings):
    config = dict(agent_loop.DEFAULTS)
    config.update(rooms=['room'], dm_rooms=[], self_session_id=SELF['sessionId'], self_name=SELF['name'],
                  state_file=os.path.join(root, 'state.json'), api_base='http://unused.invalid/v1',
                  model='configured-model', cli=['unused'])
    config.update(settings)
    return config


class ModelEndpoint:
    def __init__(self, test, *, hold_first=False):
        self.requests = queue.Queue()
        self.release = threading.Event()
        self.disconnected = threading.Event()
        sequence = itertools.count()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                first = next(sequence) == 0
                fixture.requests.put((self.path, request))
                if hold_first and first:
                    until = time.monotonic() + 5
                    while time.monotonic() < until and not fixture.release.is_set():
                        readable, _, _ = select.select([self.connection], [], [], .01)
                        if not readable:
                            continue
                        try:
                            closed = not self.connection.recv(1)
                        except ConnectionResetError:
                            closed = True
                        if closed:
                            fixture.disconnected.set()
                            return
                if request.get('stream'):
                    event = {'choices': [{'index': 0, 'delta': {'content': 'Done.'}, 'finish_reason': 'stop'}]}
                    body = ('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode()
                else:
                    body = json.dumps({'choices': [{'message': {'content': 'Done.'}}]}).encode()
                try:
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'
        test.addCleanup(self.close)

    def receive(self):
        return self.requests.get(timeout=3)

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


def wait_model_reply(arbiter):
    until = time.monotonic() + 4
    while (result := arbiter.poll()) is None:
        if time.monotonic() >= until:
            raise AssertionError('model slot did not return a result')
        time.sleep(.005)
    return result


class FakeChat:
    def __init__(self):
        self.rooms = {}
        self.sequence = 1000
        self.member = []
        self.fail_say = 0

    def add(self, room, sender, text):
        self.sequence += 1000
        message = {'id': 'message-' + str(self.sequence), 'roomId': room, 'at': self.sequence,
                   'from': sender, 'text': text}
        self.rooms.setdefault(room, []).append(message)
        return message

    def member_rooms(self):
        return self.member

    def member_alert(self, room, session_id):
        return {'lease': None, 'name': SELF['name'], 'unique': True}

    def read(self, room, count):
        return self.rooms.get(room, [])[-count:]

    def exact_message(self, room, message_id):
        selected = [m for m in self.rooms.get(room, []) if m['id'] == message_id]
        if len(selected) != 1:
            raise ValueError('no exact fixture message')
        message = copy.deepcopy(selected[0])
        message.setdefault('phoneWake', True)  # This fixture models a ringing phone.
        return message

    def say(self, room, text, reply_to=None):
        if self.fail_say:
            self.fail_say -= 1
            raise RuntimeError('synthetic post failure')
        message = self.add(room, SELF, text)
        if reply_to is not None:
            message['replyTo'] = reply_to
        return message

    def ours(self, room):
        return [message for message in self.rooms.get(room, []) if message['from'] is SELF]
