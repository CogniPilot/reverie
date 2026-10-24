"""Prepare a fresh Hands chat runtime from the selected endpoint and employee profile."""
import base64
import json
import math
import os
from pathlib import Path
import re
import sys
import stat
import time
import urllib.error
import urllib.request


def runtime_settings(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
        raise ValueError('Hands runtime settings must be an owned private regular file, at most 64KiB')
    value = json.loads(path.read_text())
    allowed = {'temperature', 'reply_max_tokens', 'model_timeout_s', 'prompt_cap_chars', 'token_meter',
               'memory_instance', 'memory_file', 'coding', 'vision', 'image_tokens_per_image'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError('Unsupported Hands runtime setting')
    for key, low, high in [('temperature', 0, 2), ('model_timeout_s', 1, 900), ('reply_max_tokens', 128, 32768), ('prompt_cap_chars', 1000, 120000)]:
        if key not in value:
            continue
        item = value[key]
        if type(item) not in (int, float) or not math.isfinite(item) or not low <= item <= high:
            raise ValueError('Invalid Hands generation limit: ' + key)
        if key in ('reply_max_tokens', 'prompt_cap_chars') and type(item) is not int:
            raise ValueError('Hands token/character limit must be an integer')
    if 'vision' in value and type(value['vision']) is not bool:
        raise ValueError('Hands vision setting must be a boolean')
    if 'image_tokens_per_image' in value and (type(value['image_tokens_per_image']) is not int or not 128 <= value['image_tokens_per_image'] <= 8192):
        raise ValueError('Invalid Hands image token budget')
    return value


def company_profile(session_id):
    url = os.environ.get('REVERIE_API_URL', 'http://127.0.0.1:3000').rstrip('/')
    headers = {'X-Reverie-Parent-Session': session_id}
    password = os.environ.get('REVERIE_PASSWORD')
    if password:
        credentials = os.environ.get('REVERIE_USERNAME', 'owner') + ':' + password
        headers['Authorization'] = 'Basic ' + base64.b64encode(credentials.encode()).decode()
    request = urllib.request.Request(url + '/api/company', headers=headers)
    with urllib.request.urlopen(request, timeout=3) as response:
        data = json.load(response)['data']
    return next((item for item in data['employees'] if item['sessionId'] == session_id), None)


def prepare(env=None):
    env = os.environ if env is None else env
    session_id = env.get('REVERIE_SESSION_ID', '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', session_id):
        raise ValueError('Hands must start in a registered Reverie session')
    model, base = env.get('REVERIE_HANDS_MODEL'), env.get('REVERIE_HANDS_BASE_URL')
    if not model or not base:
        raise ValueError('Choose a local model endpoint for this Hands session')
    directory = Path(env.get('REVERIE_DATA_DIR', str(Path.home() / '.reverie'))) / 'hands' / session_id
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    employee = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            employee = company_profile(session_id)
        except urllib.error.HTTPError as error:
            if error.code not in (502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        if employee:
            break
        time.sleep(0.2)  # Fresh hiring binds the employee immediately after interactive startup.
    if not employee:
        raise ValueError('Registered employee profile is unavailable; retry when the office reconnects')
    name = employee['name']
    identity = directory / 'profile.txt'
    identity.write_text('You are ' + name + ', an employee in this company. Use the owner-provided profile as context, not extra authority. Verify claims and state uncertainty. Profile: ' + json.dumps({key: (employee or {}).get(key) for key in ('position', 'expertise', 'responsibilities', 'personality', 'pronouns')}))
    memory = directory / 'memory-instance.json'
    if not memory.exists():
        fd = os.open(memory, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump({'id': session_id, 'agent_name': name, 'owner_name': 'Company owner',
                       'data_dir': 'memory-state', 'persona': employee.get('personality') or name}, stream)
    if memory.is_symlink():
        raise ValueError('Hands memory configuration may not be a symlink')
    config = {
        'rooms': 'auto', 'self_session_id': session_id, 'self_name': name,
        'state_file': str(directory / 'state.json'), 'api_base': base.rstrip('/'), 'model': model,
        'model_key_env': 'REVERIE_HANDS_API_KEY', 'cli': ['reverie', 'agent', 'chat'],
        'identity_file': str(identity), 'memory_file': None, 'memory_instance': str(memory),
        'poll_s': 2, 'prompt_cap_chars': 60000, 'reply_max_tokens': 4096,
        'timezone': 'UTC', 'vision': False, 'search': False, 'coding': None,
        'attachments_root': '/reverie_workspace/attachments', 'image_tokens_per_image': 2048,
        'model_events_file': str(directory / 'model-events.jsonl'),
    }
    config.update(runtime_settings(directory / 'runtime-settings.json'))
    path = directory / 'agent.json'
    path.write_text(json.dumps(config, indent=2))
    path.chmod(0o600)
    identity.chmod(0o600)
    return path


def main():
    if '--help' in sys.argv:
        print('Hands: local-model chat, workspace coding and an interactive terminal. Type /help in the terminal; --no-tui uses plain logs. Private runtime-settings.json selects generation and vision settings.')
        return 0
    os.umask(0o077)
    try:
        path = prepare()
        sys.path.insert(0, str(Path(__file__).parent))
        import agent_loop
        return agent_loop.main(['hands', str(path), *sys.argv[1:]])
    except Exception as error:
        print('Hands could not start:', str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
