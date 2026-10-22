"""Test isolation: runs before any test module imports `reverie`.

`reverie.config` reads REVERIE_* at import time and the plugin/runtime read REVERIE_*, so
a suite started from a live agent shell would otherwise read that instance's
memory. Strip every family and point REVERIE_HOME at a throwaway directory.
Every test module imports this package first.
"""
import atexit
import os
import shutil
import tempfile
import sys
from pathlib import Path

_source = str(Path(__file__).resolve().parents[1] / 'python')
sys.path.insert(0, _source)
os.environ['PYTHONPATH'] = os.pathsep.join(filter(None, (_source, os.environ.get('PYTHONPATH'))))

for _key in [key for key in os.environ if key.startswith(("REVERIE_",))]:
    del os.environ[_key]
_home = tempfile.mkdtemp(prefix="reverie-tests-")
atexit.register(shutil.rmtree, _home, True)
os.environ["REVERIE_HOME"] = _home


def executable_script(source):
    """Bind generated fixture scripts to interpreters available in this test environment."""
    import sys
    interpreters = {"#!/bin/sh": shutil.which("sh"), "#!/usr/bin/env bash": shutil.which("bash"),
                    "#!/usr/bin/env python3": sys.executable, "#!/usr/bin/python3": sys.executable}
    first, separator, rest = source.partition("\n")
    return "#!" + interpreters[first] + separator + rest if first in interpreters else source
