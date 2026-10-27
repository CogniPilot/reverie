"""Canonical import/fail-closed package checks; no console/build dependency."""
import importlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from reverie import human_shell_capabilities as capabilities
from reverie import human_terminal_protocol as protocol
from reverie import owner_terminal_bootstrap,owner_terminal_channel,owner_terminal_ledger_service

class OwnerTerminalPackageTests(unittest.TestCase):
 def test_canonical_dependencies_share_actual_protocol_classes(self):
  self.assertIs(capabilities.protocol,protocol)
  self.assertIs(owner_terminal_ledger_service.capabilities,capabilities)
  self.assertIs(owner_terminal_ledger_service.protocol,protocol)
  self.assertIs(owner_terminal_ledger_service.Handoff,owner_terminal_channel.Handoff)
 def test_absent_native_port_refuses_before_opening_ledger(self):
  with tempfile.TemporaryDirectory(dir=os.path.realpath(os.environ.get('TMPDIR',tempfile.gettempdir())))as root:
   target=Path(root)/'not-created'
   with self.assertRaisesRegex(owner_terminal_ledger_service.Refusal,'NATIVE_TARGET_UNAVAILABLE'):
    owner_terminal_ledger_service.LedgerService(None,target)
   self.assertFalse(target.exists())
 def test_flat_immutable_bundle_imports_without_package_or_engine(self):
  root=Path(capabilities.__file__).parent
  code='import human_shell_capabilities as c, human_terminal_protocol as p, owner_terminal_ledger_service as s; assert c.protocol is p and s.protocol is p; import owner_terminal_channel, owner_terminal_bootstrap'
  result=subprocess.run([sys.executable,'-B','-c',code],cwd=root,env={'PATH':'/unavailable'},capture_output=True,timeout=5)
  self.assertEqual(result.returncode,0,result.stderr.decode())
 def test_importing_bootstrap_does_not_create_channel(self):
  self.assertEqual(owner_terminal_bootstrap.PATH,'/run/reverie-owner-terminal/bootstrap.sock')
  self.assertTrue(callable(owner_terminal_bootstrap.exec_backend))

if __name__=='__main__':unittest.main()
