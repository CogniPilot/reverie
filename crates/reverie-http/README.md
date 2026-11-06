# Shared HTTP transport

This crate owns the request-phase socket timeout accounting and maintained
Hyper HTTP/1 parser configuration used by the OPS client. Consumers own
destinations, authentication, status policy, redirects, body bounds and effect
semantics. This crate provides no authority.

The implementation is preserved from the separately qualified native-backend
candidate. This main-based client composition includes no embedding adapter or
memory runtime. Future HTTP consumers should reuse this owner. The builder
retains its aggregate header buffer allowance, maximum header count
and obsolete multiline-header support. It does **not** implement a full copy of
CPython's HTTP parser. Independent old/new executable probes found these
differences in that existing Hyper configuration:

| Raw response case | Python client | Hyper transport |
| --- | --- | --- |
| 70 KiB status reason or individual header line | Refuses | Accepts within aggregate bound |
| 70 KiB chunk-size line with leading zeroes | Refuses | Accepts |
| Valid 20 KiB chunk extension, or many totaling 24 KiB | Accepts | Refuses at the maintained parser's extension bound |
| 70 KiB discarded trailer line | Refuses | Accepts within parser bounds |
| 100 short trailer fields | Discards | Refuses at configured header count |
| Malformed discarded trailer line | Discards | Refuses |

The OPS destination is the existing fixed `/api/ops` Office phone. Its local
handler emits one bounded JSON result with `Content-Length` and small fixed
Server/Date/Content-Type headers. The existing Node office relay transfers
decoded body bytes; it forwards no chunk extensions and calls no `addTrailers`.
These raw-server differences are outside that supported OPS producer. Actual
Office-handler-plus-relay qualification is separate from raw TCP fixtures.

External-server HTTP compatibility remains open; this client composition
neither resolves those differences nor qualifies an embedding consumer or
runtime selection. Parser limits
must remain explicit in that acceptance. Reimplementing framing in an IO
scanner or silently lowering the aggregate buffer would create another parser
or reject previously accepted collections of valid headers.
