# Fixed resume message source component

`buildFixedResumeMessage` formats one server-owned template from a closed binding
tuple. It has no route, service registration, credentials, clock, state reader,
persistence, send, wake, terminal or model adapter. No runtime imports it.

Inputs are employee and Goal IDs (canonical ASCII, 1–100 characters), Goal and
session generations, the exact canonical session UUID, and Goal transition
sequence. Generations are positive safe integers; sequence may be zero. Extra
fields, free-form text, caller templates, symbols and accessors refuse with the
fixed `RESUME_MESSAGE_INVALID` error. No Goal title, objective, memory, blocker
prose or private transcript is read or embedded.

The output copies/freezes the tuple and envelope, includes the deterministic text
and its SHA-256, and always says `automaticAction: NONE`. The 1024-byte ceiling and
template are internal constants. The hash identifies text; it is neither a proof
of authority nor evidence of a persisted attempt. An arbitrary valid tuple can be
formatted, so no recipient may treat the output as authentication or permission.

This supplies the fixed-message prerequisite in Kit's accepted resume contract.
The future server verb must itself construct the message from its freshly read
canonical tuple. It must accept no request-supplied message or template and must
not route the payload through pane input, capture, paste or interruption APIs.

Before any submission, that verb still needs the dedicated authenticated resume
principal/grant, exact active Goal and live session binding, per-target lock,
durable append-before-effect 3/30 ledger, accepted current FROZEN evidence and
effect-time checks for generations/sequence, intent, sleep/off/vacation, pending
input/dialog/jobs and grants after every await. Unknown or uncertain results
must not resend. Both Goal program-liveness and production-cost source holds
remain separate prerequisites. The source/report-only/dry/canary/operator ladder
still applies; this formatter alone installs no resume capability.

Named synthetic tests use the ordinary CI Vitest configuration:

    npm test -- test/fixed-resume-message.test.ts
