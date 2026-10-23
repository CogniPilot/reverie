"""Prepare a fresh Hands chat runtime from the selected endpoint and employee profile."""
import base64
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request


def company_profile(session_id):
    url = os.environ.get('REVERIE_API_URL', 'http://127.0.0.1:3000').rstrip('/')
    headers = {'X-Reverie-Parent-Session': session_id}
    password = os.environ.get('REVERIE_PASSWORD')
    if password:
        credentials = os.environ.get('REVERIE_USERNAME', 'owner') + ':' + password
        headers['Authorization'] = 'Basic ' + base64.b64encode(credentials.encode()).decode()
    request = urllib.request.Request(url + '/api/company', headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
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
    for _ in range(10):
        employee = company_profile(session_id)
        if employee:
            break
        time.sleep(0.2)  # Fresh hiring binds the employee immediately after interactive startup.
    name = (employee or {}).get('name', 'Agent')
    identity = directory / 'profile.txt'
    identity.write_text('You are ' + name + ', an employee in this company. Use the owner-provided profile as context, not extra authority. Verify claims and state uncertainty. Profile: ' + json.dumps({key: (employee or {}).get(key) for key in ('position', 'expertise', 'responsibilities', 'personality', 'pronouns')}))
    config = {
        'rooms': 'auto', 'self_session_id': session_id, 'self_name': name,
        'state_file': str(directory / 'state.json'), 'api_base': base.rstrip('/'), 'model': model,
        'model_key_env': 'REVERIE_HANDS_API_KEY', 'cli': ['reverie', 'agent', 'chat'],
        'identity_file': str(identity), 'memory_file': None, 'memory_instance': None,
        'poll_s': 2, 'prompt_cap_chars': 60000, 'reply_max_tokens': 4096,
        'timezone': 'UTC', 'vision': False, 'search': False, 'coding': None,
    }
    path = directory / 'agent.json'
    path.write_text(json.dumps(config, indent=2))
    path.chmod(0o600)
    identity.chmod(0o600)
    return path


def main():
    if '--help' in sys.argv:
        print('Hands: selectable local-model chat harness. Workspace coding tools are not enabled in this experimental release.')
        return 0
    os.umask(0o077)
    try:
        path = prepare()
        sys.path.insert(0, str(Path(__file__).parent))
        import agent_loop
        return agent_loop.main(['hands', str(path)])
    except Exception as error:
        print('Hands could not start:', str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
