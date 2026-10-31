"""A long chat message reaches the local model whole, and any cut that is still needed says so (i-6173158d)."""
import io
import re
import tempfile
import unittest

import agent_loop as loop
from debug_terminal import DebugTerminal
from test_coding_support import cfg_for

OWNER = {'kind': 'user', 'name': 'Owner', 'mark': 'owner_typed', 'authenticatedOwner': True}


def message(text, at=1_793_390_000_000, ident='m-now', sender=OWNER):
    return {'id': ident, 'at': at, 'from': sender, 'text': text}


def user_text(messages):
    content = messages[1]['content']
    return content if isinstance(content, str) else content[0]['text']


def missing(text):
    return [int(n) for n in re.findall(r'\[\.\.\. (\d+) more characters of this message are not shown\]', text)]


class LongMessageTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(); self.addCleanup(self.dir.cleanup)
        self.cfg = cfg_for(self.dir.name)

    def test_a_paste_longer_than_the_line_cap_is_answered_whole(self):
        # The reported case: a 5,317-char paste lost about 1,363 chars at the 4,000-char line cap, with no sign.
        lines = [f'{n:02d} ' + 'x' * 98 for n in range(1, 53)] + ['53 the final line']
        text = '\n'.join(lines)
        self.assertGreater(len(text), self.cfg['message_cap_chars'])
        messages, size = loop.build_prompt(self.cfg, [], message(text))
        self.assertIn(text, user_text(messages))
        self.assertEqual(missing(user_text(messages)), [])
        self.assertLessEqual(size, self.cfg['prompt_cap_chars'])

    def test_a_message_beyond_the_whole_prompt_is_cut_and_says_how_much_is_missing(self):
        text = 'y' * (self.cfg['prompt_cap_chars'] * 2)
        messages, size = loop.build_prompt(self.cfg, [], message(text), reserve=1000)
        shown = user_text(messages)
        [gone] = missing(shown)
        kept = shown.count('y')
        self.assertEqual(kept + gone, len(text))
        self.assertLessEqual(size, self.cfg['prompt_cap_chars'] - 1000)

    def test_an_earlier_long_line_is_marked_where_it_is_cut(self):
        cap = self.cfg['message_cap_chars']
        earlier = message('z' * (cap + 500), at=1_793_389_000_000, ident='m-earlier')
        messages, _ = loop.build_prompt(self.cfg, [earlier], message('Short question?'), now=1_793_390_000)
        shown = user_text(messages)
        [gone] = missing(shown)
        self.assertEqual(shown.count('z') + gone, cap + 500)
        self.assertIn('Short question?', shown)

    def test_short_messages_are_unchanged(self):
        messages, _ = loop.build_prompt(self.cfg, [message('Hi', at=1_793_389_000_000, ident='m-1')], message('Hello there'),
                                        now=1_793_390_000)
        shown = user_text(messages)
        self.assertEqual(missing(shown), [])
        self.assertTrue(shown.endswith('Owner (owner): Hello there'))


class TerminalLongMessageTests(unittest.TestCase):
    def test_debug_terminal_input_reaches_the_model_whole(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        cfg = cfg_for(directory.name)
        cfg['_terminal'] = DebugTerminal(cfg, output=io.StringIO(), interactive=False).start()
        text = 'line ' + 'w' * (cfg['message_cap_chars'] + 800) + ' END'
        seen = []
        def model(*args):
            seen.append(next(user_text(a) for a in args if isinstance(a, list) and a and isinstance(a[0], dict)))
            return {'content': 'Read it all.'}
        loop.terminal_prompt(cfg, text, [], model=model)
        self.assertTrue(seen)
        self.assertIn(text, seen[0])
        self.assertEqual(missing(seen[0]), [])


if __name__ == '__main__':
    unittest.main()
