# SPEC_0011: Broker Error Isolation and Diagnostics

## Status

DRAFT

Historical native-broker design context. This draft grants no authority to install
or recreate a host broker; current deployment follows the Docker runtime boundary.

## Summary

Keep ordinary request failures local, retain every uncertain original owner, and
make fatal shared failures explicit. Panic strategy, cleanup and diagnostics must
agree with the actual release artifact. This draft does not establish that the
current broker contains all errors.

## Specification

### Error scope and propagation

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Return a phase-local typed `Result` for expected input, authorization, availability and native-operation failures | Owning operation | Expected failures are normal outcomes |
| Distinguish refused-before-effect, issued-but-pending, known-completed and consumed-close-unknown outcomes structurally | Native effect owner | Retry and custody depend on actual effects |
| Preserve the original error and independent finalizer errors | Owning failure | Cleanup must not hide the cause |
| Derive scope from typed cause and actual owner state, never error text | Boundary classifier | Strings are not provenance |
| Refuse missing required facts instead of inventing successful defaults | All authoritative consumers | Missing proof is not success |
| Keep the failing request and its cleanup responsive without restarting unrelated requests when shared integrity remains known | Request boundary | One failure need not disconnect everyone |
| Treat capacity exhaustion and pre-admission contention as bounded backpressure | Admission boundary | Busy is not unknown execution |
| Retain genuine shared-origin, registry, descriptor or capacity uncertainty until actual settlement | Shared owner | Isolation must not release unknown resources |
| Require an explicit typed reason before escalating a local failure to service stop | Service loop | Global interruption needs shared scope |
| Preserve operator-requested shutdown and its original deadline independently of request failures | Shutdown owner | Failure cannot reset a cleanup budget |

An ordinary refusal must not be promoted to issued native work. Conversely, a
timeout after an effect may have started must not be relabeled as a pre-effect
refusal. A local error can still prevent global shutdown acknowledgement when
its original resources remain held. These are separate conclusions.

Compatibility follows [SPEC_0007](SPEC_0007_DATA_COMPATIBILITY.md). Construction
and ownership direction follows [SPEC_0006](SPEC_0006_VALID_BY_CONSTRUCTION.md).
Neither a DTO, a successful status reply nor a joined thread grants resource
release or permission to repeat an uncertain effect.

### Checked cleanup and retained ownership

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Place each partial native owner in its retaining phase before a fallible effect | Constructors | Failure must return actual custody |
| Attempt independent component finalizers even when another component fails | Finalizers | One error must not skip remaining cleanup |
| Perform consuming close at most once and preserve opaque outcomes | Descriptor/native owner | Retrying consumed ownership is unsafe |
| Keep cleanup on the same original operation, record, runtime and deadline | Recovery | Reconstruction is not settlement |
| Default Drop and unwinding must never imply known completion | Drop boundary | Destruction is not evidence |
| Make ignored results explicit about retained cause and settlement authority | Deliberate best effort | Silence must not conceal release |
| Bound retained diagnostics across repeated reconciliation | Failure owner | Polling must not grow memory indefinitely |

Some ignored results are intentional. Existing handler progress replies and
timeouts carry data only; actual record, socket, hold and original thread join
still determine settlement. An all-attempt finalizer may ignore a helper return
only when that helper already records its typed failure in the same retained
owner. A named best-effort observation may return absence only when absence has
an honest, non-authoritative meaning. These cases need documented contracts and
negative controls, rather than a blanket suppression of result checks.

### Panics and release containment

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Reserve `expect`, `panic`, assertions and unreachable branches for documented internal invariants | Production code | User failures need typed outcomes |
| Audit each production invariant's inputs and actual owner state | Owning phase | An invariant label is not proof |
| Declare the selected release panic strategy and its operational consequence | Package/runtime policy | Debug behavior is insufficient |
| Claim `catch_unwind` containment only for an unwind-enabled qualified artifact | Catch boundary | Abort bypasses unwinding |
| Qualify retained owners, poisoned locks and thread joins before changing panic strategy | Runtime integration | Unwinding changes cleanup behavior |
| Never convert a caught panic into success, an empty observation or automatic replay | Catch boundary | A panic provides no completion proof |
| Treat an uncaught invariant failure as an explicit negative outcome | Process/handler boundary | Internal bugs must stay visible |

The audited implementation uses `panic = "abort"` in the workspace release
profile while retaining `catch_unwind` branches in report parsing and native
query/child construction. Those branches do not contain release panics under
that profile. Switching to unwind alone is not an accepted fix: handler joins
can mark original records opaque, collection can escalate to service stop, and
resource-owning Drop paths need independent qualification. A blanket catch
around the broker is likewise insufficient.

Rumoca's local source checkpoint explicitly separates source errors from
internal invariants; it permits genuine invariant panics. Its worker and LSP
boundaries report scoped failures under its unwind strategy. This is a design
comparison, not evidence that a compiler's containment policy can be transplanted
unchanged into a broker holding live native resources.

### Diagnostics and CI policy

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Keep private diagnostics phase-coded, bounded and structurally linked to actual causes | Diagnostic producer | Operators need the original reason |
| Retain primary and finalizer branches without flattening their categories | Error adapters | A generic code can conceal scope |
| Keep public wire errors sanitized and stable | Transport boundary | Diagnostics must not disclose private state |
| Exclude credentials, private pane content and arbitrary argument dumps from routine diagnostics | Logging boundary | Failures must preserve privacy |
| Verify workspace lint inheritance and run strict Clippy in the canonical gate | CI | Declared policy needs enforcement |
| Ratchet restriction lints by reviewed production module and invariant class | CI adoption | Blanket bans obscure legitimate invariants |
| Test every approved ignored-result exception's retention behavior | Owning component | Best effort must stay non-authoritative |

Current strict `clippy::all` and `-D warnings` do not automatically enable
restriction lints such as `unwrap_used`, `expect_used`, `panic`, `unreachable`,
`todo`, `unimplemented` or `let_underscore_must_use`. This draft does not globally
enable them, add allowances or claim that passing Clippy proves error isolation.
Any lint change must distinguish test assertions, proven internal invariants,
user-triggerable failures and actual checked native cleanup.

### Sequential adoption and acceptance

1. Preserve current incidents and classify concrete boundary failures. Fix typed
   ownership and capacity/backpressure defects without weakening genuine unknowns.
2. Audit production panic sites and deliberate ignored results. Publish the
   selected panic strategy and explicit local-versus-shared escalation decisions.
3. Add focused failure-injection controls before altering those decisions.
4. Qualify one frozen release artifact and its actual containment/cleanup paths;
   then adopt targeted lint enforcement with independent source review.

Required controls cover pre-effect busy/refusal with unrelated C/J/T traffic;
post-spawn failure with no second effect; handler panic before and after retained
stack construction; poisoned original locks; native poll failure; consumed-close
unknown; saturated capacity; and bounded repeated reconciliation. Release panic
controls run in an owned subprocess so abort behavior is actually observed.
They must distinguish service availability from resource settlement, preserve
public-wire privacy, and retain both primary and cleanup diagnostics.

The read-only audit compared Reverie `30e134b40231983a48aaa1f4ef3cd2a735725340`
with the clean local Rumoca checkpoint
`e68c2e1a7e2b12b8e4f59baffe897ff46088ce57`, including Rumoca
`SPEC_0008_PHASE_ERRORS.md`. That checkpoint is not a claim about current
protected/upstream Rumoca. Audit findings are source observations; no panic
injection, release-containment test or production effect was performed for this
draft. Runtime implementation and acceptance remain open.
