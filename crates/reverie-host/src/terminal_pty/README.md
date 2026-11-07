# Owned terminal resource

`OwnedPty` is a Linux file-descriptor resource owner, not permission to attach to
a laptop, start an engine command, signal a process or release storage. The real
InstallingBroker viewer caller and its lifecycle-selected context remain required.
No engine executable, arguments, PID, path or authority callback is exposed here.
The complete viewer registry, transport, receipt/exit drain and stop integration
is still required work.

Master creation sets CLOEXEC, NOCTTY and NONBLOCK in the actual open. The peer
is obtained from that live master by TIOCGPTPEER with CLOEXEC and NOCTTY, remaining
blocking for the fixed child stdio consumer. No slave pathname or open→fcntl
inheritance window is used. This requires Linux's TIOCGPTPEER support; it fails
rather than introducing another lookup/fallback path. Borrowed descriptors follow
normal Rust ownership rules and do not carry an admission capability.

Preparation preserves source order: grant/unlock, own peer, apply Python3.13
`tty.setraw` via TCSAFLUSH, then set checked Core TerminalSize. libc `cfmakeraw`
does not clear every flag that this frozen source clears, so the narrow policy
uses those explicit source flags. Three actual Python owned-PTY vectors cover
default, full POSIX input/local flags and software flow control. Byte I/O is opaque,
limited to 64 KiB per syscall, and resizing sets rows/columns with zero pixel fields.
Master EIO is exposed as I/O error; the private viewer transport owns its source
EOF/error mapping. Resize preserves the kernel's normal SIGWINCH delivery to the
terminal's foreground process group. This primitive makes no explicit PID/group
signal call and does not establish a child identity.

Every fallible preparation step retains its descriptor owners before proceeding.
Preparation failure attempts both checked closes and preserves the primary error
plus both close failures. A failed slave close consumes that descriptor once and
latches uncertainty; neither a repeated close_slave call nor later successful
master cleanup can erase it. No close is retried on a possibly reused number.
Drop remains best effort: only consuming checked close confirms resource cleanup,
and that result is never a process/session cleanup receipt. Tests inject errors
only after the real close; master EIO confirms the slave really closed first.
No hard kernel/device-latency guarantee is made.

The ioctl unsafe boundary is isolated in native.rs and needs independent review.
Tests use only newly owned PTYs and synthetic data; they invoke no engine, instance
service, laptop, mounted account or private runtime file.
