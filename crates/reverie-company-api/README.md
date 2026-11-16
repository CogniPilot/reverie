# Opt-in Rust company service

This is an uninstalled, fresh-company API and CLI foundation. Rust owns credential
verification, permissions, metadata transactions, original request IDs and HTTP
dispatch. It has no Node, TypeScript or Python backend fallback. It does **not**
implement native employee Leave, Enter, Restart or Retire. Those requests persist
an original `held` result with `NATIVE_LIFECYCLE_UNIMPLEMENTED`,
`nativeState: "unobserved"`, `effectIssued: false` and no allowed actions.
Registration creates a metadata identity, not a physically ready employee.

## Run against new isolated data only

Create a private parent directory (0700), then invoke:

```
reverie-company init /tmp/my-private-parent/fresh-company
reverie-company init-status /tmp/my-private-parent/fresh-company
reverie-company serve --fresh-company /tmp/my-private-parent/fresh-company
```

The server prints its loopback address. Initialization writes the generated owner
secret only to `owner-credential.json` (0600); it never prints the token. Its
staging directory is published atomically without replacing any existing path.
An interruption before publication leaves the final name available; an unknown
publication reply is inspected with `init-status`. Existing directories, legacy
formats and unrelated version-3 documents refuse unchanged. Unpublished staging
directories are retained for inspection, not automatically adopted or erased.

## HTTP and headless client

All routes require one `Authorization: Bearer` credential. Cookies, worker identity
headers and service-token headers are rejected. Binding to loopback does not
confer authority. Owner enrollment registers a client-generated canonical
base64url secret containing 32 random bytes for the exact employee/SID/generation.
The server stores its digest, not the secret. Agent credentials are not the
existing deployed SDK HMAC credentials; that integration is pending.

| Method | Path | Strict body |
| --- | --- | --- |
| GET | `/api/company/employees` | none |
| POST | `/api/company/employees` | `requestId`, `name` |
| POST | `/api/company/employees/:id/manage-office` | `requestId`, `scope`, `enabled` |
| POST | `/api/company/employees/:id/credential` | `requestId`, `scope`, `secret` |
| POST | `/api/company/employees/:id/office/operations` | `requestId`, `scope`, `action` |
| GET | `/api/company/operations/:requestId` | none |

`scope` is `{ "sessionId": "UUID", "sessionGeneration": 1 }`; `action` is one
of `leave`, `enter`, `restart`, `retire`. Unknown/duplicate fields refuse. Owner
credentials alone register employees, enroll credentials and change grants. A
current enrolled agent with `manageOffice` can submit an office intent and read
company metadata. After grant revocation it can still inspect its own original
request, but cannot submit another action. No role/title supplied in JSON or the
environment grants permission.

Use the same API from the compiled Rust CLI; POST JSON is read from stdin:

```
reverie-company call --address 127.0.0.1:PORT \
  --credential /tmp/my-private-parent/fresh-company/owner-credential.json \
  --method post --path /api/company/employees --request-id ORIGINAL_UUID
```

The CLI makes one request and never retries. It retains the supplied request ID
in errors; exit 4 means an original held intent, exit 3 means refusal/unknown.
Resubmission of the same ID/body/actor returns the original metadata result;
changing its body or actor refuses. A rename/commit ACK loss makes that store
instance refuse new writes. Reopening and reading the exact original resolves
metadata visibility without inventing native completion. All actual writers use
independently opened directory-inode flocks and recheck original bytes before
rename. This does not defend against an administrator directly rewriting files.
The service caps connections/headers/bodies and reports shutdown unconfirmed if
an issued blocking request cannot be drained; shutdown is not cancellation proof.

## Qualification and migration boundaries

`cargo test -p reverie-company-api` exercises real Rust HTTP, compiled CLI and
credential/grant checks with child PATH excluding Node/Python, plus original ACK
loss, atomic bootstrap interruption, writer-lock and server-lifetime faults.
These are source/service tests, not native lifecycle acceptance. The workspace
Rust test gate discovers this crate; it has no deployment or packaging switch.

`reverie-company qualification` emits the executable CI coverage matrix.
`reverie-company qualification --require-complete` exits 78 while physical
lifecycle scenarios remain pending. Held requests cannot satisfy those rows.
The store has finite metadata limits (64 employees, 512 requests); reaching them
refuses without native effects. Supported archival is not implemented.

Production cutover still needs exclusive legacy CompanyStore writer migration,
preservation of all IDs, permissions, memory/goals and unknown native journals,
the genuine owner/SDK issuer, fixed native effect ownership and permanent CID
fences. Real hire-to-ready, Leave-to-verified-OFF, new-CID/SID/generation Enter,
whole self-Restart, Retire, native ACK/crash recovery and full agent CLI cycles
must run against that single authority in CI. The deployed TypeScript services
and active Python packaging have not been migrated or deleted by this slice.
