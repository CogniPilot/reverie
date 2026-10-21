import tests  # noqa: F401
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from cto.cli import main


class ConsoleBrandingTests(unittest.TestCase):
    def test_python_dispatcher_prefers_reverie_without_calling_itself(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrapper = root / "python/reverie"
            console = root / "console/reverie"
            for path in (wrapper, console):
                path.parent.mkdir()
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o700)
            with patch.dict(os.environ, {"PATH": str(wrapper.parent) + ":" + str(console.parent)}, clear=True), patch("sys.argv", [str(wrapper)]), patch("cto.cli.os.execv") as execute:
                main(["agent", "who"])
                execute.assert_called_once_with(str(console), ["reverie", "agent", "who"])

    def test_missing_console_reports_the_current_product_name(self):
        with patch.dict(os.environ, {"PATH": "/no-console-here"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Reverie console is not installed"):
                main([])
