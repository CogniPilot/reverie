"""Tool and turn handling for the Hands journal."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time

from uuid import UUID

def uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('canonical full UUID required')
    return value


MEMORY_WORKER_BYTES = 50000
READ_WORKER_BYTES = 128 * 1024
TURN_CAPTURE_BYTES = 32 * 1024 * 1024
TEXT_BYTES = 1024
RESULT_CHARS = 2400
CONTEXT_CHARS = 4800
MAX_CALLS = 3
CAPSULE_BYTES = 1536
RESERVE = CONTEXT_CHARS + MAX_CALLS * (RESULT_CHARS + 1500) + 2400


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def native_memory_command(worker, *, resolve=False):
    executable = os.environ.get('REVERIE_HANDS_MEMORY_COMMAND', 'reverie-admin-memory')
    if resolve and (found := shutil.which(executable)):
        executable = os.path.abspath(found)
    return [executable, f'--{worker}={os.getpid()}']


def native_memory_output(worker, arguments, bound=MEMORY_WORKER_BYTES, *, timeout=3):
    if len(arguments) > bound:
        return None
    try:
        reply = subprocess.run(native_memory_command(worker), input=arguments, capture_output=True,
                               check=True, start_new_session=True, timeout=timeout)
        return reply.stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def native_memory_request(worker, arguments, bound=MEMORY_WORKER_BYTES, *, timeout=3):
    output = native_memory_output(worker, arguments, bound, timeout=timeout)
    try:
        result = json.loads(output) if output is not None else None
        return result if isinstance(result, dict) else None
    except ValueError:
        return None


def encode_memory_json(payload):
    try:
        return json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    except (TypeError, ValueError):
        return None


def native_memory_json(worker, payload, bound=MEMORY_WORKER_BYTES, *, timeout=3):
    arguments = encode_memory_json(payload)
    return native_memory_request(worker, arguments, bound, timeout=timeout) if arguments is not None else None


def legacy_memory_request(action, *, timeout=3, **payload):
    return native_memory_json("legacy-memory-worker", {"action": action, **payload}, TURN_CAPTURE_BYTES, timeout=timeout)


def dream_memory_request(action, **payload):
    reply = native_memory_json("dream-worker", {"action": action, **payload}, TURN_CAPTURE_BYTES)
    if reply is None:
        raise ValueError("native dream operation could not be completed")
    return reply


def journal_tool_request(phase, **payload):
    return native_memory_json('journal-tool-worker', {'phase': phase, **payload}, READ_WORKER_BYTES)


def journal_save_request(phase, **payload):
    return native_memory_json('journal-save-worker', {'phase': phase, 'payload': payload})


def capture_turn(room, history, message):
    fields = ('id', 'roomId', 'at', 'text', 'from')

    def source(row):
        return {k: row[k] for k in fields if k in row} if isinstance(row, dict) else None

    return native_memory_json(
        'journal-capture-worker',
        {'room': room, 'history': [source(row) for row in history], 'message': source(message)},
        TURN_CAPTURE_BYTES)


def present_turn(room, capsule, turn=None):
    payload = {'room': room, 'capsule': capsule, 'turn': turn}
    arguments = encode_memory_json(payload)
    if capsule is not None and (arguments is None or len(arguments) > READ_WORKER_BYTES):
        # A custom worker can return invalid JSON values in its optional recall.
        # Preserve the ordinary journal context when the capsule cannot cross IPC.
        payload['capsule'] = None
        arguments = encode_memory_json(payload)
    return native_memory_request('journal-context-worker', arguments, READ_WORKER_BYTES) if arguments is not None else None


class Turn:
    def __init__(self, cfg, room, history, message, operation, now_ms=None, failures=None, evidence=None):
        self.operation = operation
        self.failures = failures if failures is not None else []
        self.read_only = False
        self.calls = 0
        self.call_limit = 0
        self.expanded_sources = set()
        self.tools = []
        self.accepted_calls = []
        self.offered = []
        self.needs_reason = False
        self.help_shown = False
        self.context = ''
        self.recalled = ''
        self.merged_recall = None
        self.recall_context_status = 'not_available'
        if not cfg.get('journal_enabled') or not cfg.get('memory_instance') or room is None:
            return
        try:
            # Capture before any callback can alter the caller-owned message.
            capture = capture_turn(room, history, message)
            if not capture:
                raise ValueError('invalid journal capture')
            self.captured = capture['captured']
            self.read_only = capture['read_only']
            # Query the journal in the same worker already needed for status.
            # Older workers ignore the additive query and still return status.
            automatic = room not in cfg.get('journal_auto_recall_exclude_rooms', [])
            response = (operation('journal_status', query=capture['query']) if automatic
                        else operation('journal_status'))
            if not response or response.get('status') != 'available':
                raise ValueError('writer unavailable')
            projected = present_turn(room, response.get('recall'), {
                'captured_end': self.captured['end'],
                'checkpoint': response.get('checkpoint') or None,
                'clock_ms': time.time() * 1000 if now_ms is None else now_ms,
                'catalog': capture['catalog'], 'read_only': self.read_only,
                'asked_to_remember': capture['asked_to_remember'],
                'evidence': evidence,
            })
            if not projected or not projected.get('context'):
                raise ValueError('invalid journal context')
            context = projected['context']
            self.previous_id = context['previous_id']
            self.needs_reason = context['needs_reason']
            self.context = context['text']
            self.recalled = projected['recall']
            self.recall_context_status = 'prepared' if self.recalled else 'unavailable_or_unsupported'
            self.offered = context['offered']
            self.tools = context['tools']
            self.accepted_calls = context['accepted_calls']
            self.call_limit = context['call_limit']
            if 'merged' in context:
                self.merged_recall = self.apply_merge(context['merged'])
        except (ValueError, TypeError, KeyError):
            self.recalled = ''
            self.context = '\nJournal unavailable in this turn; no commit or recall command is offered. Do not claim a journal write.'

    def merge_recalled(self, existing, max_chars):
        """Keep historical data in the existing user-data slot, never system text."""
        if not isinstance(existing, str) or len(existing) > max_chars:
            raise ValueError('recalled evidence exceeds configured cap')
        if not self.recalled:
            return existing
        merged = journal_tool_request('merge', recall=self.recalled, existing=existing,
                                      context=self.context, max_chars=max_chars)
        if not merged:
            self.recall_context_status = 'unavailable_or_unsupported'
            return existing
        return self.apply_merge(merged)

    def apply_merge(self, merged):
        self.recall_context_status = merged.get('status', self.recall_context_status)
        self.context += merged.get('context_note', '')
        return merged['text']

    def unavailable(self, **extra):
        """A journal result that could not be read, with the worker failure class when one was recorded."""
        recent = self.failures[getattr(self, 'failure_mark', 0):]
        return {'status': 'unavailable', **extra, **({'failure': recent[-1]} if recent else {})}

    def invoke(self, call):
        self.replay = '{}'
        self.failure_mark = len(self.failures)  # report only this command's worker failures
        if not self.tools:
            return {'status': 'refused', 'reason': 'journal_unavailable'}
        fn = call.get('function') if isinstance(call, dict) else None
        fn = fn if isinstance(fn, dict) else {}
        name, raw = fn.get('name'), fn.get('arguments')
        step = journal_tool_request('invoke', read_only=self.read_only,
                                    state={'calls': self.calls, 'help_shown': self.help_shown},
                                    name=name if isinstance(name, str) else None,
                                    arguments=raw if isinstance(raw, str) and len(raw) <= MEMORY_WORKER_BYTES else None)
        if not step:
            self.calls += 1
            return self.unavailable(reason='journal_command_worker_unavailable')
        self.calls = step['state']['calls']
        self.help_shown = step['state']['help_shown']
        self.replay = step['replay']
        if 'reply' in step:
            return step['reply']
        try:
            dispatch = step['dispatch']
            raw = dispatch.get('arguments')
            if isinstance(raw, dict):
                raw = json.dumps(raw)
            if dispatch['name'] == 'journal_commit':
                return self.save(raw)
            return self.read(dispatch['name'], raw)
        except (ValueError, TypeError, KeyError):
            return {'status': 'refused', 'reason': 'invalid_arguments_or_source; compress text and use exact source IDs/quotes'}

    def read(self, tool, arguments):
        request = native_memory_json('journal-read-worker', {
            'phase': 'plan', 'tool': tool, 'captured_end': self.captured['end'],
            'expanded_sources': sorted(self.expanded_sources),
            'arguments': arguments if isinstance(arguments, str) and len(arguments) <= MEMORY_WORKER_BYTES else None,
        }, READ_WORKER_BYTES)
        if not request:
            return self.unavailable(reason='journal_read_worker_unavailable')
        if 'reply' in request:
            return request['reply']
        operation = dict(request['request'])
        result = self.operation(operation.pop('op'), **operation)
        recent = self.failures[self.failure_mark:]
        settled = native_memory_json('journal-read-worker', {
            'phase': 'settle', 'request': request['request'], 'captured': self.captured,
            'result': result, 'failure': recent[-1] if recent else None,
        }, READ_WORKER_BYTES)
        if not settled:
            return self.unavailable(reason='journal_read_worker_unavailable')
        if 'captured' in settled:
            self.captured = settled['captured']
            self.expanded_sources.add(settled['expanded_id'])
        return settled['reply']

    def save(self, raw):
        plan = journal_save_request('prepare', room=self.captured['room'], captured=self.captured,
                                    read_only=self.read_only, needs_reason=self.needs_reason,
                                    arguments=raw if isinstance(raw, str) and len(raw) <= MEMORY_WORKER_BYTES else None)
        if plan is None:
            return self.unavailable(reason='journal_save_worker_unavailable')
        if plan.get('action') == 'reply':
            return plan['reply']
        if plan.get('action') != 'commit':
            return self.unavailable(reason='journal_save_worker_unavailable')
        key = plan['key']
        result = self.save_effect('journal_commit', draft=plan['draft'], captured=self.captured,
                                  previous_id=self.previous_id)
        settled = journal_save_request('classify', key=key, result=result)
        if not settled or settled.get('action') != 'reply':
            result = self.save_effect('journal_receipt', **key)
            recent = self.failures[self.failure_mark:]
            settled = journal_save_request('recover', key=key, result=result,
                                           failure=recent[-1] if recent else None)
        if not settled or settled.get('action') != 'reply' or not isinstance(settled.get('reply'), dict):
            return {'status': 'unknown', 'turn_id': key['turn_id'],
                    'reason': 'write outcome unresolved; do not retry the write'}
        if 'previous_id' in settled:
            self.previous_id = settled['previous_id']
        return settled['reply']

    def save_effect(self, operation, **payload):
        try:
            return self.operation(operation, **payload)
        except Exception:
            return None
