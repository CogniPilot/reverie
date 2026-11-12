# Terminal input receipts and recovery

The browser keeps pending input with a stable client ID, per-session sequence,
original text and dispatch choice. WebSocket and HTTP fallback share those
values. The client persists its queue and counters in browser storage; storage
failure or an abrupt browser exit can still lose local data. This is not a
durable exactly-once delivery guarantee.

## One original request

One server application service owns the process-local receipts used by both
transports. A receipt binds the original Session/provider subject, owner,
client ID, sequence and a digest of the input and dispatch semantics. A matching
confirmed receipt suppresses another write. A watermark alone, missing or
evicted receipt knowledge, a different payload or a successor Session cannot
supply that confirmation.

`useMux: true` selects the guarded mux writer on either transport; the browser
includes it on both when selected. A missing choice uses the shared plain-prompt
selection. Explicit API `useMux: false` requests raw input and remains distinct.
Raw keystrokes run immediately when no async write precedes them. A bounded
WebSocket queue preserves their order behind an async mux write.

Receipts reserve the request before dispatch. Queued requests do not spend the
numeric watermark until their own write starts. Only an actual known refusal
may release its original request. A possible effect, retained text or confirmed
write cannot be refunded or automatically dispatched again. Unknown receipts
are not evicted to make room; exhausted capacity refuses new input.

## Wire outcomes

- `{t:'ia',seq,confirmed:true}` acknowledges the original accepted write or
  its exact confirmed receipt without another write. Every positive receipt
  ACK carries this flag; it never asks the browser to allocate a new sequence.
- `{t:'ia',seq,unconfirmed:true}` reports a possible effect. Do not replay it.
- `{t:'ia',seq,typedUnsent:true,delivered:false}` reports retained composer text.
  Do not resend it; an explicit new Enter remains available. This outcome never
  clears an existing unknown hold.
- `{t:'ia',seq,held:true}` reports an unresolved barrier without authorizing a
  new write. Untagged failures use `t:'ie'` with the same diagnostic flags.
- `{t:'ip',seq}` and HTTP `{pending:true}` report an exact original operation
  still pending. Keep its tag and payload; this is neither delivery nor a sticky
  unknown barrier.
- `{t:'ir',seq,retryable:true,reason:'capacity'}` or `reason:'unavailable'` is a
  known not-issued refusal. Retain the same record and back off; do not assign
  a replacement sequence. HTTP known-not-issued refusals return 409 with
  `data.delivered:false`, without an unknown-effect hold. HTTP retained text
  returns 409 with `data:{delivered:false,typedUnsent:true}` on both the original
  settled response and its exact duplicate.

HTTP conflicts with `recoveryRequired: true`, and uncertain delivery errors,
carry the same deny-only meaning. The browser retains held text and shows the
barrier instead of draining it. Refreshing status or observing a healthy
provider does not reconcile the original effect or clear that barrier.

An ACK is not proof that a model read or completed the prompt. An
HTTP mux operation still in flight returns `pending:true` without claiming
delivery.
RemoteWake byte-buffer acceptance is separate from terminal delivery and
remains an unqualified custody boundary.

## Recovery limits

An unconfirmed write sets a private input hold and attempts to save its deny-only
Session marker. Normal and reboot restoration preserve/refuse that marker.
However, receipts and dispatch ownership are still process-local. A crash before
persistence, a failed save, or a new server instance cannot establish whether an
old request executed. Restarting, changing client IDs, current provider health
or a readable saved row is not permission to replay it. Durable effect journals
and supported original-operation reconciliation remain required release work.

Both transports reject oversized input using the shared input limit. Browser
splitting and permanent-size refusal controls remain covered by
`test/input-size-limit.test.ts`.

The actual WS/HTTP route tests cover confirmed originals, unknown and pending
writes, changed payloads, owner/subject changes, queue capacity and no replay.
Legacy client watermark handling is tested only as compatibility behavior; the
current server does not use it as original-delivery evidence.
