import json
import unittest

from coding_diagnostics import runner_report


class RunnerReportTests(unittest.TestCase):
    def encode(self, report):
        return json.dumps({'sandbox_runner': report}).encode()

    def report(self):
        return dict(rc=0, mode='task', reason='done', wall_ms=10, peak_rss_bytes=1000,
            rss_interval_s=0.1, rss_samples=1, disk_interval_s=0.1, disk_samples=1,
            max_members=1, workspace_bytes=1, workspace_entries=1, min_free_bytes_seen=10000)

    def test_last_line_retains_only_the_typed_runner_report(self):
        expected = self.report()
        raw = b'UNTRUSTED_TOOL_ERROR\n' + self.encode(expected) + b'\n'
        self.assertEqual(runner_report(raw), expected)
        self.assertEqual(runner_report(self.encode(dict(rc=2, mode='task', reason='refused'))),
            dict(rc=2, mode='task', reason='refused'))

    def test_unknown_text_and_invalid_metrics_are_not_logging_authority(self):
        for field, value in [('detail', 'PRIVATE_CANARY'), ('rc', True), ('mode', 'verify'),
                             ('reason', 'PRIVATE_CANARY'), ('peak_rss_bytes', 'PRIVATE_CANARY'),
                             ('wall_ms', -1), ('rss_interval_s', float('nan')),
                             ('disk_interval_s', True), ('max_members', 2 ** 70)]:
            report = self.report()
            report[field] = value
            with self.subTest(field=field):
                self.assertIsNone(runner_report(self.encode(report)))

    def test_missing_oversized_malformed_or_nonfinal_report_is_unavailable(self):
        for raw in (b'', b'not-json', b'\xff', b'x' * 4097, self.encode(self.report()) + b'\nother',
                    b'[]', b'{"sandbox_runner": {}}'):
            with self.subTest(raw=raw[:30]):
                self.assertIsNone(runner_report(raw))


if __name__ == '__main__':
    unittest.main()
