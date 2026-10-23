# Owner and host-service route authorization

Owner-only HTTP operations require `ownerVerifier({service, ctx})`, passed as
`verifiedOwner` by the web server. It validates the full owner session cookie and
requires no parent-session header. A service token, a missing header, a role name,
`requireAdmin`, and `getAuthUser` are not owner authentication. The global policy
continues to enforce same-origin writes and restricted-session checks. Local owner
checks remain strict even when the global policy is in log/off mode.

Company recovery and expert delegation retain their existing employee grants and
launch constraints. Service credentials cannot impersonate those agents by adding
a parent-session header. Room content and mutations require a verified owner or a live scoped
agent, so headerless services cannot read private rooms/files or take owner actions.
The Company response advertises `canManage` only to the verified owner.

## Explicit host operations

The host service grant is a separate verifier, never an owner actor. In single-user
mode only:

| Service token name       | Operation                                | Boundary                                                                                                               |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `watcher`                | `PUT /api/company/employees/:id/session` | Existing company rebind validation; no parent header; audited as `service:watcher`                                     |
| `stall-watch`            | `GET /api/chatrooms`                     | Aggregate session/pending counts only; no room identities, names, messages, files, relationships or owner capabilities |
| `plan-usage`, `routines` | `GET /api/subscription-profiles/usage`   | Read the existing usage response only; no parent header                                                                |

Other names, invalid tokens and mixed service/agent identities receive no such
grant. Multi-user service grants are disabled because these host identities have
no tenant binding. This does not change the service token format or claim a global
service-token scope system: other existing service-accessible routes remain under
their existing middleware. A service's required new owner-only operation must get
an explicit reviewed grant, rather than restoring missing-header owner promotion.

Before deployment, verify the host units use the documented token names and
operations. No credentials need to be read or copied to a laptop for that check.
The source tests use synthetic tokens and fixture stores, never live host state.

## Tests

`owner-route-principals.test.ts` uses real OwnerAuthService and enforce policy with
actual route handlers. It checks full-owner success, service/anonymous/invalid
refusals, unchanged side-effect counters, membership read refusals, same-origin
checks, named rebind and service-name separation, and no hire/retire/pinned launch
on a refused request. Existing route unit fixtures explicitly inject a test-only
trusted-browser verifier; they do not test authentication and never provide that
verifier to production. Authentication integration tests keep the real verifier.
