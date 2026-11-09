# Cooperative job admission

`reverie-job` preserves a foreground command's exit status and cooperatively
counts estimates plus observed memory. It does not enforce a cgroup, stop
descendants, grant host-pool administration or establish physical capacity.
The gate process exiting is not proof that every descendant has settled.

The ledger directory must already be private to its actual user, or be newly
created privately. Symlink directories, unsafe permissions, linked/nonregular
records and occupied publication names refuse without repair or truncation.
Original regular 0644 records remain readable inside that private directory;
new files are 0600. Unknown and oversized records stay retained. The fixed
4096-byte record bound is an explicit malformed-input refusal.

Each captured ledger has a distinct owner brand and held directory descriptor.
Its lock cannot be substituted from another capture, even for the same path.
Callers finalize actual lock and directory owners explicitly; library admission
does not return a decision until lock finalization succeeds. Temporary data is
synced and consuming-close checked before descriptor-relative publication and
directory sync. Unknown publication/close outcomes are not automatically retried.

The protected private namespace and cooperative flock serialize supported
writers. Name/inode checks do not claim an atomic unlink guarantee against
hostile code already running as the same OS user outside that contract.
