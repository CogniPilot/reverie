"""The harness's human-facing clocks follow the office zone the server reports, by zone name, with UTC alongside."""
import json
import tempfile
import unittest

import agent_loop as loop
from test_coding_support import ChatCliFixture, FakeChat, cfg_for


class OfficeClockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = cfg_for(self.tmp.name)
        self.cfg['timezone'] = 'UTC'  # what the launcher writes

    def test_a_room_read_records_the_zone_the_server_reports(self):
        fixture = ChatCliFixture(self)
        for reply in ({'messages': [], 'timeZone': 'America/Indianapolis'},
                      {'messages': [], 'timeZone': 'Not/AZone'},
                      {'messages': []}):
            fixture.respond(json.dumps(reply))
            fixture.chat.read('room', 5)
            self.assertEqual(fixture.chat.time_zone, 'America/Indianapolis')

    def test_a_pass_over_the_rooms_carries_the_reported_zone_into_the_prompt_clock(self):
        chat = FakeChat()  # a client that reports no zone leaves the configured one in force
        loop.tick(self.cfg, chat, {}, model=lambda *a: {'content': 'reply'})
        self.assertNotIn('_time_zone', self.cfg)
        chat.time_zone = 'America/Indianapolis'
        loop.tick(self.cfg, chat, {}, model=lambda *a: {'content': 'reply'})
        self.assertEqual(self.cfg['_time_zone'], 'America/Indianapolis')
        messages, _ = loop.build_prompt(self.cfg, [], {'text': 'check the clock'}, now=1_793_559_480)
        self.assertIn('Now: Sunday 2026-11-01 1:58 PM EST (18:58 UTC).', messages[0]['content'])


if __name__ == '__main__':
    unittest.main()
