"""Fixed immutable console graph for the host resume purpose; no owner grant."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1])); __package__ = 'reverie'

from .owner_terminal_channel import need

PURPOSE = 'host-worker-resume-program-v1'
MAX_FILES = 65536
# Complete console output plus its fixed executable; no runtime subset omission.
MAX_BYTES = 2 * 1024**3


def signature(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def immutable(path):
    path = Path(path)
    need(path.is_absolute() and path.is_relative_to('/nix/store') and
         path.resolve(strict=True) == path, 'RESUME_IMMUTABLE_PROGRAM')
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.getuid()) and
         not info.st_mode & 0o222 and info.st_nlink >= 1,
         'RESUME_IMMUTABLE_PROGRAM')
    return path


def file_fact(path):
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o222,
         'RESUME_READONLY_PROGRAM')
    need(0 <= before.st_size <= 256 << 20, 'RESUME_PROGRAM_BOUND')
    with path.open('rb') as stream:
        value = hashlib.file_digest(stream, 'sha256').hexdigest()
    need(signature(path.lstat()) == signature(before), 'RESUME_PROGRAM_CHANGED')
    return {'sha256': value, 'bytes': before.st_size, 'mode': stat.S_IMODE(before.st_mode)}


def programs(console,node):
    """Only the two compiled entrypoints and their fixed resource variant."""
    return [[str(node),str(Path(console)/entry),'web','--host','0.0.0.0','--port','3000',*extra]
            for entry in ('lib/reverie/dist/index.js','lib/reverie/scripts/owner-terminal-start.mjs')
            for extra in ([],['--resource-replacement'])]


def require_programs(value):
    need(value['programs']==programs(value['console'],value['nodeInvocation']) and
         str(Path(value['console'])/'lib/reverie/scripts/owner-terminal-start.mjs')in value['files'],
         'RESUME_FIXED_WEBSITE_ARGV')
    owner_program(value, verify_files=True)


def owner_program(value, *, verify_files=False, input_validator=None):
    """An optional Nix-selected H manifest, never a caller's argv extension."""
    pair = value.get('ownerTerminalProgram')
    if pair is None:
        need('ownerTerminalProgram' not in value, 'RESUME_H_PROGRAM_PAIR')
        return None
    need(type(pair) is dict and set(pair) == {'path', 'sha256'}
         and type(pair['path']) is str and 0 < len(pair['path']) <= 4096
         and type(pair['sha256']) is str and len(pair['sha256']) == 64
         and all(c in '0123456789abcdef' for c in pair['sha256']), 'RESUME_H_PROGRAM_PAIR')
    from .website_image_provenance import startup_program
    from .website_service_auth import protected_startup
    program, observed = startup_program(pair['path'], value['console'], value['nodeInvocation'],
        verify_files=verify_files, input_validator=input_validator)
    need(observed == pair, 'RESUME_H_PROGRAM_CHANGED')
    return protected_startup(program)


def selected_programs(value, command):
    """Bind ordinary auth startup to native same-container Cmd, never wire input.

    Protected authenticated startup additionally requires its exact immutable
    H manifest selected in this broker's program graph.
    """
    need(type(command) is list and 1 <= len(command) <= 16 and all(
         type(arg) is str and 0 < len(arg.encode('utf8')) <= 4096 and
         not any(char in arg for char in '\0\r\n') for arg in command), 'RESUME_FIXED_WEBSITE_ARGV')
    protected = owner_program(value)
    if protected is not None and command[0] == protected['command'][0]:
        need(command == protected['command'], 'RESUME_FIXED_WEBSITE_ARGV')
        return [protected['node']]
    if not any(arg == '--service-auth-config' or arg.startswith('--service-auth-config=') for arg in command):
        return value['programs']
    base = ['web', '--host', '0.0.0.0', '--port', '3000']
    end = 1 + len(base)
    need(command[0] in ('reverie', '/bin/reverie') and command[1:end] == base,
         'RESUME_FIXED_WEBSITE_ARGV')
    extra = command[end:]
    need(len(extra) in (2, 3) and extra[0] == '--service-auth-config' and
         (len(extra) == 2 or extra[2] == '--resource-replacement'), 'RESUME_FIXED_WEBSITE_ARGV')
    path = Path(extra[1])
    need(path.is_absolute() and extra[1] != '/' and not extra[1].startswith('//') and
         '..' not in path.parts and str(path) == extra[1], 'RESUME_FIXED_WEBSITE_ARGV')
    return [[*value['programs'][0], *extra]]


def build(console, node, *, input_validator=None, owner_terminal_program=None):
    """The Nix package fixes both inputs; includes the complete console output."""
    console, node = Path(console), Path(node)
    need(console.is_absolute() and console.resolve(strict=True) == console and
         console.is_relative_to('/nix/store') and console.is_dir(), 'RESUME_CONSOLE_OUTPUT')
    invocation = str(node); validate=immutable if input_validator is None else input_validator
    executable = validate(node.resolve(strict=True))
    node_fact = file_fact(executable)
    files, links, directories, total = {}, {}, [], node_fact['bytes']
    need(total <= MAX_BYTES, 'RESUME_PROGRAM_TOTAL')
    pending = [console]
    while pending:
        directory = pending.pop(); info = directory.lstat()
        need(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o222,
             'RESUME_READONLY_PROGRAM_DIRECTORY')
        directories.append(str(directory))
        for path in sorted(directory.iterdir()):
            need(len(files) + len(links) + len(directories) < MAX_FILES, 'RESUME_PROGRAM_COUNT')
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = path.resolve(strict=True)
                need(target.is_relative_to(console), 'RESUME_CONSOLE_LINK_ESCAPES')
                links[str(path)] = os.readlink(path)
            elif stat.S_ISDIR(info.st_mode):
                pending.append(path)
            else:
                need(stat.S_ISREG(info.st_mode), 'RESUME_PROGRAM_ENTRY')
                fact = file_fact(path); total += fact['bytes']
                need(total <= MAX_BYTES, 'RESUME_PROGRAM_TOTAL')
                files[str(path)] = fact
    files[str(executable)] = node_fact
    entry = str(console / 'lib/reverie/dist/index.js')
    need(entry in files and str(console / 'lib/reverie/dist/host-worker-resume.js') in files and
         str(console/'lib/reverie/scripts/owner-terminal-start.mjs')in files,
         'RESUME_MATCHING_CONSOLE_REQUIRED')
    result = {'version': 1, 'purpose': PURPOSE, 'console': str(console),
            'nodeInvocation': invocation, 'nodeExecutable': str(executable),
            'programs': programs(console,invocation), 'files': files, 'links': links,
            'directories': sorted(directories)}
    if owner_terminal_program is not None:
        selected = validate(Path(owner_terminal_program))
        need(selected.stat().st_size <= 65536, 'RESUME_H_PROGRAM_BOUND')
        result['ownerTerminalProgram'] = {'path': str(selected), 'sha256': file_fact(selected)['sha256']}
        owner_program(result, verify_files=True, input_validator=(
            lambda path, maximum, **kwargs: validate(path)))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ('console', 'node', 'output'): parser.add_argument('--' + name, required=True)
    parser.add_argument('--nix-build-inputs',action='store_true')
    parser.add_argument('--owner-terminal-program')
    args = parser.parse_args(argv)
    from .website_image_provenance import nix_build_input
    value = build(args.console, args.node,input_validator=(
        lambda path:nix_build_input(path,256<<20))if args.nix_build_inputs else None,
        owner_terminal_program=args.owner_terminal_program)
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    need(0<len(raw)<=16<<20,'RESUME_MANIFEST_GRAPH_BOUND')
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:stream.write(raw)


if __name__ == '__main__':
    main()
