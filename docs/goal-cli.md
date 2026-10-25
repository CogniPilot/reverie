# Scoped Goal client

`reverie agent goal` uses the normal scoped office HTTP transport. It requires
the separately installed and configured Goal r3 server API. An absent API reports
`GOAL_UNAVAILABLE`; this client does not activate routes, configure trust/custody,
mint grants, wake a session or maintain another Goal store. Target employee/session
fields are CAS inputs, not authentication claims. The server authenticates the
caller and applies current owner/worker/verifier/read authority.

Commands:

```text
reverie agent goal list [--json]
reverie agent goal read <goal-id> [--full] [--json]
reverie agent goal metadata <employee-id> [--grant <existing-grant-id>] [--json]
reverie agent goal create --input <command.json> [--json]
reverie agent goal transition <goal-id> --input <command.json> [--json]
```

List, default read and all mutations print closed ID/binding/state/generation/
sequence summaries, even with `--json`. Mutation summaries include a closed
receipt. A server `visibility: "verification"` response retains exactly that
discriminant and closed shape. A full mutation response becomes the client-only
`visibility: "summary"` projection; it is not a canonical full record. Only an
explicit `read --full` prints private objective/action/history/evidence fields,
and only after the server authorizes and returns that full record. Metadata uses
the fixed r3 projection and an existing owner-issued grant where required.

Create input is the exact r3 JSON body, for example:

```json
{
  "createId": "delivery-create-1",
  "employeeId": "worker-id",
  "sessionId": "current-session-id",
  "sessionGeneration": 1,
  "objective": "Complete the assigned source change",
  "nextAction": "Prepare the reviewable source",
  "inputDigests": []
}
```

Transition input excludes the path-owned `goalId` and includes the exact fence:

```json
{
  "transitionId": "delivery-review-1",
  "generation": 1,
  "expectedState": "ACTIVE",
  "expectedSequence": 2,
  "sessionId": "current-session-id",
  "sessionGeneration": 1,
  "to": "REVIEW",
  "nextAction": "Await independent verification",
  "evidenceRefs": ["evidence:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
}
```

The optional r3 transition fields are `blocker`, `deadlineAt`,
`semanticProgressAt`, `evidenceRefs`, `verifierGrantId` and `unblockProofId`.
HOLD requires its typed category/summary/unblocker; worker HOLD resume requires
the server's current owner-attested proof. A verifier names its existing exact
VERIFY grant. Worker authority ends at REVIEW; the server enforces all legal
edges, actor restrictions, current credentials/grants and generation fences.
This client adds no thresholds, cross-agent authority or grant/adoption commands.

Both input commands require a caller-selected stable idempotency key. Input files
are regular UTF-8 JSON files of at most 64KiB; symlinks and nonregular inputs are
refused. Unknown fields (including actor/owner/credentials), missing CAS fields
and missing keys refuse before transport. Keep private command files in an
appropriate private workspace; the client does not save or print their contents.

Exit codes are `0` confirmed, `1` unavailable/unsupported read response, `4`
invalid/refused/conflict, and `5` uncertain submission. Errors use fixed redacted
messages, never server error bodies or validation input. A transport failure,
ambiguous server failure, malformed success or mismatched receipt after POST is
uncertain: one request is sent, with no automatic retry or state lookup. Inspect
authorized canonical state before manually replaying the unchanged command file
with the same key. A genuine new command uses a new key and a newly inspected
fence; never change the old command to evade a conflict. Session replacement or
terminal reopen cannot reuse old generation authority.

Source tests cover the exact request bodies/paths and response discriminants,
denial/unavailability, closed privacy outputs, stale/mismatched replies,
uncertainty and bounded file input. Source acceptance does not establish the full
installed/deployed/observed Goal workflow or authorize later effect adapters.
