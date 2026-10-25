# Canonical Goal and recovery source composition

The optional accepted Goal service uses the ordinary Company's existing store,
writer lock, auth/custody boundary and WebServer registry. The eighth server input
remains trusted bootstrap provisioning. There is no second CompanyStore, registry,
Goal reducer, authority namespace or writer. Missing provisioning remains denied.

The report-only recovery projection is attached to that same CompanyService and
registry using the same mandatory custody assertion. SessionManager and the server
Map use one scalar-only registry selector. The Goal selector reads only matching
canonical ID, generation, state and transition sequence; ambiguous Goals and an
unwitnessed or changed on-disk canonical file yield unknown Goal fields. It never
chooses a latest Goal, clones a snapshot, reads objective/evidence/private state,
or treats a Goal's declared session generation as runtime proof.

Existing identity/preference observations retain their report-only in-memory
semantics: externally changed employee data requires ordinary canonical reload.
A stale employee observation is not authority. No complete recovery metadata is
produced: runtime generation, revision and complete activity remain unknown, and
recoveryRead unconditionally returns null. No authenticated resume-service grant,
positive FROZEN proof, exclusive runtime lease or provider is supplied. The accepted
outer recovery transaction's clock, ledger, append-before-effect, after-await and
uncertain-send fences are unchanged. No effect adapter or live route is activated.

Owner-only Goal mode retains the accepted explicit configuration/custody gates;
employee signing remains unavailable without the independently required original
program observer. Registration and component fixtures are not custody or activation.
Native image/helper pairing, actual engine/custody, data-preserving OFF image and
owner canary remain separate release requirements.
