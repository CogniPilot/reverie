"""Build immutable website image/program facts; never installs or grants authority.

The Nix builder supplies its own image, console, interpreter and client manifest.
The archive configuration hash and complete expected image fields, including
RootFS diff IDs, remain distinct from the engine's native image/manifest ID.
Native consumers must compare all expected fields to the actual daemon image
and independently qualify the live container, code mounts and process peers.
This is not a layer privacy scan, owner approval or a running-service receipt.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import time

MAX_JSON = 4 << 20
MAX_ARCHIVE = 16 << 30
MAX_UNPACKED = 64 << 30
MAX_CODE = 256 << 20
SHA = re.compile(r'[a-f0-9]{64}\Z')


def require(value, message):
    if not value:
        raise ValueError(message)


def unique(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, 'Duplicate provenance field')
        out[key] = value
    return out


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite provenance field')))


def archive_configuration(file):
    """Read finite archive metadata only; never extracts or executes a member."""
    limit = time.monotonic() + 300
    manifest = None
    configurations = {}
    seen, regular, total, count = set(), set(), 0, 0
    with tarfile.open(file, mode='r|*') as archive:
        for member in archive:
            require(time.monotonic() < limit, 'Image metadata read deadline')
            count += 1
            require(count <= 4096, 'Image archive member bound')
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and '..' not in name.parts and str(name) == member.name.rstrip('/'),
                    'Canonical archive member required')
            require(member.name not in seen, 'Duplicate archive member')
            seen.add(member.name)
            if member.isfile():
                regular.add(member.name)
            require(member.size >= 0, 'Invalid archive size')
            total += ((member.size + 511) // 512 + 1) * 512
            require(total <= MAX_UNPACKED, 'Image decompressed byte bound')
            selected = member.name == 'manifest.json' or (
                len(name.parts) == 1 and member.name.endswith('.json') and SHA.fullmatch(member.name[:-5]))
            if not selected:
                continue
            require(member.isfile() and 0 < member.size <= MAX_JSON, 'Image metadata must be bounded regular files')
            raw = archive.extractfile(member).read(MAX_JSON + 1)
            require(len(raw) == member.size, 'Image metadata changed')
            if member.name == 'manifest.json':
                manifest = decode(raw)
            else:
                configurations[member.name] = raw
    require(type(manifest) is list and len(manifest) == 1 and type(manifest[0]) is dict,
            'Exactly one Docker image required')
    item = manifest[0]
    require(set(item) == {'Config', 'RepoTags', 'Layers'} and type(item['Config']) is str
            and item['Config'] in configurations and type(item['Layers']) is list
            and 1 <= len(item['Layers']) <= 256 and all(type(v) is str and v in regular for v in item['Layers']),
            'Complete image configuration and layers required')
    raw = configurations[item['Config']]
    identity = hashlib.sha256(raw).hexdigest()
    require(item['Config'] == identity + '.json', 'Image configuration identity differs')
    document = decode(raw)
    require(type(document) is dict and type(document.get('config')) is dict,
            'Complete image configuration required')
    rootfs = document.get('rootfs')
    require(type(rootfs) is dict and set(rootfs) == {'type', 'diff_ids'} and rootfs['type'] == 'layers'
            and type(rootfs['diff_ids']) is list and len(rootfs['diff_ids']) == len(item['Layers'])
            and all(type(v) is str and v.startswith('sha256:') and SHA.fullmatch(v[7:]) for v in rootfs['diff_ids']),
            'Complete image RootFS required')
    require(type(document.get('architecture')) is str and re.fullmatch('[a-z0-9_]{1,32}', document['architecture'])
            and document.get('os') == 'linux' and type(document.get('created')) is str,
            'Complete image platform and creation metadata required')
    created = datetime.datetime.fromisoformat(document['created'].replace('Z', '+00:00'))
    require(created.tzinfo is not None, 'Image creation timezone required')
    return {'archiveConfigSHA256': identity,
            'imageSpec': {'Config': document['config'],
                          'RootFS': {'Type': 'layers', 'Layers': rootfs['diff_ids']},
                          'Architecture': document['architecture'], 'Os': document['os'],
                          'Created': document['created']}}


def immutable(path, maximum, *, allow_empty=False):
    path = Path(path)
    require(path.is_absolute() and path.is_relative_to('/nix/store') and path.resolve(strict=True) == path,
            'Canonical immutable Nix artifact required')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o222
            and (0 if allow_empty else 1) <= info.st_size <= maximum, 'Immutable artifact custody refused')
    return path


def nix_build_input(path, maximum, *, allow_empty=False):
    """Read-only Nix builder input, never a native custody or authority proof.

    Linux Nix user namespaces may expose root-owned store inputs as uid 65534.
    Derive that mapping from the fixed namespace root/store, not an environment
    variable or caller-supplied uid. Native consumers continue to use immutable.
    """
    path = Path(path)
    require(path.is_absolute() and path.is_relative_to('/nix/store') and path.resolve(strict=True) == path,
            'Canonical immutable Nix artifact required')
    store = Path('/nix/store').stat()
    require(stat.S_ISDIR(store.st_mode) and store.st_uid == Path('/').stat().st_uid,
            'Nix builder root/store ownership differs')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == store.st_uid and not info.st_mode & 0o222
            and (0 if allow_empty else 1) <= info.st_size <= maximum, 'Read-only Nix build input refused')
    return path


def verify_image_spec(provenance, actual):
    """Match a native image readback; no caller identity, grants or effects."""
    require(type(actual) is dict and type(actual.get('Id')) is str and actual['Id'].startswith('sha256:')
            and SHA.fullmatch(actual['Id'][7:]), 'Native image identity required')
    expected = provenance['imageSpec']
    for name in ['Config', 'RootFS', 'Architecture', 'Os']:
        require(actual.get(name) == expected[name], 'Native full image fields differ')
    def instant(value):
        require(type(value) is str, 'Image creation instant required')
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parsed.tzinfo is not None, 'Image creation timezone required')
        return parsed
    require(instant(actual.get('Created')) == instant(expected['Created']), 'Native image creation differs')
    descriptor = actual.get('Descriptor')
    if descriptor is None:
        require(actual['Id'] == 'sha256:' + provenance['archiveConfigSHA256'], 'Legacy image config identity differs')
    else:
        require(type(descriptor) is dict and descriptor.get('digest') == actual['Id']
                and descriptor.get('mediaType') in ('application/vnd.docker.distribution.manifest.v2+json',
                    'application/vnd.oci.image.manifest.v1+json'), 'Native image manifest identity differs')
    return actual['Id']


def code(path, *, input_validator=None):
    validate = immutable if input_validator is None else input_validator
    path = validate(path, MAX_CODE, allow_empty=True)
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        while part := stream.read(1 << 20):
            hasher.update(part)
    return str(path), {'sha256': hasher.hexdigest(), 'bytes': path.stat().st_size}


def startup_program(path, console, node, *, verify_files=False, input_validator=None):
    """Optional fixed H startup graph, selected by the Nix build, never HTTP."""
    validate = immutable if input_validator is None else input_validator
    path = validate(path, 65536); raw = path.read_bytes(); value = decode(raw)
    require(type(value) is dict and set(value) == {'version', 'purpose', 'nodeInvocation', 'nodeExecutable',
            'nodeWrapper', 'applicationEntry', 'argvPrefix', 'startupPython', 'normalEntrypoint', 'codeFiles'}
            and type(value['version']) is int and value['version'] == 1
            and value['purpose'] == 'owner-terminal-website-program-v1', 'Fixed website startup manifest required')
    prefix = value['argvPrefix']
    require(type(prefix) is list and 2 <= len(prefix) <= 32
            and all(type(v) is str and 0 < len(v) <= 4096 and '\0' not in v for v in prefix)
            and prefix[:2] == [value['nodeInvocation'], value['nodeWrapper']]
            and Path(value['nodeInvocation']).resolve(strict=True) == Path(node).resolve(strict=True)
            and value['nodeExecutable'] == str(Path(node).resolve(strict=True))
            and value['applicationEntry'] == str(console)+'/lib/reverie/dist/index.js', 'Fixed startup Node graph required')
    python = value['startupPython']
    require(type(python) is dict and set(python) == {'invocation', 'executable', 'entry', 'bootstrapModule', 'packageInit', 'argvPrefix'}
            and type(python['argvPrefix']) is list and python['argvPrefix'][:3] == [python['invocation'], '-I', python['entry']]
            and Path(python['invocation']).resolve(strict=True) == Path(python['executable']), 'Fixed startup Python graph required')
    files = value['codeFiles']; require(type(files) is dict and 1 <= len(files) <= 4096, 'Fixed startup code manifest required')
    total = 0
    for name, selected in files.items():
        require(type(name) is str and name.startswith('/nix/store/') and str(Path(name)) == name
                and '..' not in Path(name).parts and type(selected) is dict and set(selected) == {'sha256', 'bytes'}
                and type(selected['bytes']) is int and 0 <= selected['bytes'] <= MAX_CODE
                and type(selected['sha256']) is str and SHA.fullmatch(selected['sha256']), 'Fixed startup code binding required')
        total += selected['bytes']; require(total <= 512 << 20, 'Fixed startup code total bound')
        if verify_files: require(code(name, input_validator=validate)[1] == selected, 'Fixed startup code bytes differ')
    required = [value['nodeExecutable'], value['nodeWrapper'], value['applicationEntry'], value['normalEntrypoint'],
                python['executable'], python['entry'], python['bootstrapModule'], python['packageInit']]
    require(all(name in files for name in required), 'Incomplete startup code graph')
    return value, {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}


def build(archive, console, node, client, program_manifest=None, *, input_validator=None):
    validate = immutable if input_validator is None else input_validator
    archive = validate(archive, MAX_ARCHIVE)
    manifest_path = validate(client, 8192)
    raw = manifest_path.read_bytes(); manifest = decode(raw)
    require(type(manifest) is dict and set(manifest) == {'version', 'purpose', 'pythonInvocation',
            'pythonExecutable', 'entry', 'entrySHA256', 'argvPrefix'} and type(manifest['version']) is int
            and manifest['version'] == 1 and manifest['purpose'] == 'resource-replacement-client-v1',
            'Fixed packaged resource client required')
    require(manifest['argvPrefix'] == [manifest['pythonInvocation'], '-I', '-B', manifest['entry'], 'client']
            and Path(manifest['pythonInvocation']).resolve(strict=True) == Path(manifest['pythonExecutable']),
            'Isolated packaged client binding required')
    console = Path(console)
    require(console.is_absolute() and console.is_relative_to('/nix/store')
            and console.resolve(strict=True) == console and console.is_dir(), 'Fixed console output required')
    entry = console / 'lib/reverie/dist/index.js'
    invocation = str(node)
    require(Path(invocation).is_absolute() and Path(invocation).is_relative_to('/nix/store')
            and '..' not in Path(invocation).parts, 'Fixed Nix Node invocation required')
    executable = Path(node).resolve(strict=True)
    files = dict(code(path, input_validator=validate) for path in [executable, entry, manifest['pythonExecutable'], manifest['entry']])
    require(files[manifest['entry']]['sha256'] == manifest['entrySHA256'], 'Client entry bytes differ')
    for program in (executable, Path(manifest['pythonExecutable'])):
        with program.open('rb') as stream:
            require(stream.read(4) == b'\x7fELF', 'Bare installed interpreter ELF required')
    startup = None; prefix = [invocation, str(entry)]
    if program_manifest is not None:
        selected, startup = startup_program(program_manifest, console, node, verify_files=True, input_validator=validate)
        for name, value in selected['codeFiles'].items():
            require(name not in files or files[name] == value, 'Conflicting fixed code graph')
            files[name] = value
        prefix = selected['argvPrefix']
    return {'version': 1, 'purpose': 'website-image-provenance-v1', **archive_configuration(archive),
            'console': str(console), 'node': {'executable': str(executable), 'argvPrefix': prefix}, 'startupManifest': startup,
            'clientManifest': {'path': str(manifest_path), 'sha256': hashlib.sha256(raw).hexdigest()},
            'codeFiles': files}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ['archive', 'console', 'node', 'client-manifest', 'output']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--program-manifest', help='Matching immutable optional website startup program manifest')
    parser.add_argument('--nix-build-inputs', action='store_true',
                        help='Fixed Nix producer only: namespace-mapped read-only store inputs; no native custody claim')
    args = parser.parse_args(argv)
    try:
        result = build(args.archive, args.console, args.node, args.client_manifest, args.program_manifest,
                       input_validator=nix_build_input if args.nix_build_inputs else None)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('x') as stream:
            json.dump(result, stream, sort_keys=True, separators=(',', ':')); stream.write('\n')
        return 0
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError):
        parser.exit(2, 'Immutable website image provenance unavailable\n')


if __name__ == '__main__':
    raise SystemExit(main())
