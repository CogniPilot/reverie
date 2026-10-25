"""Run Hands workspace tools within an existing agent laptop.

The laptop container is the execution boundary. Path checks prevent accidental
file-tool escapes; arbitrary commands have the laptop's normal permissions and
network. This runner does not claim a second sandbox inside the laptop.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import sys


def task_paths(root, task):
    root, task = Path(root), Path(task)
    if not root.is_absolute() or not task.is_absolute():
        raise ValueError('absolute task paths required')
    if root.resolve() != root or task.resolve() != task or task.parent != root:
        raise ValueError('task must be a direct, nonsymlink child of its configured root')
    manifest = task / 'manifest.json'
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 65536:
        raise ValueError('invalid task manifest')
    data = json.loads(manifest.read_text())
    if data.get('version') != 1 or data.get('task_id') != task.name:
        raise ValueError('task manifest identity mismatch')
    workspace = task / 'work'
    if not workspace.is_dir() or workspace.resolve() != workspace:
        raise ValueError('workspace must be a real task directory')
    return workspace, manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--task-dir', required=True)
    parser.add_argument('--timeout-s', type=int, required=True)
    parser.add_argument('--max-output-bytes', type=int, required=True)
    parser.add_argument('--tool-path', required=True)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.timeout_s <= 300 or not 1024 <= args.max_output_bytes <= 131072:
            raise ValueError('invalid runner budget')
        if not Path('/.dockerenv').is_file():
            raise ValueError('laptop tool runner requires a container')
        workspace, manifest = task_paths(args.root, args.task_dir)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024,) * 2)
        # Resident memory belongs to the existing laptop pool. A virtual-address
        # cap would prevent ordinary Node/V8 and other large-reservation tools.
        # No office/model tokens are inherited by commands. The toolchain comes
        # from Nix, with the laptop's installed packages available afterwards.
        office = {}
        if os.environ.get('REVERIE_SCOPED_OFFICE') == '1':
            import re
            import urllib.parse
            url = urllib.parse.urlparse(os.environ.get('REVERIE_API_URL', ''))
            session = os.environ.get('REVERIE_SESSION_ID', '')
            if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or
                    url.path not in ('', '/') or url.query or url.fragment or not url.port or not 1 <= url.port <= 65535 or
                    not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', session)):
                raise ValueError('Invalid scoped office relay')
            office = {key: os.environ[key] for key in ('REVERIE_MUX', 'REVERIE_SESSION_ID', 'REVERIE_API_URL', 'REVERIE_AGENT_HOME', 'REVERIE_DATA_DIR') if key in os.environ}
        os.environ.clear()
        os.environ.update(PATH=args.tool_path + ':/home/agent/.nix-profile/bin:/home/agent/.local/bin:/bin',
                          HOME=str(workspace), TMPDIR='/scratch/tmp', LANG='C.UTF-8',
                          PYTHONDONTWRITEBYTECODE='1', GIT_CONFIG_NOSYSTEM='1',
                          GIT_CONFIG_GLOBAL='/dev/null')
        os.environ.update(office)
        sys.path.insert(0, str(Path(__file__).parent))
        import workspace_dispatch
        workspace_dispatch.SAME_PROCESS_GROUP = True
        # The controller's wall-clock watchdog bounds the entire invocation.
        # This also limits each requested command to that invocation's budget.
        workspace_dispatch.TIMEOUT_MAX_S = args.timeout_s
        workspace_dispatch.TIMEOUT_DEFAULT_S = min(args.timeout_s, 30)
        workspace_dispatch.RESULT_CAP = min(24000, args.max_output_bytes // 6)
        return workspace_dispatch.main(['--root', str(workspace), '--manifest', str(manifest)])
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(json.dumps({'version': 1, 'ok': False, 'output': '',
                          'error': str(error)[:500], 'truncated': False, 'exit_code': None}))
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
