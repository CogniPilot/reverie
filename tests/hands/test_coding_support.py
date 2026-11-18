import copy
import json
import os
from pathlib import Path
import select
import subprocess
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
    config = agent_loop.default_config()
    config.update(rooms=['room'], dm_rooms=[], self_session_id=SELF['sessionId'], self_name=SELF['name'],
                  state_file=os.path.join(root, 'state.json'), api_base='http://unused.invalid/v1',
                  model='configured-model', cli=['unused'])
    config.update(settings)
    return config


class ModelEndpoint:
    def __init__(self, test, *, hold_first=False):
        fixture = Path(__file__).parent / 'fixtures' / 'model_endpoint.mts'
        self.process = subprocess.Popen(
            ['node', '--experimental-strip-types', str(fixture), *(['--hold-first'] if hold_first else [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        test.addCleanup(self.close)
        self.url = self.read_event('ready')['url']

    def read_event(self, kind, timeout=3):
        pipe = self.process.stdout
        if not select.select([pipe], [], [], timeout)[0]:
            raise AssertionError(f'model fixture did not emit {kind}')
        event = json.loads(pipe.readline())
        if event['kind'] != kind:
            raise AssertionError(f'model fixture emitted {event["kind"]} while waiting for {kind}')
        return event

    def receive(self):
        event = self.read_event('request')
        return event['path'], event['payload']

    def wait_disconnected(self):
        self.read_event('disconnected', 2)

    def has_event(self):
        return bool(select.select([self.process.stdout], [], [], 0)[0])

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        finally:
            self.process.stdout.close()


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
