"""Immutable r12 declaration entry point; no command-line revision selection."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    '_reverie_prune_declarative', Path(__file__).with_name('declarative.py'))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

if __name__ == '__main__':
    raise SystemExit(D.main(installer_type=D.DeclaredInstaller))
