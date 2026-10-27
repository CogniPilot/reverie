# Claude launch selection

Managed Claude launches choose a conversation **before** executing the provider.
The shared selector runs inside the actual local, worker, container or remote
namespace, with that launch's inherited `CLAUDE_CONFIG_DIR` (otherwise
`HOME/.claude`) and unchanged working directory. The website's home is not
evidence about another runtime's transcripts.

The ordered candidates are the bound conversation-chain tail, original resume
seed and session ID. The selector checks only metadata under
`projects/<project>/<candidate>.jsonl`; it never reads transcript contents.
An existing readable regular transcript selects resume, including a one-line
transcript or one under a renamed project. Proven absence permits the existing
fresh session ID. Inaccessible, malformed, dangling or uncertain metadata
refuses with a static message and exit78. Traversal is bounded to4096 project
entries and three candidates. A two-second monotonic/POSIX real-time guard
covers selection only. Expiry is uncertain metadata (exit78), never absence.
Cleanup blocks the alarm, disarms the timer, drains any queued alarm as expiry,
and restores the previous signal handler and mask before the single provider exec. An inherited active timer or blocked alarm refuses rather
than replacing caller state. Python must support POSIX timers in that runtime.
Signals interrupt ordinary waits; uninterruptible kernel I/O can delay delivery,
so this is not a hard filesystem I/O deadline or a kernel-stall guarantee.

For non-SSH native, worker and direct Docker launches, until an existing authenticated
provider hook identifies the selected conversation, the website reports `claudeSessionId: null` and `claudeSessionIdPending: true`.
Archived resume intent and the prior hook chain remain history, never a claimed
current selection. The response viewer and transcript-title writes wait; a Docker
case's saved resume seed updates through the actual hook rather than a guessed
candidate. Once saved through normal session persistence, pending state survives website
recovery. A crash before that save remains outside this guarantee; this change
does not add a durable transaction before launch. Unified history does not fold
an archived candidate or same-directory prompt into a saved pending runtime.
A live pane attachment preserves its known conversation. A hook arriving during
launch is retained; no extra worker-to-website receipt protocol is introduced.
This reuses existing per-instance hook authentication and event correlation;
it does not add cryptographic process or runtime-generation attestation.

Remote SSH keeps its prior attribution behavior: replacing a local SSH transport
can attach an already-running remote provider. Neither an owned attach-or-create
command nor a non-owned attach reveals the branch to the website. Those operations
preserve the known ID and first-hand state; fresh remote creation keeps the existing
provisional resume intent until a hook. Remote selected-ID/crash attribution is not
proved by this change. No extra probe, receipt protocol, or missing-remote-session
refusal is added. When remote creation actually launches the provider, the selector
still runs there and executes only one selected argv.

Selection executes one provider argv, preserving its arguments, environment,
cwd and standard streams. Provider exit1,137 or143, a signal, or an ordinary
runtime/authentication failure never starts a creation command afterward.
An executable missing at exec exits127; other exec failures exit126. Normal
provider locking remains authoritative: a metadata race can still make that
single launch fail, and its failure is retained rather than retried under a
different identity. No locks are removed and no session IDs are rewritten.

The native Reverie and worker runtime closures already include Python3. The
fixed selector uses `python3 -I` and the standard library, without loading the
Reverie CLI or a user's Python path. A remote host must provide Python3; its
absence refuses before Claude rather than installing a package or guessing that
a transcript is missing. Explicit remote command overrides retain their own
semantics. Explicitly replaced custom registry variant arrays retain their
legacy renderer unless they opt into the fixed `claude-transcript` selection
profile. An explicit Docker base command retains its existing shell semantics
within the selected leg. Owner-supplied command programs may implement their
own control flow; the managed selector does not add another provider attempt.
Other providers are unchanged.

Owned fixture tests distinguish absent, present and uncertain metadata, inject
I/O errors, and compare actual fake-provider signal/exit outcomes. They prove
the launch behavior; they do not retrospectively identify a historical crash's
branch or establish live account/provider acceptance.
