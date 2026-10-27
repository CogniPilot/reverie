"""Journal fault controls using only owned temporary files and inert callbacks."""
import copy
import hashlib
import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reverie import laptop_resource_operations as ledger

SCOPE = {'owner_scope_digest': '1' * 64,
         'company_id': '11111111-1111-4111-8111-111111111111'}
KEY = '22222222-2222-4222-8222-222222222222'
OTHER_KEY = '33333333-3333-4333-8333-333333333333'
EMPLOYEE = '44444444-4444-4444-8444-444444444444'
OTHER_EMPLOYEE = '55555555-5555-4555-8555-555555555555'
POOL = '66666666-6666-4666-8666-666666666666'
SID = '77777777-7777-4777-8777-777777777777'
MIB = 1048576


def observed(employee=EMPLOYEE):
    return {'pool_id': POOL, 'pool_revision_digest': '2' * 64,
            'budget_bytes': str(128 * MIB), 'committed_bytes': str(100 * MIB),
            'employee_id': employee, 'current_sid': SID, 'generation': '1',
            'source_binding_digest': '3' * 64, 'profile_version': '1',
            'current_memory_bytes': str(32 * MIB)}


def proposal(obs=None, requested=48):
    obs = obs or observed()
    return {'employee_id': obs['employee_id'], 'pool_id': obs['pool_id'],
            'source_binding_digest': obs['source_binding_digest'],
            'profile_version': obs['profile_version'],
            'requested_memory_bytes': str(requested * MIB), 'preview_digest': '4' * 64,
            'observation_digest': ledger.fingerprint(obs)}


def guard(_):
    return None


def observer(_scope, pool, employee):
    assert pool == POOL
    return observed(employee)


def race_claim(root, key, employee, barrier, output):
    store = ledger.OperationStore(root, scope_guard=guard, capacity_observer=observer)
    try:
        barrier.wait(timeout=10)
        store.claim(SCOPE, key, proposal(observed(employee)))
        output.put((employee, 'CLAIMED'))
    except ledger.OperationRefusal as error:
        output.put((employee, str(error)))
    finally:
        store.close()


class Operations(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('LEDGER_TEST_TMP'))
        self.root = Path(self.tmp.name) / 'private'
        self.root.mkdir(mode=0o700)
        self.store = self.open()
        self.store.initialize(SCOPE)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def open(self, **kwargs):
        return ledger.OperationStore(self.root, scope_guard=kwargs.get('scope_guard', guard),
                                     capacity_observer=kwargs.get('capacity_observer', observer))

    def claim(self, **kwargs):
        return self.store.claim(kwargs.get('scope', SCOPE), kwargs.get('key', KEY),
                                kwargs.get('request', proposal()))

    def fresh(self):
        self.store.close()
        self.store = self.open()

    def raw(self):
        return json.loads((self.root / 'operations.json').read_text())

    def test_claim_is_durable_and_replay_has_no_handle(self):
        view, handle = self.claim()
        self.assertIsNotNone(handle)
        op = view['operation']
        self.assertEqual(op['delta_bytes'], str(16 * MIB))
        self.assertNotEqual(op['reserved_sid'], SID)
        self.assertEqual(self.raw()['operations'][op['id']], op)
        replay, duplicate = self.claim()
        self.assertEqual(replay, view)
        self.assertIsNone(duplicate)
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_same_key_changed_request_conflicts(self):
        self.claim()
        with self.assertRaisesRegex(ledger.OperationRefusal, 'IDEMPOTENCY_CONFLICT'):
            self.claim(request=proposal(requested=49))
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_scope_isolated_lookup_and_global_capacity(self):
        self.claim()
        other = dict(SCOPE, owner_scope_digest='8' * 64)
        self.assertIsNone(self.store.lookup(other, KEY))
        with self.assertRaisesRegex(ledger.OperationRefusal, 'CAPACITY_EXHAUSTED'):
            self.store.claim(other, KEY, proposal(observed(OTHER_EMPLOYEE)))

    def test_employee_cannot_have_two_retained_claims(self):
        self.claim()
        with self.assertRaisesRegex(ledger.OperationRefusal, 'EMPLOYEE_HAS_RETAINED_CLAIM'):
            self.claim(key=OTHER_KEY)

    def test_shrink_does_not_create_capacity_credit(self):
        view, _ = self.claim(request=proposal(requested=16))
        self.assertEqual(view['operation']['delta_bytes'], '0')
        with self.assertRaisesRegex(ledger.OperationRefusal, 'CAPACITY_EXHAUSTED'):
            self.store.claim(SCOPE, OTHER_KEY, proposal(observed(OTHER_EMPLOYEE), requested=61))

    def test_restart_keeps_claim_but_cannot_resume_effect(self):
        view, handle = self.claim()
        self.fresh()
        replay, lease = self.claim()
        self.assertEqual(replay['operation']['id'], view['operation']['id'])
        self.assertEqual(replay['operation']['state'], 'RECOVERY_REQUIRED')
        self.assertTrue(replay['reservation_retained'])
        self.assertFalse(replay['retry_allowed'])
        self.assertIsNone(lease)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'MISSING_ACTIVE_CLAIM'):
            self.store.begin_effect(SCOPE, handle, 'prepare', expected_version=1)

    def test_phase_sequence_is_not_native_verification_or_credit(self):
        _, handle = self.claim()
        n = 1
        for effect, pending, after in [('prepare', 'PREPARING', 'PREPARED'),
                                        ('start', 'STARTING', 'STARTED'),
                                        ('verify', 'VERIFYING', 'VERIFY_RECORDED')]:
            v = self.store.begin_effect(SCOPE, handle, effect, expected_version=n)
            n += 1
            self.assertEqual(v['operation']['state'], pending)
            self.assertEqual(self.raw()['operations'][v['operation']['id']]['state'], pending)
            v = self.store.record_ack(SCOPE, handle, effect, '5' * 64, expected_version=n)
            n += 1
            self.assertEqual(v['operation']['state'], after)
            self.assertFalse(v['verified'])
            self.assertTrue(v['reservation_retained'])
        self.fresh()
        self.assertEqual(self.store.lookup(SCOPE, KEY)['operation']['state'], 'RECOVERY_REQUIRED')
        with self.assertRaisesRegex(ledger.OperationRefusal, 'CAPACITY_EXHAUSTED'):
            self.store.claim(SCOPE, OTHER_KEY, proposal(observed(OTHER_EMPLOYEE)))

    def test_stale_version_duplicate_and_wrong_order_refuse(self):
        _, handle = self.claim()
        with self.assertRaisesRegex(ledger.OperationRefusal, 'OUT_OF_ORDER'):
            self.store.begin_effect(SCOPE, handle, 'start', expected_version=1)
        self.store.begin_effect(SCOPE, handle, 'prepare', expected_version=1)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'STALE_OPERATION_VERSION'):
            self.store.record_ack(SCOPE, handle, 'prepare', '5' * 64, expected_version=1)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'OUT_OF_ORDER'):
            self.store.begin_effect(SCOPE, handle, 'prepare', expected_version=2)

    def test_missing_phase_receipt_never_enables_next_effect(self):
        view, handle = self.claim()
        value = self.raw()
        value['operations'][view['operation']['id']].update(state='PREPARED', version=3)
        (self.root / 'operations.json').write_text(json.dumps(value))
        with self.assertRaisesRegex(ledger.OperationRefusal, 'PHASE_RECEIPT'):
            self.store.begin_effect(SCOPE, handle, 'start', expected_version=3)

    def test_unknown_outcome_revokes_handle_and_retains_delta(self):
        _, handle = self.claim()
        self.store.begin_effect(SCOPE, handle, 'prepare', expected_version=1)
        self.store.mark_uncertain(SCOPE, handle, expected_version=2, reason='RELOAD_ACK_LOST')
        self.assertEqual(self.store.lookup(SCOPE, KEY)['operation']['reason'], 'RELOAD_ACK_LOST')
        with self.assertRaisesRegex(ledger.OperationRefusal, 'MISSING_ACTIVE_CLAIM'):
            self.store.record_ack(SCOPE, handle, 'prepare', '5' * 64, expected_version=3)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'CAPACITY_EXHAUSTED'):
            self.store.claim(SCOPE, OTHER_KEY, proposal(observed(OTHER_EMPLOYEE)))

    def test_missing_or_corrupt_ledger_never_means_not_found(self):
        path = self.root / 'operations.json'
        before = path.read_bytes()
        for raw in [b'', b'{"schema":1,"schema":2}', b'[]', b'{' + b'x' * ledger.MAX_BYTES,
                    b'{"revision":' + b'9' * 5000 + b'}']:
            with self.subTest(raw=raw[:20]):
                path.write_bytes(raw)
                with self.assertRaises(ledger.OperationRefusal):
                    self.store.lookup(SCOPE, KEY)
        path.write_bytes(before)
        path.unlink()
        with self.assertRaises(ledger.OperationRefusal):
            self.store.lookup(SCOPE, KEY)

    def test_missing_guard_or_capacity_cannot_claim(self):
        with self.assertRaisesRegex(ledger.OperationRefusal, 'MISSING_SCOPE_GUARD'):
            self.open(scope_guard=None)
        s = self.open(capacity_observer=None)
        try:
            with self.assertRaisesRegex(ledger.OperationRefusal, 'MISSING_CAPACITY_OBSERVER'):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(self.raw()['operations'], {})

    def test_nonvoid_guard_and_owner_revocation_refuse(self):
        s = self.open(scope_guard=lambda _: True)
        try:
            with self.assertRaisesRegex(ledger.OperationRefusal, 'MUST_RETURN_NONE'):
                s.lookup(SCOPE, KEY)
        finally:
            s.close()
        def denied(_):
            raise ledger.OperationRefusal('OWNER_REVOKED')
        s = self.open(scope_guard=denied)
        try:
            with self.assertRaisesRegex(ledger.OperationRefusal, 'OWNER_REVOKED'):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()

    def test_closed_numeric_and_canonical_input_validation(self):
        invalid = [dict(proposal(), extra=True), dict(proposal(), requested_memory_bytes='01'),
                   dict(proposal(), requested_memory_bytes=str(2**64)),
                   dict(proposal(), requested_memory_bytes='9' * 6000),
                   dict(proposal(), requested_memory_bytes='0'),
                   dict(proposal(), requested_memory_bytes=str(MIB+1)),
                   dict(proposal(), profile_version=str(2**53)),
                   dict(proposal(), employee_id=EMPLOYEE.upper())]
        # This synthetic UUID has digits only; substitute a genuinely mixed-case UUID.
        invalid[-1]['employee_id'] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.upper()
        for value in invalid:
            with self.subTest(value=str(value)[:150]), self.assertRaises(ledger.OperationRefusal):
                self.claim(request=value)
        self.assertEqual(self.raw()['operations'], {})

    def test_caller_mutation_does_not_change_durable_claim(self):
        req = proposal()
        selected = copy.deepcopy(SCOPE)
        view, _ = self.claim(request=req, scope=selected)
        req['requested_memory_bytes'] = '1'
        selected['owner_scope_digest'] = '9' * 64
        view['operation']['request']['preview_digest'] = '9' * 64
        self.assertEqual(self.store.lookup(SCOPE, KEY)['operation']['request']['preview_digest'], '4' * 64)

    def test_capacity_revision_drift_before_commit_refuses_without_write(self):
        count = 0
        def changing(_scope, _pool, employee):
            nonlocal count
            count += 1
            value = observed(employee)
            if count >= 2:
                value['pool_revision_digest'] = '9' * 64
            return value
        s = self.open(capacity_observer=changing)
        try:
            with self.assertRaises(ledger.OperationRefusal):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(self.raw()['operations'], {})

    def test_lost_capacity_recheck_after_install_is_uncertain(self):
        count = 0
        def changing(_scope, _pool, employee):
            nonlocal count
            count += 1
            value = observed(employee)
            if count >= 3:
                value['pool_revision_digest'] = '9' * 64
            return value
        s = self.open(capacity_observer=changing)
        try:
            with self.assertRaises(ledger.OperationCommitUncertain):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(len(self.raw()['operations']), 1)
        self.assertEqual(self.store.lookup(SCOPE, KEY)['operation']['state'], 'RECOVERY_REQUIRED')

    def test_rename_ack_loss_keeps_claim_and_does_not_reissue_handle(self):
        rename = os.rename
        def lost(*args, **kwargs):
            rename(*args, **kwargs)
            raise OSError('synthetic rename ACK loss')
        with patch.object(ledger.os, 'rename', lost), self.assertRaises(ledger.OperationCommitUncertain):
            self.claim()
        self.assertEqual(len(self.raw()['operations']), 1)
        replay, handle = self.claim()
        self.assertIsNone(handle)
        self.assertEqual(replay['operation']['state'], 'RECOVERY_REQUIRED')

    def test_directory_fsync_failure_keeps_claim(self):
        fsync = os.fsync
        def lost(fd):
            fsync(fd)
            if fd == self.store.fd:
                raise OSError('synthetic directory fsync failure')
        with patch.object(ledger.os, 'fsync', lost), self.assertRaises(ledger.OperationCommitUncertain):
            self.claim()
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_final_guard_failure_after_commit_is_uncertain(self):
        calls = 0
        def final(_):
            nonlocal calls
            calls += 1
            if calls == 4:
                raise ledger.OperationRefusal('OWNER_REVOKED')
        s = self.open(scope_guard=final)
        try:
            with self.assertRaises(ledger.OperationCommitUncertain):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_partial_write_is_completed_and_zero_write_refuses(self):
        write = os.write
        with patch.object(ledger.os, 'write', lambda fd, data: write(fd, data[:7])):
            self.claim()
        self.assertEqual(len(self.raw()['operations']), 1)
        req = proposal(observed(OTHER_EMPLOYEE), requested=33)
        with patch.object(ledger.os, 'write', lambda *_: 0), self.assertRaisesRegex(ledger.OperationRefusal, 'SHORT_WRITE'):
            self.store.claim(SCOPE, OTHER_KEY, req)
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_pool_epoch_cannot_credit_or_rebase_old_reservations(self):
        self.claim()
        obs = observed(OTHER_EMPLOYEE)
        obs.update(pool_revision_digest='9' * 64, committed_bytes=str(90 * MIB))
        s = self.open(capacity_observer=lambda *_: obs)
        try:
            with self.assertRaisesRegex(ledger.OperationRefusal, 'POOL_RECONCILIATION_REQUIRED'):
                s.claim(SCOPE, OTHER_KEY, proposal(obs))
        finally:
            s.close()
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_read_replay_does_not_require_new_capacity_observation(self):
        self.claim()
        s = self.open(capacity_observer=None)
        try:
            value, handle = s.claim(SCOPE, KEY, proposal())
            self.assertEqual(value['operation']['state'], 'RECOVERY_REQUIRED')
            self.assertIsNone(handle)
        finally:
            s.close()

    def test_lock_replaced_during_claim_refuses_before_install(self):
        calls = 0
        def change(_):
            nonlocal calls
            calls += 1
            if calls == 2:
                lock = self.root / 'operations.lock'
                lock.unlink()
                lock.touch(mode=0o600)
        s = self.open(scope_guard=change)
        try:
            with self.assertRaises(ledger.OperationRefusal):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(self.raw()['operations'], {})

    def test_post_commit_same_content_file_replacement_is_uncertain(self):
        calls = 0
        def change(_):
            nonlocal calls
            calls += 1
            if calls == 4:
                original = self.root / 'operations.json'
                other = self.root / 'replacement'
                other.write_bytes(original.read_bytes())
                other.chmod(0o600)
                other.replace(original)
        s = self.open(scope_guard=change)
        try:
            with self.assertRaises(ledger.OperationCommitUncertain):
                s.claim(SCOPE, KEY, proposal())
        finally:
            s.close()
        self.assertEqual(len(self.raw()['operations']), 1)
        self.assertEqual(self.store.lookup(SCOPE, KEY)['operation']['state'], 'RECOVERY_REQUIRED')

    def test_lock_close_ack_failure_after_commit_is_uncertain(self):
        close = os.close
        failed = False
        metadata = (self.root / 'operations.lock').stat()
        identity = metadata.st_dev, metadata.st_ino
        def lost(fd):
            nonlocal failed
            try:
                value = os.fstat(fd)
                is_lock = (value.st_dev, value.st_ino) == identity
            except OSError:
                is_lock = False
            close(fd)
            if not failed and is_lock:
                failed = True
                raise OSError('synthetic lock-close ACK failure')
        with patch.object(ledger.os, 'close', lost), self.assertRaises(ledger.OperationCommitUncertain):
            self.claim()
        self.assertTrue(failed)
        self.assertEqual(len(self.raw()['operations']), 1)
        replay, handle = self.claim()
        self.assertIsNone(handle)
        self.assertEqual(replay['operation']['state'], 'RECOVERY_REQUIRED')

    def test_private_files_and_lock_replacement_refuse(self):
        path = self.root / 'operations.json'
        path.chmod(0o644)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'PRIVATE_FILE'):
            self.store.lookup(SCOPE, KEY)
        path.chmod(0o600)
        os.link(path, self.root / 'hardlink')
        with self.assertRaisesRegex(ledger.OperationRefusal, 'PRIVATE_FILE'):
            self.store.lookup(SCOPE, KEY)
        (self.root / 'hardlink').unlink()
        lock = self.root / 'operations.lock'
        lock.unlink()
        lock.symlink_to(path)
        with self.assertRaises(ledger.OperationRefusal):
            self.store.lookup(SCOPE, KEY)

    def test_journal_fifo_refuses_without_blocking(self):
        (self.root / 'operations.json').unlink()
        os.mkfifo(self.root / 'operations.json', mode=0o600)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'PRIVATE_FILE'):
            self.store.lookup(SCOPE, KEY)

    def test_root_or_ancestor_rebinding_refuses(self):
        displaced = self.root.with_name('displaced')
        self.root.rename(displaced)
        self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(ledger.OperationRefusal, 'DIRECTORY_REBOUND'):
            self.store.lookup(SCOPE, KEY)
        self.root.rmdir()
        self.root.symlink_to(displaced)
        with self.assertRaises(ledger.OperationRefusal):
            self.store.lookup(SCOPE, KEY)

    def test_bootstrap_is_explicit_and_cannot_erase_existing_journal(self):
        with self.assertRaisesRegex(ledger.OperationRefusal, 'NOT_EMPTY_OR_INITIALIZED'):
            self.store.initialize(SCOPE)
        self.claim()
        self.assertEqual(len(self.raw()['operations']), 1)

    def test_umask_cannot_create_a_nonprivate_journal(self):
        root = Path(self.tmp.name) / 'umask'
        root.mkdir(mode=0o700)
        old = os.umask(0o777)
        try:
            s = ledger.OperationStore(root, scope_guard=guard, capacity_observer=observer)
            try:
                s.initialize(SCOPE)
                s.claim(SCOPE, KEY, proposal())
            finally:
                s.close()
        finally:
            os.umask(old)
        self.assertEqual((root / 'operations.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / 'operations.lock').stat().st_mode & 0o777, 0o600)

    def test_two_processes_cannot_overbook_capacity(self):
        context = multiprocessing.get_context('fork')
        barrier, queue = context.Barrier(2), context.Queue()
        args = [(KEY, EMPLOYEE), (OTHER_KEY, OTHER_EMPLOYEE)]
        jobs = [context.Process(target=race_claim, args=(str(self.root), key, eid, barrier, queue))
                for key, eid in args]
        try:
            for proc in jobs:
                proc.start()
            for proc in jobs:
                proc.join(timeout=10)
                self.assertFalse(proc.is_alive())
                self.assertEqual(proc.exitcode, 0)
            results = [queue.get(timeout=3), queue.get(timeout=3)]
            self.assertEqual(sum(status == 'CLAIMED' for _, status in results), 1)
            self.assertEqual(len(self.raw()['operations']), 1)
            rejected_employee = next(eid for eid, status in results if status != 'CLAIMED')
            rejected_key = next(key for key, eid in args if eid == rejected_employee)
            # A BUSY refusal is definitely pre-mutation; this controlled serial
            # check then discriminates admission arithmetic from lock exclusion.
            with self.assertRaisesRegex(ledger.OperationRefusal, 'CAPACITY_EXHAUSTED'):
                self.store.claim(SCOPE, rejected_key, proposal(observed(rejected_employee)))
        finally:
            for proc in jobs:
                if proc.is_alive():
                    proc.terminate()
                    proc.join(timeout=3)
            queue.close()
            queue.join_thread()


if __name__ == '__main__':
    unittest.main()
