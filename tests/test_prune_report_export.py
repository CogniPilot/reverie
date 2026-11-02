"""Aggregate export of cleanup runs to a readable report directory (python/reverie/cleanup/report_export.py)."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'python' / 'reverie' / 'cleanup' / 'report_export.py'
OLD, NEW = '20261101T020000Z-aaaaaa', '20261102T020000Z-bbbbbb'


class ReportExportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.state = self.root / 'state'
        (self.state / 'logs').mkdir(parents=True)
        self.out = self.root / 'reports'
        self.out.mkdir()

    def summary(self, run_id, **extra):
        data = {'run_id': run_id, 'mode': 'dry', 'passes': ['high-water'], 'exit': 0, 'deleted_or_would_bytes': 300,
                'df_before': [{'path': '/private/mount', 'total': 1000, 'free': 200, 'used_pct': 80.0}],
                'df_after': [{'path': '/private/mount', 'total': 1000, 'free': 500, 'used_pct': 50.0}],
                'by_decision': {'DELETED': 2, 'SKIP': 1},
                'by_laptop': {'laptop-one': {'DELETED': 100, 'SKIP': 7}, 'laptop-two': {'DELETED': 200}},
                'ceiling_bytes': 10 ** 9, 'ceiling_hit': False, **extra}
        (self.state / 'logs' / f'{run_id}.summary.json').write_text(json.dumps(data))
        (self.state / 'logs' / f'{run_id}.jsonl').write_text('{"host_path": "/private/detail", "repo": "o/r"}\n')

    def export(self, uid=None, out=None, **env):
        return subprocess.run([sys.executable, '-I', '-B', str(SCRIPT), '--state', str(self.state), '--out', str(out or self.out),
                               '--uid', str(os.getuid() if uid is None else uid), '--gid', str(os.getgid())],
                              capture_output=True, text=True, env={'PATH': os.environ['PATH'], **env}, timeout=30)

    def latest(self):
        return json.loads((self.out / 'latest.json').read_text())

    def test_exports_only_aggregates_of_the_newest_run(self):
        self.summary(OLD)
        self.summary(NEW)
        result = self.export(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), [f'{NEW}.json', 'latest.json'])
        latest = self.latest()
        self.assertEqual((latest['service_result'], latest['exit_status'], latest['run_id'], latest['new_summary']),
                         ('success', '0', NEW, True))
        summary = latest['summary']
        self.assertEqual(summary, json.loads((self.out / f'{NEW}.json').read_text()))
        self.assertEqual((summary['mode'], summary['deleted_or_would_bytes'], summary['laptops']), ('dry', 300, 2))
        self.assertEqual(summary['count_by_decision'], {'DELETED': 2, 'SKIP': 1})
        self.assertEqual(summary['laptop_bytes_by_decision'], {'DELETED': 300, 'SKIP': 7})
        self.assertEqual(summary['disk_before'], [{'total': 1000, 'free': 200, 'used_pct': 80.0}])
        self.assertEqual(summary['started_utc'], '2026-11-02T02:00:00Z')
        self.assertGreaterEqual(summary['duration_s'], 0)
        text = ''.join(p.read_text() for p in self.out.iterdir())
        for private in ('/private', 'laptop-one', 'laptop-two', 'o/r'):
            self.assertNotIn(private, text)
        for path in self.out.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_failed_run_without_a_new_summary_is_visible(self):
        self.summary(NEW)
        self.assertEqual(self.export().returncode, 0)
        result = self.export(SERVICE_RESULT='exit-code', EXIT_CODE='exited', EXIT_STATUS='2')
        self.assertEqual(result.returncode, 0, result.stderr)
        latest = self.latest()
        self.assertEqual((latest['service_result'], latest['run_id'], latest['new_summary'], latest['summary']),
                         ('exit-code', NEW, False, None))

    def test_no_summary_yet(self):
        shutil.rmtree(self.state / 'logs')
        result = self.export(SERVICE_RESULT='exit-code')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.latest()['run_id'], self.latest()['summary']), (None, None))

    def test_keeps_the_newest_sixty_runs(self):
        for day in range(1, 31):
            for hour in (1, 2):
                (self.out / f'202610{day:02d}T{hour:02d}0000Z-old000.json').write_text('{}')
        (self.out / 'notes.json').write_text('{}')
        self.summary(NEW)
        self.assertEqual(self.export().returncode, 0)
        kept = sorted(p.name for p in self.out.glob('2026*.json'))
        self.assertEqual(len(kept), 60)
        self.assertEqual(kept[0], '20261001T020000Z-old000.json')
        self.assertEqual(kept[-1], f'{NEW}.json')
        self.assertTrue((self.out / 'notes.json').exists())

    def test_never_follows_symlinks_in_the_report_path(self):
        self.summary(NEW)
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        linked = self.root / 'linked'
        linked.symlink_to(elsewhere)
        self.assertNotEqual(self.export(out=linked).returncode, 0)
        (elsewhere / 'reports').mkdir()
        self.assertNotEqual(self.export(out=linked / 'reports').returncode, 0)
        self.assertEqual(list((elsewhere / 'reports').iterdir()), [])
        victim = self.root / 'victim'
        victim.write_text('keep')
        (self.out / 'latest.json').symlink_to(victim)
        self.assertEqual(self.export().returncode, 0)
        self.assertEqual(victim.read_text(), 'keep')
        self.assertFalse((self.out / 'latest.json').is_symlink())

    def test_refuses_a_symlinked_summary(self):
        secret = self.root / 'secret.json'
        secret.write_text(json.dumps({'mode': 'dry', 'by_laptop': {'leak': {}}}))
        (self.state / 'logs' / f'{NEW}.summary.json').symlink_to(secret)
        self.assertNotEqual(self.export().returncode, 0)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_refuses_root_as_the_writer(self):
        self.summary(NEW)
        result = self.export(uid=0)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(list(self.out.iterdir()), [])

    @unittest.skipIf(os.getuid() == 0, 'needs an unprivileged caller')
    def test_writes_nothing_when_it_cannot_drop_to_the_report_user(self):
        self.summary(NEW)
        self.assertEqual(self.export(uid=os.getuid() + 1).returncode, 1)
        self.assertEqual(list(self.out.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
