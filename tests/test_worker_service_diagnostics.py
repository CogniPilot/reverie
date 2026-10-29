"""Owner-local CLI output only; no real manager, engine, credentials or instance."""
from contextlib import redirect_stderr, redirect_stdout
import errno
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from reverie import worker_service as S
from reverie import worker_service_upgrade as U
from tests import test_worker_service_upgrade as upgrade_fixture


class WorkerServiceDiagnosticsTests(unittest.TestCase):
    def call(self, error, diagnostic=True):
        output, errors = io.StringIO(), io.StringIO()
        args = ['--config', '/synthetic/private/not-selected.json', 'check-backend']
        if diagnostic: args.append('--diagnostic')
        with patch.object(S.WorkerService, 'positive_preflight', side_effect=error), redirect_stdout(output), redirect_stderr(errors):
            code = S.main(args)
        return code, output.getvalue(), errors.getvalue()

    def test_known_guard_has_stable_category_and_safe_exact_reason(self):
        code, output, errors = self.call(ValueError('Final metadata changed after finalizers'))
        self.assertEqual(code, 1); self.assertEqual(output, '')
        value = json.loads(errors.splitlines()[-1])
        self.assertEqual(value, {'category': 'GUARD_CHECK_FAILED', 'reason': 'Final metadata changed after finalizers'})
        self.assertLess(len(errors.encode()), 512)

    def test_private_paths_errno_and_unlisted_sensitive_messages_are_never_printed(self):
        secret = 'synthetic-sensitive-do-not-print'
        cases = [FileNotFoundError(errno.ENOENT, secret, '/private/' + secret),
                 PermissionError(errno.EACCES, secret, '/private/' + secret),
                 ValueError('New generation readback changed\n' + secret),
                 RuntimeError({'config': secret, 'credential': secret}),
                 ValueError('RESERVATION_' + secret.upper()),
                 ValueError(secret * 100000)]
        for error in cases:
            with self.subTest(kind=type(error).__name__):
                code, output, errors = self.call(error)
                self.assertEqual(code, 1); self.assertEqual(output, '')
                self.assertNotIn(secret, errors); self.assertNotIn(secret.upper(), errors)
                self.assertNotIn('/private/', errors)
                self.assertLess(len(errors.encode()), 512)
                self.assertIn('category', json.loads(errors.splitlines()[-1]))

    def test_timeout_never_serializes_command_or_captured_output(self):
        secret = 'synthetic-client-private-payload'
        error = subprocess.TimeoutExpired(['fixed-tool', secret], 2, output=secret, stderr=secret)
        code, output, errors = self.call(error)
        self.assertEqual(code, 1); self.assertEqual(output, '')
        self.assertNotIn(secret, errors)
        self.assertEqual(json.loads(errors.splitlines()[-1])['category'], 'OBSERVATION_TIMEOUT')

    def test_opt_in_and_help_do_not_change_success_or_default_failure_status(self):
        code, output, errors = self.call(ValueError('synthetic-private-reason'), diagnostic=False)
        self.assertEqual(code, 1); self.assertEqual(output, '')
        self.assertIn('--diagnostic', errors); self.assertNotIn('category', errors)
        self.assertNotIn('synthetic-private-reason', errors)
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as stop: S.main(['--help'])
        self.assertEqual(stop.exception.code, 0); self.assertIn('--diagnostic', output.getvalue())
        with patch.object(S.WorkerService, 'positive_preflight', return_value={}), redirect_stdout(output):
            self.assertEqual(S.main(['--diagnostic', 'check-backend']), 0)

    def test_real_attempt_failure_remains_nonzero_consumed_without_done_or_rollback(self):
        case = upgrade_fixture.GPUServiceUpgradeTests(); case.setUp(); self.addCleanup(case.doCleanups)
        sha = case.prepare(); case.failure = 'start'
        output, errors = io.StringIO(), io.StringIO()
        args = ['--config', str(case.service.config_path), '--diagnostic', 'apply-gpu-upgrade',
                '--operation', str(case.operation), '--plan-sha256', sha]
        with patch.object(S, 'WorkerService', return_value=case.service), \
             patch.object(U, 'GPUUpgrade', return_value=case.upgrade), \
             patch.object(U.P, 'run', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')), \
             redirect_stdout(output), redirect_stderr(errors):
            code = S.main(args)
        self.assertEqual(code, 1); self.assertEqual(output.getvalue(), '')
        self.assertEqual(json.loads(errors.getvalue().splitlines()[-1])['category'], 'OBSERVATION_TIMEOUT')
        self.assertTrue((case.operation / 'ATTEMPT.json').exists())
        self.assertFalse((case.operation / 'DONE.json').exists())
        self.assertNotEqual(case.service.config_path.read_bytes(), case.baseline_config)
        self.assertFalse(case.active)
        self.assertNotIn(str(case.service.config_path), errors.getvalue())

    def test_only_fixed_transport_stage_names_are_exposed(self):
        error = PermissionError(errno.EACCES, 'synthetic-private', '/private/synthetic-private')
        error._reverie_transport_stage = 'POSTSTART_BROKER'
        code, output, errors = self.call(error)
        self.assertEqual((code, output), (1, ''))
        self.assertEqual(json.loads(errors.splitlines()[-1]), {
            'category': 'PATH_PERMISSION', 'reason': 'Unlisted exception details withheld.',
            'stage': 'POSTSTART_BROKER'})
        for value in ('/private/synthetic-private', 'POSTSTART_BROKER\nprivate', {'private': 'data'}):
            error._reverie_transport_stage = value
            _, _, errors = self.call(error)
            self.assertNotIn('stage', json.loads(errors.splitlines()[-1]))
            self.assertNotIn('synthetic-private', errors)

    def test_actual_transport_poststart_failure_keeps_attempt_and_reports_fixed_stage(self):
        from tests.test_worker_service_transport_upgrade import TransportUpgradeTests
        from reverie import worker_service_transport_upgrade as T
        for phase in ('POSTSTART_BROKER', 'POSTSTART_LISTENERS', 'POSTSTART_CONTINUITY'):
            with self.subTest(phase=phase):
                case = TransportUpgradeTests(); case.setUp()
                try:
                    sha = case.prepare(); original_broker = case.upgrade.broker
                    original_continuity = case.upgrade._unchanged
                    failure = PermissionError(errno.EACCES, 'private-payload', '/private/path')
                    def broker(unit):
                        if case.f.broker_generation > 1 and phase == 'POSTSTART_BROKER': raise failure
                        return original_broker(unit)
                    def continuity(plan, gate):
                        if case.f.broker_generation > 1 and phase == 'POSTSTART_CONTINUITY': raise failure
                        return original_continuity(plan, gate)
                    case.upgrade.broker = broker; case.upgrade._unchanged = continuity
                    if phase == 'POSTSTART_LISTENERS':
                        # Primary readiness now precedes full broker observation;
                        # this control targets the subsequent listener bracket.
                        case.upgrade.tools.ready_socket.side_effect = [None, failure]
                    output, errors = io.StringIO(), io.StringIO()
                    args = ['--config', str(case.service.config_path), '--diagnostic', 'apply-transport-upgrade',
                            '--operation', str(case.operation), '--plan-sha256', sha]
                    with patch.object(S, 'WorkerService', return_value=case.service), \
                         patch.object(T, 'TransportUpgrade', return_value=case.upgrade), \
                         redirect_stdout(output), redirect_stderr(errors):
                        code = S.main(args)
                    self.assertEqual((code, output.getvalue()), (1, ''))
                    diagnostic = json.loads(errors.getvalue().splitlines()[-1])
                    self.assertEqual(diagnostic['stage'], phase)
                    self.assertEqual(diagnostic['category'], 'PATH_PERMISSION')
                    self.assertNotIn('/private/path', errors.getvalue())
                    self.assertNotIn('private-payload', errors.getvalue())
                    self.assertTrue((case.operation / 'ATTEMPT.json').exists())
                    self.assertFalse((case.operation / 'DONE.json').exists())
                    self.assertEqual(case.service.unit.resolve(), case.service.target_unit())
                finally: case.doCleanups()


if __name__ == '__main__': unittest.main()
