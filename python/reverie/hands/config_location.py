"""The launcher-selected, session-bound Hands configuration path; never searches."""
from pathlib import Path
import re


def configuration_path(env, session=None):
    selected = session or env.get('REVERIE_SESSION_ID', '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', selected):
        raise ValueError('Invalid registered session')
    if session and env.get('REVERIE_SESSION_ID', session) != session:
        raise ValueError('Configuration session mismatch')
    home = Path(env.get('REVERIE_AGENT_HOME') or env.get('HOME') or Path.home())
    root = Path(env.get('REVERIE_DATA_DIR') or home / '.reverie')
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Use the canonical launcher data directory')
    path = root / 'hands' / selected / 'agent.json'
    if path.resolve() != path:
        raise ValueError('Configuration ancestry is aliased')
    return path
