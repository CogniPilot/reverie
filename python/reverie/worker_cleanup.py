"""Bounded owned-client cleanup; never a provider identity or authority source."""
import os
import selectors
import signal
import subprocess
import time
import threading

UNIT_STOP_SECONDS = 35
RETURN_MARGIN_SECONDS = 1
STOP_SECONDS = UNIT_STOP_SECONDS - RETURN_MARGIN_SECONDS
POLL_SECONDS = .01
ENGINE_OUTPUT_BYTES = 4 * 1024 * 1024
CLEANUP_CODES = frozenset({'VIEWER_UNREAPED', 'VIEWER_START_PENDING', 'ENGINE_CLIENT_UNREAPED',
    'OFFICE_HANDLER_ACTIVE', 'OFFICE_CLOSE_FAILED', 'LOCK_UNAVAILABLE', 'SUPERVISOR_ACTIVE',
    'HANDLER_ACTIVE', 'DEADLINE_EXHAUSTED', 'PROVIDER_CLEANUP_UNCONFIRMED', 'CLEANUP_ERROR',
    # Goal-on-3be composition: 3be's storage leases carried into the fixed diagnostic vocabulary.
    'CHAT_IMAGE_CLEANUP_UNCONFIRMED',
    'STORAGE_RELEASE_UNCONFIRMED', 'STORAGE_LOCK_UNAVAILABLE', 'LEASE_PEER_ACTIVE',
    'RESOURCE_ADMISSION_RELEASE_UNCONFIRMED'})


class CleanupUnconfirmed(RuntimeError):
    def __init__(self, codes):
        # Never silently erase the only reason an operation remains failed.
        # Unknown details still stay private; they are not a successful cleanup.
        self.codes = tuple(sorted(set(codes) & CLEANUP_CODES)) or ('CLEANUP_ERROR',)
        super().__init__('Broker cleanup unconfirmed: ' + ','.join(self.codes))

    def report(self):
        # Fixed bounded metadata only. Never block behind a full stderr pipe.
        data = ('Broker cleanup unconfirmed: ' + ','.join(self.codes) + '\n').encode()
        try:
            blocking = os.get_blocking(2)
            try:
                os.set_blocking(2, False)
                os.write(2, data)
            finally:
                os.set_blocking(2, blocking)
        except OSError:
            pass


class StopBudget:
    """One first-stop budget, including signals while another cleanup is running.

    Append before publishing the Event. Concurrent first callers can only shorten
    the deadline: taking the minimum never replaces an earlier start with a later
    one. No signal handler acquires a lock another interrupted thread might own.
    """
    def __init__(self):
        self._starts = []
        self._set = False

    def set(self):
        if not self._starts:
            self._starts.append(time.monotonic())
        self._set = True

    def is_set(self):
        return self._set

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while not self._set and remaining(deadline):
            time.sleep(min(.05, remaining(deadline)))
        return self._set

    @property
    def deadline(self):
        return min(self._starts) + STOP_SECONDS if self._starts else None


def remaining(deadline, stop=None):
    shared = stop.deadline if stop is not None else None
    if shared is not None:
        deadline = min(deadline, shared)
    return max(0., deadline - time.monotonic())


def wait_poll(child, deadline, stop=None):
    """Popen.poll uses waitpid(WNOHANG); no wait()/context-manager fallback."""
    while child.poll() is None:
        left = remaining(deadline, stop)
        if not left:
            return False
        time.sleep(min(POLL_SECONDS, left))
    return True


def reap_viewer(child, stop, uncertain):
    """Only the Popen engine attach CLIENT in its own start_new_session group."""
    deadline = time.monotonic() + 5
    try:
        if child.poll() is None:
            child.terminate()
        if not wait_poll(child, deadline, stop):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # Existing grace stays5s; only formerly unbounded post-kill reaping
            # gets a100ms ceiling, still clamped to the global stop budget.
            if not wait_poll(child, time.monotonic() + .1, stop):
                uncertain.add('VIEWER_UNREAPED')
                return False
        return True
    except OSError:
        uncertain.add('VIEWER_UNREAPED')
        return False


# The command timeout remains unknown to its caller. Terminal cleanup may only
# settle the separate owned-client fact through the exact retained Popen record.
_CLIENT_STATE_LOCK = threading.Lock()


def _client_state_acquire(owner, deadline):
    left = remaining(deadline, owner.stopping)
    held = (_CLIENT_STATE_LOCK.acquire(timeout=left) if left else
            _CLIENT_STATE_LOCK.acquire(blocking=False))
    if not held:
        # Monotonic opaque fact, published before the marker. Never reconcile a
        # bookkeeping operation that could not obtain its original budget.
        owner._engine_client_uncertainty_opaque = True
        owner.cleanup_uncertain.update({'LOCK_UNAVAILABLE', 'ENGINE_CLIENT_UNREAPED'})
    return held


def _client_unreaped(owner, token, child, deadline):
    if not _client_state_acquire(owner, deadline):
        return
    try:
        state = getattr(owner, '_engine_client_uncertainty', None)
        if state is None:
            state = {'clients': {}, 'opaque': 'ENGINE_CLIENT_UNREAPED' in owner.cleanup_uncertain}
            owner._engine_client_uncertainty = state
        state['clients'][token] = child
        owner.cleanup_uncertain.add('ENGINE_CLIENT_UNREAPED')
    finally:
        _CLIENT_STATE_LOCK.release()


def settle_owned_clients(owner, deadline):
    """Final shutdown proof for exact owned clients, under the existing budget.

    No command retry, signal, fresh grace or arbitrary PID lookup. A pending
    constructor is still owned; wait for its publication/removal only until the
    shared deadline. Untracked diagnostics and every other cleanup code remain.
    """
    missing = object()
    for token in tuple(owner.owned_clients):
        child = owner.owned_clients.get(token, missing)
        while child is None and remaining(deadline, owner.stopping):
            time.sleep(min(POLL_SECONDS, remaining(deadline, owner.stopping)))
            child = owner.owned_clients.get(token, missing)
        if child is missing:
            continue
        if child is not None and wait_poll(child, deadline, owner.stopping):
            if owner.owned_clients.get(token) is child:
                owner.owned_clients.pop(token, None)
        else:
            _client_unreaped(owner, token, child, deadline)
    if not _client_state_acquire(owner, deadline):
        return
    try:
        state = getattr(owner, '_engine_client_uncertainty', None)
        if state is None:
            return
        for token, child in tuple(state['clients'].items()):
            current = owner.owned_clients.get(token, missing)
            if child is None:
                if current is missing:
                    # run_client removed its placeholder only after failed
                    # construction or actual child reaping.
                    state['clients'].pop(token)
                    continue
                child = current
            if child is not None and child.poll() is not None:
                state['clients'].pop(token)
                if current is child:
                    owner.owned_clients.pop(token, None)
        if (not state['clients'] and not owner.owned_clients and not state['opaque'] and
                not getattr(owner, '_engine_client_uncertainty_opaque', False)):
            owner.cleanup_uncertain.discard('ENGINE_CLIENT_UNREAPED')
            # A contending producer cannot take this lock to publish its failure.
            # Recheck the monotonic opaque flag after discard so a late failed
            # acquisition can never lose its separately published marker.
            if getattr(owner, '_engine_client_uncertainty_opaque', False):
                owner.cleanup_uncertain.add('ENGINE_CLIENT_UNREAPED')
    finally:
        _CLIENT_STATE_LOCK.release()


def run_client(command, *, timeout, owner, limit=ENGINE_OUTPUT_BYTES, stderr=True):
    """Exact argv, bounded two-pipe output, nonblocking reads and explicit reap.

    Timeout remains TimeoutExpired. Never uses subprocess.run/communicate, Popen
    __exit__, or an unbounded post-kill wait. Retained Popen records distinguish
    unconfirmed reaping from completion; no kernel D-state guarantee is made.
    """
    deadline = time.monotonic() + timeout
    token = object()
    owner.owned_clients[token] = None  # A blocked process creation is outstanding.
    child = None
    streams = []
    try:
        if not remaining(deadline, owner.stopping):
            raise subprocess.TimeoutExpired(command, timeout)
        child = subprocess.Popen(command, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE if stderr else subprocess.DEVNULL)
        # Own both pipes before selector allocation/registration can fail.
        streams = (child.stdout, child.stderr)
        owner.owned_clients[token] = child
        output = [bytearray(), bytearray()]
        with selectors.DefaultSelector() as selector:
            for index, stream in enumerate((child.stdout, child.stderr)):
                if stream is not None:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, index)
            while selector.get_map() or child.poll() is None:
                left = remaining(deadline, owner.stopping)
                if not left:
                    raise subprocess.TimeoutExpired(command, timeout)
                if not selector.get_map():
                    time.sleep(min(POLL_SECONDS, left))
                    continue
                for key, _ in selector.select(min(.05, left)):
                    try:
                        chunk = os.read(key.fileobj.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output[key.data].extend(chunk)
                        if sum(map(len, output)) > limit:
                            raise RuntimeError('Worker engine output exceeds bound')
        return subprocess.CompletedProcess(command, child.returncode,
                                           output[0].decode(), output[1].decode())
    finally:
        try:
            if child is not None:
                if child.poll() is None:
                    try:
                        child.kill()
                    except ProcessLookupError:
                        pass
                    except OSError:
                        _client_unreaped(owner, token, child, deadline)
                    # An exhausted deadline gets WNOHANG, not a fresh grace.
                    if not wait_poll(child, deadline, owner.stopping):
                        _client_unreaped(owner, token, child, deadline)
                if child.poll() is not None:
                    owner.owned_clients.pop(token, None)
            else:
                owner.owned_clients.pop(token, None)
        finally:
            for stream in streams:
                if stream is None:
                    continue
                try: stream.close()
                except OSError: owner.cleanup_uncertain.add('CLEANUP_ERROR')
