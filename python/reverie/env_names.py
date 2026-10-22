"""Read and propagate REVERIE_* environment settings."""
from __future__ import annotations
import os

PREFIX = "REVERIE_"

def name(suffix: str) -> str:
    return PREFIX + suffix

def get(suffix: str, default: str | None = None, env: os._Environ | dict | None = None) -> str | None:
    values = os.environ if env is None else env
    return values.get(name(suffix)) or default

def is_set(suffix: str, env: os._Environ | dict | None = None) -> bool:
    return get(suffix, None, env) is not None


def entry(suffix: str, value: str) -> dict[str, str]:
    """Environment entry for a child process."""
    return {name(suffix): value}

def child_env(base: os._Environ | dict | None = None, **values: str) -> dict[str, str]:
    """A copy of ``base`` (default: this process's environment) with each ``values`` suffix set under its REVERIE name."""
    env = dict(os.environ if base is None else base)
    for suffix, value in values.items():
        env.update(entry(suffix, value))
    return env


def lookup(full_name: str, default: str | None = None, env: os._Environ | dict | None = None) -> str | None:
    """Like :func:`get` but takes the full name (REVERIE_X)."""
    assert full_name.startswith(PREFIX), full_name
    return get(full_name[len(PREFIX):], default, env)


def require(full_name: str, env: os._Environ | dict | None = None) -> str:
    """Read a required variable; raise KeyError when unset."""
    value = lookup(full_name, None, env)
    if value is None:
        raise KeyError(full_name)
    return value
