"""Approved target/version ABI with owned stores and controlled native ports."""
import copy
import fcntl
import inspect
import json
import os
from pathlib import Path
import unittest
import uuid
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_reservations as R
from reverie.worker_resources import effective_config, policy_digest
from tests import test_laptop_resource_operations as ledger_fixture
from tests import test_worker_resource_reservations as native_fixture

TARGET = native_fixture.APPROVED_TARGET
OTHER_TARGET = '88888888-8888-4888-8888-888888888888'


class JournalTargets(unittest.TestCase):
    def setUp(self):
        self.f = ledger_fixture.Operations(); self.f.setUp(); self.addCleanup(self.f.tearDown)

    def test_protected_target_persists_and_matching_or_omitted_replay_has_no_new_handle(self):
        f = self.f; req = ledger_fixture.proposal()
        view, handle = f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, req, reserved_sid=TARGET)
        self.assertIsNotNone(handle); self.assertEqual(view['operation']['reserved_sid'], TARGET)
        for options in ({'reserved_sid': TARGET}, {}):
            again, replay = f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, req, **options)
            self.assertEqual(again['operation']['id'], view['operation']['id']); self.assertIsNone(replay)
        with self.assertRaisesRegex(J.OperationRefusal, 'IDEMPOTENCY_CONFLICT'):
            f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, req, reserved_sid=OTHER_TARGET)
        self.assertEqual(f.raw()['operations'][view['operation']['id']]['reserved_sid'], TARGET)

    def test_legacy_allocator_sequence_and_replay_remain_unchanged(self):
        ids = [uuid.UUID('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
               uuid.UUID('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
               uuid.UUID('33333333-cccc-4ccc-8ccc-cccccccccccc')]
        with patch.object(J.uuid, 'uuid4', side_effect=ids) as allocation:
            view, _ = self.f.claim()
        self.assertEqual(view['operation']['reserved_sid'], str(ids[2])); self.assertEqual(allocation.call_count, 3)
        _, handle = self.f.claim(); self.assertIsNone(handle)

    def test_target_collision_or_source_alias_refuses_before_journal_mutation(self):
        f = self.f; before = f.raw()
        with self.assertRaisesRegex(J.OperationRefusal, 'RESERVATION_ROLES'):
            f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, ledger_fixture.proposal(),
                          reserved_sid=ledger_fixture.SID)
        self.assertEqual(f.raw(), before)
        first, _ = f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, ledger_fixture.proposal(), reserved_sid=TARGET)
        before = f.raw(); other = ledger_fixture.proposal(ledger_fixture.observed(ledger_fixture.OTHER_EMPLOYEE), requested=40)
        for target in [TARGET, first['operation']['id'], first['operation']['reservation_id'], ledger_fixture.SID]:
            with self.subTest(targetRole=target), self.assertRaises(J.OperationRefusal):
                f.store.claim(ledger_fixture.SCOPE, ledger_fixture.OTHER_KEY, other, reserved_sid=target)
            self.assertEqual(f.raw(), before)

    def test_invalid_target_is_not_a_new_wire_field_or_a_uuid_authority(self):
        for target in [False, 42, 'not-a-session', '00000000-0000-0000-0000-000000000000']:
            with self.subTest(kind=type(target).__name__), self.assertRaises(J.OperationRefusal):
                self.f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, ledger_fixture.proposal(), reserved_sid=target)
        req = dict(ledger_fixture.proposal(), reserved_sid=TARGET)
        with self.assertRaisesRegex(J.OperationRefusal, 'CLOSED_SCHEMA'):
            self.f.store.claim(ledger_fixture.SCOPE, ledger_fixture.KEY, req)
        self.assertEqual(self.f.raw()['operations'], {})


class ApprovedProfileTargets(unittest.TestCase):
    def setUp(self):
        self.f = native_fixture.Reservations(); self.f.setUp(); self.addCleanup(self.f.doCleanups)

    def profile(self):
        return self.f.profiles.snapshot()['profiles'][native_fixture.EID]

    def change_profile(self, *, target=OTHER_TARGET, generation=None):
        f = self.f; snapshot = f.profiles.snapshot(); profile = snapshot['profiles'][native_fixture.EID]
        binding = dict(profile['binding'], target_sid=target)
        if generation is not None: binding['target_generation'] = generation
        return f.profiles.put(native_fixture.EID, profile['resources'], binding,
            expected_revision=snapshot['revision'], expected_profile_version=profile['version'],
            expected_binding=profile['binding'])

    def test_same_profile_version_and_target_survive_claim_and_real_stage_config(self):
        f = self.f; profile = self.profile(); before = (f.control / 'profiles/profiles.json').read_bytes()
        locks = []; observe = f.gate._observe_claim
        def under_lock(*args):
            fd = os.open(f.control / 'operations/operations.lock', os.O_RDWR)
            try:
                try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError: locks.append(True)
                else: locks.append(False)
            finally: os.close(fd)
            return observe(*args)
        with patch.object(f.gate, '_observe_claim', side_effect=under_lock):
            view = f.claim()
        self.assertTrue(len(locks) >= 3 and all(locks))
        self.assertEqual(view['operation']['reserved_sid'], profile['binding']['target_sid'])
        self.assertEqual(view['operation']['request']['profile_version'], str(profile['version']))
        staged = f.profiles.stage_config(f.config, native_fixture.EID, profile['binding'],
            expected_revision=1, expected_profile_version=1,
            sid_owners={native_fixture.SID: native_fixture.EID, TARGET: native_fixture.EID})['config']
        candidate = R.compatibility_candidate(f.config, staged, native_fixture.SID, TARGET)
        self.assertEqual(effective_config(candidate, TARGET)['memoryMiB'], 4096)
        self.assertEqual(policy_digest(f.config, native_fixture.SID), policy_digest(candidate, native_fixture.SID))
        self.assertEqual((f.control / 'profiles/profiles.json').read_bytes(), before)
        self.assertEqual(self.profile()['version'], 1)
        self.assertEqual(self.profile()['binding'], profile['binding'])

    def test_current_sid_or_wrong_generation_is_not_an_approved_replacement(self):
        f = self.f
        self.change_profile(target=native_fixture.SID, generation=1)
        with self.assertRaises(ValueError):f.claim()
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))
        self.change_profile(generation=3)
        # Request fixture has version1, so use the fresh canonical fields.
        req = f.request(); req['profile_version'] = str(self.profile()['version'])
        with self.assertRaisesRegex(ValueError, 'APPROVED_TARGET_REQUIRED'):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))

    def test_target_already_published_in_company_or_native_state_is_not_fenced(self):
        f = self.f; req = f.request()
        company = {'employees': [f.employee, dict(f.employee, id=OTHER_TARGET, sessionId=TARGET)]}
        Path(f.config['companyFile']).write_text(json.dumps(company))
        with self.assertRaisesRegex(ValueError, 'TARGET_ALREADY_PUBLISHED'):
            f.gate.reserve(native_fixture.KEY, req)
        f.company(); row = f.native.row('3' * 64, 'already-selected', 125, 512,
            {'reverie.worker': 'other', 'reverie.session': TARGET})
        f.kernel(row); f.native.rows.append(row)
        req = f.request()
        with self.assertRaisesRegex(ValueError, 'TARGET_ALREADY_PUBLISHED'):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))

    def test_existing_historical_target_binding_is_not_a_fresh_reserved_sid(self):
        f = self.f; before = (f.control / 'profiles/profiles.json').read_bytes()
        Path(f.config['companyFile']).with_name('plan-moves.json').write_text(json.dumps([
            {'employeeId': native_fixture.EID, 'owner': f.employee['owner'],
             'oldSession': TARGET, 'newSession': native_fixture.SID, 'phase': 'completed'}]))
        with self.assertRaisesRegex(ValueError, 'TARGET_ALREADY_PUBLISHED'):f.claim()
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))
        self.assertEqual((f.control / 'profiles/profiles.json').read_bytes(), before)

    def test_profile_change_between_read_and_claim_refuses_without_new_operation(self):
        f = self.f; req = f.request(); factory = f.gate._store
        def changed():
            store = factory(); self.change_profile(); return store
        with patch.object(f.gate, '_store', side_effect=changed), self.assertRaises(ValueError):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))
        self.assertEqual(self.profile()['binding']['target_sid'], OTHER_TARGET)

    def test_profile_change_after_first_locked_observation_is_rechecked_before_commit(self):
        f = self.f; req = f.request(); observer = f.gate._observe_claim; calls = []
        def changed(*args):
            value = observer(*args)
            if not calls: calls.append(True); self.change_profile()
            return value
        with patch.object(f.gate, '_observe_claim', side_effect=changed), self.assertRaises(ValueError):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertIsNone(f.gate.inspect(native_fixture.KEY))

    def test_profile_change_after_rename_keeps_original_target_claim_uncertain(self):
        f = self.f; req = f.request(); rename = J.os.rename
        def changed(*args, **kwargs):
            result = rename(*args, **kwargs)
            if args[1] == 'operations.json': self.change_profile()
            return result
        with patch.object(J.os, 'rename', side_effect=changed), self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        view = f.gate.inspect(native_fixture.KEY)
        self.assertEqual(view['operation']['reserved_sid'], TARGET)
        self.assertEqual(view['operation']['state'], 'RECOVERY_REQUIRED')
        self.assertEqual(self.profile()['binding']['target_sid'], OTHER_TARGET)
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            with f.gate.admission(TARGET):pass

    def test_profile_change_after_claim_ack_is_not_reported_as_fresh_success(self):
        f = self.f; req = f.request(); factory = f.gate._store
        def changed():
            store = factory(); claim = store.claim
            def after(*args, **kwargs):
                value = claim(*args, **kwargs); self.change_profile(); return value
            store.claim = after
            return store
        with patch.object(f.gate, '_store', side_effect=changed), self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertEqual(f.gate.inspect(native_fixture.KEY)['operation']['reserved_sid'], TARGET)
        self.assertEqual(self.profile()['version'], 2)

    def test_selected_commit_ack_loss_never_rewrites_the_approved_profile(self):
        f = self.f; before = (f.control / 'profiles/profiles.json').read_bytes(); req = f.request(); rename = J.os.rename
        def lost(*args, **kwargs):
            result = rename(*args, **kwargs)
            if args[1] == 'operations.json':raise OSError('owned selected-SID ACK loss')
            return result
        with patch.object(J.os, 'rename', side_effect=lost), self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertEqual(f.gate.inspect(native_fixture.KEY)['operation']['reserved_sid'], TARGET)
        self.assertEqual((f.control / 'profiles/profiles.json').read_bytes(), before)

    def final_read_mutation(self, kind):
        f = self.f; req = f.request(); before = (f.control / 'profiles/profiles.json').read_bytes()
        factory, inventory, profile = f.gate._store, f.gate.native.inventory, f.gate._profile
        phase = {'afterClaim': False, 'published': False, 'profileReads': 0, 'nativeReads': 0}
        def publish():
            phase['published'] = True
            if kind == 'company':
                other = dict(f.employee, id=OTHER_TARGET, sessionId=TARGET)
                Path(f.config['companyFile']).write_text(json.dumps({'employees': [f.employee, other]}))
            elif kind == 'directory':
                (Path(f.config['stateRoot']) / TARGET).mkdir(mode=0o700)
            elif kind == 'native':
                f.native.rows.append(f.native.row('3' * 64, 'late-target', 125, 512,
                    {'reverie.worker': 'other', 'reverie.session': TARGET}))
            else:
                self.change_profile()
        def wrapped_store():
            store = factory(); claim = store.claim
            def wrapped_claim(*args, **kwargs):
                value = claim(*args, **kwargs); phase['afterClaim'] = True; return value
            store.claim = wrapped_claim
            return store
        def late_native(*args, **kwargs):
            rows = inventory(*args, **kwargs)
            if phase['afterClaim'] and inspect.currentframe().f_back.f_code.co_name == '_observe_claim':
                phase['nativeReads'] += 1
                if not phase['published'] and (kind in ('company', 'directory') or
                                               kind == 'profile' and phase['nativeReads'] == 2):
                    publish()
            return rows
        def late_profile(*args):
            value = profile(*args)
            if phase['afterClaim'] and inspect.currentframe().f_back.f_code.co_name == '_observe_claim':
                phase['profileReads'] += 1
                if kind == 'native' and phase['profileReads'] == 2 and not phase['published']:
                    publish()
            return value
        with patch.object(f.gate, '_store', side_effect=wrapped_store), \
             patch.object(f.gate.native, 'inventory', new=late_native), \
             patch.object(f.gate, '_profile', new=late_profile), \
             self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertTrue(phase['published'])
        view = f.gate.inspect(native_fixture.KEY)
        self.assertEqual(view['operation']['reserved_sid'], TARGET)
        self.assertEqual(view['operation']['state'], 'RECOVERY_REQUIRED')
        if kind != 'profile':
            self.assertEqual((f.control / 'profiles/profiles.json').read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            with f.gate.admission(TARGET):pass

    def test_company_target_publication_after_final_native_read_retains_uncertain_claim(self):
        self.final_read_mutation('company')

    def test_target_directory_after_final_native_read_retains_uncertain_claim(self):
        self.final_read_mutation('directory')

    def test_target_native_entry_after_final_profile_read_retains_uncertain_claim(self):
        self.final_read_mutation('native')

    def test_profile_change_during_last_native_read_retains_uncertain_claim(self):
        self.final_read_mutation('profile')

    def terminal_mutation(self, kind, stage='guard'):
        f = self.f; req = f.request(); factory, inventory = f.gate._store, f.gate.native.inventory
        phase = {'claimed': False, 'changed': False}
        def change():
            phase['changed'] = True
            if kind == 'company':
                other = dict(f.employee, id=OTHER_TARGET, sessionId=TARGET)
                Path(f.config['companyFile']).write_text(json.dumps({'employees': [f.employee, other]}))
            elif kind == 'directory':
                (Path(f.config['stateRoot']) / TARGET).mkdir(mode=0o700)
            elif kind == 'native':
                f.native.rows.append(f.native.row('3' * 64, 'late-target', 125, 512,
                    {'reverie.worker': 'other', 'reverie.session': TARGET}))
            elif kind == 'profile':
                self.change_profile()
            elif kind == 'peer':
                row = f.native.row('4' * 64, 'late-peer', 126, 512,
                    {'reverie.worker': 'other', 'reverie.session': OTHER_TARGET})
                f.kernel(row); f.native.rows.append(row)
            elif kind == 'incarnation':
                path = f.proc / '123/stat'; path.write_text(path.read_text().replace('77', '78'))
            elif kind == 'storage':
                home = R.storage_paths(f.config, native_fixture.SID).home
                home.rename(home.with_name('old-home')); home.mkdir(mode=0o700)
            else:
                f.employee['desiredRunning'] = False; f.company()
        def wrapped_store():
            store = factory(); claim, close = store.claim, store.close
            def after_claim(*args, **kwargs):
                value = claim(*args, **kwargs); phase['claimed'] = True; return value
            def after_close():
                close()
                terminal = '_finish_claim' in {frame.function for frame in inspect.stack()}
                if phase['claimed'] and not phase['changed'] and (
                        stage == 'reader-close' and terminal or stage == 'claim-close' and not terminal):
                    change()
            store.claim, store.close = after_claim, after_close
            return store
        def late_inventory(*args, **kwargs):
            frames = {frame.function for frame in inspect.stack()}
            if stage == 'guard' and phase['claimed'] and not phase['changed'] and \
                    'admission' in frames and '_observe_claim' not in frames:
                change()
            return inventory(*args, **kwargs)
        with patch.object(f.gate, '_store', side_effect=wrapped_store), \
             patch.object(f.gate.native, 'inventory', new=late_inventory), \
             self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertTrue(phase['changed'])
        self.assertEqual(len(json.loads((f.control / 'operations/operations.json').read_text())['operations']), 1)
        self.assertEqual(f.gate.inspect(native_fixture.KEY)['operation']['reserved_sid'], TARGET)
        self.assertIsNone(f.gate._local.terminal_claim)
        self.assertIsNone(f.gate._local.approved_profile)

    def test_outer_admission_native_io_cannot_return_view_after_target_publication(self):
        self.terminal_mutation('company')

    def test_outer_admission_native_io_cannot_return_view_after_target_directory(self):
        self.terminal_mutation('directory')

    def test_outer_admission_native_io_cannot_return_view_after_native_target(self):
        self.terminal_mutation('native')

    def test_outer_admission_native_io_cannot_return_view_after_profile_change(self):
        self.terminal_mutation('profile')

    def test_outer_admission_native_io_cannot_return_view_after_owner_stop(self):
        self.terminal_mutation('employee')

    def test_outer_admission_peer_creation_cannot_return_stale_capacity(self):
        self.terminal_mutation('peer')

    def test_outer_admission_same_pid_new_incarnation_cannot_return_stale_binding(self):
        self.terminal_mutation('incarnation')

    def test_outer_admission_new_physical_home_cannot_return_stale_binding(self):
        self.terminal_mutation('storage')

    def test_original_claim_store_finalizer_is_before_terminal_target_check(self):
        self.terminal_mutation('company', 'claim-close')

    def test_terminal_reader_finalizer_is_before_last_native_target_check(self):
        self.terminal_mutation('native', 'reader-close')

    def test_terminal_check_retains_global_lock_and_finishes_native_io_before_metadata(self):
        f = self.f; profile, guard = f.gate._profile, f.gate._guard; calls = []
        def final_profile(eid):
            if inspect.currentframe().f_back.f_code.co_name == '_finish_claim':
                fd = os.open(f.control / 'admission.lock', os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:os.close(fd)
                calls.append('metadata')
            return profile(eid)
        def guard_calls(*args):
            self.assertNotIn('metadata', calls)
            return guard(*args)
        with patch.object(f.gate, '_profile', new=final_profile), patch.object(f.gate, '_guard', new=guard_calls):
            view = f.claim()
        self.assertEqual(calls, ['metadata']); self.assertEqual(view['operation']['reserved_sid'], TARGET)
        self.assertIsNone(f.gate._local.terminal_claim)

    def test_terminal_reader_close_failure_is_uncertain_and_retains_claim(self):
        f = self.f; factory = f.gate._store
        def wrapped_store():
            store = factory(); close = store.close
            def failing_close():
                close()
                if '_finish_claim' in {frame.function for frame in inspect.stack()}:
                    raise OSError('owned terminal close failure')
            store.close = failing_close
            return store
        with patch.object(f.gate, '_store', side_effect=wrapped_store), self.assertRaises(J.OperationCommitUncertain):
            f.claim()
        self.assertEqual(f.gate.inspect(native_fixture.KEY)['operation']['reserved_sid'], TARGET)

    def terminal_producer_mutation(self, kind):
        f = self.f; req = f.request(); capacity, storage, inventory = (
            f.gate.native.capacity, f.gate.native.storage, f.gate.native.inventory)
        phase = {'derived': False, 'changed': False}
        def change():
            phase['changed'] = True
            if kind in ('capacity-target', 'storage-target'):
                f.native.rows.append(f.native.row('3' * 64, 'producer-target', 125, 512,
                    {'reverie.worker': 'other', 'reverie.session': TARGET}))
            else:
                path = f.control / 'operations/operations.json'; value = json.loads(path.read_text())
                value['revision'] += 1
                if kind == 'journal-replace':
                    temporary = path.with_name('owned-replacement.json')
                    temporary.write_text(json.dumps(value)); temporary.chmod(0o600); temporary.replace(path)
                else:
                    path.write_text(json.dumps(value))
        def late_capacity(*args, **kwargs):
            value = capacity(*args, **kwargs)
            if inspect.currentframe().f_back.f_code.co_name == '_finish_claim':
                phase['derived'] = True
                if kind == 'capacity-target' and not phase['changed']:change()
            return value
        def late_storage(*args, **kwargs):
            value = storage(*args, **kwargs)
            if kind == 'storage-target' and not phase['changed'] and \
                    inspect.currentframe().f_back.f_code.co_name == '_finish_claim':change()
            return value
        def late_inventory(*args, **kwargs):
            value = inventory(*args, **kwargs)
            if kind.startswith('journal') and phase['derived'] and not phase['changed']:change()
            return value
        with patch.object(f.gate.native, 'capacity', new=late_capacity), \
             patch.object(f.gate.native, 'storage', new=late_storage), \
             patch.object(f.gate.native, 'inventory', new=late_inventory), \
             self.assertRaises(J.OperationCommitUncertain):
            f.gate.reserve(native_fixture.KEY, req)
        self.assertTrue(phase['changed'])
        self.assertEqual(len(json.loads((f.control / 'operations/operations.json').read_text())['operations']), 1)
        self.assertEqual(f.gate.inspect(native_fixture.KEY)['operation']['reserved_sid'], TARGET)

    def test_terminal_capacity_target_publication_is_caught_by_last_native_bracket(self):
        self.terminal_producer_mutation('capacity-target')

    def test_terminal_storage_target_publication_is_caught_by_last_native_bracket(self):
        self.terminal_producer_mutation('storage-target')

    def test_journal_replacement_during_last_native_guard_retains_uncertain_claim(self):
        self.terminal_producer_mutation('journal-replace')

    def test_journal_same_inode_change_during_last_native_guard_retains_uncertain_claim(self):
        self.terminal_producer_mutation('journal-write')


if __name__ == '__main__':unittest.main()
