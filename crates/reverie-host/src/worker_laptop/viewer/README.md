# Fixed native viewer session

This Host owner implements the PTY attach-client constructor and finalizer from
`worker.py` after the real pane and original Nix-guard finalization. It requires
the same record's `NixReleasedPane`. The actual App continuation must still
perform its protected CLI-start publication, admission close and canonical
release before calling it. This token supplies neither authorization nor proof
that those App operations occurred. Recovered/reused panes have no constructor
here; their genuine owner must be joined separately.

The existing bounded laptop record owns the concrete viewer Job before thread
creation, PTY open or native spawn. The shared captured client admits that exact
Job under its existing single active mutex as `ViewerConstructor`, alongside
the existing `Query` variant. Pending constructors block queries with Busy;
they do not cancel them. Successful handoff requires joined constructor
completion, checked descriptor finalizers, the same Arc and an open context
under that mutex. The long viewer then belongs to the laptop inventory and
metadata queries can proceed. Old query/viewer settlement cannot clear or
cancel another current variant. Explicit common close inventories pending
constructors; Runtime also inventories the actual viewer after handoff.

The Job retains the service's original command snapshot, derived worker name,
terminal size and fresh sixteen-byte marker. Its fixed attach recipe shares
the original locale/tmux argument owner and matches unchanged Python vectors.
There is no caller program, argv, PID, path or environment constructor. PTY
stdio uses a CLOEXEC duplicate above fd 2. The child performs only setsid,
the existing private pidfd handoff, fixed dup2/checked close, then exact exec.
The parent checks both its duplicate and original slave finalization.

TERM and WINCH target the transferred pidfd. Status uses WNOWAIT until the final
group-signal/reap decision; Python signal status is negative. Group KILL uses
only the actual session leader's `Child.id`, while that leader remains
unreaped. This preserves the existing pidfd/waitid kernel baseline without a
silent requirement for newer process-group pidfd flags. The fixed service must
own child reaping: default SIGCHLD, no SA_NOCLDWAIT and no foreign wait-any
reaper. Constructor and group boundaries check disposition; WNOWAIT/ECHILD
checks refuse lost ownership. These checks do not exclude a foreign component
changing policy or reaping concurrently. Adding such a component requires a
different shared ownership protocol. Current production Host/Application has
no SIGCHLD installer or wait-any reaper; isolated test fixtures are separate.

Cleanup retains TERM to the attach client, up to five seconds, and the original
100 ms finalization bound. One deliberate compatibility correction closes a
measured leak: unchanged Python and the initial Rust candidate acknowledged an
already-exited leader while its real group member continued running. Before
reaping, cleanup now makes the final one-shot KILL decision against the pinned
owned group even when the leader has exited. A failed decision keeps its pin
and sticky uncertainty; it never becomes a sent-completion state on reentry.
After successful decision/reap the closed `AwaitingGroupAbsence` state can only
perform signal-zero queries. These send no signal; only ESRCH confirms absence.
Reuse can cause conservative retention, never destructive targeting of another
group or a false absence while an original member survives. Existing/zombie
groups, permissions and deadline exhaustion remain retained. This needs no
proc census or assumptions about its mount visibility. Every phase is clipped
by the original caller and first-stop deadline.
The first close plan survives late construction and repeated calls. Attempted
spawn without a returned child remains unknown. Descriptor close errors are
sticky, consumed FDs are never retried, and typed constructor/cleanup causes
remain with the Job. No local constructor settlement clears the laptop's
daemon-effect uncertainty. Default abandonment retains the same record and
real storage/Office/engine owners through the existing Runtime quarantine.

Read/write are bounded PTY operations. Resize here is the local ioctl plus
exact client WINCH; it is not a guest-client dimension acknowledgement. The
marker inventory, latest-request confirmation, accepted-J relay, receipt-first
X/output drain, positive pane-dead recheck, viewer replacement and final App
handler/resource release remain required transport consumers. Local session
cleanup does not prove an escaped-process/descendant-tree census, container cleanup,
storage-writer release, admission release or global shutdown. Live OCI/guest
and GPU/company effects are not exercised by the owned Rust-child controls.
