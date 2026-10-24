# Phase 0 launch guard
The pure reducer consumes metadata fixtures, not a live chat API. It has no network,
credential, terminal, scheduler, model, provider, process-execution or host adapter.

Run from the repository:
```sh
PYTHONPATH=python python3 -m reverie.launch_guard < input.json
```
Input is exactly {request, now_ms}; see tests/fixtures/launch_guard/cases.json for
complete request examples. Output is a versioned LAUNCH_GUARD receipt; exit0 means
predicate PASS, exit2 means refusal. Invalid JSON/schema produces a bounded refusal
diagnostic (not a receipt with fabricated identities). Stdin is capped at65536bytes,
messages256 and bound rooms16. No rejected content or exception text is echoed.

Schema v1 uses closed fields, types, role/state/reason enums and opaque IDs; unknown
future fields or schema versions refuse. JSON schema documents structural rules;
the Python validator additionally checks identity pairing, GO=transition identity,
room maps, result/code agreement and receipt digest. The hash detects mutation,
not authenticity: callers cannot treat a recomputable digest as a signature.

The authorizing GO is the transitionId, with goal/session generation and optional
decisionId/generation on that same identity spine. Per-room sequence cursors describe
what was read at GO. New USER/coordinator posts, launcher mentions or GO references in
bound rooms refuse; unrelated chatter and unbound rooms do not. Historical GO references
before the cursor do not invalidate it. A source must affirm complete coverage since
each cursor; unavailable/incomplete or older-than5s snapshots fail closed. Clock reversal
and future message metadata refuse. Event ordering uses sequence, not sender clock.
The MP4 metadata reconstruction has GO23:51:49Z, suspension23:52:54Z and launch23:53:56Z:
GUARD_UNREAD_INSTRUCTION. No original message bodies are retained in fixtures.

PASS is SYNTHETIC evidence only, NOT an execution grant or effect-ready authorization.
An eventual trusted adapter must authenticate metadata and current principal/GO, acquire
goal/session locks, verify cursor continuity and current generations and recheck immediately
before effect. This pure function does not prove caller honesty, persistence, auth,
permission grants or absence of changes after the supplied snapshot.
ReceiptReplay is bounded in-memory synthetic idempotency only; durable server replay,
journaling and restart reconciliation belong to later slices. Replaying a key returns the
original receipt, never a freshly stamped PASS; reuse is not permission to execute again.
Snapshots and returned receipts are copied; mutations cannot corrupt replay state.

All four Phase0 effect signatures require guard_receipt: heavy_job, compute_lease,
resume and publication_adjacent. They validate its shape and refuse ADAPTER_UNAVAILABLE
even for PASS. No runtime imports, CLI registrations, daemon or service activation changes.
Later receipt kinds, readiness/ledger/seal, compute/rest/watchers and durable goal APIs
are separate increments; this slice implements only the envelope and LAUNCH_GUARD.

Tests check the ten outcome+reason fixtures, privacy fields, generation/state/age boundaries,
idempotency and tampering, bounded input, schema-forward rejection and AST effect/import scan.
Production deployment, shadow scheduling and any live input remain separate review gates.

## Optional managed command
The optional flake app is `launch-guard` (package `launchGuard`, executable
`reverie-launch-guard`). It is not installed into the default console, worker image,
service or scheduler. There is no automatic launch interception or blocking.

After this source is independently reviewed and available at an exact revision,
build/install from Reverie's own flake in a verified checkout:
```sh
nix build .#launchGuard --out-link ./result-launch-guard
./result-launch-guard/bin/reverie-launch-guard --example |
  ./result-launch-guard/bin/reverie-launch-guard
```
This example evaluates the installed synthetic input and prints a SYNTHETIC PASS;
it does not authorize any action. Actual input uses the same command with stdin.
`nix run .#launch-guard -- --help` shows usage. Use a pinned flake revision when
installing remotely, rather than a mutable branch.

For an optional persistent user installation, retain the prior
`nix profile list --json` inventory privately, then run
`nix profile install .#launchGuard` from that verified checkout. Record the new
profile element name and store path; do not replace the console profile element.
Rollback removes ONLY that newly added element using
`nix profile remove <recorded-element-name>`; for build-only use, remove only the
`result-launch-guard` symlink. Neither operation restarts services or laptops.
If an existing element with this name is present, stop and plan its upgrade/rollback
separately rather than remove or overwrite it blindly. Keep other profile entries.
No package build, installation or host rollout is implied by source-level checks.

The wrapper runs the exact minimal source payload with Python `-I -B` and an
explicit pinned import path, ignoring ambient PYTHONPATH and current-directory
modules. It accepts only stdin mode, `--help`, or `--example`; there are no live
chat, server, credential, provider, scheduler, resume or effect options.
