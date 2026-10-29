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
MAX_BYTES = 1024**3


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


def build(console, node, *, input_validator=None):
    """The Nix package fixes both inputs; includes the complete console output."""
    console, node = Path(console), Path(node)
    need(console.is_absolute() and console.resolve(strict=True) == console and
         console.is_relative_to('/nix/store') and console.is_dir(), 'RESUME_CONSOLE_OUTPUT')
    invocation = str(node); validate=immutable if input_validator is None else input_validator
    executable = validate(node.resolve(strict=True))
    files, links, directories, total = {}, {}, [], 0
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
    files[str(executable)] = file_fact(executable)
    entry = str(console / 'lib/reverie/dist/index.js')
    need(entry in files and str(console / 'lib/reverie/dist/host-worker-resume.js') in files and
         str(console/'lib/reverie/scripts/owner-terminal-start.mjs')in files,
         'RESUME_MATCHING_CONSOLE_REQUIRED')
    return {'version': 1, 'purpose': PURPOSE, 'console': str(console),
            'nodeInvocation': invocation, 'nodeExecutable': str(executable),
            'programs': programs(console,invocation), 'files': files, 'links': links,
            'directories': sorted(directories)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ('console', 'node', 'output'): parser.add_argument('--' + name, required=True)
    parser.add_argument('--nix-build-inputs',action='store_true')
    args = parser.parse_args(argv)
    from .website_image_provenance import nix_build_input
    value = build(args.console, args.node,input_validator=(
        lambda path:nix_build_input(path,256<<20))if args.nix_build_inputs else None)
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    need(0<len(raw)<=16<<20,'RESUME_MANIFEST_GRAPH_BOUND')
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:stream.write(raw)


if __name__ == '__main__':
    main()
