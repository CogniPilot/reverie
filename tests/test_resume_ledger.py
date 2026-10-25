"""Owned synthetic files only. No session, model, network, or effect adapter."""
from dataclasses import replace
from contextlib import closing
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from reverie.resume_ledger import Binding, LedgerError, ResumeLedger


def competing_reserve(file, binding, key, result):
    store = ResumeLedger(file)
    try:
        result.put(store.reserve(binding, key, 1000))
    except LedgerError as error:
        result.put({"error": error.code})
    finally:
        store.close()

def competing_complete(file, binding, key, result):
    store = ResumeLedger(file)
    try:
        for _ in range(50):
            try:
                item = store.reserve(binding, key, 1000)["receipt"]
                if item["receiptType"] == "RESUME_ATTEMPT":
                    store.advance(binding, item["attemptId"], 1, "QUEUED", "REFUSED",
                                  "POLICY_REFUSED", "finished", 1000)
                result.put(item["receiptType"])
                return
            except LedgerError as error:
                if error.code != "UNRESOLVED_ATTEMPT":
                    result.put(error.code)
                    return
                time.sleep(0.005)
        result.put("TEST_RETRY_EXHAUSTED")
    finally:
        store.close()


class ResumeLedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="resume-ledger-owned-")
        self.root = Path(self.directory.name)
        self.file = self.root / "resume.db"
        self.ledger = ResumeLedger(self.file)
        self.binding = Binding("employee-a", "goal-a", 1, "session-a", 1, 0)

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def reserve(self, key="request-1", now=1000, binding=None):
        return self.ledger.reserve(binding or self.binding, key, now)

    def advance(self, receipt, state, reason, key="transition-1", now=1001, binding=None):
        return self.ledger.advance(binding or self.binding, receipt["attemptId"],
            receipt["sequence"], receipt["state"], state, reason, key, now)

    def refusal(self, key, now, binding=None):
        queued = self.reserve(key, now, binding)["receipt"]
        return self.advance(queued, "REFUSED", "POLICY_REFUSED", key, now + 1, binding)["receipt"]

    def code(self, expected, function):
        with self.assertRaises(LedgerError) as caught:
            function()
        self.assertEqual(expected, caught.exception.code)
        self.assertEqual(expected, str(caught.exception))

    def test_durable_original_reservation_and_transition_replays(self):
        first = self.reserve()
        changed = self.advance(first["receipt"], "SUBMITTED", "SUBMISSION_CONFIRMED")
        self.ledger.close()
        self.ledger = ResumeLedger(self.file)
        repeated = self.reserve(now=1002)
        self.assertTrue(repeated["replayed"])
        self.assertEqual(first["receipt"], repeated["receipt"])
        # Replay does not manufacture a freshly stamped QUEUED grant.
        self.assertEqual("NONE", repeated["receipt"]["automaticAction"])
        transition = self.advance(first["receipt"], "SUBMITTED", "SUBMISSION_CONFIRMED", now=1003)
        self.assertTrue(transition["replayed"])
        self.assertEqual(changed["receipt"], transition["receipt"])

    def test_idempotency_reuse_cannot_adopt_replacement_binding(self):
        self.reserve()
        for changed in (
            replace(self.binding, goal_generation=2),
            replace(self.binding, session_id="replacement-session"),
            replace(self.binding, transition_sequence=1),
            replace(self.binding, goal_id="replacement-goal"),
        ):
            self.code("IDEMPOTENCY_CONFLICT", lambda: self.reserve(binding=changed))

    def test_three_refused_attempts_count_and_fourth_has_one_persisted_report(self):
        for number in range(3):
            self.refusal("request-" + str(number), 1000 + number * 10)
        first = self.reserve("fourth", 1030)
        self.assertFalse(first["replayed"])
        self.assertEqual("RESUME_BUDGET_REFUSED", first["receipt"]["receiptType"])
        self.ledger.close()
        self.ledger = ResumeLedger(self.file)
        repeated = self.reserve("fifth-new-key", 1040)
        self.assertTrue(repeated["replayed"])
        self.assertEqual(first["receipt"], repeated["receipt"])
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual(3, db.execute("SELECT count(*) FROM attempts").fetchone()[0])
            self.assertEqual(1, db.execute("SELECT count(*) FROM alerts").fetchone()[0])

    def test_exact_rolling_boundary_expires_oldest_attempt(self):
        for number in range(3):
            self.refusal("request-" + str(number), 1000 + number * 10)
        refused = self.reserve("fourth", 1800999)["receipt"]
        self.assertEqual(1801000, refused["blockedUntilMs"])
        allowed = self.reserve("after-window", 1801000)["receipt"]
        self.assertEqual("QUEUED", allowed["state"])

    def test_replaced_sessions_and_goals_cannot_reset_employee_budget(self):
        for number in range(3):
            target = replace(self.binding, session_id="session-" + str(number),
                             session_generation=number + 1, goal_id="goal-" + str(number),
                             goal_generation=number + 1)
            self.refusal("key-" + str(number), 1000 + number * 10, target)
        changed = replace(self.binding, session_id="new-session", goal_id="new-goal", goal_generation=9)
        self.assertEqual("employee", self.reserve("fourth", 1030, changed)["receipt"]["dimension"])

    def test_goal_and_session_dimensions_are_independently_bounded(self):
        for dimension in ("goal", "session"):
            with self.subTest(dimension=dimension):
                file = self.root / (dimension + ".db")
                ledger = ResumeLedger(file)
                try:
                    for n in range(3):
                        target = Binding("worker-" + str(n), "same-goal" if dimension == "goal" else "g-" + str(n),
                                         n + 1, "same-session" if dimension == "session" else "s-" + str(n), n + 1, 0)
                        item = ledger.reserve(target, "request", 1000 + n * 10)["receipt"]
                        ledger.advance(target, item["attemptId"], 1, "QUEUED", "FAILED",
                                       "SUBMISSION_FAILED", "finish", 1001 + n * 10)
                    target = Binding("fourth-worker", "same-goal" if dimension == "goal" else "fourth-goal",
                                     9, "same-session" if dimension == "session" else "fourth-session", 9, 0)
                    self.assertEqual(dimension, ledger.reserve(target, "fourth", 1040)["receipt"]["dimension"])
                finally:
                    ledger.close()

    def test_stale_state_sequence_and_binding_refuse_without_append(self):
        queued = self.reserve()["receipt"]
        self.advance(queued, "SUBMITTED", "SUBMISSION_CONFIRMED")
        self.code("CAS_STALE", lambda: self.advance(queued, "REFUSED", "POLICY_REFUSED", "different", 1002))
        self.code("BINDING_CHANGED", lambda: self.advance(queued, "REFUSED", "POLICY_REFUSED",
            "different", 1002, replace(self.binding, transition_sequence=1)))
        self.code("IDEMPOTENCY_CONFLICT", lambda: self.advance(queued, "REFUSED", "POLICY_REFUSED",
            "transition-1", 1002))
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual(2, db.execute("SELECT count(*) FROM events").fetchone()[0])

    def test_restart_at_each_unfinished_stage_is_uncertain_and_never_requeued(self):
        for stage in ("QUEUED", "SUBMITTED", "TURN_STARTED"):
            with self.subTest(stage=stage):
                target = replace(self.binding, employee_id="worker-" + stage,
                                 goal_id="goal-" + stage, session_id="session-" + stage)
                item = self.reserve(stage, 2000, target)["receipt"]
                if stage in ("SUBMITTED", "TURN_STARTED"):
                    item = self.advance(item, "SUBMITTED", "SUBMISSION_CONFIRMED", "send", 2000, target)["receipt"]
                if stage == "TURN_STARTED":
                    item = self.advance(item, "TURN_STARTED", "TURN_CONFIRMED", "turn", 2000, target)["receipt"]
                self.ledger.close()
                self.ledger = ResumeLedger(self.file)
                receipts = self.ledger.reconcile_restart(2000)
                self.assertEqual(1, len(receipts))
                uncertain = receipts[0]
                self.assertEqual("UNCERTAIN", uncertain["state"])
                self.assertEqual("PROCESS_RESTART", uncertain["reason"])
                self.assertEqual([], self.ledger.reconcile_restart(2000))
                # Even after the quota window and after replacement, uncertainty holds.
                # Run this check at the same clock so later subtests do not reverse time.
                self.code("UNRESOLVED_ATTEMPT", lambda: self.reserve("new-key", 2000,
                    replace(target, session_id="replacement", session_generation=2)))
                self.code("TRANSITION_INVALID", lambda: self.advance(uncertain, "SUBMITTED",
                    "SUBMISSION_CONFIRMED", "retry", 2000, target))

    def test_uncertainty_survives_window_expiry_and_employee_replacement(self):
        queued = self.reserve()["receipt"]
        self.advance(queued, "UNCERTAIN", "SEND_UNCERTAIN")
        self.code("UNRESOLVED_ATTEMPT", lambda: self.reserve("retry", 3601000,
            replace(self.binding, session_id="replacement", session_generation=2)))

    def test_full_success_path_has_append_only_receipts(self):
        item = self.reserve()["receipt"]
        receipts = [item]
        for number, (state, reason) in enumerate((
            ("SUBMITTED", "SUBMISSION_CONFIRMED"), ("TURN_STARTED", "TURN_CONFIRMED"),
            ("PROGRESS_OBSERVED", "PROGRESS_CONFIRMED"))):
            item = self.advance(item, state, reason, "key-" + str(number), 1001 + number)["receipt"]
            receipts.append(item)
        self.assertEqual([1, 2, 3, 4], [r["sequence"] for r in receipts])
        self.assertEqual(4, len({r["receiptId"] for r in receipts}))
        with closing(sqlite3.connect(self.file)) as db:
            for table in ("attempts", "events"):
                with self.assertRaises(sqlite3.DatabaseError):
                    db.execute("DELETE FROM " + table)

    def test_caller_restart_key_cannot_collide_with_internal_reconciliation(self):
        item = self.reserve("restart")["receipt"]
        self.advance(item, "SUBMITTED", "SUBMISSION_CONFIRMED", "restart")
        self.assertEqual("UNCERTAIN", self.ledger.reconcile_restart(1002)[0]["state"])

    def test_clock_reversal_and_malformed_private_input_have_fixed_errors(self):
        self.reserve()
        self.code("CLOCK_REVERSED", lambda: self.reserve("different", 999))
        for changed in (replace(self.binding, employee_id="PRIVATE CONTENT /secret"),
                        replace(self.binding, goal_generation=True),
                        replace(self.binding, transition_sequence=-1)):
            self.code("INPUT_INVALID", lambda: self.reserve(binding=changed))
        self.code("INPUT_INVALID", lambda: self.reserve(key="a" * 97))
        self.code("INPUT_INVALID", lambda: self.reserve(now=2**53 - 1))

    def test_one_unresolved_attempt_prevents_parallel_new_keys(self):
        self.reserve()
        self.code("UNRESOLVED_ATTEMPT", lambda: self.reserve("new-key", 1001))

    def test_transaction_rollback_preserves_no_partial_queued_attempt(self):
        with patch.object(self.ledger, "_append", side_effect=sqlite3.OperationalError("PRIVATE disk fault")):
            self.code("STORE_UNAVAILABLE", lambda: self.reserve())
        self.assertFalse(self.reserve()["replayed"])
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual(1, db.execute("SELECT count(*) FROM attempts").fetchone()[0])

    def test_bounded_storage_failure_preserves_old_attempts(self):
        with patch("reverie.resume_ledger._MAX_ROWS", 1):
            self.refusal("first", 1000)
            self.code("STORE_FULL", lambda: self.reserve("second", 1002))
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual(1, db.execute("SELECT count(*) FROM attempts").fetchone()[0])

    def test_custody_rejects_permissions_symlinks_and_replaced_inode(self):
        os.chmod(self.file, 0o644)
        self.code("CUSTODY_INVALID", lambda: self.reserve())
        os.chmod(self.file, 0o600)
        link = self.root / "link.db"
        link.symlink_to(self.file)
        self.code("CUSTODY_INVALID", lambda: ResumeLedger(link))
        os.link(self.file, self.root / "hard.db")
        self.code("CUSTODY_INVALID", lambda: self.reserve())
        (self.root / "hard.db").unlink()
        self.file.rename(self.root / "previous.db")
        self.file.write_bytes(b"not a ledger")
        os.chmod(self.file, 0o600)
        self.code("CUSTODY_INVALID", lambda: self.reserve())

    def test_corrupt_database_never_adopts_backup(self):
        self.ledger.close()
        self.file.write_bytes(b"corrupt database")
        (self.root / "resume.db.bak").write_bytes(b"not an authority")
        self.code("STORE_UNAVAILABLE", lambda: ResumeLedger(self.file))

    def test_four_concurrent_connections_share_one_idempotent_attempt(self):
        # Bounded child processes inherit the single-CPU test affinity.
        self.ledger.close()
        context = multiprocessing.get_context("fork")
        queue = context.Queue()
        children = [context.Process(target=competing_reserve,
                    args=(str(self.file), self.binding, "same-key", queue)) for _ in range(4)]
        try:
            for child in children:
                child.start()
            results = [queue.get(timeout=5) for _ in children]
            for child in children:
                child.join(timeout=5)
                self.assertEqual(0, child.exitcode)
            self.assertEqual(1, sum(not x["replayed"] for x in results))
            self.assertEqual(1, len({x["receipt"]["receiptId"] for x in results}))
        finally:
            for child in children:
                if child.is_alive():
                    child.terminate()
                child.join(timeout=5)
            queue.close()
            queue.join_thread()

    def test_independent_targets_cannot_bypass_active_queue_bound(self):
        self.reserve()
        other = Binding("worker-b", "goal-b", 1, "session-b", 1, 0)
        with patch("reverie.resume_ledger._MAX_ACTIVE", 1):
            self.code("QUEUE_FULL", lambda: self.reserve("other", 1001, other))

    def test_event_capacity_failure_leaves_attempt_unfinished_and_fenced(self):
        item = self.reserve()["receipt"]
        with patch("reverie.resume_ledger._MAX_EVENTS", 1):
            self.code("STORE_FULL", lambda: self.advance(item, "REFUSED", "POLICY_REFUSED"))
            self.code("STORE_FULL", lambda: self.ledger.reconcile_restart(1001))
        self.code("UNRESOLVED_ATTEMPT", lambda: self.reserve("other", 1001))

    def test_partial_restart_append_failure_rolls_back_the_entire_batch(self):
        self.reserve()
        other = Binding("worker-b", "goal-b", 1, "session-b", 1, 0)
        self.reserve("other", 1000, other)
        append = self.ledger._append
        calls = []

        def failing_append(*args):
            calls.append(True)
            if len(calls) == 2:
                raise sqlite3.OperationalError("PRIVATE failure")
            return append(*args)

        with patch.object(self.ledger, "_append", side_effect=failing_append):
            self.code("STORE_UNAVAILABLE", lambda: self.ledger.reconcile_restart(1001))
        receipts = self.ledger.reconcile_restart(1001)
        self.assertEqual(2, len(receipts))
        self.assertTrue(all(r["sequence"] == 2 for r in receipts))

    def test_lost_commit_ack_replays_original_without_new_attempt(self):
        connection = self.ledger._db

        class LostAck:
            def __getattr__(self, key):
                return getattr(connection, key)

            def execute(self, sql, *args):
                result = connection.execute(sql, *args)
                if sql == "COMMIT":
                    raise sqlite3.OperationalError("PRIVATE lost acknowledgement")
                return result

        self.ledger._db = LostAck()
        self.code("STORE_UNAVAILABLE", lambda: self.reserve())
        self.ledger._db = connection
        repeated = self.reserve(now=1001)
        self.assertTrue(repeated["replayed"])
        self.assertEqual("QUEUED", repeated["receipt"]["state"])
        self.assertEqual(1, len(self.ledger.reconcile_restart(1002)))

    def test_transition_connections_allow_exactly_one_cas_winner(self):
        item = self.reserve()["receipt"]
        second = ResumeLedger(self.file)
        try:
            self.advance(item, "SUBMITTED", "SUBMISSION_CONFIRMED")
            self.code("CAS_STALE", lambda: second.advance(
                self.binding, item["attemptId"], 1, "QUEUED", "REFUSED",
                "POLICY_REFUSED", "competing", 1001))
        finally:
            second.close()

    def test_competing_distinct_keys_cannot_exceed_three_attempts(self):
        self.ledger.close()
        context = multiprocessing.get_context("fork")
        queue = context.Queue()
        children = [context.Process(target=competing_complete,
                    args=(str(self.file), self.binding, "key-" + str(n), queue)) for n in range(4)]
        try:
            for child in children:
                child.start()
            results = [queue.get(timeout=5) for _ in children]
            for child in children:
                child.join(timeout=5)
                self.assertEqual(0, child.exitcode)
            self.assertCountEqual(["RESUME_ATTEMPT"] * 3 + ["RESUME_BUDGET_REFUSED"], results)
        finally:
            for child in children:
                if child.is_alive():
                    child.terminate()
                child.join(timeout=5)
            queue.close()
            queue.join_thread()

    def test_receipts_have_closed_metadata_without_text_or_effects(self):
        item = self.reserve()["receipt"]
        self.assertEqual({"schema_version", "receiptType", "receiptId", "attemptId", "binding",
                          "sequence", "state", "reason", "createdAtMs", "automaticAction"}, set(item))
        self.assertEqual("NONE", item["automaticAction"])
        serialized = json.dumps(item)
        for forbidden in ("prompt", "terminal", "argv", "credential", "objective"):
            self.assertNotIn(forbidden, serialized)

    def test_canonical_binding_ids_and_operation_keys_have_separate_envelopes(self):
        binding = replace(self.binding, employee_id="." + "e" * 99,
                          goal_id="goal:part.1", session_id="s" * 100)
        item = self.reserve("k" * 96, binding=binding)["receipt"]
        self.assertEqual(binding.__dict__, item["binding"])
        for key in ("k" * 97, "key:part", ".key", "key.with.dot"):
            self.code("INPUT_INVALID", lambda: self.reserve(key, binding=binding))
        for value in ("", "g" * 101, "g/part", "é", "g\n"):
            self.code("INPUT_INVALID", lambda: self.reserve(binding=replace(binding, goal_id=value)))

    def test_cas_idempotency_and_capacity_refusals_commit_only_the_clock_floor(self):
        item = self.reserve()["receipt"]
        self.advance(item, "SUBMITTED", "SUBMISSION_CONFIRMED", now=1100)
        self.code("CAS_STALE", lambda: self.advance(item, "REFUSED", "POLICY_REFUSED", "stale", 5000))
        self.code("IDEMPOTENCY_CONFLICT", lambda: self.reserve(now=6000,
            binding=replace(self.binding, goal_generation=2)))
        other = Binding("worker-b", "goal-b", 1, "session-b", 1, 0)
        with patch("reverie.resume_ledger._MAX_ROWS", 1):
            self.code("STORE_FULL", lambda: self.reserve("full", 7000, other))
        self.ledger.close()
        self.ledger = ResumeLedger(self.file)
        self.code("CLOCK_REVERSED", lambda: self.reserve("older", 6999, other))
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual([(7000,)], db.execute("SELECT clock_floor FROM ledger_meta").fetchall())
            self.assertEqual(1, db.execute("SELECT count(*) FROM attempts").fetchone()[0])
            self.assertEqual(2, db.execute("SELECT count(*) FROM events").fetchone()[0])

    def test_semantic_refusal_after_partial_append_rolls_back_operation_but_keeps_floor(self):
        append = self.ledger._append

        def refuse_after_append(*args):
            append(*args)
            raise LedgerError("STORE_FULL")

        with patch.object(self.ledger, "_append", side_effect=refuse_after_append):
            self.code("STORE_FULL", lambda: self.reserve(now=5000))
        self.ledger.close()
        self.ledger = ResumeLedger(self.file)
        self.code("CLOCK_REVERSED", lambda: self.reserve(now=4000))
        with closing(sqlite3.connect(self.file)) as db:
            for table in ("attempts", "events", "alerts"):
                self.assertEqual(0, db.execute("SELECT count(*) FROM " + table).fetchone()[0])
            self.assertEqual([(5000,)], db.execute("SELECT clock_floor FROM ledger_meta").fetchall())

    def corrupt_owned_row(self, table, sql, arguments=()):
        # Synthetic persistence corruption; restore the original immutable trigger.
        self.ledger.close()
        with closing(sqlite3.connect(self.file)) as db:
            with db:
                db.execute("DROP TRIGGER " + table + "_no_update")
                db.execute(sql, arguments)
                db.execute("CREATE TRIGGER " + table + "_no_update BEFORE UPDATE ON " + table +
                           " BEGIN SELECT RAISE(ABORT,'immutable'); END")
        self.ledger = ResumeLedger(self.file)

    def test_closed_persisted_event_matrix_refuses_before_replay_or_new_reservation(self):
        original = self.reserve()["receipt"]
        corruptions = [
            {**original, "extra": "synthetic-only"},
            {**original, "schema_version": True},
            {**original, "automaticAction": "SEND"},
            {**original, "receiptId": "0" * 32},
            {**original, "attemptId": "0" * 32},
            {**original, "sequence": True},
            {**original, "sequence": 2},
            {**original, "state": "REFUSED", "reason": "POLICY_REFUSED"},
            {**original, "reason": "UNKNOWN"},
            {**original, "createdAtMs": 999},
            {**original, "createdAtMs": 1001},
            {**original, "binding": {**original["binding"], "goal_generation": 2}},
            {**original, "binding": {**original["binding"], "goal_generation": True}},
        ]
        for body in corruptions:
            with self.subTest(body=body):
                self.corrupt_owned_row("events", "UPDATE events SET body=?", (json.dumps(body),))
                self.code("STORE_UNAVAILABLE", lambda: self.reserve(now=1001))
                other = Binding("worker-b", "goal-b", 1, "session-b", 1, 0)
                self.code("STORE_UNAVAILABLE", lambda: self.reserve("other", 1001, other))
        for raw in ('{"schema_version":1,"schema_version":999}', 'NaN', '[]', '"text"', '{'):
            with self.subTest(raw=raw):
                self.corrupt_owned_row("events", "UPDATE events SET body=?", (raw,))
                self.code("STORE_UNAVAILABLE", lambda: self.reserve(now=1001))

    def test_attempt_columns_binding_and_fingerprint_must_match(self):
        original = self.reserve()["receipt"]
        for column, bad, good in (("employee", "other", self.binding.employee_id),
                                  ("goal", "other", self.binding.goal_id),
                                  ("session", "other", self.binding.session_id),
                                  ("issued", 999, 1000),
                                  ("fingerprint", "0" * 64, None)):
            with self.subTest(column=column):
                self.corrupt_owned_row("attempts", "UPDATE attempts SET " + column + "=?", (bad,))
                self.code("STORE_UNAVAILABLE", lambda: self.advance(original, "REFUSED", "POLICY_REFUSED"))
                if good is not None:
                    self.corrupt_owned_row("attempts", "UPDATE attempts SET " + column + "=?", (good,))

    def test_transition_fingerprint_and_event_chain_are_validated(self):
        original = self.reserve()["receipt"]
        self.advance(original, "SUBMITTED", "SUBMISSION_CONFIRMED")
        self.corrupt_owned_row("events", "UPDATE events SET fingerprint=? WHERE sequence=2", ("0" * 64,))
        self.code("STORE_UNAVAILABLE", lambda: self.reserve(now=1002))

    def test_closed_budget_report_and_its_backing_attempts_are_validated(self):
        for number in range(3):
            self.refusal("request-" + str(number), 1000 + number * 10)
        report = self.reserve("fourth", 1030)["receipt"]
        for body in ({**report, "subject": "other"}, {**report, "extra": "synthetic-only"},
                     {**report, "blockedUntilMs": True}, {**report, "blockedUntilMs": 1801001}):
            with self.subTest(body=body):
                self.corrupt_owned_row("alerts", "UPDATE alerts SET body=?", (json.dumps(body),))
                self.code("STORE_UNAVAILABLE", lambda: self.reserve("again", 1040))
        self.corrupt_owned_row("alerts", "UPDATE alerts SET body=?", (json.dumps(report),))
        self.corrupt_owned_row("attempts", "UPDATE attempts SET issued=issued+1")
        self.code("STORE_UNAVAILABLE", lambda: self.reserve("again", 1040))

    def test_corrupt_floor_and_unknown_columns_are_unavailable(self):
        self.reserve()
        self.ledger.close()
        with closing(sqlite3.connect(self.file)) as db:
            with db:
                db.execute("UPDATE ledger_meta SET clock_floor='invalid'")
        self.ledger = ResumeLedger(self.file)
        self.code("STORE_UNAVAILABLE", lambda: self.reserve(now=1001))
        self.ledger.close()
        with closing(sqlite3.connect(self.file)) as db:
            with db:
                db.execute("UPDATE ledger_meta SET clock_floor=1000")
                db.execute("ALTER TABLE attempts ADD COLUMN unknown TEXT")
        self.ledger = ResumeLedger(self.file)
        self.code("STORE_UNAVAILABLE", lambda: self.reserve(now=1001))


if __name__ == "__main__":
    unittest.main()
