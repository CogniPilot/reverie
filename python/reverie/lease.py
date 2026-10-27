"""The ONE lease implementation is reverie.cleanup.lease (lease CLI r7). This name lets workspaces.py import it as
packaged next to itself (LAUNCH adapter r4) without a second copy that could drift: every public name is the canonical
object (tests/test_lease_reexport.py)."""
from .cleanup import lease as _canonical

globals().update({name: value for name, value in vars(_canonical).items() if not name.startswith('_')})
