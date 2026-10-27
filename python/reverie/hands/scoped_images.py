"""Read a laptop image through the ordinary membership-checked chat CLI."""
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile

UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z')
SCRATCH_TEMP = Path('/scratch/tmp')


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def fetch(cli, session, room, attachment, max_bytes, timeout):
    # The laptop relay fixes the caller's identity. Never substitute an attachment
    # path/URL, another session, an owner credential, or a shared-drive fallback.
    if (os.environ.get('REVERIE_WORKER') != '1' or os.environ.get('REVERIE_SESSION_ID') != session or
            not isinstance(session, str) or not UUID.fullmatch(session) or
            not isinstance(room, str) or not UUID.fullmatch(room) or
            not isinstance(attachment, str) or not UUID.fullmatch(attachment)):
        raise ValueError('image has no exact scoped room/file identity')
    if type(max_bytes) is not int or not 1 <= max_bytes <= 64 * 1024**2:
        raise ValueError('invalid image byte ceiling')
    if not isinstance(cli, (list, tuple)) or not cli or any(not isinstance(part, str) or not part for part in cli):
        raise ValueError('invalid scoped chat command')
    if type(timeout) not in (int, float) or not 0 < timeout <= 120:
        raise ValueError('invalid image deadline')
    timeout = min(timeout, 10)
    SCRATCH_TEMP.mkdir(mode=0o700, exist_ok=True)
    info = SCRATCH_TEMP.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or SCRATCH_TEMP.resolve() != SCRATCH_TEMP:
        raise ValueError('private image scratch directory unavailable')
    with tempfile.TemporaryDirectory(prefix='reverie-image-', dir=SCRATCH_TEMP) as temporary:
        # CLI bounds both the network body and deadline, refuses redirects, and
        # creates only this new basename with O_EXCL/O_NOFOLLOW and mode0600.
        command = list(cli) + ['fetch', room, attachment, '--output', 'image.bin',
            '--max-bytes', str(max_bytes), '--timeout', str(max(1, int(timeout * 1000))), '--json']
        process = subprocess.Popen(command, cwd=temporary, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
            raise ValueError('scoped image download timed out') from None
        if code != 0:
            raise ValueError('scoped image download refused')
        fd = os.open(Path(temporary) / 'image.bin', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or
                    stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > max_bytes):
                raise ValueError('invalid scoped image output')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                data = stream.read(max_bytes + 1)
            if len(data) > max_bytes or len(data) != before.st_size or stamp(os.fstat(fd)) != stamp(before):
                raise ValueError('scoped image output changed or exceeded its limit')
            return data
        finally:
            os.close(fd)
