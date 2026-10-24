import ast
import copy
import inspect
import json
from pathlib import Path
import unittest
import subprocess
import sys
import tempfile
import os
import hashlib
from unittest.mock import patch
from contextlib import ExitStack

from reverie import launch_guard as guard

FIXTURES = Path(__file__).parent / "fixtures" / "launch_guard" / "cases.json"


def base():
    return {
        "schema_version": 1, "goId": "go-1", "transitionId": "go-1",
        "idempotencyKey": "attempt-1", "goalId": "goal-1", "goalGeneration": 1,
        "currentGoalGeneration": 1, "goalState": "ACTIVE", "decisionId": None,
        "decisionGeneration": None, "sessionId": "session-1", "sessionGeneration": 1,
        "currentSessionGeneration": 1, "employeeId": "employee-1", "rooms": ["room-1"],
        "cursor": {"room-1": 10},
        "source": {"available": True, "complete": True, "observedAtMs": 100000, "messages": []},
    }


def message(**changes):
    value = {"id": "message-11", "roomId": "room-1", "sequence": 11, "atMs": 99000,
             "authorRole": "AGENT", "mentionsLauncher": False, "goId": None}
    value.update(changes)
    return value


class LaunchGuardTests(unittest.TestCase):
    def test_all_ten_acceptance_fixtures_outcome_and_exact_reason(self):
        cases = json.loads(FIXTURES.read_text())
        self.assertEqual(len(cases), 10)
        for case in cases:
            with self.subTest(case=case["name"]):
                receipt = guard.launch_guard(case["request"], case["now_ms"])
                self.assertEqual(receipt["data"]["result"], case["expected_result"])
                self.assertEqual(receipt["code"], case["expected_code"])
                guard.validate_receipt(receipt)

    def test_goal_or_session_generation_change(self):
        for key in ("currentGoalGeneration", "currentSessionGeneration"):
            request = base()
            request[key] = 2
            self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_GEN_CHANGED")

    def test_all_nonactive_goal_states(self):
        for state in guard.GOAL_STATES - {"ACTIVE", "ASSIGNED"}:
            request = base()
            request["goalState"] = state
            self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_STATE_NOT_ACTIVE")

    def test_unknown_future_fields_and_versions_rejected(self):
        for key, value in (("future", 1), ("schema_version", 2)):
            request = base()
            request[key] = value
            with self.assertRaises(guard.ContractError):
                guard.launch_guard(request, 100000)

    def test_privacy_negative_fields_at_all_levels(self):
        for secret in ("prompt", "output", "pane", "argv", "env", "credential", "checkpoint", "path"):
            for level in ("request", "source", "message"):
                request = base()
                request["source"]["messages"] = [message()]
                target = request if level == "request" else (
                    request["source"] if level == "source" else request["source"]["messages"][0])
                target[secret] = "sensitive synthetic content"
                with self.assertRaises(guard.ContractError):
                    guard.launch_guard(request, 100000)

    def test_no_free_text_ids_or_roles_or_bool_generations(self):
        for key, value in (("goalId", "/private/file"), ("sessionId", "prompt with spaces"),
                           ("goalGeneration", True), ("goalGeneration", 0), ("goalState", "custom")):
            request = base()
            request[key] = value
            with self.assertRaises(guard.ContractError):
                guard.launch_guard(request, 100000)

    def test_limits_bound_storage_and_input(self):
        for changes in ({"rooms": []}, {"rooms": ["r"] * 17},
                        {"cursor": {"room-1": -1}}):
            request = base()
            request.update(changes)
            with self.assertRaises(guard.ContractError):
                guard.launch_guard(request, 100000)
        request = base()
        request["source"]["messages"] = [message(id=f"m-{i}", sequence=i + 1) for i in range(257)]
        with self.assertRaises(guard.ContractError):
            guard.launch_guard(request, 100000)

    def test_invalid_metadata_duplicate_ids_positions(self):
        for second in (message(sequence=12), message(id="other")):
            request = base()
            request["source"]["messages"] = [message(), second]
            with self.assertRaises(guard.ContractError):
                guard.launch_guard(request, 100000)

    def test_stale_future_unavailable_incomplete_fail_closed(self):
        for update in ({"observedAtMs": 94999}, {"observedAtMs": 100001},
                       {"available": False}, {"complete": False}):
            request = base()
            request["source"].update(update)
            self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_API_UNAVAILABLE")

    def test_observation_age_boundary(self):
        request = base()
        request["source"]["observedAtMs"] = 95000
        self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_PASS")

    def test_future_message_refused(self):
        request = base()
        request["source"]["messages"] = [message(atMs=100001)]
        self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_API_UNAVAILABLE")

    def test_go_reference_after_cursor_refused(self):
        request = base()
        request["source"]["messages"] = [message(goId="go-1")]
        self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_UNREAD_INSTRUCTION")

    def test_unbound_user_and_mention_do_not_block(self):
        request = base()
        request["source"]["messages"] = [message(roomId="other", authorRole="USER", mentionsLauncher=True)]
        self.assertEqual(guard.launch_guard(request, 100000)["code"], "GUARD_PASS")

    def test_permutation_is_same_decision(self):
        request = base()
        request["source"]["messages"] = [message(), message(id="m-12", sequence=12, authorRole="USER")]
        first = guard.launch_guard(request, 100000)
        request["source"]["messages"].reverse()
        second = guard.launch_guard(request, 100000)
        self.assertEqual(first["code"], second["code"])
        self.assertEqual(first["data"]["newest_seen"], second["data"]["newest_seen"])

    def test_pure_does_not_mutate_input(self):
        request = base()
        original = copy.deepcopy(request)
        self.assertEqual(guard.launch_guard(request, 100000), guard.launch_guard(request, 100000))
        self.assertEqual(request, original)

    def test_replay_returns_original_copy_not_new_timestamp(self):
        replay = guard.ReceiptReplay()
        first = replay.evaluate(base(), 100000)
        second = replay.evaluate(base(), 100100)
        self.assertEqual(first, second)
        first["data"]["result"] = "altered"
        self.assertEqual(replay.evaluate(base(), 100200), second)

    def test_replay_mismatched_key_refuses(self):
        replay = guard.ReceiptReplay()
        replay.evaluate(base(), 100000)
        changed = base()
        changed["source"]["messages"] = [message(authorRole="USER")]
        with self.assertRaisesRegex(guard.ContractError, "IDEMPOTENCY_CONFLICT"):
            replay.evaluate(changed, 100001)

    def test_decision_optional_but_paired_and_bound(self):
        request = base()
        request.update(decisionId="decision-1", decisionGeneration=3)
        guard.validate_receipt(guard.launch_guard(request, 100000))
        request["decisionGeneration"] = None
        with self.assertRaises(guard.ContractError):
            guard.launch_guard(request, 100000)

    def test_no_parallel_go_identity(self):
        request = base()
        request["goId"] = "different-go"
        with self.assertRaises(guard.ContractError):
            guard.launch_guard(request, 100000)

    def test_receipt_immutable_hash_and_closed_fields(self):
        receipt = guard.launch_guard(base(), 100000)
        for key, value in (("prompt", "sensitive"), ("schema_version", 2),
                           ("code", "FREE_TEXT"), ("employeeId", "different")):
            altered = copy.deepcopy(receipt)
            altered[key] = value
            with self.assertRaises(guard.ContractError):
                guard.validate_receipt(altered)

    def test_all_effect_stubs_require_guard_and_are_unavailable(self):
        receipt = guard.launch_guard(base(), 100000)
        for function in (guard.heavy_job, guard.compute_lease, guard.resume, guard.publication_adjacent):
            self.assertEqual(list(inspect.signature(function).parameters), ["guard_receipt"])
            with self.assertRaises(TypeError):
                function()
            with self.assertRaises(guard.ContractError):
                function({})
            self.assertEqual(function(receipt), {"schema_version": 1, "code": "ADAPTER_UNAVAILABLE", "effect": False})

    def test_cli_bounded_positive_refusal_and_private_invalid_inputs(self):
        source_root = Path(__file__).parent.parent
        valid = {"request": base(), "now_ms": 100000}
        refused = copy.deepcopy(valid)
        refused["request"]["source"]["messages"] = [message(authorRole="USER")]
        future = copy.deepcopy(valid)
        future["request"]["schema_version"] = 2
        private = copy.deepcopy(valid)
        private["request"]["source"]["prompt"] = "DO_NOT_ECHO_SYNTHETIC_SECRET"
        cases = [
            (json.dumps(valid).encode(), 0, "GUARD_PASS"),
            (json.dumps(refused).encode(), 2, "GUARD_UNREAD_INSTRUCTION"),
            (json.dumps(future).encode(), 2, "GUARD_INPUT_INVALID"),
            (json.dumps(private).encode(), 2, "GUARD_INPUT_INVALID"),
            (b'{"request":{},"request":{},"now_ms":0}', 2, "GUARD_INPUT_INVALID"),
            (b"x" * (guard.MAX_BYTES + 1), 2, "GUARD_INPUT_INVALID"),
            (b'{"request":NaN,"now_ms":0}', 2, "GUARD_INPUT_INVALID"),
        ]
        for payload, expected_rc, code in cases:
            with self.subTest(expected_code=code, size=len(payload)):
                result = subprocess.run(
                    [sys.executable, "-B", "-m", "reverie.launch_guard"], input=payload,
                    capture_output=True, timeout=3, cwd=source_root,
                    env={"PYTHONPATH": str(source_root / "python")})
                self.assertEqual(result.returncode, expected_rc)
                self.assertEqual(json.loads(result.stdout)["code"], code)
                self.assertEqual(result.stderr, b"")
                self.assertNotIn(b"DO_NOT_ECHO_SYNTHETIC_SECRET", result.stdout)

    def test_evaluation_external_effect_tripwires_and_unchanged_sentinel(self):
        # Test-harness setup alone writes one synthetic sentinel. Reducer runs while
        # filesystem/process/network entry points are tripwired, then state is compared.
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "sentinel"
            sentinel.write_bytes(b"unchanged synthetic fixture")
            before = hashlib.sha256(sentinel.read_bytes()).hexdigest()
            tripwires = ["builtins.open", "os.open", "os.write", "os.unlink", "os.mkdir",
                         "os.rename", "os.system", "subprocess.Popen", "socket.socket"]
            with ExitStack() as stack:
                mocks = [stack.enter_context(patch(name, side_effect=AssertionError("effect attempted")))
                         for name in tripwires]
                receipt = guard.launch_guard(base(), 100000)
                guard.validate_receipt(receipt)
                for stub in (guard.heavy_job, guard.compute_lease, guard.resume, guard.publication_adjacent):
                    self.assertFalse(stub(receipt)["effect"])
                for mock in mocks:
                    mock.assert_not_called()
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["sentinel"])
            self.assertEqual(hashlib.sha256(sentinel.read_bytes()).hexdigest(), before)

    def test_negative_disabled_unread_check_breaks_mp4_refusal(self):
        namespace = {"__name__": "synthetic_mutant"}
        source = inspect.getsource(guard)
        needle = 'code = "GUARD_UNREAD_INSTRUCTION" if relevant else "GUARD_PASS"'
        self.assertEqual(source.count(needle), 1)
        exec(compile(source.replace(needle, 'code = "GUARD_PASS"'), "<synthetic mutant>", "exec"), namespace)
        case = json.loads(FIXTURES.read_text())[-1]
        self.assertEqual(guard.launch_guard(case["request"], case["now_ms"])["code"],
                         case["expected_code"])
        mutant = namespace["launch_guard"](case["request"], case["now_ms"])
        self.assertNotEqual(mutant["code"], case["expected_code"])
        self.assertEqual(mutant["data"]["result"], "PASS")

    def test_schema_document_matches_closed_runtime_fields(self):
        schema = json.loads((Path(__file__).parent.parent / "schemas" / "launch-guard-receipt-v1.json").read_text())
        self.assertEqual(set(schema["required"]), guard.ENVELOPE_FIELDS)
        self.assertEqual(set(schema["properties"]), guard.ENVELOPE_FIELDS)
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["properties"]["code"]["enum"]), guard.CODES)

    def test_static_zero_effect_imports_and_no_calls(self):
        tree = ast.parse(inspect.getsource(guard))
        imports = {n.name for node in ast.walk(tree) if isinstance(node, ast.Import) for n in node.names}
        self.assertEqual(imports, {"hashlib", "json", "re", "sys"})
        forbidden = {"open", "exec", "eval", "compile", "__import__", "subprocess", "socket", "requests",
                     "urllib", "tmux", "send_keys", "system", "popen", "sleep"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else (
                    node.func.attr if isinstance(node.func, ast.Attribute) else "")
                if (isinstance(node.func, ast.Attribute) and node.func.attr == "compile"
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == "re"):
                    continue  # Regex construction is not Python code execution.
                self.assertNotIn(name, forbidden)


if __name__ == "__main__":
    unittest.main()
