"""Closed optional service-auth startup facts; no configuration contents or IO."""
from pathlib import PurePosixPath

from .owner_terminal_channel import need

WEB = ['web', '--host', '0.0.0.0', '--port', '3000']


def config_path(value):
    need(type(value) is str and 1 < len(value.encode('utf-8')) <= 4096
         and value.startswith('/') and not value.startswith('//')
         and not any(ord(c) < 32 or ord(c) == 127 for c in value)
         and '..' not in PurePosixPath(value).parts
         and str(PurePosixPath(value)) == value, 'SERVICE_AUTH_GUEST_PATH')
    return value


def web_arguments(arguments):
    need(type(arguments) is list and arguments[:len(WEB)] == WEB,
         'SERVICE_AUTH_FIXED_WEB_ARGV')
    tail = arguments[len(WEB):]
    if tail and tail[-1] == '--resource-replacement':tail = tail[:-1]
    if not tail:return None
    need(len(tail) == 2 and tail[0] == '--service-auth-config', 'SERVICE_AUTH_FIXED_WEB_ARGV')
    return config_path(tail[1])


def protected_startup(program):
    """The two fixed interpreters must receive identical closed web arguments."""
    prefix = program['argvPrefix']; python = program['startupPython']
    wrapper = str(PurePosixPath(program['applicationEntry']).parent.parent / 'scripts/owner-terminal-start.mjs')
    need(type(prefix) is list and prefix[:2] == [program['nodeInvocation'], wrapper]
         and program['nodeWrapper'] == wrapper, 'SERVICE_AUTH_H_NODE_ARGV')
    selected = web_arguments(prefix[2:])
    entry = python['entry']
    need(type(entry) is str, 'SERVICE_AUTH_H_BOOTSTRAP_ARGV')
    path = PurePosixPath(entry)
    need(str(path) == entry and path.is_relative_to('/nix/store')
         and '..' not in path.parts and path.parts[-2:] == ('libexec', 'reverie')
         and python['argvPrefix'] == [python['invocation'], '-I', entry, *prefix[2:]],
         'SERVICE_AUTH_H_BOOTSTRAP_ARGV')
    return {'command': [entry, *prefix[2:]], 'node': prefix, 'serviceAuthConfig': selected}
