import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_loop as loop
from coding_manager import TaskManager
from test_coding_support import FakeChat, cfg_for
from test_coding_tasks import TOOLS, call, response


OWNER = {'kind': 'user', 'name': 'Owner', 'mark': 'owner_typed', 'authenticatedOwner': True}


class FakeArbiter:
    replies = []
    instances = []
    ready = True
    def __init__(self, *args, **kwargs):
        self.pending = None
        self.paused = False
        self.preemptions = 0
        self.__class__.instances.append(self)
    def submit(self, payload, timeout):
        self.pending = payload
    def resume(self):
        self.paused = False
    def pause_for_chat(self):
        if self.pending is not None:
            self.preemptions += 1
        self.paused = True
    def poll(self):
        if not self.ready or self.pending is None or self.paused:
            return None
        self.pending = None
        return {'ok': True, 'result': self.__class__.replies.pop(0)}
    def cancel(self):
        self.pending = None


class FakeRunner:
    requests = []
    invocations = []
    def __init__(self, argv, body, timeout, cap, **kwargs):
        request = json.loads(body)
        self.__class__.requests.append(request)
        self.__class__.invocations.append((argv, timeout, cap, kwargs))
        self.output = json.dumps(response('fixture result', exit_code=0)).encode()
        self.stderr_tail = json.dumps({'sandbox_runner': {'rc': 0, 'mode': 'task', 'reason': 'done',
            'wall_ms': 10, 'peak_rss_bytes': 1000}}).encode()
        self.error = None
    def poll(self):
        return True
    def cancel(self, *args):
        pass


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        schema = root / 'tools.json'
        schema.write_text(json.dumps({'version': 1, 'args_cap': 24000, 'result_cap': 24000, 'tools': TOOLS}))
        coding = {'root': str(root / 'tasks'), 'runner_argv': ['/unused-runner'],
                  'tool_schema_file': str(schema), 'profiles': {'drill': {'seconds': 3}},
                  'tasks': {'fixture': {'rooms': ['room'], 'delegate_sessions': []}}}
        self.cfg = cfg_for(str(root), coding=coding, prompt_cap_chars=120000)
        self.chat = FakeChat()
        self.chat.member = [{'id': 'room'}]
        self.state = {'room': {'seen': [], 'claims': {}, 'since': 1}}
        FakeArbiter.instances, FakeRunner.requests = [], []
        FakeRunner.invocations = []
        FakeArbiter.replies, FakeArbiter.ready = [{'content': 'Done.'}], True
        self.manager = TaskManager(loop, self.cfg, self.chat, arbiter_factory=FakeArbiter,
                                   process_factory=FakeRunner)
        self.cfg['_coding_manager'] = self.manager
        self.addCleanup(lambda: self.manager.finish({'status': 'stopped', 'reason': 'test_cleanup'}, post=False))

    def start(self):
        source = self.chat.add('room', OWNER, '/code fixture Inspect and test.')
        loop.tick(self.cfg, self.chat, self.state)
        return source

    def test_schema_envelope_is_unwrapped_before_worker_start(self):
        self.start()
        self.assertIsNotNone(self.manager.active)
        self.assertEqual(self.manager.active['tools'], TOOLS)
        self.assertEqual(FakeArbiter.instances, [])

    def test_incompatible_export_stops_before_model_or_tool(self):
        schema = Path(self.cfg['coding']['tool_schema_file'])
        schema.write_text(json.dumps({'version': 2, 'args_cap': 24000, 'result_cap': 24000, 'tools': TOOLS}))
        self.start()
        self.assertIsNone(self.manager.active)
        self.assertEqual(FakeArbiter.instances, [])
        self.assertEqual(FakeRunner.requests, [])
        self.assertIn('task_preparation_failed', self.chat.rooms['room'][-1]['text'])

    def pump_until(self, condition):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            self.manager.pump()
            if condition():
                return
            time.sleep(0.002)
        self.fail('task did not reach expected state')

    def test_background_task_runs_tools_and_finishes_with_receipt(self):
        FakeArbiter.replies = [call(name='run_tests'), {'content': 'Finished.'}]
        source = self.start()
        self.assertIn('queued', self.chat.ours('room')[0]['text'])
        self.pump_until(lambda: self.manager.active is None)
        row = self.state['_coding']['room:' + source['id']]
        self.assertEqual(row['status'], 'completed')
        self.assertEqual(row['tests_run'], 1)
        self.assertEqual(row['runner_reports'], 1)
        self.assertEqual(row['runner_wall_ms'], 10)
        self.assertEqual(row['runner_peak_rss_bytes'], 1000)
        self.assertEqual(len(FakeRunner.requests), 1)
        self.assertIn('Tests: exit 0', self.chat.ours('room')[-1]['text'])
        self.assertEqual(self.chat.ours('room')[-1]['replyTo'], source['id'])

    def test_runner_receives_only_fixed_argv_and_bounded_metadata(self):
        FakeArbiter.replies = [call(name='run_tests'), {'content': 'Finished.'}]
        self.start()
        self.pump_until(lambda: self.manager.active is None)
        argv, timeout, cap, options = FakeRunner.invocations[0]
        self.assertEqual(argv[:3], ['/unused-runner', '--task-dir',
            str(Path(self.cfg['coding']['root']) / 'fixture')])
        self.assertEqual(argv[3:], ['--timeout-s', str(timeout), '--max-output-bytes', str(cap)])
        self.assertTrue(argv[4].isdigit())
        self.assertLessEqual(timeout, 3)
        self.assertLessEqual(cap, 131072)
        self.assertEqual(set(options['environment']), {'PATH', 'LANG'})
        request = FakeRunner.requests[0]
        self.assertEqual(set(request), {'version', 'name', 'args', 'max_output_chars'})
        self.assertGreaterEqual(request['max_output_chars'], 500)
        self.assertLessEqual(request['max_output_chars'], 20000)

    def test_less_than_one_second_never_rounds_up_or_starts_runner(self):
        self.cfg['coding']['profiles']['drill']['seconds'] = 0.5
        FakeArbiter.replies = [call(name='run_tests')]
        source = self.start()
        self.pump_until(lambda: self.manager.active is None)
        row = self.state['_coding']['room:' + source['id']]
        self.assertEqual(row['reason'], 'time_limit')
        self.assertEqual(FakeRunner.requests, [])

    def test_untrusted_diagnostics_never_enter_chat_model_or_journal(self):
        FakeArbiter.replies = [call(name='run_tests'), {'content': 'Finished.'}]
        def runner(*args, **kwargs):
            process = FakeRunner(*args, **kwargs)
            process.stderr_tail = b'PRIVATE_DIAGNOSTIC_CANARY'
            return process
        self.manager.process_factory = runner
        source = self.start()
        with patch.object(loop, 'log') as log:
            self.pump_until(lambda: self.manager.active is None)
        row = self.state['_coding']['room:' + source['id']]
        self.assertEqual(row['runner_reports_unavailable'], 1)
        self.assertNotIn('last_runner_report', row)
        self.assertNotIn('PRIVATE_DIAGNOSTIC_CANARY', repr(log.call_args_list))
        self.assertNotIn('PRIVATE_DIAGNOSTIC_CANARY', json.dumps(self.state))
        self.assertNotIn('PRIVATE_DIAGNOSTIC_CANARY', json.dumps(self.chat.rooms))

    def test_voice_answer_preempts_coding_without_waiting_for_model(self):
        FakeArbiter.ready = False
        self.start()
        self.pump_until(lambda: self.manager.active['pending'] is not None)
        voice = self.chat.add('room', {**OWNER, 'mark': 'owner_spoken'}, 'Quick room question')
        started = time.monotonic()
        loop.tick(self.cfg, self.chat, self.state, model=lambda *args: {'content': 'Voice reply first.'})
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertEqual(FakeArbiter.instances[0].preemptions, 1)
        self.assertEqual(self.chat.ours('room')[-1]['replyTo'], voice['id'])
        self.assertEqual(FakeRunner.requests, [])
        FakeArbiter.ready = True
        self.pump_until(lambda: self.manager.active is None)

    def test_second_code_request_is_refused_not_queued(self):
        self.start()
        self.chat.add('room', OWNER, '/code fixture Another task')
        loop.tick(self.cfg, self.chat, self.state)
        self.assertIn('another task is active', self.chat.ours('room')[-1]['text'])
        self.assertEqual(len(self.state['_coding']), 1)

    def test_failed_start_post_never_starts_worker(self):
        self.chat.fail_say = 1
        source = self.start()
        self.manager.pump()
        self.assertIsNone(self.manager.active)
        self.assertEqual(self.state['_coding']['room:' + source['id']]['reason'], 'start_post_unconfirmed')
        self.assertEqual(FakeArbiter.instances, [])
        self.assertEqual(FakeRunner.requests, [])

    def test_authorized_cancel_closes_worker_and_preserves_no_replay(self):
        FakeArbiter.ready = False
        source = self.start()
        self.pump_until(lambda: self.manager.active['pending'] is not None)
        self.chat.add('room', OWNER, '/code-cancel fixture')
        loop.tick(self.cfg, self.chat, self.state)
        self.assertIsNone(self.manager.active)
        self.assertEqual(self.state['_coding']['room:' + source['id']]['reason'], 'cancelled')
        self.assertEqual(FakeRunner.requests, [])

    def test_failed_done_post_cannot_repeat_effects(self):
        FakeArbiter.replies = [call(), {'content': 'Done.'}]
        source = self.start()
        self.chat.fail_say = 1
        self.pump_until(lambda: self.manager.active is None)
        row = self.state['_coding']['room:' + source['id']]
        self.assertEqual(row['final_post'], 'failed')
        self.assertEqual(len(FakeRunner.requests), 1)
        loop.tick(self.cfg, self.chat, self.state)
        self.assertEqual(len(FakeRunner.requests), 1)

    def test_runner_exception_stops_task_without_crashing_chat(self):
        FakeArbiter.replies = [call()]
        source = self.start()
        def broken(*args, **kwargs):
            raise OSError('synthetic runner failure')
        self.manager.process_factory = broken
        self.pump_until(lambda: self.manager.active is None)
        self.assertEqual(self.state['_coding']['room:' + source['id']]['reason'], 'controller_failed')
        self.chat.add('room', OWNER, 'Still available?')
        self.assertEqual(loop.tick(self.cfg, self.chat, self.state,
                                   model=lambda *args: {'content': 'Still available.'}), 1)
        self.assertEqual(FakeRunner.requests, [])

    def test_task_instructions_are_not_silently_truncated(self):
        self.chat.add('room', OWNER, '/code fixture ' + 'x' * self.cfg['message_cap_chars'])
        loop.tick(self.cfg, self.chat, self.state)
        self.assertIsNone(self.manager.active)
        self.assertIn('full instructions fit', self.chat.ours('room')[-1]['text'])
        self.assertEqual(FakeRunner.requests, [])


if __name__ == '__main__':
    unittest.main()
