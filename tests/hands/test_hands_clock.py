"""The harness's human-facing clocks follow the office zone the server reports, by zone name, with UTC alongside."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import agent_loop as loop
from test_coding_support import FakeChat, cfg_for


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp()


class OfficeClockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = cfg_for(self.tmp.name)
        self.cfg['timezone'] = 'UTC'  # what the launcher writes

    def test_now_line_uses_the_reported_office_zone_and_shows_utc(self):
        self.cfg['_time_zone'] = 'America/Indianapolis'
        self.assertEqual(loop.now_line(self.cfg, at('2026-11-01T18:58:00')),
                         'Now: Sunday 2026-11-01 1:58 PM EST (18:58 UTC).')

    def test_the_zone_name_carries_the_daylight_saving_change(self):
        # 1:30 AM happens twice on the night the clocks go back: first as EDT, an hour later as EST.
        self.cfg['_time_zone'] = 'America/Indianapolis'
        self.assertEqual(loop.now_line(self.cfg, at('2026-11-01T05:30:00')),
                         'Now: Sunday 2026-11-01 1:30 AM EDT (05:30 UTC).')
        self.assertEqual(loop.now_line(self.cfg, at('2026-11-01T06:30:00')),
                         'Now: Sunday 2026-11-01 1:30 AM EST (06:30 UTC).')
        self.assertEqual(loop.clock(self.cfg, at('2026-10-31T18:58:00') * 1000), '2:58 PM EDT')
        self.assertEqual(loop.clock(self.cfg, at('2026-11-01T18:58:00') * 1000), '1:58 PM EST')

    def test_without_a_valid_reported_zone_the_configured_zone_is_used(self):
        for reported in (None, '', 'Mars/Phobos', 'x' * 101, 5, '-05:00'):
            self.cfg['_time_zone'] = reported
            self.assertEqual(loop.now_line(self.cfg, at('2026-11-01T18:58:00')),
                             'Now: Sunday 2026-11-01 6:58 PM UTC (18:58 UTC).', reported)

    def test_a_room_read_records_the_zone_the_server_reports(self):
        chat = loop.Chat(['reverie', 'agent', 'chat'], 5)
        replies = iter([{'messages': [], 'timeZone': 'America/Indianapolis'},
                        {'messages': [], 'timeZone': 'Not/AZone'},
                        {'messages': []}])
        with patch.object(loop.Chat, '_run', lambda _self, _args: json.dumps(next(replies))):
            chat.read('room', 5)
            self.assertEqual(chat.time_zone, 'America/Indianapolis')
            chat.read('room', 5)  # an unknown name never replaces a good one
            chat.read('room', 5)
        self.assertEqual(chat.time_zone, 'America/Indianapolis')

    def test_a_pass_over_the_rooms_carries_the_reported_zone_into_the_prompt_clock(self):
        chat = FakeChat()  # a client that reports no zone leaves the configured one in force
        loop.tick(self.cfg, chat, {}, model=lambda *a: {'content': 'reply'})
        self.assertNotIn('_time_zone', self.cfg)
        chat.time_zone = 'America/Indianapolis'
        loop.tick(self.cfg, chat, {}, model=lambda *a: {'content': 'reply'})
        self.assertEqual(self.cfg['_time_zone'], 'America/Indianapolis')
        self.assertTrue(loop.now_line(self.cfg, at('2026-11-01T18:58:00')).endswith('1:58 PM EST (18:58 UTC).'))


if __name__ == '__main__':
    unittest.main()
