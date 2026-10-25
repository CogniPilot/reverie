"""Private disposable laptop temp storage; identities come from the host resolver."""
import hashlib
import os
from pathlib import Path
import re
import stat
import uuid

IDENTITY = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
START = '<!-- reverie-laptop-storage -->'
END = '<!-- /reverie-laptop-storage -->'
INSTRUCTIONS = '''## Laptop storage

This persistent laptop belongs to your employee identity and survives model,
account and conversation/session changes. Those changes do not authorize a new
identity or new tool grants.

`/tmp` is your own disk-backed disposable temporary drive. `TMPDIR`, `TMP` and
`TEMP` point there. Put builds, caches and downloads under `/tmp/<project>/...`;
the default tool directories are separated by working-directory identity.
`/scratch` remains a compatibility mount for existing paths and is disposable too.
Neither location is a durable home for source, unfinished work or retained results.

Keep installed tools and profiles in your private `/nix` and `/home/agent`.
Use the project's pinned `nix develop`, `nix build` or `nix run` first. Use
`nix shell` for temporary tools and `nix profile install` only for tools you need
persistently. Domain simulators and large project stacks belong in project
flakes, not the base laptop. These are ordinary Linux paths; there is no apt
compatibility shim. Docker needs an actually approved usable engine, not just a
client binary. If the owner enabled rootless Docker, use
`nix profile install .#workerDocker` from a Reverie checkout (or temporary
`nix shell .#workerDocker`), run `dockerd-rootless`, then verify `docker info`
before building or running containers. Keep that launcher running in another
terminal. Its images and volumes live in durable `~/.local/share/docker`;
installing the tools does not grant a missing host capability.
QEMU software TCG can come from a project flake; KVM requires an
explicit optional capability and never implies access to all host devices.

Keep repositories and retained results in explicitly granted durable `/workspace`
or project paths, or private home storage. `/reverie_workspace` remains compatible;
`~/workspace` may point there when that shared drive is granted. Existing project
mounts and occupied paths are preserved. A project name or symlink does not
prove durability; check its actual granted backing storage. Before cleanup,
save handoffs and preserve source, results and work still in progress. Do not
delete another task's data or move an active cache.

Credentials need explicit named grants outside disposable storage. Never paste
credential bytes into chat. A laptop/tool upgrade grants no mission or flight GO.
'''


def temporary_environment(cwd=None):
    root = '/tmp/reverie'
    if cwd is not None:
        root += '/projects/' + hashlib.sha256(os.fsencode(cwd)).hexdigest()[:24]
    return dict(TMPDIR='/tmp', TMP='/tmp', TEMP='/tmp',
                XDG_CACHE_HOME=root + '/cache',
                PIP_CACHE_DIR=root + '/cache/pip', UV_CACHE_DIR=root + '/cache/uv',
                npm_config_cache=root + '/cache/npm', CCACHE_DIR=root + '/cache/ccache',
                GOCACHE=root + '/cache/go-build', GOMODCACHE=root + '/cache/go-mod',
                XDG_DOWNLOAD_DIR=root + '/downloads')


def workspace_alias(config):
    """Alias an already granted shared drive; never cover an explicit project."""
    shared = [m for m in config['mounts'] if m['destination'] == '/reverie_workspace']
    occupied = any(m['destination'] == '/workspace' or m['destination'].startswith('/workspace/')
                   for m in config['mounts'])
    return shared[0] if len(shared) == 1 and not occupied else None


def home_workspace_alias(config, home):
    if not any(m['destination'] == '/reverie_workspace' for m in config['mounts']): return
    path = Path(home) / 'workspace'
    try: os.symlink('/reverie_workspace', path)
    except FileExistsError: pass  # Owner content and custom aliases always win.


def prepare_temporary(config, scratch):
    """Accept only the resolver's fixed private scratch identity, never a request path.

    The one-component SID layout is retained for composition with older source.
    Canonical employee integration supplies scratchRoot/employees/<employeeUUID>.
    No human name is accepted as an authoritative storage identity.
    """
    root, scratch = Path(config['scratchRoot']), Path(scratch)
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Laptop scratch root must be canonical')
    try:
        parts = scratch.relative_to(root).parts
    except ValueError:
        raise ValueError('Laptop temporary storage is outside its scratch root') from None
    if not ((len(parts) == 1 and IDENTITY.fullmatch(parts[0])) or
            (len(parts) == 2 and parts[0] == 'employees' and IDENTITY.fullmatch(parts[1]))):
        raise ValueError('Fixed laptop storage identity required')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptors = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(fd)
        def private(directory):
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
                raise ValueError('Laptop temporary storage must be private and owned')
        private(fd)
        for part in (*parts, 'tmp'):
            try: os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError: pass
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            descriptors.append(fd); private(fd)
        target = scratch / 'tmp'
        current = target.lstat()
        held = os.fstat(fd)
        if target.resolve() != target or (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('Laptop temporary storage changed')
        return target
    finally:
        for fd in reversed(descriptors): os.close(fd)


def write_storage_instructions(home):
    """Update only our marked AGENTS block, preserving the owner's other text."""
    home = Path(home)
    if home.resolve() != home:
        raise ValueError('Canonical private laptop home required')
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.laptop-instructions-' + str(uuid.uuid4())
    try:
        parent = os.fstat(directory)
        if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
            raise ValueError('Private owned laptop home required')
        prior = None
        try:
            fd = os.open('AGENTS.md', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            text = ''
        else:
            with os.fdopen(fd, 'rb') as source:
                prior = os.fstat(source.fileno())
                if not stat.S_ISREG(prior.st_mode) or prior.st_uid != os.getuid() or prior.st_nlink != 1:
                    raise ValueError('Owned regular laptop instructions required')
                raw = source.read(65537)
                if len(raw) > 65536: raise ValueError('Laptop instruction budget exceeded')
                text = raw.decode('utf-8')
        block = START + '\n' + INSTRUCTIONS + END
        if START in text or END in text:
            if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
                raise ValueError('Ambiguous managed laptop instructions')
            text = text[:text.index(START)] + block + text[text.index(END) + len(END):]
        else:
            text += ('\n\n' if text else '') + block + '\n'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'w') as output:
            output.write(text); output.flush(); os.fsync(output.fileno())
        def identity(info):
            return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns
        try: current = os.stat('AGENTS.md', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError: current = None
        if ((prior is None) != (current is None) or
                prior is not None and identity(prior) != identity(current) or
                (home.lstat().st_dev, home.lstat().st_ino) != (parent.st_dev, parent.st_ino)):
            raise ValueError('Laptop instructions changed before publication')
        os.replace(temporary, 'AGENTS.md', src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try: os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError: pass
        os.close(directory)


def memory_aware_build_jobs(environ, cgroup_root='/sys/fs/cgroup', cpu_count=None):
    """Conservative new-hire default; explicit job admission always wins.

    Read inside the laptop, never from the host broker's cgroup. One GiB is
    reserved for non-compiler work; budget one GiB per compiler process.
    Unknown limits use one job. This limits parallelism, not total build RSS.
    """
    if 'CARGO_BUILD_JOBS' in environ:
        return {}
    limits = []
    for name in ('memory.max', 'memory.high'):
        try:
            raw = (Path(cgroup_root) / name).read_text().strip()
            if raw != 'max' and int(raw) > 0:
                limits.append(int(raw))
        except (OSError, ValueError):
            pass
    jobs = max(1, (min(limits) - 1024**3) // 1024**3) if limits else 1
    return {'CARGO_BUILD_JOBS': str(min(jobs, cpu_count or os.cpu_count() or 1))}
