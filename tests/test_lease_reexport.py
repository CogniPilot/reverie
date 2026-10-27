import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import unittest

from reverie import lease
from reverie.cleanup import lease as canonical


class LeaseReexportTests(unittest.TestCase):
    def test_every_public_name_is_the_canonical_object(self):
        # reverie.lease only re-exports the ONE lease implementation; a missing or drifted name fails here, not at runtime.
        public = [name for name in vars(canonical) if not name.startswith('_')
                  and getattr(getattr(canonical, name), '__module__', None) == canonical.__name__]
        self.assertTrue(public)
        for name in public:
            with self.subTest(name=name):
                self.assertIs(getattr(lease, name), getattr(canonical, name))
        for name in ('LeaseError', 'hold', 'janitor', 'reserve', 'unreserve'):  # what workspaces.py (LAUNCH r4) uses
            self.assertIs(getattr(lease, name), getattr(canonical, name))


if __name__ == '__main__':
    unittest.main()
