"""Immutable worker factory facts; never installs, loads, starts or grants access.

The fixed Nix factory supplies the archive, profile, source and static toolkit.
Native consumers must compare the actual loaded image with imageSpec and retain
their independent owner, lifecycle, storage, capacity and canary requirements.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import tarfile
import time

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from reverie import website_image_provenance as W
else:
    from . import website_image_provenance as W

PURPOSE = 'worker-image-provenance-v1'
SOURCE_FILES = ('flake.nix', 'nix/image.nix', 'nix/human-terminal-toolkit.nix',
                'nix/worker-idmap.nix', 'nix/worker-idmap.py', 'nix/worker-base-tools.nix',
                'python/reverie/human_terminal_static.c', 'python/reverie/worker_image_provenance.py',
                'python/reverie/website_image_provenance.py', 'python/reverie/__init__.py',
                'nix/worker-image-provenance.nix')
FACTORY_FIELDS = {'name', 'system', 'uid', 'gid', 'subuidStart', 'subgidStart', 'subidCount', 'browser'}
TARGETS = ('/opt/reverie/human/bin/bash', '/opt/reverie/human/bin/reverie-human-shell')
TRACKED = {str(p).lstrip('/') for target in TARGETS for p in (Path(target), *Path(target).parents)
           if str(p) != '/'}
MAX_ELF = 16 << 20
MAX_SOURCE = 1 << 20
MAX_MEMBERS = 2_000_000
MAX_EVENTS = 4096
DEADLINE_SECONDS = 300
SHA = re.compile(r'[a-f0-9]{64}\Z')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def stamp(path):
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def read_input(path, maximum, validate):
    path = validate(path, maximum)
    before = stamp(path)
    with path.open('rb') as stream:
        raw = stream.read(maximum + 1)
    need(0 < len(raw) <= maximum and len(raw) == before[2] and stamp(path) == before,
         'Worker provenance input changed or exceeded its bound')
    return path, raw


def pin(raw):
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}


def profile(raw):
    value = W.decode(raw)
    need(type(value) is dict and set(value) == FACTORY_FIELDS
         and value['name'] == 'lib.workerDockerImage'
         and value['system'] in ('x86_64-linux', 'aarch64-linux')
         and type(value['browser']) is bool, 'Fixed worker factory profile required')
    for key in ('uid', 'gid', 'subuidStart', 'subgidStart', 'subidCount'):
        need(type(value[key]) is int and 0 < value[key] < 4294967295,
             'Finite integer worker factory identity required')
    need(value['uid'] < 2147483648 and value['gid'] < 2147483648 and value['subidCount'] >= 65536,
         'Worker factory identity or mapping bound refused')
    for identity, start in [('uid', 'subuidStart'), ('gid', 'subgidStart')]:
        end = value[start] + value['subidCount']
        need(end < 4294967295 and not value[start] <= value[identity] < end,
             'Worker factory subordinate range refused')
    return value


def require_factory_image(factory, image):
    config = image['Config']
    labels = config.get('Labels')
    need(type(labels) is dict and config.get('User') == f"{factory['uid']}:{factory['gid']}"
         and config.get('Entrypoint') == ['/bin/sleep'] and config.get('Cmd') == ['infinity']
         and config.get('WorkingDir') == '/reverie_workspace', 'Worker image program or identity differs')
    expected = {'org.reverie.worker.uid': str(factory['uid']),
                'org.reverie.worker.gid': str(factory['gid']),
                'org.reverie.worker.rootless-docker': '1',
                'org.reverie.worker.rootless-docker.mount-layout': '1',
                'org.reverie.worker.subuid-start': str(factory['subuidStart']),
                'org.reverie.worker.subgid-start': str(factory['subgidStart']),
                'org.reverie.worker.subid-count': str(factory['subidCount']),
                'reverie.worker.nix-store': '1'}
    need(all(labels.get(k) == v for k, v in expected.items()), 'Worker factory labels differ')
    need((labels.get('org.reverie.worker.browser') == '1') if factory['browser'] else
         ('org.reverie.worker.browser' not in labels),
         'Worker factory browser profile differs')
    need(image['Os'] == 'linux' and image['Architecture'] ==
         {'x86_64-linux': 'amd64', 'aarch64-linux': 'arm64'}[factory['system']],
         'Worker factory platform differs')


def require_static_elf(raw, system):
    """Read ELF64 metadata only, including every dynamic table; never execute."""
    need(64 <= len(raw) <= MAX_ELF and raw[:7] == b'\x7fELF\x02\x01\x01',
         'Static little-endian ELF64 toolkit required')
    header = struct.unpack_from('<16sHHIQQQIHHHHHH', raw)
    need(header[1] in (2, 3) and header[2] == {'x86_64-linux': 62, 'aarch64-linux': 183}[system]
         and header[3] == 1 and header[8] == 64 and header[9] == 56
         and 1 <= header[10] <= 1024 and header[5] + 56 * header[10] <= len(raw),
         'Toolkit ELF program metadata differs')
    load = False
    for i in range(header[10]):
        kind, _flags, offset, _virtual, _physical, size, _memory, _align = struct.unpack_from(
            '<IIQQQQQQ', raw, header[5] + i * 56)
        need(offset <= len(raw) and size <= len(raw) - offset and kind != 3,
             'Toolkit interpreter or segment bounds refused')
        load |= kind == 1
        if kind == 2:
            need(size % 16 == 0, 'Toolkit dynamic metadata malformed')
            for position in range(offset, offset + size, 16):
                tag, _value = struct.unpack_from('<qQ', raw, position)
                need(tag != 1, 'Toolkit dynamic dependency refused')
                if tag == 0:
                    break
    need(load, 'Toolkit ELF load segment required')


def toolkit(manifest, factory, validate):
    path, raw = read_input(manifest, 8192, validate)
    need(path.name == 'manifest.json' and path.parent.name == 'reverie-human-terminal'
         and path.parent.parent.name == 'share', 'Fixed human toolkit manifest path required')
    value = W.decode(raw)
    need(type(value) is dict and set(value) == {'version', 'static', 'files'}
         and type(value['version']) is int and value['version'] == 1 and value['static'] is True
         and type(value['files']) is dict and set(value['files']) == set(TARGETS),
         'Exact static human toolkit manifest required')
    for name, expected in value['files'].items():
        need(type(expected) is dict and set(expected) == {'sha256', 'bytes'}
             and type(expected['bytes']) is int and 64 <= expected['bytes'] <= MAX_ELF
             and type(expected['sha256']) is str and SHA.fullmatch(expected['sha256']),
             'Toolkit file pin malformed')
        _file, data = read_input(path.parents[2] / name.lstrip('/'), MAX_ELF, validate)
        need(pin(data) == expected, 'Toolkit immutable file bytes differ')
        require_static_elf(data, factory['system'])
    return {'manifest': {'path': str(path), **pin(raw)}, **value}


class HashReader:
    def __init__(self, stream, maximum, end):
        self.stream, self.maximum, self.end = stream, maximum, end
        self.count = 0
        self.digest = hashlib.sha256()

    def read(self, size=-1):
        need(time.monotonic() < self.end, 'Worker archive deadline expired')
        part = self.stream.read(min(size, 1 << 20) if size >= 0 else 1 << 20)
        self.count += len(part)
        need(self.count <= self.maximum and time.monotonic() < self.end,
             'Worker archive read bound or deadline expired')
        self.digest.update(part)
        return part

    def drain(self):
        while self.read(1 << 20):
            pass


def canonical(name):
    need(type(name) is str and len(name) <= 8192 and '\0' not in name
         and '..' not in name.split('/'), 'Canonical worker layer path required')
    return '/'.join(p for p in name.split('/') if p not in ('', '.'))


def layer_facts(stream, maximum, end, files, budget):
    reader = HashReader(stream, maximum, end)
    deletes, entries = [], []
    with tarfile.open(fileobj=reader, mode='r|') as layer:
        for member in layer:
            budget[0] -= 1
            need(budget[0] >= 0, 'Worker layer member bound exceeded')
            name = canonical(member.name)
            parent, _, base = name.rpartition('/')
            if base.startswith('.wh.'):
                prefix, include = (parent, False) if base == '.wh..wh..opq' else (
                    (parent + '/' if parent else '') + base[4:], True)
                if any((include and t == prefix) or not prefix or t.startswith(prefix + '/') for t in TRACKED):
                    deletes.append((prefix, include))
            elif name in TRACKED:
                kind = 'directory' if member.isdir() else 'file' if member.isfile() else 'other'
                fact = {'kind': kind, 'uid': member.uid, 'gid': member.gid, 'mode': member.mode & 0o7777}
                if '/' + name in files and member.isfile():
                    need(member.size == files['/' + name]['bytes'] and member.size <= MAX_ELF,
                         'Archived toolkit file size differs')
                    data = layer.extractfile(member)
                    need(data is not None, 'Archived toolkit file unavailable')
                    raw = data.read(MAX_ELF + 1)
                    need(len(raw) == member.size and pin(raw) == files['/' + name],
                         'Archived toolkit file bytes differ')
                    fact.update(pin(raw))
                entries.append((name, fact))
            need(len(entries) + len(deletes) <= MAX_EVENTS, 'Worker selected-layer event bound exceeded')
    reader.drain()
    need(reader.count == maximum, 'Worker layer length differs')
    return reader.digest.hexdigest(), deletes, entries


def apply_facts(changes, files):
    state = {}
    for deletes, entries in changes:
        # OCI whiteouts remove lower-layer content before this layer's additions.
        for prefix, include in deletes:
            for name in list(state):
                if (include and name == prefix) or not prefix or name.startswith(prefix + '/'):
                    del state[name]
        for name, fact in entries:
            if fact['kind'] != 'directory':
                for child in list(state):
                    if child.startswith(name + '/'):
                        del state[child]
            if '/' + name in files:
                need(all(state.get(str(parent), {}).get('kind') == 'directory'
                         for parent in Path(name).parents if str(parent) != '.'),
                     'Archived toolkit ancestor unavailable or replaced')
            state[name] = fact
    for name in TRACKED:
        actual = state.get(name)
        need(actual is not None and actual['uid'] == actual['gid'] == 0,
             'Final toolkit path or root ownership differs')
        if '/' + name in files:
            need(actual == {'kind': 'file', 'uid': 0, 'gid': 0, 'mode': 0o555, **files['/' + name]},
                 'Final direct regular0555 toolkit file differs')
        else:
            need(actual['kind'] == 'directory' and not actual['mode'] & 0o022,
                 'Final toolkit ancestor is not a protected directory')


def archive_facts(archive, files, image, end):
    before = stamp(archive)
    layers, manifest, seen, budget = {}, None, set(), [MAX_MEMBERS]
    with archive.open('rb') as raw:
        reader = HashReader(raw, before[2], end)
        with tarfile.open(fileobj=reader, mode='r|*') as outer:
            for member in outer:
                name = canonical(member.name)
                need(name not in seen and len(seen) < 4096, 'Worker archive member repeated or excessive')
                seen.add(name)
                if name == 'manifest.json':
                    need(member.isfile() and 0 < member.size <= W.MAX_JSON, 'Worker manifest must be bounded regular data')
                    data = outer.extractfile(member).read(W.MAX_JSON + 1)
                    need(len(data) == member.size, 'Worker manifest length differs')
                    manifest = W.decode(data)
                elif name.endswith('/layer.tar'):
                    need(member.isfile() and 0 < member.size <= W.MAX_UNPACKED, 'Worker layer must be bounded regular data')
                    layers[name] = layer_facts(outer.extractfile(member), member.size, end, files, budget)
        reader.drain()
        need(reader.count == before[2], 'Worker archive length differs')
    need(type(manifest) is list and len(manifest) == 1 and type(manifest[0]) is dict
         and set(manifest[0]) == {'Config', 'RepoTags', 'Layers'}, 'Exactly one fixed worker image required')
    selected = manifest[0]
    need(selected['Config'] == image['archiveConfigSHA256'] + '.json'
         and type(selected['Layers']) is list and len(selected['Layers']) == len(set(selected['Layers']))
         and set(selected['Layers']) == set(layers), 'Complete worker layer order required')
    need(len(selected['Layers']) == len(image['imageSpec']['RootFS']['Layers']), 'Worker layer count differs')
    changes = []
    for name, expected in zip(selected['Layers'], image['imageSpec']['RootFS']['Layers']):
        digest, deletes, entries = layers[name]
        need(expected == 'sha256:' + digest, 'Worker actual layer DiffID differs')
        changes.append((deletes, entries))
    apply_facts(changes, files)
    need(stamp(archive) == before and time.monotonic() < end, 'Worker archive changed or deadline expired')
    return {'path': str(archive), 'sha256': reader.digest.hexdigest(), 'bytes': before[2]}


def build(archive, source, profile_path, toolkit_manifest, *, input_validator=None):
    """Generate facts from real archive bytes; a test port may model file custody only."""
    validate = W.immutable if input_validator is None else input_validator
    end = time.monotonic() + DEADLINE_SECONDS
    archive = validate(archive, W.MAX_ARCHIVE)
    _profile, raw = read_input(profile_path, 4096, validate)
    factory = profile(raw)
    source = Path(source)
    need(source.is_absolute() and source.resolve(strict=True) == source and source.is_dir(),
         'Canonical fixed factory source required')
    source_files = {}
    for name in SOURCE_FILES:
        _path, raw = read_input(source / name, MAX_SOURCE, validate)
        source_files[name] = pin(raw)
    selected_toolkit = toolkit(toolkit_manifest, factory, validate)
    image = W.archive_configuration(archive)
    require_factory_image(factory, image['imageSpec'])
    selected_archive = archive_facts(archive, selected_toolkit['files'], image, end)
    need(time.monotonic() < end, 'Worker provenance deadline expired')
    return {'version': 1, 'purpose': PURPOSE, **image, 'archive': selected_archive,
            'factory': factory, 'source': {'path': str(source), 'factoryFiles': source_files},
            'toolkit': selected_toolkit}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ('archive', 'source', 'profile', 'toolkit-manifest', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--nix-build-inputs', action='store_true',
                        help='Fixed Nix producer: read-only namespace-mapped inputs, not native authority')
    args = parser.parse_args(argv)
    try:
        result = build(args.archive, args.source, args.profile, args.toolkit_manifest,
                       input_validator=W.nix_build_input if args.nix_build_inputs else None)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('x') as stream:
            json.dump(result, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
        return 0
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError, struct.error):
        parser.exit(2, 'Immutable worker image provenance unavailable\n')


if __name__ == '__main__':
    raise SystemExit(main())
