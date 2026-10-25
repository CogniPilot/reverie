# Exact canonical Goal client targets

The supported client validates canonical IDs before interpolating them into Goal
paths. `goalClientTarget` preserves exact ASCII bytes only for its closed supported
method/path/query tuples. Colon is not percent-encoded, dot-only IDs are not
normalized, and the single optional metadata `grantId` is not rewritten by
`URLSearchParams`. This is serialization, not authentication, permission or route
registration. Arbitrary encoded paths remain refused.

Generic HTTP transport retains its existing origin, headers, credentials, body,
timeout and cancellation. Only a recognized Goal target replaces the serialized
request path. Other APIs use the existing URL path unchanged. Client validation
requires absolute end-of-input: JavaScript `$` alone also admits a final newline.

The retained transport and broker-auth positive controls explicitly select the
test-only `--component-proof` fixture mode. Actual supported functions and
`httpRequest` cross an injected network edge into unchanged signing/header codecs
with synthetic key/binding/clock/transport. They cover colon, dot-only IDs,
canonical punctuation, 64/65/100-character boundaries, exact query/body bytes,
HMAC/provenance and replay controls. They do not exercise an installed OfficeAPI
signer or prove working employee delivery. No listener or host runtime starts.

Separate actual restricted-Office controls retain403 for canonical and malformed
Goal requests without upstream forwarding or credential lookup, even when a valid
synthetic component proof is supplied. Absent-adapter server controls receive an
explicit synthetic proof and must still return403. Invalid IDs are refused before
client transport or nonce claim; expected statuses and canonical bounds are not
relaxed to accommodate the restricted broker.

The optional private-config owner launcher is implemented; config omission remains
default-unavailable. The matching restricted broker does not support employee
signing or a trusted original-worker observer. Real installed custody, provisioning,
image/rollback acceptance and activation remain separate gates. See
[current assembly](goal-current-assembly.md) and
[private bootstrap](goal-private-bootstrap.md). These fixture/documentation
corrections do not re-review the earlier ID implementation or claim a live Goal
rollout.
