"""Environment variable names: ``REVERIE_*`` is the name, ``FLEET_*`` the deprecated spelling still accepted (draft for cto/).

Readers call :func:`get` with the bare suffix. Writers that launch children call :func:`both` so an older component on the same
host still finds the value under its old name during the transition. Each deprecated name is reported once per process.
"""
from __future__ import annotations

import os
import sys

PREFIX = "REVERIE_"
OLD_PREFIX = "FLEET_"
_reported: set[str] = set()


def name(suffix: str) -> str:
    return PREFIX + suffix


def old_name(suffix: str) -> str:
    return OLD_PREFIX + suffix


def get(suffix: str, default: str | None = None, env: os._Environ | dict | None = None) -> str | None:
    """Value of REVERIE_<suffix>, else FLEET_<suffix> (reported once as deprecated), else default."""
    e = os.environ if env is None else env
    new, old = name(suffix), old_name(suffix)
    if new in e and e[new] != "":
        return e[new]
    if old in e and e[old] != "":
        if old not in _reported:
            _reported.add(old)
            print(f"{old} is deprecated; use {new}", file=sys.stderr)
        return e[old]
    return default


def is_set(suffix: str, env: os._Environ | dict | None = None) -> bool:
    return get(suffix, None, env) is not None


def both(suffix: str, value: str) -> dict[str, str]:
    """Env entries for a child: the new name and, for one release, the old one too."""
    return {name(suffix): value, old_name(suffix): value}


def child_env(base: os._Environ | dict | None = None, **values: str) -> dict[str, str]:
    """A copy of ``base`` (default: this process's environment) with each ``values`` suffix set under both names."""
    env = dict(os.environ if base is None else base)
    for suffix, value in values.items():
        env.update(both(suffix, value))
    return env


def lookup(full_name: str, default: str | None = None, env: os._Environ | dict | None = None) -> str | None:
    """Like :func:`get` but takes the full new name (REVERIE_X); the FLEET_X spelling is accepted as a fallback."""
    assert full_name.startswith(PREFIX), full_name
    return get(full_name[len(PREFIX):], default, env)


def require(full_name: str, env: os._Environ | dict | None = None) -> str:
    """Like ``os.environ[name]`` for the new name, accepting the old spelling; KeyError when neither is set."""
    value = lookup(full_name, None, env)
    if value is None:
        raise KeyError(full_name)
    return value
