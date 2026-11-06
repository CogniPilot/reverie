# Worker launch preparation

This unit ports the complete request rules and valid-upstream create/tmux/account
argument preparation. `validate_request` consumes the broker's bounded J/L bytes,
using the existing default Python bytes JSON mode: encoding auto-detection,
last values on duplicate keys, original environment insertion order, nonfinite
constants and the 4300-digit integer conversion bound. Exact request fields,
nil-accepting SID, literal attach boolean, lexical writable cwd, command,
environment and terminal rules are checked in source order. Unicode limits count
Python codepoints, including lone surrogates; later OS encoding is separate.

`prepare_create` accepts a captured validated configuration, SID and the SAME
`StoragePaths` selected by the installing broker's storage context. It retains
those paths, original configuration, effective configuration and derived worker
name. It does not infer an employee ID from a request, re-resolve storage, hold
native custody or construct a start/admission permit. It runs the existing full
effective-config owner, observes rootless security and runtime separately, then
GPU arguments and the fresh ID+owner hostname label in source order. Exact
hashes, tmpfs overlays, workspace alias, resource flags and argument order are
preserved. The low-level formatter also retains the original SID scratch fallback
for trusted older composition; the application always passes selected scratch.

`WorkerCreatePlan::account_mounts` is deliberately later and uses the ORIGINAL
configuration. Tool account paths are checked in fixed key order, including a
fresh resolution for duplicate raw destinations before insertion-order
deduplication. Only the selected namespace paths are observed; credential file
contents are never read. Strict source containment compares preserved Python
path text, not equivalent native bytes. Symlinked accounts inside the company
remain accepted. Empty account sets still perform rootless qualification.
Returned paths/argv are unpinned readonly snapshots, not mount permission.

`tmux_args` derives its reference from the plan's checked worker name. The
contracts helper also accepts a checked complete observed container ID for the
existing pane/viewer workflows. It formats fixed container `/bin/tmux` arguments,
not a host-command endpoint. Temporary environment hashes raw cwd fsencode bytes,
without normalizing its spelling. Hostname observes only ID+owner matching and
the frozen Python lowercase/ASCII label rule: historical storage remains allowed,
and unrelated registry/session data is not promoted into hostname authority.

The create/account formatters consume valid upstream configuration and checked
request environment. They do not claim arbitrary malformed calls into private
Python helpers are a new supported API. Shared iterative JSON deliberately does
not copy CPython implementation stack-exhaustion limits; grammar, numbers, text,
schema, byte bounds and observation order are qualified instead.

## Consumer inventory and remaining effects

The existing Python broker remains selected. Its worker connection handler calls
`validate_request` for ordinary frames and protected resource launch records,
then `create_args` after selecting storage. Native resource helpers also validate
captured requests and compare `account_mounts` with observed engine rows. Their
protected request/row/custody adapters must consume this same rules owner during
the full broker cutover; no Python fallback or second runtime is selected here.

The broker's pane retention/recovery/viewer checks, new-session setup and attach
path consume `tmux_exec_args`. Container child setup consumes
`temporary_environment(request.cwd)`. `home_workspace_alias` actually writes a
home symlink and remains an effect obligation, along with private launch/exit
files, storage preparation, Gate admission/start/recheck, account-row identity
comparison, telemetry create checks, network/container create/start/stop, tmux
process/PTY relays, child environment/unlink/exec, failure recording and cleanup.
Those effects must consume separately admitted custody; a plan cannot authorize
them. No engine invocation, account write, public endpoint or service activation
is introduced by this cohort.

Tests seal actual unpatched Python request bytes/hashes and complete create argv,
with real owned account symlinks/company metadata, raw-surrogate path provenance,
current and historical employee projection, tmpfs/alias behavior and raw cwd
fsencode. A private controlled observer verifies the two rootless reads and
failure ordering; it is not a production source override. The native client's
unchanged allowlist behavior now delegates to the same Core key owner and is
qualified through the selected immutable executable/manifest package gate.
