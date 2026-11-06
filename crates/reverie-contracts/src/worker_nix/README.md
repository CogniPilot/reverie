# Nix preparation data

These named views preserve the existing guard, rollback, helper argument and
engine-row data rules. Callers supply the actual captured worker configuration;
the views do not authorize effects or prove current writers stopped.

Migration markers keep the strict metadata/65,536-byte reader and literal
integer version2. Rollback keeps the separate UTF-8 read-text/universal-newline,
last-wins Python-string JSON mode and Python equality for the legacy version1
document. No new rollback file-size cap or general stage-config bound is added.
The shared decoder owns grammar, text and integer-token policy.

Helper arguments come from the effective configuration at the original phase,
including pool placement and reversed account bind insertion. The fixed helper
budget and network/read-only flags have one argument owner here. Upstream full
worker validation remains necessary; the raw projection is not a second worker
validator. Direct helper fixture values outside the validated worker domain do
not become a new policy API.

Image opt-in is the literal string1. Engine JSON uses the source last-wins
UTF-8 string mode; Running truthiness and ExitCode's Python numeric equality are
preserved. Checked container IDs close the selected engine argument surface;
malformed IDs from a broken engine refuse instead of becoming flags. A decoded
old helper label or CID is data, and cannot construct a removal/start context.
