import unittest
from unittest.mock import Mock

import agent_loop as loop
from test_coding_support import cfg_for


class PublicWebTests(unittest.TestCase):
    def test_native_worker_refuses_an_unsafe_target(self):
        with self.assertRaisesRegex(ValueError, '^Public web read unavailable$'):
            loop.fetch_public_page('https://127.0.0.1/')


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
