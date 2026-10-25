# Owner-only Goal broker custody (source candidate)

This increment adds the closed `G` custody request to the current worker broker.
It does not install the website Goal routes or provision any private state. The
shared private-config schema is version 1 with required `mode`; this restricted
broker accepts **only** `owner-only`. The recognized `owner-and-employee` mode is
unsupported here and fails closed. Missing whole configuration remains
unavailable. A pinned configuration identity change requires restart.

The exact request is `{"action":"goal-custody"}`. Existing kernel peer checks,
namespace checks, bounded inventory, private-entry checks and projection rules
remain mandatory. No request supplies a path, key, generation or engine command.
The response contains only version, config digest and the fixed fourteen private
entry identities. It never contains key content or creates trust/state.

The already packaged Python module supports
`python3 -m reverie.worker client --goal-custody` and the bounded stream helper
`python3 -m reverie.worker client --goal-custody-stream`. The existing worker
executable packaging is in `nix/package.nix` (`workerExec`); this patch
does not add or guess an installed host path. An operator must attest the actual
immutable executable, ownership and execution context before provisioning.

Office HTTP forwarding always has an unavailable Goal signer, independently of
configured mode. Reserved Goal requests are denied before upstream forwarding;
worker-supplied Goal assertion headers are stripped on other paths. No original
program pin, employee signer, generation adoption, launch, child, tmux, runtime
record or terminal behavior is added. Existing host actions remain unchanged.

The accepted allocation/recovery cleanup is carried alongside this boundary.
Unit templates remain `TasksMax=512`; the isolation default remains 16 workers.
These are preserved source values, not a receipt of effective host settings.

The shutdown successor derives one34-second internal cleanup target from the
unchanged35-second unit budget, with one second reserved for returning to the
service manager. This is not a new service SLA. All listener stop requests
precede bounded joins; waits/reaps share the first-stop deadline. Fixed metadata
records unreaped clients, blocked handlers/locks or other unfinished cleanup and
returns failure, never an invented successful reap. It cannot guarantee kernel
D-state exit, filesystem responsiveness or real provider continuity.

Activation remains blocked on independent composition review, the matching
owner-only website/configuration lane, real private-custody/operator evidence,
provider/Office continuity preflight and a safe stop/rollback plan. In particular,
the predecessor's25-second drain plus sixteen half-second Office closes plus a
five-second join is about38seconds. That original defect witness remains
unchanged in the sealed predecessor/receipt; successor fake-clock controls check
the shared target and honest uncertainty, not a fabricated host receipt.

No live state, host service, key, grant, engine or website has been changed. Do
not replace the combined current source with an older full bootstrap worker.
