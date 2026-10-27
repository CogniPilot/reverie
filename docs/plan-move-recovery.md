# Recovering an interrupted plan move

A website restart keeps unfinished plan moves held. In **Plans → Recent plan moves**, the signed-in owner can choose **Adopt existing destination** when source cleanup was durably verified. The operation checks the recorded destination account and harness, current employee binding/running intent, stopped source and live destination composer. It changes only the move journal: no session is started, stopped or rebound, and the old handoff is not replayed.

Source cleanup proof is recorded only after native cleanup reports zero surviving process identities. Older journals without that proof remain held for inspection; they cannot be recovered merely because the old session is absent from the UI. Ambiguous multiple outstanding records for one employee also remain held.

Recovery writes a private pending receipt before publishing its terminal record, then a verified acknowledgement tied to the exact terminal-record digest after native validation. Startup keeps an adopted record held without that matching acknowledgement. A valid acknowledgement is explicit completion evidence even if a caller lost the response; it is not inferred from a filename or a completed phase alone. Receipts use bounded, no-follow reads, private modes and hashed move identifiers. Existing receipts are retained and conflicting acknowledgements fail closed.

The endpoint is `POST /api/plans/moves/:id/resolve` with `action: "adopt-existing"` and exact `oldSession`, `newSession`, and `toAccount`. It requires the same authenticated owner and same-origin boundary as other owner plan operations. Agent headers and limited logins do not authorize it. Every slow inspection is followed by a fresh owner/binding fence before the journal commit.

New optional journal fields and recovery receipts belong to the new application schema. Do not insert them into an older running website's strict journal format or treat an old image as a rollback. Live repairs of legacy records require separate verified native evidence, an exact backup and explicit owner/coordinator review; this source change performs no such repair.
