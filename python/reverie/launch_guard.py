"""Versioned metadata-only launch guard. No live adapters or authorization source.

The caller must supply an authenticated, complete snapshot under its goal/session
lock. PASS proves this predicate only; it is neither an effect grant nor a durable
ledger. Phase-0 effect entry points below are unavailable even with PASS.
"""
import hashlib
import json
import re
import sys

SCHEMA_VERSION = 1
MAX_BYTES = 65536
MAX_MESSAGES = 256
MAX_ROOMS = 16
MAX_AGE_MS = 5000
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
GOAL_STATES = frozenset(("READY", "ASSIGNED", "ACTIVE", "HOLD", "REVIEW", "DONE", "NO_GO", "CANCELLED"))
CODES = frozenset((
    "GUARD_PASS", "GUARD_UNREAD_INSTRUCTION", "GUARD_GEN_CHANGED",
    "GUARD_STATE_NOT_ACTIVE", "GUARD_API_UNAVAILABLE", "GUARD_INPUT_INVALID",
    "GUARD_RECEIPT_INVALID", "IDEMPOTENCY_CONFLICT", "ADAPTER_UNAVAILABLE",
))
ENVELOPE_FIELDS = frozenset((
    "schema_version", "receiptType", "receiptId", "goalId", "goalGeneration",
    "decisionId", "decisionGeneration", "sessionId", "sessionGeneration",
    "employeeId", "transitionId", "idempotencyKey", "createdAtMs", "level", "code", "data",
))
REQUEST_FIELDS = frozenset((
    "schema_version", "goId", "transitionId", "idempotencyKey", "goalId",
    "goalGeneration", "currentGoalGeneration", "goalState", "decisionId",
    "decisionGeneration", "sessionId", "sessionGeneration", "currentSessionGeneration",
    "employeeId", "rooms", "cursor", "source",
))
SOURCE_FIELDS = frozenset(("available", "complete", "observedAtMs", "messages"))
MESSAGE_FIELDS = frozenset(("id", "roomId", "sequence", "atMs", "authorRole", "mentionsLauncher", "goId"))
ROLES = frozenset(("USER", "COORDINATOR", "AGENT", "SYSTEM"))


class ContractError(ValueError):
    """Only a fixed code is ever exposed, not rejected input or exception text."""
    def __init__(self, code="GUARD_INPUT_INVALID"):
        self.code = code
        super().__init__(code)


def fields(value, expected):
    if type(value) is not dict or set(value) != expected:
        raise ContractError()


def opaque(value):
    if type(value) is not str or not ID.fullmatch(value):
        raise ContractError()


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ContractError()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_request(value):
    fields(value, REQUEST_FIELDS)
    if type(value["schema_version"]) is not int or value["schema_version"] != SCHEMA_VERSION:
        raise ContractError()
    for key in ("goId", "transitionId", "idempotencyKey", "goalId", "sessionId", "employeeId"):
        opaque(value[key])
    # The GO is the authorizing transition identity, never an independent shadow ID.
    if value["goId"] != value["transitionId"]:
        raise ContractError()
    for key in ("goalGeneration", "currentGoalGeneration", "sessionGeneration", "currentSessionGeneration"):
        integer(value[key], 1)
    if (value["decisionId"] is None) != (value["decisionGeneration"] is None):
        raise ContractError()
    if value["decisionId"] is not None:
        opaque(value["decisionId"])
        integer(value["decisionGeneration"], 1)
    if type(value["goalState"]) is not str or value["goalState"] not in GOAL_STATES:
        raise ContractError()
    rooms = value["rooms"]
    if type(rooms) is not list or not 1 <= len(rooms) <= MAX_ROOMS:
        raise ContractError()
    for room in rooms:
        opaque(room)
    if len(set(rooms)) != len(rooms):
        raise ContractError()
    fields(value["cursor"], set(rooms))
    for seq in value["cursor"].values():
        integer(seq)
    source = value["source"]
    fields(source, SOURCE_FIELDS)
    for key in ("available", "complete"):
        if type(source[key]) is not bool:
            raise ContractError()
    integer(source["observedAtMs"])
    messages = source["messages"]
    if type(messages) is not list or len(messages) > MAX_MESSAGES:
        raise ContractError()
    seen_ids, seen_positions = set(), set()
    for message in messages:
        fields(message, MESSAGE_FIELDS)
        for key in ("id", "roomId"):
            opaque(message[key])
        integer(message["sequence"], 1)
        integer(message["atMs"])
        if type(message["authorRole"]) is not str or message["authorRole"] not in ROLES:
            raise ContractError()
        if type(message["mentionsLauncher"]) is not bool:
            raise ContractError()
        if message["goId"] is not None:
            opaque(message["goId"])
        position = (message["roomId"], message["sequence"])
        if message["id"] in seen_ids or position in seen_positions:
            raise ContractError()
        seen_ids.add(message["id"])
        seen_positions.add(position)


def _receipt(request, now_ms, code):
    data = {
        "goId": request["goId"],
        "rooms": sorted(request["rooms"]),
        "cursor_checked": dict(sorted(request["cursor"].items())),
        "newest_seen": dict(sorted(request["cursor"].items())),
        "result": "PASS" if code == "GUARD_PASS" else "REFUSE",
        "snapshotSha256": hashlib.sha256(canonical(request).encode()).hexdigest(),
    }
    for message in request["source"]["messages"]:
        room = message["roomId"]
        if room in data["newest_seen"]:
            data["newest_seen"][room] = max(data["newest_seen"][room], message["sequence"])
    receipt = {
        "schema_version": SCHEMA_VERSION, "receiptType": "LAUNCH_GUARD",
        "goalId": request["goalId"], "goalGeneration": request["goalGeneration"],
        "decisionId": request["decisionId"], "decisionGeneration": request["decisionGeneration"],
        "sessionId": request["sessionId"], "sessionGeneration": request["sessionGeneration"],
        "employeeId": request["employeeId"], "transitionId": request["transitionId"],
        "idempotencyKey": request["idempotencyKey"], "createdAtMs": now_ms,
        "level": "SYNTHETIC", "code": code, "data": data,
    }
    receipt["receiptId"] = hashlib.sha256(canonical(receipt).encode()).hexdigest()
    return receipt


def launch_guard(request, now_ms):
    """Pure deterministic predicate. No IO, clock, network, or process operations."""
    integer(now_ms)
    validate_request(request)
    source = request["source"]
    if (request["goalGeneration"] != request["currentGoalGeneration"] or
            request["sessionGeneration"] != request["currentSessionGeneration"]):
        code = "GUARD_GEN_CHANGED"
    elif request["goalState"] not in ("ASSIGNED", "ACTIVE"):
        code = "GUARD_STATE_NOT_ACTIVE"
    elif (not source["available"] or not source["complete"] or
          not 0 <= now_ms - source["observedAtMs"] <= MAX_AGE_MS or
          any(m["atMs"] > source["observedAtMs"] for m in source["messages"])):
        code = "GUARD_API_UNAVAILABLE"
    else:
        relevant = [
            m for m in source["messages"]
            if m["roomId"] in request["cursor"] and m["sequence"] > request["cursor"][m["roomId"]]
            and (m["authorRole"] in ("USER", "COORDINATOR") or m["mentionsLauncher"]
                 or m["goId"] == request["goId"])
        ]
        code = "GUARD_UNREAD_INSTRUCTION" if relevant else "GUARD_PASS"
    return _receipt(request, now_ms, code)


def validate_receipt(receipt):
    fields(receipt, ENVELOPE_FIELDS)
    if type(receipt["schema_version"]) is not int or receipt["schema_version"] != SCHEMA_VERSION:
        raise ContractError("GUARD_RECEIPT_INVALID")
    if receipt["receiptType"] != "LAUNCH_GUARD" or receipt["level"] != "SYNTHETIC":
        raise ContractError("GUARD_RECEIPT_INVALID")
    for key in ("goalId", "sessionId", "employeeId", "transitionId", "idempotencyKey"):
        opaque(receipt[key])
    for key in ("goalGeneration", "sessionGeneration"):
        integer(receipt[key], 1)
    if (receipt["decisionId"] is None) != (receipt["decisionGeneration"] is None):
        raise ContractError()
    if receipt["decisionId"] is not None:
        opaque(receipt["decisionId"])
        integer(receipt["decisionGeneration"], 1)
    integer(receipt["createdAtMs"])
    if type(receipt["code"]) is not str or receipt["code"] not in CODES:
        raise ContractError("GUARD_RECEIPT_INVALID")
    data = receipt["data"]
    fields(data, {"goId", "rooms", "cursor_checked", "newest_seen", "result", "snapshotSha256"})
    opaque(data["goId"])
    if data["goId"] != receipt["transitionId"]:
        raise ContractError()
    rooms = data["rooms"]
    if type(rooms) is not list or not 1 <= len(rooms) <= MAX_ROOMS:
        raise ContractError()
    for room in rooms:
        opaque(room)
    if rooms != sorted(set(rooms)):
        raise ContractError()
    for key in ("cursor_checked", "newest_seen"):
        fields(data[key], set(rooms))
        for seq in data[key].values():
            integer(seq)
    if any(data["newest_seen"][r] < data["cursor_checked"][r] for r in rooms):
        raise ContractError()
    expected_result = "PASS" if receipt["code"] == "GUARD_PASS" else "REFUSE"
    if data["result"] != expected_result:
        raise ContractError()
    for digest in (data["snapshotSha256"], receipt["receiptId"]):
        if type(digest) is not str or not re.fullmatch("[0-9a-f]{64}", digest):
            raise ContractError()
    unsigned = {k: v for k, v in receipt.items() if k != "receiptId"}
    if receipt["receiptId"] != hashlib.sha256(canonical(unsigned).encode()).hexdigest():
        raise ContractError("GUARD_RECEIPT_INVALID")


class ReceiptReplay:
    """Bounded in-memory synthetic replay fixture, NOT a durable production store."""
    def __init__(self):
        self._rows = {}

    def evaluate(self, request, now_ms):
        validate_request(request)
        key = (request["employeeId"], request["sessionId"], request["sessionGeneration"],
               request["goalId"], request["goalGeneration"], request["idempotencyKey"])
        digest = hashlib.sha256(canonical(request).encode()).hexdigest()
        if key in self._rows:
            prior_digest, prior = self._rows[key]
            if digest != prior_digest:
                raise ContractError("IDEMPOTENCY_CONFLICT")
            return json.loads(prior)
        if len(self._rows) >= 256:
            raise ContractError("GUARD_API_UNAVAILABLE")
        receipt = launch_guard(request, now_ms)
        self._rows[key] = (digest, canonical(receipt))
        return json.loads(self._rows[key][1])


def _unavailable(guard_receipt):
    validate_receipt(guard_receipt)
    return {"schema_version": 1, "code": "ADAPTER_UNAVAILABLE", "effect": False}


# Every Phase-0 effect-class entry point requires a guard receipt, and cannot act.
def heavy_job(guard_receipt):
    return _unavailable(guard_receipt)


def compute_lease(guard_receipt):
    return _unavailable(guard_receipt)


def resume(guard_receipt):
    return _unavailable(guard_receipt)


def publication_adjacent(guard_receipt):
    return _unavailable(guard_receipt)


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ContractError()
        result[key] = value
    return result


def main():
    """One bounded stdin JSON {request, now_ms}; no configurable adapters or paths."""
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ContractError()
        value = json.loads(raw, object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ContractError()))
        fields(value, {"request", "now_ms"})
        receipt = launch_guard(value["request"], value["now_ms"])
        print(canonical(receipt))
        return 0 if receipt["data"]["result"] == "PASS" else 2
    except (ContractError, ValueError, TypeError, RecursionError) as error:
        code = error.code if isinstance(error, ContractError) else "GUARD_INPUT_INVALID"
        print(canonical({"schema_version": 1, "code": code, "result": "REFUSE"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
