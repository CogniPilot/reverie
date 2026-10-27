"""Build a read-only image-prefix closure for narrowly privileged ID helpers."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess

PREFIX = '/opt/reverie-idmap'


def build(shadow, output, patchelf):
    target = output / PREFIX.lstrip('/')
    (target / 'bin').mkdir(parents=True)
    (target / 'lib').mkdir()
    libraries = {}
    interpreters = set()
    for name in ('newuidmap', 'newgidmap'):
        source = shadow / 'bin' / name
        interpreter = subprocess.check_output([patchelf, '--print-interpreter', str(source)], text=True).strip()
        if not interpreter.startswith('/nix/store/'):
            raise ValueError('Nix interpreter required')
        interpreters.add(Path(interpreter).name)
        # Source has neither SUID nor filecaps. Trace resolves all transitive
        # normal libraries without running helper main or modifying any maps.
        env = {'LD_TRACE_LOADED_OBJECTS': '1', 'LC_ALL': 'C'}
        trace = subprocess.check_output([str(source)], env=env, text=True)
        for value in re.findall(r'(/nix/store/[^\s()]+)', trace):
            path = Path(value)
            if not path.is_file():
                raise ValueError('Resolved library file required')
            old = libraries.setdefault(path.name, path.resolve())
            if old != path.resolve() and old.read_bytes() != path.read_bytes():
                raise ValueError('Ambiguous library SONAME')
        shutil.copyfile(source, target / 'bin' / name)
    if len(interpreters) != 1:
        raise ValueError('One architecture interpreter required')
    for name, source in libraries.items():
        shutil.copyfile(source, target / 'lib' / name)
    for path in [*(target / 'bin').iterdir(), *(target / 'lib').iterdir()]:
        path.chmod(0o755)
        if path.name in interpreters:
            # The loader bootstraps itself before ordinary dynamic relocation;
            # adding/rearranging its dynamic section can make it crash. It has
            # no interpreter/dependencies and needs no loader search changes.
            needed = subprocess.check_output([patchelf, '--print-needed', str(path)], text=True).strip()
            if needed:
                raise ValueError('Dependency-free ELF interpreter required')
            path.write_bytes(path.read_bytes().replace(b'/nix/store/', b'/opt/idmap/'))
            path.chmod(0o555)
            continue
        subprocess.run([patchelf, '--set-rpath', PREFIX + '/lib', '--no-default-lib', str(path)], check=True)
        needed = subprocess.check_output([patchelf, '--print-needed', str(path)], text=True).splitlines()
        for dependency in needed:
            if '/' in dependency:
                name = Path(dependency).name
                if name not in libraries:
                    raise ValueError('Unclosed absolute dependency')
                subprocess.run([patchelf, '--replace-needed', dependency, name, str(path)], check=True)
            elif dependency not in libraries:
                raise ValueError('Unclosed library dependency')
        existing_interpreter = subprocess.run([patchelf, '--print-interpreter', str(path)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if existing_interpreter.returncode == 0 and existing_interpreter.stdout.strip():
            subprocess.run([patchelf, '--set-interpreter', PREFIX + '/lib/' + next(iter(interpreters)), str(path)], check=True)
        # Secure execution ignores loader environment overrides, but libc can
        # retain compiled-in module/config paths (for example gconv). Redirect
        # every original-store spelling to an equally long, immutable absent
        # prefix. Optional modules must fail closed, never load from laptop Nix.
        data = path.read_bytes()
        path.write_bytes(data.replace(b'/nix/store/', b'/opt/idmap/'))
        path.chmod(0o555)
    # libc files/NSS are selected by immutable /etc/nsswitch.conf (files only).
    # DF_1_NODEFLIB on every caller also refuses missing-plugin fallback into the
    # original default Nix library directories or the loader cache.
    (target / 'README').write_text('Image-only immutable ID helper closure. No writable Nix loader/library fallback.\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--shadow', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--patchelf', required=True)
    arguments = parser.parse_args()
    build(arguments.shadow, arguments.output, arguments.patchelf)
