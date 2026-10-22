import json
import os
import sys
import time
import unittest

from coding_process import BoundedProcess


class ProcessDiagnosticsTests(unittest.TestCase):
    def run_child(self, script):
        process = BoundedProcess([sys.executable, '-I', '-B', '-c', script], b'', 3, 4096,
            environment={'PATH': os.defpath, 'LANG': 'C.UTF-8'})
        self.addCleanup(process.cancel)
        while not process.poll():
            time.sleep(0.002)
        return process

    def test_bounded_report_tail_is_separate_from_model_tool_output(self):
        report = {'version': 1, 'status': 'ok', 'peak_rss_bytes': 1024}
        script = ('import sys; print("tool output"); '
                  'sys.stderr.write(' + repr(json.dumps(report) + '\n') + ')')
        process = self.run_child(script)
        self.assertIsNone(process.error)
        self.assertEqual(bytes(process.output), b'tool output\n')
        self.assertEqual(json.loads(process.stderr_tail.decode().splitlines()[-1]), report)
        self.assertEqual(process.diagnostics, len(process.stderr_tail))

    def test_diagnostics_overflow_still_stops_and_retains_only_bounded_tail(self):
        process = self.run_child('import sys; sys.stderr.write("x" * 12000); sys.stderr.flush()')
        self.assertEqual(process.error, 'diagnostics_limit')
        self.assertGreater(process.diagnostics, 4096)
        self.assertLessEqual(len(process.stderr_tail), 4096)


if __name__ == '__main__':
    unittest.main()
