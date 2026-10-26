import copy
import json
import subprocess
import unittest
from unittest.mock import Mock, patch

import agent_loop as loop
from test_coding_support import cfg_for


class TurnSummaryTests(unittest.TestCase):
    def test_cli_is_read_only_and_timeout_is_bounded(self):
        cfg = cfg_for('/tmp/fixture')
        messages = [{'role': 'system', 'content': 'rules'}, {'role': 'user', 'content': 'task'}]
        original = copy.deepcopy(messages)
        response = Mock(returncode=0, stdout=json.dumps({'text': 'ring: one pending', 'total': 1}), stderr='')
        with patch.object(loop.subprocess, 'run', return_value=response) as run:
            request = loop.turn_context(cfg, messages)
        self.assertEqual(run.call_args.args[0], ['unused', 'summary', '--json'])
        self.assertEqual(run.call_args.kwargs['timeout'], 2)
        self.assertIn('untrusted', request[2]['content'])
        self.assertIn('one pending', request[2]['content'])
        self.assertEqual(messages, original)

    def test_failure_replaces_stale_snapshot_and_preserves_budget(self):
        cfg = cfg_for('/tmp/fixture', prompt_cap_chars=500)
        messages = [{'role': 'system', 'content': 'rules'}, {'role': 'user', 'content': 'task'}]
        with patch.object(loop.Chat, 'turn_summary', side_effect=['x' * 9000, subprocess.TimeoutExpired('fixture', 2)]) as fetch:
            first = loop.turn_context(cfg, messages)
            second = loop.turn_context(cfg, messages)
        self.assertLessEqual(loop.request_chars(first), 500)
        self.assertIn('truncated', first[2]['content'])
        self.assertIn('pending status is unknown', second[2]['content'])
        self.assertNotIn('xxx', second[2]['content'])
        self.assertEqual(fetch.call_count, 2)

    def test_terminal_turns_refresh_without_persisting_snapshot(self):
        cfg = cfg_for('/tmp/fixture')
        cfg['_terminal'] = Mock()
        cfg['_turn_summary'] = Mock(side_effect=['ring: first', 'silent: none eligible'])
        history = []
        requests = []
        def model(cfg, messages, tools):
            requests.append(copy.deepcopy(messages))
            return {'content': 'reply'}
        loop.terminal_prompt(cfg, 'first question', history, model=model)
        loop.terminal_prompt(cfg, 'second question', history, model=model)
        self.assertEqual(cfg['_turn_summary'].call_count, 2)
        self.assertIn('ring: first', requests[0][2]['content'])
        self.assertIn('silent: none eligible', requests[1][2]['content'])
        self.assertNotIn('ring: first', str(requests[1]))
        self.assertNotIn(loop.SUMMARY_FRAME, str(history))

    def test_refresh_for_search_and_finishing_requests(self):
        cfg = cfg_for('/tmp/fixture', search=True, search_max_calls=1)
        msg = {'id': 'source', 'at': 1, 'text': 'question', 'from': {'name': 'Owner'}}
        outputs = iter([{'tool_calls': [{'id': 'search', 'function': {'name': 'web_search', 'arguments': '{"query":"fixture"}'}}]},
                        {'content': ''}, {'content': 'answer'}])
        requests = []
        def model(cfg, messages, tools):
            requests.append(copy.deepcopy(messages))
            return next(outputs)
        with patch.object(loop.Chat, 'turn_summary', side_effect=['first', 'second', 'third']) as fetch, patch.object(loop, 'log_web'):
            reply, _, _ = loop.answer(cfg, None, [], msg, model, lambda cfg, query: 'result')
        self.assertEqual(reply, loop.WEB_MARK + 'answer')
        self.assertEqual(fetch.call_count, 3)
        for index, expected in enumerate(['first', 'second', 'third']):
            snapshots = [m for m in requests[index] if str(m.get('content', '')).startswith(loop.SUMMARY_FRAME)]
            self.assertEqual(len(snapshots), 1)
            self.assertTrue(snapshots[0]['content'].endswith(expected))

    def test_empty_snapshot_uses_no_context_tokens(self):
        cfg = cfg_for('/tmp/fixture')
        messages = [{'role': 'system', 'content': 'rules'}, {'role': 'user', 'content': 'task'}]
        cfg['_turn_summary'] = lambda: ''
        self.assertIs(loop.turn_context(cfg, messages), messages)
