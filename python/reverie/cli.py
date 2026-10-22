"""Reverie entry point for the compatible local console executable."""
from __future__ import annotations
import os
from pathlib import Path
import sys


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments == ["--about"]:
        print("Reverie — persistent agents and memory")
        return 0
    wrapper = Path(sys.argv[0]).resolve()
    installed_wrapper = (Path(sys.prefix) / "bin" / "reverie").resolve()
    # Prefer the branded console, skipping this Python dispatcher to avoid recursion.
    for name in ("reverie",):
        for directory in os.get_exec_path():
            executable = Path(directory) / name
            if executable.is_file() and os.access(executable, os.X_OK) and executable.resolve() not in {wrapper, installed_wrapper}:
                os.execv(str(executable), ["reverie", *arguments])
                return 0
    raise RuntimeError("Reverie console is not installed; run this command in the Reverie container.")


if __name__ == "__main__":
    raise SystemExit(main())
