"""Serialized private channel -> accepted ledger adapter. No server/PTY/install.

Constructor ports are trusted composition inputs. No field on this channel can
select a callback, native observer, directory, consumer or command. The channel
must already have passed the independent native two-phase process admission.
"""
import copy
import json
import math
import select
import socket
import struct
import threading
import time
import uuid
if __package__:
    from . import human_shell_capabilities as capabilities
    from . import human_terminal_protocol as protocol
    from .owner_terminal_channel import Handoff
else:
    import human_shell_capabilities as capabilities
    import human_terminal_protocol as protocol
    from owner_terminal_channel import Handoff

MAX_FRAME = 8192
MAX_OPERATIONS = 1024
MAX_CHECKS = 64


class Refusal(ValueError):
    pass


class Unconfirmed(Refusal):
    pass


def need(ok, code):
    if not ok:
        raise Refusal(code)


def encoded(value):
    raw = json.dumps(value, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()
    need(0 < len(raw) <= MAX_FRAME, 'FRAME_BOUND')
    return raw


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'CLOSED_FRAME')


class FramedChannel:
    def __init__(self, channel):
        need(isinstance(channel, Handoff) and channel.state == 'CONNECTED', 'NATIVE_CHANNEL_REQUIRED')
        self.channel = channel
        self.failed = False
        self.deadline = time.monotonic() + 5

    def close(self):
        self.failed = True
        self.channel.close()

    def guard(self):
        need(not self.failed and self.channel.state == 'CONNECTED', 'CHANNEL_ENDED')
        need(time.monotonic() < self.deadline, 'CHANNEL_DEADLINE')
        need(not select.select([self.channel.pidfd], [], [], 0)[0], 'BACKEND_ENDED')
        self.channel.website.assert_process(self.channel.credentials, 'node')
        need(time.monotonic() < self.deadline, 'CHANNEL_DEADLINE')

    def send(self, value):
        raw = encoded(value)
        try:
            self.guard()
            self.channel.node.settimeout(min(2, self.deadline - time.monotonic()))
            self.channel.node.sendall(struct.pack('!I', len(raw)) + raw)
            self.guard()
        except BaseException:
            self.close()
            raise

    def read(self):
        def take(count):
            result = bytearray()
            while len(result) < count:
                self.guard()
                self.channel.node.settimeout(min(2, self.deadline - time.monotonic()))
                result.extend(self.channel.read(min(MAX_FRAME, count - len(result))))
                self.guard()
            return bytes(result)
        try:
            size = struct.unpack('!I', take(4))[0]
            need(0 < size <= MAX_FRAME, 'FRAME_BOUND')
            raw = take(size)
            value = protocol.decode(raw)  # Existing duplicate/depth/integer bounds.
            need(encoded(value) == raw, 'NONCANONICAL_FRAME')
            return value
        except BaseException:
            self.close()
            raise


class LedgerService:
    """One host event-loop thread. No background reader or implicit retry.

    Native observer.observe(EID) and protected consumer verifier are required
    fixed ports, not metadata sent by Node. Missing native target refuses before
    opening the ledger. No broker-consume command exists on the owner channel.
    """
    def __init__(self, channel, directory, *, native_target=None, consumer_verifier=None, terminal=None):
        need(callable(getattr(native_target, 'observe', None)), 'NATIVE_TARGET_UNAVAILABLE')
        self.wire = FramedChannel(channel)
        self.observe = native_target.observe
        self.thread = threading.get_ident()
        self.active = None
        self.seen = set()
        self.next_sequence = 1
        self.registrations = {}  # reference -> private context handle and EID.
        self.__issued = {}  # Private memory only: no status/log/JSON exposure.
        self.ledger = capabilities.CapabilityLedger(directory, issuer=self, peer_verifier=consumer_verifier)
        self.terminal = terminal

    def close(self):
        settled = True
        if self.terminal is not None:
            settled = self.terminal.close()  # Unknown cleanup retains its durable intent.
        self.wire.close()
        self.registrations.clear()
        self.__issued.clear()
        self.ledger.close()
        return settled

    def _begin(self, binding):
        need(threading.get_ident() == self.thread and self.active is None, 'SERIAL_LOOP_REQUIRED')
        self.wire.deadline = time.monotonic() + 5
        self.wire.guard()
        self.active = {**binding, 'checks': 0, 'scope': None, 'target': None, 'expires': None, 'native': None}

    def _authority(self):
        need(self.active is not None, 'ACTIVE_OWNER_OPERATION_REQUIRED')
        op = self.active
        op['checks'] += 1
        need(op['checks'] <= MAX_CHECKS, 'AUTHORITY_CHECK_BOUND')
        challenge = str(uuid.uuid4())
        request = {'kind': 'authority-check', 'n': op['n'], 'operationId': op['operationId'],
                   'handle': op['handle'], 'challenge': challenge}
        self.wire.send(request)
        answer = self.wire.read()
        common = {'kind', 'n', 'operationId', 'handle', 'challenge'}
        if type(answer) is dict and answer.get('kind') == 'authority-refused':
            exact(answer, common)
            need(all(answer[k] == request[k] for k in common - {'kind'}), 'AUTHORITY_RESPONSE_BINDING')
            raise Refusal('CURRENT_OWNER_UNAVAILABLE')
        exact(answer, common | {'scopeDigest', 'expiresAtEpochMs', 'target'})
        need(answer['kind'] == 'authority' and all(answer[k] == request[k] for k in common - {'kind'}), 'AUTHORITY_RESPONSE_BINDING')
        capabilities.hex64(answer['scopeDigest'])
        expires = answer['expiresAtEpochMs']
        need(type(expires) is int and 0 < expires - int(time.time() * 1000) <= 3600000, 'OWNER_SCOPE_EXPIRED')
        current = self.observe(op['employeeId'])
        protocol.exact(current, protocol.CURRENT_KEYS)
        protocol.identities(current)
        need(current['employeeId'] == op['employeeId'], 'NATIVE_EMPLOYEE_DRIFT')
        # Compare the entire independently produced incarnation/state, not a
        # claimed owner bool or a wire digest as an authorization credential.
        need(protocol.canonical(current) == protocol.canonical(answer['target']), 'NATIVE_TARGET_DRIFT')
        need(current['running'] is True and current['desiredRunning'] is True
             and current['onVacation'] is False and current['humanTerminalEntitled'] is True, 'NATIVE_TARGET_UNAVAILABLE')
        if self.terminal is not None:
            native = self.terminal.capture_target(op['employeeId'])
            exact(native, {'target', 'binding'})
            need(protocol.canonical(native['target']) == protocol.canonical(current)
                 and type(native['binding']) is dict and native['binding']
                 and len(protocol.canonical(native)) <= MAX_FRAME, 'H_NATIVE_TARGET_CHANGED')
            expected = self.__issued.get(op.get('reference'), {}).get('native', op['native'])
            if expected is not None:
                need(protocol.canonical(expected) == protocol.canonical(native), 'H_NATIVE_INCARNATION_CHANGED')
            op['native'] = copy.deepcopy(native)
        if op['scope'] is not None:
            need(op['scope'] == answer['scopeDigest'] and op['expires'] == expires
                 and protocol.canonical(op['target']) == protocol.canonical(current), 'OWNER_SCOPE_OR_TARGET_DRIFT')
        op.update(scope=answer['scopeDigest'], expires=expires, target=copy.deepcopy(current))
        self.wire.guard()
        return op

    def assert_current_owner_same_origin(self):
        return self._authority()['scope']

    def canonical_target(self):
        return copy.deepcopy(self._authority()['target'])

    def serve_once(self):
        """A fixed owner command only. Never executes a hook, model or shell."""
        try:
            return self._serve_once()
        except BaseException:
            self.close()
            raise

    def _serve_once(self):
        need(self.active is None and threading.get_ident() == self.thread, 'SERIAL_LOOP_REQUIRED')
        self.wire.deadline = time.monotonic() + 5
        command = self.wire.read()
        common = {'kind', 'n', 'operationId', 'action', 'handle', 'employeeId'}
        action = command.get('action') if type(command) is dict else None
        terminal_action = action in ('open', 'input', 'resize', 'poll', 'end')
        exact(command, common | ({'cols', 'rows', 'lifetimeSeconds'} if action == 'issue' else
                                 {'reference', 'payload'} if terminal_action else {'reference'}))
        need(command['kind'] == 'command' and action in ('issue', 'status', 'revoke', 'open', 'input', 'resize', 'poll', 'end'), 'FIXED_OPERATION_REQUIRED')
        need(type(command['n']) is int and command['n'] == self.next_sequence <= MAX_OPERATIONS, 'SEQUENCE_OR_REPLAY')
        for key in ('operationId', 'handle', 'employeeId'):
            need(type(command[key]) is str and protocol.UUID.fullmatch(command[key]), 'SERVER_REFERENCE')
        need(command['operationId'] not in self.seen, 'OPERATION_REPLAY')
        self.seen.add(command['operationId']); self.next_sequence += 1
        self._begin(command)
        state, result, committed_return = 'ok', None, False
        try:
            if action == 'issue':
                self._authority()
                seconds = command['lifetimeSeconds']
                need(type(seconds) is int and 1 <= seconds <= protocol.MAX_LIFETIME, 'LIFETIME_BOUND')
                # Leave the entire remaining operation budget before scope expiry;
                # ledger.issue performs its own fresh owner checks before clocking
                # the capability. Never extend the backend's absolute scope.
                seconds = min(seconds, (self.active['expires'] - int(time.time() * 1000)) // 1000 - 5)
                need(seconds > 0, 'OWNER_SCOPE_EXPIRED')
                result = self.ledger.issue(cols=command['cols'], rows=command['rows'], lifetime_seconds=seconds)
                committed_return = True
                self.registrations[result['request']['authorizationRef']] = (command['handle'], command['employeeId'])
                self.__issued[result['request']['authorizationRef']] = copy.deepcopy(result)
                if self.terminal is not None:
                    self.__issued[result['request']['authorizationRef']]['native'] = copy.deepcopy(self.active['native'])
            else:
                need(self.registrations.get(command['reference']) == (command['handle'], command['employeeId']), 'REFERENCE_CONTEXT_DRIFT')
                if terminal_action:
                    need(self.terminal is not None, 'INSTALLED_H_UNAVAILABLE')
                    private = self.__issued[command['reference']]
                    shim = capabilities.LedgerCapability(self.ledger, private['proof'], self.terminal.digest)
                    # Existing sessions retain their original consumed shim.
                    # This wrapper is used only for open's single consume.
                    class ActiveCapability:
                        request = copy.deepcopy(private['request'])
                        def consume(self, value): return shim.consume(value)
                        def recheck(self, value): return shim.recheck(value)
                    self._authority()
                    # Once handed to H, any exception may follow a durable
                    # consume or process launch; never label it effect-free.
                    committed_return = True
                    result = self.terminal.handle(action, ActiveCapability(), self.observe(command['employeeId']), command['payload'])
                else:
                    result = self.ledger.status(command['reference']) if action == 'status' else self.ledger.revoke(command['reference'])
                    committed_return = action == 'revoke'
            self._authority()
        except capabilities.CommitUncertain:
            state = 'unconfirmed'
        except (Refusal, capabilities.Refusal, protocol.Refusal):
            state = 'unconfirmed' if committed_return else 'refused'
        except BaseException:
            self.active = None
            self.close()
            raise Unconfirmed('OWNER_LEDGER_OPERATION_UNCONFIRMED') from None
        try:
            self.wire.send({'kind': 'result', 'n': command['n'], 'operationId': command['operationId'], 'state': state, 'value': result if state == 'ok' else None})
        except BaseException:
            self.close()
            raise Unconfirmed('OWNER_LEDGER_RESPONSE_UNCONFIRMED_NO_RETRY') from None
        finally:
            self.active = None
        if state == 'unconfirmed':
            self.close()
        return state

    def for_consumer(self, reference, consumer_digest):
        """Trusted future H-actor port only; never a Node/browser command.

        The caller must schedule this and subsequent operations on THIS serialized
        event-loop, with no concurrent serve_once reader. Consumer peer verifier
        remains mandatory in the unchanged ledger; no digest from wire suffices.
        """
        need(reference in self.registrations, 'REFERENCE_UNAVAILABLE')
        handle, employee = self.registrations[reference]
        service = self
        private = self.__issued[reference]
        request, proof = private['request'], private['proof']
        shim = capabilities.LedgerCapability(self.ledger, proof, consumer_digest)
        class Consumer:
            failed = False
            @property
            def request(self):
                return copy.deepcopy(request)
            def _call(self, method, current_request):
                need(not self.failed, 'CONSUMER_UNCONFIRMED_NO_RETRY')
                owned_operation = None
                try:
                    need(protocol.canonical(current_request) == protocol.canonical(request), 'CONSUMER_REQUEST_DRIFT')
                    service._begin({'n': 0, 'operationId': str(uuid.uuid4()), 'handle': handle, 'employeeId': employee,
                                    'reference': reference})
                    owned_operation = service.active
                    getattr(shim, method)(current_request)
                except BaseException:
                    self.failed = True
                    raise
                finally:
                    # A refused overlapping/wrong-thread call never acquired the
                    # active operation and must not clear another caller's guard.
                    if owned_operation is not None and service.active is owned_operation:
                        service.active = None
            def consume(self, value): self._call('consume', value)
            def recheck(self, value): self._call('recheck', value)
        return Consumer()
