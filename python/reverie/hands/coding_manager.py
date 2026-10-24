import copy
import json
import os
import sys
import time
from dataclasses import asdict, replace

from coding_arbiter import ModelArbiter
from coding_chat import RULES, authorize_task, read_tool_specs, validate_settings
from coding_diagnostics import runner_report
from coding_process import BoundedProcess
from coding_tasks import (Limits, begin_request, checked_result, control_request,
                          encoded, permitted_sender, reserve_chars)
from coding_worker import CodingWorker


class TaskManager:
    def __init__(self, loop, cfg, chat, *, clock=time.monotonic,
                 worker_factory=CodingWorker, arbiter_factory=ModelArbiter,
                 process_factory=BoundedProcess):
        self.loop, self.cfg, self.chat = loop, cfg, chat
        self.clock = clock
        self.worker_factory, self.arbiter_factory = worker_factory, arbiter_factory
        self.process_factory = process_factory
        self.active = None

    def save(self):
        job = self.active
        if job:
            self.loop.save_json(self.cfg['state_file'], job['state'])

    def control(self, state, room, history, message):
        settings = copy.deepcopy(self.cfg['coding'])
        validate_settings(settings)
        control = control_request(message)
        task_id = control['task_id']
        if len(message.get('text', '')) > self.cfg['message_cap_chars']:
            return 'Coding task refused: shorten the request so its full instructions fit the message budget.'
        if not permitted_sender(settings, room, task_id, message):
            return 'Coding task refused: sender or room is not authorized.'
        task = settings['tasks'][task_id]
        if not task.get('enabled', True):
            return 'Coding task refused: task is disabled.'
        if control['action'] == 'cancel':
            if self.active and self.active['task_id'] == task_id:
                self.finish({'status': 'stopped', 'reason': 'cancelled'}, post=False)
                return f'Task {task_id} cancelled.'
            return 'No active coding task matches that id.'
        if self.active:
            return 'Coding task refused: another task is active.'
        journal = state.setdefault('_coding', {})
        profile = task.get('profile', 'drill')
        limits = Limits(**settings.get('profiles', {'drill': {}})[profile])
        limits = replace(limits, prompt_chars=min(limits.prompt_chars, self.cfg['prompt_cap_chars']))
        source_id = message['id']
        if not begin_request(journal, room, source_id, task_id,
                             lambda: self.loop.save_json(self.cfg['state_file'], state)):
            return 'Coding request was already started and will not be replayed.'
        epoch = state.get('_coding_epoch', 0) + 1
        state['_coding_epoch'] = epoch
        journal[room + ':' + source_id]['epoch'] = epoch
        self.active = {'state': state, 'journal': journal, 'key': room + ':' + source_id,
                       'room': room, 'source': message, 'task_id': task_id, 'profile': profile,
                       'limits': limits, 'settings': settings, 'worker': None, 'arbiter': None,
                       'runner': None, 'pending': None, 'last_progress': self.clock(),
                       'deadline': self.clock() + limits.seconds, 'epoch': epoch}
        try:
            tools = read_tool_specs(settings['tool_schema_file'])
            prompt_cfg = dict(self.cfg, prompt_cap_chars=limits.prompt_chars)
            messages, _ = self.loop.build_prompt(prompt_cfg, history, message, room,
                reserve=reserve_chars(limits) + len(RULES) + len(encoded(tools)) + 1024)
            messages[0]['content'] += '\n' + RULES
            self.active.update(messages=messages, tools=tools)
            self.save()
        except Exception:
            self.finish({'status': 'stopped', 'reason': 'task_preparation_failed'}, post=False)
            return f'Task {task_id} stopped: task_preparation_failed. No tool ran.'
        return (f'Task {task_id} queued in its configured workspace; profile {profile}: {limits.steps} operations, '
                f'{limits.seconds:g} seconds, {limits.total_bytes} returned bytes. '
                'Chat takes priority. Tools use the configured runner and its execution permissions.')

    def authorization(self, *, check_cancel=True):
        job = self.active
        if not job:
            return 'revoked'
        return authorize_task(self.loop, self.cfg, self.chat, job['room'], job['source'],
                              job['settings'], job['task_id'], job['deadline'],
                              check_cancel=check_cancel, clock=self.clock)

    def before_chat(self):
        if self.active and self.active['arbiter']:
            self.active['arbiter'].pause_for_chat()

    def finish(self, result, *, post=True):
        job = self.active
        if not job:
            return
        if job['runner']:
            job['runner'].cancel('task_finished')
        if job['arbiter']:
            job['arbiter'].cancel()
        if job['worker']:
            job['worker'].close()
        row = job['journal'][job['key']]
        row.update(status=result.get('status', 'stopped'), reason=result.get('reason', 'worker_failed'),
                   profile=job['profile'], limits=asdict(job['limits']))
        for name in ('steps', 'output_bytes', 'tests_run', 'test_exit_code', 'largest_prompt', 'omitted_rounds'):
            if name in result:
                row[name] = result[name]
        for name in ('peak_prompt_tokens', 'context_tokens', 'model_prompt_tokens', 'model_output_tokens'):
            if name in result:
                row[name] = result[name]
        for name in ('tests_current', 'context_overflows', 'model_responses', 'usage_measured_responses', 'call_retries'):
            if name in result:
                row[name] = result[name]
        if job['arbiter']:
            row['preemptions'] = job['arbiter'].preemptions
            row['model_requests_started'] = getattr(job['arbiter'], 'requests_started', None)
            row['model_watchdogs'] = getattr(job['arbiter'], 'watchdog_events', [])
        self.save()
        if post and self.authorization(check_cancel=False) is None:
            tests = 'not run' if not result.get('tests_run') else 'exit ' + str(result.get('test_exit_code'))
            if result.get('tests_run') and not result.get('tests_current'):
                tests += ' (no current completion, or later operations not rechecked)'
            paths = ', '.join(repr(path) for path in result.get('edited_paths', [])) or 'none recorded'
            text = (f'Task {job["task_id"]}: {row["status"]}: {row["reason"]}.\n'
                    f'Confirmed edit tools: {paths}. Tests: {tests}. '
                    'Full diff not independently collected.' +
                    ('\nAgent report: ' + result['text'] if result.get('text') else ''))[:2400]
            try:
                self.chat.say(job['room'], text, reply_to=job['source']['id'])
            except Exception:
                row['final_post'] = 'failed'
                self.save()
        self.active = None

    def start_worker(self):
        job = self.active
        if job['source']['id'] not in job['state'].get(job['room'], {}).get('seen', []):
            self.finish({'status': 'stopped', 'reason': 'start_post_unconfirmed'}, post=False)
            return False
        denied = self.authorization()
        if denied:
            self.finish({'status': 'stopped', 'reason': denied})
            return False
        remaining = job['deadline'] - self.clock()
        if remaining <= 0:
            self.finish({'status': 'stopped', 'reason': 'time_limit'})
            return False
        meter = copy.deepcopy(job['settings'].get('token_meter'))
        if meter is not None and self.cfg.get('vision'):
            meter['image_tokens_per_image'] = self.cfg.get('image_tokens_per_image', 2048)
        job['arbiter'] = self.arbiter_factory(self.cfg['api_base'], key_env=self.cfg.get('model_key_env'),
                                             timeout_s=min(self.cfg['model_timeout_s'], 300),
                                             token_meter=meter,
                                             events_file=self.cfg.get('model_events_file'))
        options = {'model': self.cfg['model'], 'max_tokens': self.cfg['reply_max_tokens'], 'stream': False}
        if 'temperature' in self.cfg:
            options['temperature'] = self.cfg['temperature']
        job['worker'] = self.worker_factory(job['messages'], job['tools'], replace(job['limits'], seconds=remaining),
            options, epoch=job['epoch'])
        return True

    def pump(self):
        try:
            self.advance()
        except Exception:
            self.loop.log('coding controller failed')
            self.finish({'status': 'stopped', 'reason': 'controller_failed'})

    def record_runner_report(self, process):
        job = self.active
        row = job['journal'][job['key']]
        report = runner_report(getattr(process, 'stderr_tail', b''))
        if report is None:
            row['runner_reports_unavailable'] = row.get('runner_reports_unavailable', 0) + 1
            self.loop.log('coding runner', job['task_id'], 'report_unavailable')
        else:
            row['last_runner_report'] = report
            row['runner_reports'] = row.get('runner_reports', 0) + 1
            row['runner_wall_ms'] = row.get('runner_wall_ms', 0) + report.get('wall_ms', 0)
            row['runner_peak_rss_bytes'] = max(row.get('runner_peak_rss_bytes', 0), report.get('peak_rss_bytes', 0))
            self.loop.log('coding runner', job['task_id'], encoded(report))
        self.save()

    def advance(self):
        job = self.active
        if not job:
            return
        if self.clock() >= job['deadline']:
            self.finish({'status': 'stopped', 'reason': 'time_limit'})
            return
        if job['worker'] is None:
            if not self.start_worker():
                return
        arbiter = job['arbiter']
        arbiter.resume()
        if job['pending']:
            event = job['pending']
            if event['kind'] == 'model':
                answer = arbiter.poll()
                if answer is None:
                    return
                job['worker'].reply(event['sequence'], answer.get('result'),
                                    None if answer.get('ok') else 'model_failed')
            else:
                process = job['runner']
                if not process.poll():
                    return
                self.record_runner_report(process)
                if process.error:
                    reason = {'timeout': 'runner_timeout', 'output_limit': 'output_limit'}.get(process.error, 'runner_crash')
                    result = {'version': 1, 'ok': False, 'output': '', 'error': reason,
                              'truncated': False, 'exit_code': None}
                else:
                    try:
                        result, _ = checked_result(bytes(process.output), job['limits'])
                    except Exception:
                        result = {'version': 1, 'ok': False, 'output': '', 'error': 'invalid_output',
                                  'truncated': False, 'exit_code': None}
                request = event['payload']['request']
                entry = {'tool': request['name'], 'ok': result['ok'], 'exit_code': result['exit_code']}
                path = request.get('args', {}).get('path')
                if isinstance(path, str):
                    entry['path'] = path[:200]
                row = job['journal'][job['key']]
                row['tool_history'] = (row.get('tool_history', []) + [entry])[-128:]
                self.save()
                self.loop.log('coding result', job['task_id'], encoded(entry))
                job['worker'].reply(event['sequence'], result)
                job['runner'] = None
            job['pending'] = None
        event = job['worker'].poll()
        if event is None:
            return
        if type(event.get('epoch')) is not int or event['epoch'] != job['epoch']:
            self.finish({'status': 'stopped', 'reason': 'stale_task_epoch'})
            return
        kind = event.get('kind')
        if kind == 'result':
            self.finish(event['result'])
        elif kind == 'failed':
            self.finish({'status': 'stopped', 'reason': event.get('error', 'worker_failed')})
        elif kind == 'authorize':
            job['worker'].reply(event['sequence'], self.authorization())
        elif kind == 'model':
            denied = self.authorization()
            if denied:
                job['worker'].reply(event['sequence'], error=denied)
            else:
                arbiter.submit(event['payload']['request'], min(event['payload']['timeout'], job['deadline'] - self.clock()))
                job['pending'] = event
        elif kind == 'tool':
            denied = self.authorization()
            if denied:
                job['worker'].reply(event['sequence'], error=denied)
                return
            payload = event['payload']
            timeout = int(min(payload['timeout'], job['deadline'] - self.clock()))
            if timeout < 1:
                self.finish({'status': 'stopped', 'reason': 'time_limit'})
                return
            tool_request = dict(payload['request'])
            allowance = min(job['limits'].output_chars, (payload['cap'] - 1024) // 6)
            if allowance < 500:
                job['worker'].reply(event['sequence'], {'version': 1, 'ok': False, 'output': '',
                    'error': 'output_limit', 'truncated': False, 'exit_code': None})
                return
            tool_request['max_output_chars'] = allowance
            argv = job['settings']['runner_argv'] + ['--task-dir',
                    os.path.join(job['settings']['root'], job['task_id']),
                    '--timeout-s', str(timeout), '--max-output-bytes', str(payload['cap'])]
            job['runner'] = self.process_factory(argv, encoded(tool_request).encode('utf-8'),
                timeout, payload['cap'], environment={'PATH': os.defpath, 'LANG': 'C.UTF-8'})
            job['pending'] = event
        elif kind == 'progress':
            step = event['payload']
            self.loop.log('coding step', job['task_id'], job['profile'], step['step'], step['tool'], str(step['ok']))
            if self.clock() - job['last_progress'] >= 30 and self.authorization(check_cancel=False) is None:
                try:
                    self.chat.say(job['room'], f'Task {job["task_id"]}: step {step["step"]}, '
                                  f'{step["tool"]}; {"ok" if step["ok"] else "refused or failed"}.',
                                  reply_to=job['source']['id'])
                    job['last_progress'] = self.clock()
                except Exception:
                    self.finish({'status': 'stopped', 'reason': 'progress_post_failed'}, post=False)
                    return
            job['worker'].reply(event['sequence'], None)
        else:
            self.finish({'status': 'stopped', 'reason': 'invalid_worker_event'})
