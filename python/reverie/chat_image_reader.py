"""Image bytes through an existing laptop's normal identity-fixed Office socket.

No credentials, server filesystem paths, arbitrary URLs, new sockets or provider
input are created. The owning broker supplies the already-bound socket path.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import time

from .chat_image_paths import ImagePathRefused, UUID, image_extension

MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp'}


class _OfficeConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        try:
            connection.connect(str(self.path))
        except BaseException:
            connection.close()
            raise
        self.sock = connection
        self.deadline_socket = connection


class OfficeImageReader:
    def __init__(self, path, session_id, *, connect=_OfficeConnection, clock=time.monotonic):
        self.path = Path(path)
        if (not self.path.is_absolute() or '..' in self.path.parts or
                type(session_id) is not str or not UUID.fullmatch(session_id)):
            raise ImagePathRefused('invalid_identity')
        self.session_id, self.connect, self.clock = session_id, connect, clock

    def _socket_identity(self):
        # A configured socket may be unavailable. Never create/repair it, follow
        # a link or substitute the website's owner credentials/another office.
        try:
            info = self.path.lstat()
            if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or self.path.resolve(strict=True) != self.path):
                raise ImagePathRefused('office_unavailable')
            return info.st_dev, info.st_ino
        except OSError:
            raise ImagePathRefused('office_unavailable') from None

    def _read(self, endpoint, ceiling, deadline):
        left = deadline - self.clock()
        if left <= 0:
            raise ImagePathRefused('timeout')
        identity = self._socket_identity()
        connection = self.connect(self.path, min(left, 5))
        try:
            connection.request('GET', endpoint, headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
            response = connection.getresponse()
            headers = {}
            for name, value in response.getheaders():
                headers.setdefault(name.lower(), []).append(value)
            lengths = headers.get('content-length', [])
            if (response.status != 200 or len(lengths) != 1 or not lengths[0].isascii()
                    or not lengths[0].isdigit() or int(lengths[0]) > ceiling
                    or headers.get('content-encoding', ['identity']) != ['identity']
                    or 'transfer-encoding' in headers):
                raise ImagePathRefused('access_or_body_refused')
            expected = int(lengths[0])
            chunks = []
            size = 0
            while True:
                left = deadline - self.clock()
                if left <= 0:
                    raise ImagePathRefused('timeout')
                # read1 does at most one socket read, so a slow stream cannot
                # renew the total deadline with a sequence of tiny reads.
                transport = getattr(connection, 'deadline_socket', connection.sock)
                if transport is not None:
                    transport.settimeout(min(left, 5))
                chunk = response.read1(min(65536, ceiling + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > ceiling:
                    raise ImagePathRefused('body_limit')
                chunks.append(chunk)
            if size != expected or self._socket_identity() != identity:
                raise ImagePathRefused('body_or_binding_changed')
            return b''.join(chunks), headers
        except ImagePathRefused:
            raise
        except Exception:
            raise ImagePathRefused('office_unavailable') from None
        finally:
            connection.close()

    def _message(self, scope, file_id, deadline):
        raw, _ = self._read(f"/api/v1/chatrooms/{scope['roomId']}/messages/{scope['messageId']}",
                            1024 * 1024, deadline)
        try:
            result = json.loads(raw)
            message = result['data']['message']
            if (result.get('success') is not True or type(message) is not dict
                    or message.get('id') != scope['messageId'] or message.get('deleted')
                    or type(message.get('attachments')) is not list):
                raise ValueError
            files = [item for item in message['attachments'] if type(item) is dict and item.get('id') == file_id]
            if len(files) != 1 or files[0].get('type') not in MIME.values():
                raise ValueError
            return files[0]['type']
        except (ValueError, TypeError, KeyError):
            raise ImagePathRefused('message_or_file_refused') from None

    def fetch(self, scope, file_id, max_bytes):
        if (scope.get('sessionId') != self.session_id or file_id not in scope.get('fileIds', ())
                or any(type(scope.get(key)) is not str or not UUID.fullmatch(scope[key])
                       for key in ('sessionId', 'roomId', 'messageId'))
                or type(file_id) is not str or not UUID.fullmatch(file_id)
                or type(max_bytes) is not int or not 1 <= max_bytes <= 8 * 1024 * 1024):
            raise ImagePathRefused('invalid_identity')
        deadline = self.clock() + 10
        content_type = self._message(scope, file_id, deadline)
        raw, headers = self._read(f"/api/v1/chatrooms/{scope['roomId']}/files/{file_id}", max_bytes, deadline)
        # No redirect following or fallback to a body/path from message metadata.
        if headers.get('content-type') != [content_type] or MIME[image_extension(raw)] != content_type:
            raise ImagePathRefused('unsupported_image')
        # Reauthorize after the byte transfer, also refusing deletion/revocation
        # and a changed exact message/file pair before local publication.
        if self._message(scope, file_id, deadline) != content_type:
            raise ImagePathRefused('message_or_file_refused')
        return raw
