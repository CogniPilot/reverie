"""One scoped, metadata-only long-poll listener; it never reads chat or calls a model.

The main thread alone consumes wake signals and uses its existing durable message
claims. A missed signal/reconnection gap is covered by the normal room scan.
"""
from collections import deque
import http.client
import json
import os
import re
import socket
import threading
import time
import urllib.parse


class AttentionWake:
    def __init__(self, cfg, report=lambda text: None, *, env=None, connection=http.client.HTTPConnection):
        self.signal = threading.Event()
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.thread = self.connection = None
        self.factory = connection
        self.report = report
        self.status = 'disabled'
        self.host = None
        self.seen = set()
        self.order = deque()
        env = os.environ if env is None else env
        if not cfg.get('phone_wake'):
            return
        session = cfg.get('self_session_id', '')
        try:
            endpoint = urllib.parse.urlsplit(env.get('REVERIE_API_URL', ''))
            valid = (env.get('REVERIE_WORKER') == '1' and endpoint.scheme == 'http' and
                     endpoint.hostname == '127.0.0.1' and endpoint.port and
                     not endpoint.username and not endpoint.password and endpoint.path in ('', '/') and
                     not endpoint.query and not endpoint.fragment and
                     env.get('REVERIE_SESSION_ID') == session and
                     re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', session))
        except ValueError:
            valid = False
        if valid:
            self.host, self.port, self.session = endpoint.hostname, endpoint.port, session
            self.status = 'connecting'
        else:
            self.status = 'unavailable (no scoped laptop phone)'

    def start(self):
        if self.host and self.thread is None:
            self.thread = threading.Thread(target=self._run, name='hands-phone-wake', daemon=True)
            self.thread.start()
        return self

    def _status(self, status):
        if status != self.status:
            self.status = status
            self.report('Phone wake: ' + status + '; general messages use the normal scan.')

    def _poll(self):
        connection = self.factory(self.host, self.port, timeout=32)
        with self.lock:
            if self.stopped.is_set():
                connection.close()
                return
            self.connection = connection
        try:
            connection.request('GET', '/api/chatrooms/attention', headers={
                'X-Reverie-Parent-Session': self.session, 'Accept': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError('attention unavailable')
            raw = response.read(4097)
            if len(raw) > 4096:
                raise ValueError('oversized attention response')
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get('success') is not True or not isinstance(data.get('data'), dict):
                raise ValueError('invalid attention response')
            event = data['data'].get('event')
            if event is not None:
                if (not isinstance(event, dict) or set(event) != {'roomId', 'messageId'} or
                        any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', value)
                            for value in event.values())):
                    raise ValueError('invalid attention metadata')
                key = (event['roomId'], event['messageId'])
                if key not in self.seen:
                    self.seen.add(key)
                    self.order.append(key)
                    if len(self.order) > 500:
                        self.seen.remove(self.order.popleft())
                    self.signal.set()
            self._status('active')
        finally:
            with self.lock:
                if self.connection is connection:
                    self.connection = None
            connection.close()

    def _run(self):
        delay = 1
        while not self.stopped.is_set():
            try:
                self._poll()
                delay = 1
                self.stopped.wait(0.1)  # Bound reconnect rate even during a burst of notifications.
            except (OSError, ValueError, http.client.HTTPException):
                if self.stopped.is_set():
                    break
                self._status('unavailable; polling fallback')
                self.stopped.wait(delay)
                delay = min(30, delay * 2)

    def close(self):
        self.stopped.set()
        with self.lock:
            if self.connection:
                try:
                    if self.connection.sock:
                        self.connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
        if self.thread:
            self.thread.join(2)


def wait_for_scan(seconds, wake, view, manager=None):
    """Accepted phone traffic wakes the serial loop; UI and coding work remain responsive."""
    until = time.monotonic() + seconds
    while time.monotonic() < until and not view.quit_requested:
        if not view.inputs.empty() or wake.signal.is_set():
            break
        if manager and manager.active:
            manager.pump()
        wake.signal.wait(min(0.05, max(0, until - time.monotonic())))
