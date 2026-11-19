"""Tool and turn handling for the Hands journal."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from weakref import finalize

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
MAX_CALLS = 3
CAPSULE_BYTES = 1536


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


def project_memory_request(action, root, project, **fields):
    reply = native_memory_json("project-memory-worker", {
        "action": action, "root": list(map(ord, os.fspath(root))), "project": project,
        **{key: list(map(ord, value)) for key, value in fields.items()},
    }, 4 * 1024 * 1024, timeout=35)
    if reply is None:
        raise RuntimeError("the packaged project memory worker is unavailable")
    if "error" in reply:
        raise ValueError(reply["error"])
    return reply["value"]


def dream_memory_request(action, **payload):
    reply = native_memory_json("dream-worker", {"action": action, **payload}, TURN_CAPTURE_BYTES)
    if reply is None:
        raise ValueError("native dream operation could not be completed")
    return reply


def journal_tool_request(phase, **payload):
    return native_memory_json('journal-tool-worker', {'phase': phase, **payload}, READ_WORKER_BYTES)


def journal_save_request(phase, **payload):
    return native_memory_json('journal-save-worker', {'phase': phase, 'payload': payload})


def journal_sources(room, history, message):
    fields = ('id', 'roomId', 'at', 'text', 'from')

    def source(row):
        return {k: row[k] for k in fields if k in row} if isinstance(row, dict) else None

    return {'room': room, 'history': [source(row) for row in history], 'message': source(message)}


def capture_turn(room, history, message):
    return native_memory_json('journal-capture-worker', journal_sources(room, history, message), TURN_CAPTURE_BYTES)


def present_turn(room, capsule, turn=None):
    payload = {'room': room, 'capsule': capsule, 'turn': turn}
    arguments = encode_memory_json(payload)
    if capsule is not None and (arguments is None or len(arguments) > READ_WORKER_BYTES):
        # A custom worker can return invalid JSON values in its optional recall.
        # Preserve the ordinary journal context when the capsule cannot cross IPC.
        payload['capsule'] = None
        arguments = encode_memory_json(payload)
    return native_memory_request('journal-context-worker', arguments, READ_WORKER_BYTES) if arguments is not None else None


def automatic_config(cfg):
    keys = ('cli', 'memory_instance', 'memory_timeout_s', 'recall_cap_chars',
            'history_n', 'message_cap_chars', 'self_session_id')
    return {**{key: cfg[key] for key in keys}, 'journal_enabled': cfg.get('journal_enabled', False)}


class Turn:
    """Compatibility client for the native journal turn and its room effects."""

    call_limit = calls = 0
    tools = offered = accepted_calls = ()
    context = recalled = ''
    merged_recall = captured = None
    recall_context_status = 'not_available'
    replay = '{}'

    def __init__(self, cfg, room, history, message, operation=None, now_ms=None, failures=None, evidence=None):
        self.operation = operation
        self.timeout = 23 if operation is None else 5
        self.failures = failures if failures is not None else []
        self.worker = self.cleanup = None
        self.write_sent = False
        if not cfg.get('journal_enabled') or not cfg.get('memory_instance') or room is None:
            return
        from coding_process import WorkerSocket
        try:
            job = journal_sources(room, history, message)
            job.update(automatic=room not in cfg.get('journal_auto_recall_exclude_rooms', []),
                       clock_ms=time.time() * 1000 if now_ms is None else now_ms, evidence=evidence)
            if operation is None:
                job['memory'] = {'config': automatic_config(cfg),
                                 'status_timeout_s': cfg.get('journal_status_timeout_s', 5),
                                 'command_timeout_s': cfg.get('journal_command_timeout_s', 8),
                                 'suppress': room in cfg.get('dm_rooms', []) or room in cfg.get('_auto_dms', [])}
            self.worker = WorkerSocket('journal-turn-worker', job, startup_limit=TURN_CAPTURE_BYTES,
                                       environment=os.environ if operation is None else None)
            self.cleanup = finalize(self, self.worker.close, grace=0.1)
            self.__dict__.update(self.receive())
        except (OSError, EOFError, KeyError, ValueError):
            self.close()
            self.context = ('\nJournal unavailable in this turn; no commit or recall command is offered. '
                            'Do not claim a journal write.')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self.cleanup:
            self.cleanup()
        self.worker = None

    def receive(self):
        while True:
            reply = self.worker.wait(self.timeout)
            if reply.get('write_started'):
                self.write_sent = True
            elif 'effect' in reply:
                self.send_effect(reply['effect'])
            else:
                return reply

    def send_effect(self, request):
        op = request.pop('op')
        self.write_sent |= op == 'journal_commit'
        mark = len(self.failures)
        result, invalid = None, False
        try:
            result = self.operation(op, **request)
        except Exception as error:
            invalid = isinstance(error, (ValueError, TypeError, KeyError))
            if not invalid and not self.write_sent:
                self.close()
                raise
        failure = self.failures[-1] if len(self.failures) > mark else None
        frame = {'result': result, 'failure': failure, 'invalid': invalid}
        if encode_memory_json(frame) is None and op == 'journal_status' and isinstance(result, dict):
            frame['result'] = {**result, 'recall': None}
        if encode_memory_json(frame) is None:
            frame['result'] = None
        self.worker.send(frame)

    def request(self, action, **fields):
        self.worker.send({'action': action, **fields})
        reply = self.receive()
        self.__dict__.update(reply['turn'])
        return reply['result']

    def merge_recalled(self, existing, max_chars):
        if not isinstance(existing, str) or len(existing) > max_chars:
            raise ValueError('recalled evidence exceeds configured cap')
        if not self.worker or not self.recalled:
            return existing
        merged = self.request('merge', existing=existing, max_chars=max_chars)
        if isinstance(merged, dict):
            raise ValueError(merged['error'])
        return merged

    def invoke(self, call):
        self.replay = '{}'
        if not self.worker or not self.tools:
            return {'status': 'refused', 'reason': 'journal_unavailable'}
        self.write_sent = False
        try:
            return self.request('invoke', call=call)
        except (ConnectionError, TimeoutError, EOFError, ValueError):
            self.close()
            self.tools = ()
            if self.write_sent:
                return {'status': 'unknown', 'turn_id': self.captured['end']['id'],
                        'reason': 'write outcome unresolved; do not retry the write'}
            return {'status': 'unavailable', 'failure': 'worker_error'}
