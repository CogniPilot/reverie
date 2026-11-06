# Structured OPS client

`reverie-ops` sends the existing closed OPS command format to the installed
Office phone at `/api/ops`. It provides the same status, inspect and effect
submission interface as the Python client. Clap help includes installation,
permissions, examples, output and recovery guidance:

```console
reverie-ops --help
reverie-ops status website
reverie-ops inspect website operation-id
reverie-ops submit < reviewed-command.json
```

The installation supplies `REVERIE_API_URL`, a local HTTP Office phone on
`localhost` or `127.0.0.1`. The phone's server establishes the employee's
identity. Client environment variables and command data cannot select an actor
or confer owner permissions. Submit accepts at most 16 KiB and requires every
existing grant, artifact, generation and idempotency field; it creates none.
The server validates current authorization and owns all effects.

Stdout contains one canonical JSON object followed by a newline. Exit 0 means
the original Python truth test accepted the response's `success` field; exit 3
means refusal or unavailable transport, and argument errors exit 2. Replies
remain server data, not proof of a host effect. A lost response can follow an
effect: inspect the durable operation before submitting again. There are no
automatic retries, redirects, proxy environment inheritance or engine access.

Malformed non-object submit input now produces that same structured exit-3
refusal. The old Python CLI crashed with exit 1 and no JSON before dispatch;
both paths send no request. This is an intentional error-contract correction.
The URL parser preserves Python's frozen decimal conversion bound, including
leading zeroes in a port. The maintained HTTP parser has explicitly recorded
[line, chunk-extension and trailer differences](../reverie-http/README.md)
outside the actual fixed Office handler's response format. No claim of complete
legacy HTTP parser equivalence is made.

The portable CI gate includes this CLI, its closed wire contracts and the
shared HTTP implementation. Tests cover original Python byte-format vectors
and the actual native executable over an owned TCP phone. The `opsNativeCli`
flake package builds and tests this candidate independently. Its existence does
not select it in the runtime, replace the OPS daemon, or establish real-host
acceptance. Those consumer changes require separate qualification.
