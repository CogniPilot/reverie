# Native Office transport (unselected)

`OfficeService::from_runtime` borrows the installing broker's actual
`WorkerRuntime` capture. Its retained phones observe that same cancellation and
first-stop deadline. No new engine runner, owner grant or credential namespace is
created. The installing owner supplies the company root and observed console IP;
the upstream port is fixed at3000. `update_address` accepts only a newly observed
IP, never a guest-selected URL. The canonical address observation/refresh consumer
still needs to be joined to the installing lifecycle.

`bind` fixes one checked session ID before creating the Unix phone. The service
retains the actual server/request owner even if its public handle is dropped.
`close_phone` rejects another service's handle. `close` attempts every retained
phone, joins the actual thread and asynchronous request tasks, closes the native
listener and removes only the original socket entry. Deadline expiry, a changed
entry or a failed finalizer retains the owner. An accidental service drop fences
and retains outstanding owners for process lifetime; it is never a capacity or
all-context release acknowledgement. Registry-lock waits respect the caller's
deadline. Native filesystem operations themselves have no hard latency guarantee.

The filesystem socket inode is held by an actual `O_PATH|O_NOFOLLOW` descriptor
through removal and checked finalization. Its identity cannot be recycled after
the distinct listener socket closes. Mode changes use that held descriptor's
fixed procfs reference. This pin still does not make a pathname comparison and
unlink atomic against a separate writer.

Runtime construction precedes bind. The listener/leaf are adopted before any
fallible metadata lookup. Reactor registration borrows the listener instead of
consuming its sole descriptor on an error. A retained spawn payload remains
recoverable when thread creation fails; every prepared listener/anchor/entry
gets a checked cleanup attempt and secondary errors remain attached. An
unidentified created leaf or unconfirmed finalizer retains a failed registry
owner rather than disappearing from the global close result.

Hyper owns HTTP request/response parsing and framing. Each phone admits at most
four connections, the process admits32, and the existing40-token/10-per-second
request budget is retained. An admitted request body is bounded to8MiB and one
absolute15-second read window. An unavailable OPS call settles its at-most16KiB
body before503. The response streams as frames arrive, bounded to32MiB; the
upstream connection lives inside that response, with no detached client driver or
pump task. Closing the phone drops and joins its own connections. This proves
local transport settlement, not rollback/completion of an upstream effect.

Forwarding removes guest Authorization, Cookie, service token, parent session,
hook secret, Goal/recovery proofs, Origin and connection/framing headers. Host
Basic credentials are reread from the configured company's `console/.env`, and
the parent session comes only from the phone constructor. Hook bodies must match
that session before the host hook secret is attached. Hook JSON uses the shared
default Python bytes decoder, including last-key semantics. Upstream Set-Cookie
is never returned to the employee.

Plan approve/reject uses the existing exact private capability chain and bound
request/session/nonce schema. All ancestors are opened no-follow; `console`,
`plan-request-capabilities`, and the session directory must be private and owned
by this host user. The regular capability leaf must be private, singly linked,
stable through the read, and at most4096bytes. The decision retains the exact
UTF-8 handoff, adds only that nonce, and forwards it to the authoritative API;
the console still decides permission, expiry and replay. Retired credential
export URLs refuse before any lookup or forwarding.

The code is an integration candidate, not a Python Office replacement selector.
The actual installing broker must retain this service/phone through launch,
recovery and stop. Named OPS, browser-job, host-action and command-telemetry
adapters and the configured scoped-recovery signer are not implemented here;
those calls currently retain the default unavailable/refused behavior. Default
owner-only Goal paths remain unavailable, as in the existing Python constructor.
No arbitrary callback or JSON grant is substituted for a real adapter.

Compatibility corrections and remaining gates are explicit: malformed HTTP is
handled by Hyper rather than reproducing every Python parser/error-body quirk;
regular credential reads now refuse symlink ancestry and are bounded (1MiB env,
64KiB hook secret); all admitted bodies get an absolute15-second window; an
oversized upstream body terminates with a transport error; and an existing socket
is never blindly unlinked. The canonical stale-socket recovery owner and old/new
HTTP discriminator corpus remain required before selection. Private-directory
checks/inode comparisons require the lifecycle owner's actual writer exclusion;
they are not atomic protection against an independently authorized concurrent
filesystem writer. Preserve all existing plans, accounts, employees and data.
