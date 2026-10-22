import os

import agent_loop


SELF = {'kind': 'agent', 'sessionId': 'session-worker', 'name': 'Worker'}


def cfg_for(root, **settings):
    config = dict(agent_loop.DEFAULTS)
    config.update(rooms=['room'], dm_rooms=[], self_session_id=SELF['sessionId'], self_name=SELF['name'],
                  state_file=os.path.join(root, 'state.json'), api_base='http://unused.invalid/v1',
                  model='configured-model', cli=['unused'])
    config.update(settings)
    return config


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
