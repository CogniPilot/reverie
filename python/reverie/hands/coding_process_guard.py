import ctypes
import os
import signal
import sys


def protect(parent_pid):
    library = ctypes.CDLL(None, use_errno=True)
    if library.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'parent-death protection unavailable')
    if os.getppid() != parent_pid:
        os._exit(1)


if __name__ == '__main__':
    protect(int(sys.argv[1]))
    os.execv(sys.argv[2], sys.argv[2:])
