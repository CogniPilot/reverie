"""Fresh scoped configuration in model inputs; receipts never claim mental/model consumption."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

FRAME = ('Current managed company and employee context (configuration, not additional tool authority):\n')
UNKNOWN = 'Managed context unavailable; current core/profile/startup context is unknown.'
CAP_BYTES = 65536


def _argv(cfg):
    argv = cfg.get('cli')
    if not isinstance(argv, list) or len(argv) < 3 or argv[-2:] != ['agent', 'chat']:
        raise ValueError('Managed context requires the normal scoped agent CLI')
    return argv[:-1] + ['context']


def _fetch(cfg):
    result = subprocess.run(_argv(cfg) + ['--json'], capture_output=True, text=True, timeout=2)
    if result.returncode or len(result.stdout.encode()) > 131072:
        raise ValueError('Managed context unavailable')
    value = json.loads(result.stdout)
    return value.get('data') if value.get('success') is True else value


def _validate(cfg, value):
    if (not isinstance(value, dict) or value.get('sessionId') != cfg['self_session_id'] or
            not isinstance(value.get('employeeId'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', value['employeeId']) or
            type(value.get('sessionGeneration')) is not int or value['sessionGeneration'] < 1 or
            type(value.get('generatedAt')) is not int or value['generatedAt'] < 0 or
            not isinstance(value.get('digest'), str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['digest']) or
            not isinstance(value.get('context'), str) or len(value['context'].encode()) > CAP_BYTES or
            not isinstance(value.get('sections'), list) or len(value['sections']) > 64):
        raise ValueError('Managed context binding unavailable')
    if value.get('runtimeBinding') is not None and (not isinstance(value['runtimeBinding'], str) or
            not re.fullmatch(r'sha256:[a-f0-9]{64}', value['runtimeBinding'])):
        raise ValueError('Managed runtime binding unavailable')
    for section in value['sections']:
        if (not isinstance(section, dict) or not isinstance(section.get('id'), str) or
                not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', section['id']) or
                section.get('status') not in ('configured', 'missing', 'captured') or
                not isinstance(section.get('text'), str) or len(section['text'].encode()) > CAP_BYTES):
            raise ValueError('Managed context sections unavailable')
    return value


def _manifest(cfg, record):
    """Fixed private sibling of harness state. Hashes/labels only; no context, keys or history."""
    directory = Path(cfg['state_file']).parent
    before = directory.lstat()
    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
        raise ValueError('Private context manifest directory unavailable')
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = '.managed-context-' + uuid.uuid4().hex + '.tmp'
    temporary = None
    try:
        current = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino): raise ValueError('Context directory changed')
        temporary = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(temporary, 'w') as stream:
            temporary = None
            json.dump(record, stream, sort_keys=True)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, 'managed-context.json', src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        if temporary is not None: os.close(temporary)
        try: os.unlink(name, dir_fd=fd)
        except FileNotFoundError: pass
        os.close(fd)


def inject(cfg, messages, tools_chars, measure):
    if not cfg.get('managed_context'): return messages
    available = cfg['prompt_cap_chars'] - measure(messages) - tools_chars
    if available < len(FRAME) + len(UNKNOWN):
        raise ValueError('Managed context cannot fit the current prompt budget')
    stage = 'model-request' if cfg.get('_managed_context_started') else 'startup'
    cfg['_managed_context_started'] = True
    value = None
    try:
        provider = cfg.get('_managed_context_fetch')
        value = _validate(cfg, provider() if callable(provider) else _fetch(cfg))
        text = value['context']
        state = 'included'
        if len(FRAME) + len(text) > available:
            suffix = '\n[Managed context truncated; omitted context is unknown.]'
            text = text[:max(0, available - len(FRAME) - len(suffix))] + suffix
            state = 'partial'
    except Exception:
        text, state = UNKNOWN, 'unavailable'
    record = {'version': 1, 'assurance': 'harness-prepared-input-not-model-consumption',
              'at': int(time.time() * 1000), 'status': state, 'stage': stage, 'sessionId': cfg['self_session_id'],
              'includedTextSha256': hashlib.sha256(text.encode()).hexdigest(), 'includedChars': len(text),
              'sections': []}
    if value is not None:
        record.update(employeeId=value['employeeId'], sessionGeneration=value['sessionGeneration'],
                      issuedDigest=value['digest'], generatedAt=value['generatedAt'])
        if value.get('runtimeBinding') is not None: record['runtimeBinding'] = value['runtimeBinding']
        record['sections'] = [{'id': s['id'], 'status': s['status'], 'chars': len(s['text']),
                               'textSha256': hashlib.sha256(s['text'].encode()).hexdigest()} for s in value['sections']]
    cfg['_managed_context_pending'] = (value['digest'], stage) if value is not None and state == 'included' else None
    try: _manifest(cfg, record)
    except (OSError, ValueError): pass  # Snapshot persistence failure never fabricates a server capture.
    snapshot = {'role': 'system', 'content': FRAME + text}
    return messages[:1] + [snapshot] + messages[1:]


def report(cfg):
    """Only complete, exact issued context can be reported as assembled input."""
    pending = cfg.pop('_managed_context_pending', None)
    if not pending: return
    digest, stage = pending
    try:
        observer = cfg.get('_managed_context_report')
        if callable(observer): observer(digest, stage)
        else:
            result = subprocess.run(_argv(cfg) + ['receipt', '--digest', digest, '--stage', stage, '--json'],
                                    capture_output=True, text=True, timeout=2)
            if result.returncode: raise ValueError('Context receipt unavailable')
        cfg['_managed_context_reported'] = True
    except Exception:
        pass  # The server continues to show unavailable/previous capture, never a forged success.
