import os,stat,unittest
from tests import test_employee_resource_profiles as a
class Successor(unittest.TestCase):
 def test_first_lock_and_data_creation_ignore_restrictive_umask(self):
  f=a.Controls();f.setUp();self.addCleanup(f.doCleanups)
  old=os.umask(0o200)
  try:f.save()
  finally:os.umask(old)
  for name in ('profiles.lock','profiles.json'):self.assertEqual(stat.S_IMODE((f.root/name).stat().st_mode),0o600)
  self.assertEqual(f.store.snapshot()['revision'],1)
