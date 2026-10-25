"""Host-owner installation of named GitHub bindings. Token values never leave files."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import stat
import secrets
from contextlib import ExitStack

NAME = re.compile(r'^[a-z][a-z0-9-]{0,47}$')
SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')

def regular_info(info):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError('Credential inputs must be private owner-owned regular files without links')
    if info.st_size > 65536:
        raise ValueError('Credential input exceeds its size limit')
    return info

def private_read(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        regular_info(os.fstat(fd))
        return os.read(fd, 65537)
    finally:
        os.close(fd)

class DirectoryAnchor:
    """Keep every no-follow ancestry edge open, including the selected home."""
    def __init__(self, path: Path):
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise ValueError('Use the canonical configured laptop ancestry')
        self.fds = []
        self.edges = []
        try:
            self.fds.append(os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            for part in path.parts[1:]:
                self.descend(part)
            self.check()
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.fds[-1]

    def descend(self, name, private=None):
        parent = self.fd
        if private is not None:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.fds.append(child)
        self.edges.append((parent, name, child, private))
        info = os.fstat(child)
        if private is not None and (info.st_uid != os.getuid() or info.st_mode & (0o077 if private else 0o022)):
            raise ValueError('Credential directory ownership or privacy is invalid')
        self.check()
        return self

    def check(self):
        for parent, name, child, private in self.edges:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            held = os.fstat(child)
            if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (held.st_dev, held.st_ino):
                raise ValueError('Credential destination ancestry changed')
            if private is not None and (held.st_uid != os.getuid() or held.st_mode & (0o077 if private else 0o022)):
                raise ValueError('Credential destination privacy changed')
        home_fd = getattr(self, 'home_fd', None)
        if home_fd is not None:
            info = os.fstat(home_fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Selected laptop home custody changed')

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


def credential_directory(anchor, components):
    for name, private in components:
        anchor.descend(name, private)
    return anchor.fd


def selected_home(policy, session):
    state = Path(policy['stateRoot'])
    if not SESSION.fullmatch(session) or not state.is_absolute() or state.resolve(strict=True) != state:
        raise ValueError('Use the canonical configured state root and current session')
    anchor = DirectoryAnchor(state / session / 'home')
    try:
        info = os.fstat(anchor.fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError('Selected laptop home ownership is invalid')
        anchor.home_fd = anchor.fd
        anchor.check()
        return anchor
    except BaseException:
        anchor.close()
        raise


def existing(fd, name):
    try: source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError: return None
    try:
        regular_info(os.fstat(source));return os.read(source, 65537)
    finally:os.close(source)

def atomic(fd, name: str, content: bytes, replace: bool):
    previous = existing(fd, name)
    if previous == content or (name.endswith('.token') and previous is not None and previous.strip() == content.strip()):return
    if previous is not None and not replace:
        raise ValueError('A different binding already exists; explicit replacement is required')
    temporary = '.credential-'+secrets.token_hex(12)
    target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(target, 'wb') as handle:
            handle.write(content);handle.flush();os.fsync(handle.fileno())
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:pass

def install(root: Path, name: str, source: Path, employees: list[str], repositories: list[str], *, replace=False):
    if os.environ.get('REVERIE_MUX') == '1' or os.environ.get('REVERIE_CONTAINER') == '1':
        raise ValueError('Install credentials from the owner host, not an agent laptop or website')
    if not NAME.fullmatch(name) or not employees or len(employees) > 32 or len(set(employees)) != len(employees):
        raise ValueError('Select a valid name and explicit unique employee IDs')
    if len(repositories) > 50 or any(not REPO.fullmatch(repo) for repo in repositories):
        raise ValueError('Repository references must use owner/repository names')
    root = root.expanduser()
    # Do not silently canonicalize an aliased selected root into a different one.
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError('Use the canonical configured root')
    config = root/'runtime/worker-isolation/broker.json'
    policy = json.loads(private_read(config))
    company = json.loads(Path(policy['companyFile']).read_text())
    records = company.get('employees', [])
    # Refuse invalid source custody before creating any destination directories.
    # This checks metadata only: the content read below still waits for every
    # canonical destination descriptor and repeats all source checks.
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        regular_info(os.fstat(source_fd))
    finally:
        os.close(source_fd)
    with ExitStack() as stack:
        root_anchor = DirectoryAnchor(root)
        stack.callback(root_anchor.close)
        homes = []
        for employee in employees:
            matches = [row for row in records if row.get('id') == employee]
            if len(matches) != 1 or not SESSION.fullmatch(matches[0].get('sessionId', '')):
                raise ValueError('Each selected employee must have exactly one current laptop binding')
            home = Path(policy['stateRoot'])/matches[0]['sessionId']/'home'
            anchor = selected_home(policy, matches[0]['sessionId'])
            stack.callback(anchor.close)
            for mount in policy.get('mounts', []):
                if home.is_relative_to(Path(mount['source']).resolve()):
                    raise ValueError('Laptop home overlaps a shared mount; fix custody before installing credentials')
            homes.append(anchor)
        host = root/'credentials/github'
        if any(host.resolve().is_relative_to(Path(m['source']).resolve()) for m in policy.get('mounts', [])):
            raise ValueError('Host credential storage overlaps a laptop shared mount')
        directories = [credential_directory(root_anchor, [('credentials', True), ('github', True)])]
        for anchor in homes:
            directories.append(credential_directory(anchor, [('.config', False), ('reverie', False), ('credentials', True), ('github', True)]))
        anchors = [root_anchor, *homes]
        for anchor in anchors:
            anchor.check()
        # All selected canonical descriptors are retained before token content is read.
        token = private_read(source).strip()
        if not re.fullmatch(rb'[A-Za-z0-9_-]{20,1024}', token):
            raise ValueError('Input is not a single bounded GitHub token')
        for anchor in anchors:
            anchor.check()
        for fd in directories:
            previous = existing(fd, name+'.token')
            if previous is not None and not replace and previous.strip() != token:
                raise ValueError('A different binding exists; explicit replacement is required')
            existing(fd, name+'.json')
        metadata = {'name': name, 'repositories': sorted(set(repositories)), 'scopeBasis': 'Owner-declared repository references; GitHub enforces actual token scopes'}
        for anchor, fd in zip(anchors, directories):
            for selected in anchors:
                selected.check()
            atomic(fd, name+'.token', token+b'\n', replace)
            anchor.check()
            atomic(fd, name+'.json', (json.dumps(metadata, indent=2)+'\n').encode(), True)

    return {'name': name, 'employeeIds': employees, 'repositories': metadata['repositories'], 'laptopPath': '$HOME/.config/reverie/credentials/github/'+name+'.token', 'tokenPrinted': False}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.home()/'reverie')
    sub = parser.add_subparsers(dest='command', required=True)
    action = sub.add_parser('install-github')
    action.add_argument('--name', required=True);action.add_argument('--source', type=Path, required=True)
    action.add_argument('--employee', action='append', required=True);action.add_argument('--repo', action='append', default=[])
    action.add_argument('--replace', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = install(args.root, args.name, args.source, args.employee, args.repo, replace=args.replace)
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(1, 'Credential installation refused; verify explicit employees, private files, existing bindings and mount custody. No token is printed.\n')
    print(json.dumps(result, indent=2));return 0

if __name__ == '__main__':
    raise SystemExit(main())
