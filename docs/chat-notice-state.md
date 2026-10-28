# Own notice attention

The per-agent turn summary keeps attention separate from transport and task work.
An eligible owner message remains pending across reads and restarts until an exact
own reply or explicit own resolution handles it. An unrelated post, room read,
summary GET or newer read cursor does not answer an owner message.

For a notice that needs no further presentation, use its exact message ID:

```bash
reverie agent chat handle MESSAGE_ID --room ROOM
reverie agent chat handle OLD_MESSAGE_ID --room ROOM --superseded-by REPLACEMENT_ID
```

The command reads the current exact source (and optional same-room replacement)
then explicitly resolves only the caller's attention. It does not acknowledge
transport, remove queued/unconfirmed identities, resend, wake an agent, change
phone mode or complete a Board task. Unconfirmed/queued deliveries remain visible
even if attention is handled. Use the existing delivery-status and exact-read
acknowledgement commands for their separate purpose.

The own-session API is `POST /api/chatrooms/notices/resolve`, also available through
the existing `/api/v1` alias. Its strict body has `roomId`, `messageId`, `readToken`
and `disposition` (`handled` or `superseded`). Supersession also requires a
`replacement` containing its room/message IDs and its own exact-read token. Both
sources must currently be visible and eligible for this recipient, with the same
owner. A read token alone performs no resolution. Actor, owner, session, file path
and query overrides are not accepted. GET summary remains read-only.

Summary records add `sourceDigest`, `attention` and `transport` alongside the
legacy `state`. Attention has `disposition` and an optional linked-reply reference
or exact-read proof timestamp; supersession also retains the replacement
room/message/digest. Transport is `queued`, `delivery-unconfirmed`, `unread` or
`unknown`. A newest-seen cursor cannot prove every older identity was read, so it
is reported as `unknown`, not confirmed delivery. Existing queued/held ledgers
remain authoritative. Summary text keeps its existing size/entry bounds.

Digest version 1 hashes recursively sorted canonical JSON for message identity,
author, recipients, timestamp, content, attachments, edit/deletion version,
reply/audio/voice fields and poll definition. Delivery bookkeeping, pinning,
reactions and poll votes are excluded. Source/replacement edits or lost access
invalidate a stored suppression. Edited/deleted linked replies invalidate derived
handling. Edited sources require a fresh explicit resolution; the service never
invents a historical source version. Valid current employee/retirement mapping can
carry own handling across a supported session replacement; names or a rebound
employee identity cannot. Unmapped recipients use exact session identity.

The website owns versioned `chat-notice-state.json` next to its ordinary chat data.
It stores at most 10,000 proof records / 8 MiB of bounded metadata, with no raw
message bodies or read tokens. Writes revalidate before an exclusive 0600 temporary
file is atomically renamed and synced. Equivalent current proofs are idempotent;
new versions/supersession retain old proof metadata. Full or invalid storage
refuses mutation without eviction. Corrupt storage remains untouched; current
eligible notices fall back to pending. A directory-sync failure after rename is
reported as unavailable, with attention unsuppressed until storage recovery.

These are source/API semantics. Installing this feature, the actionable digest
consumer, and end-to-end automatic hook acceptance are separate checks.

## Owner history beyond the recent window

SQLite builds additive owner-source and reply-reference indexes when the chat
database is opened. Ordinary chat transactions maintain them, including edits and
tombstones; they do not duplicate message bodies or change the existing raw history.
Building these indexes on an existing installation is a startup database change,
not something a summary GET performs. Its actual installed cost remains to be
qualified before deployment.

A summary discovers owner requests outside the 1,000-message recent window through
these indexes. It shares a limit of 1,000 historical source/reply rows and 8 MiB of
stored JSON across all visible rooms per call. Current membership, owner, DM and
phone filters still apply before presentation. Archived replies can establish
handling only under the same current recipient/version rules; an incomplete proof
search keeps attention pending. No unbounded archive-file or message-history scan
runs during GET.

`historyCoverage` describes **owner** discovery: `complete`, `bounded` or
`recent-only`. Under a bound, `total`/`omitted` cover examined eligible candidates,
not every pending request. The text explicitly says coverage is incomplete; an
unexamined source is never implicitly handled. Rooms with more sources include a
stable `(at,id)` `before` cursor. Legacy JSON-only chat reports `recent-only`, not
complete older-owner coverage. It does not scan the archive on demand.

Inspect one own room page without advancing reads or handling anything:

```bash
reverie agent chat pending --room ROOM --json
reverie agent chat pending --room ROOM --before-at EPOCH_MS --before-id MESSAGE_ID --json
```

The exact-caller `GET /api/chatrooms/notices/history` accepts only `roomId` and the
optional paired `beforeAt`/`beforeId`. It returns bounded source references for all
eligible examined candidates, separately from the six-entry rendered excerpt.
This keeps sources inspectable even when excerpts are omitted. It does not walk
pages automatically, advance a durable cursor, ACK transport, resolve attention or
wake anyone. A legacy instance without SQLite refuses this historical endpoint
rather than claiming coverage it cannot establish.
