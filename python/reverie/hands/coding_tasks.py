import json
import math
import re
from dataclasses import asdict, dataclass

from agent_journal import native_memory_json


TOOL_NAMES = frozenset(('read_file', 'list_files', 'search_files', 'edit_file',
                        'write_file', 'run_command', 'run_tests'))
ARGUMENT_CHARS = 24000


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


@dataclass(frozen=True)
class Limits:
    steps: int = 64
    seconds: float = 1800
    operation_seconds: float = 30
    request_bytes: int = 262144
    wire_bytes: int = 131072
    frame_chars: int = 24000
    argument_chars: int = ARGUMENT_CHARS
    output_chars: int = 20000
    output_bytes: int = 80000
    total_bytes: int = 524288
    prompt_chars: int = 120000

    def __post_init__(self):
        for name in self.__dataclass_fields__:
            value = getattr(self, name)
            numeric = name in ('seconds', 'operation_seconds')
            if (type(value) not in ((int, float) if numeric else (int,)) or
                    not math.isfinite(value) or value <= 0):
                raise ValueError('invalid limit: ' + name)
        if self.prompt_chars > 120000:
            raise ValueError('prompt limit exceeds supported context budget')
        if self.argument_chars > ARGUMENT_CHARS:
            raise ValueError('argument limit exceeds the supported tool argument budget')


def reserve_chars(limits):
    reply = native_memory_json('hands-coding-policy-worker', {'limits': asdict(limits)})
    if reply is None or 'reserve_chars' not in reply:
        raise ValueError('invalid coding limits')
    return reply['reserve_chars']


def bounded_runner_text(value, limit):
    if isinstance(value, (bytes, bytearray)) and len(value) <= limit:
        try:
            return value.decode('utf-8')
        except UnicodeError:
            pass
    return ''


def runner_outcome(process, limits):
    reply = native_memory_json('hands-coding-policy-worker', {
        'limits': asdict(limits),
        'frame': None if process.error else bounded_runner_text(process.output, limits.wire_bytes),
        'diagnostics': bounded_runner_text(getattr(process, 'stderr_tail', b''), 4096),
    }, 1048576)
    return (reply.get('result'), reply.get('report')) if reply else (None, None)


def control_request(message):
    text = message.get('text')
    if not isinstance(text, str):
        return None
    if (message.get('from') or {}).get('kind') == 'agent' and text.startswith('[external agent] '):
        text = text[len('[external agent] '):]
    matched = re.match(r'\A/code(?P<cancel>-cancel)? (?P<task>[a-z0-9][a-z0-9_-]{0,63})(?:\s|\Z)', text)
    if matched is None:
        return None
    return {'action': 'cancel' if matched['cancel'] else 'start', 'task_id': matched['task'],
            'brief': text[matched.end():].strip()}


def permitted_sender(settings, room, task_id, message):
    task = settings.get('tasks', {}).get(task_id)
    sender = message.get('from')
    if not isinstance(task, dict) or room not in task.get('rooms', []) or not isinstance(sender, dict):
        return False
    if sender.get('kind') == 'user':
        return sender.get('authenticatedOwner') is True
    if sender.get('kind') == 'agent':
        session = sender.get('sessionId')
        return isinstance(session, str) and bool(session) and session in task.get('delegate_sessions', [])
    return False


def begin_request(journal, room, source_id, task_id, persist):
    if not isinstance(source_id, str) or not source_id or len(source_id) > 200:
        raise ValueError('invalid source id')
    key = room + ':' + source_id
    if key in journal:
        return False
    if any(entry.get('status') == 'started' for entry in journal.values()):
        return False
    if len(journal) >= 500:
        raise ValueError('journal capacity; operator rotation required')
    journal[key] = {'task_id': task_id, 'status': 'started', 'reason': None}
    persist()
    return True


def interrupt_requests(journal, persist):
    changed = False
    for entry in journal.values():
        if entry.get('status') == 'started':
            entry.update(status='stopped', reason='interrupted')
            changed = True
    if changed:
        persist()
