"""Test isolation: runs before any test module imports `cto`.

`cto.config` reads REVERIE_* (and the older FLEET_* spelling) at import time and the plugin/runtime read CODEMAN_*, so
a suite started from a live agent shell would otherwise read that instance's
memory. Strip every family and point REVERIE_HOME at a throwaway directory.
Every test module imports this package first.
"""
import atexit
import os
import shutil
import tempfile

for _key in [key for key in os.environ if key.startswith(("CODEMAN_", "FLEET_", "REVERIE_"))]:
    del os.environ[_key]
_home = tempfile.mkdtemp(prefix="reverie-tests-")
atexit.register(shutil.rmtree, _home, True)
os.environ["REVERIE_HOME"] = _home
