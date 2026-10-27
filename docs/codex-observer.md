# Optional native hook observer candidate

`codexObserver` builds an optional diagnostic candidate from public Codex
0.163.0, exact upstream commit
`83086188ae0614bd882818ff1aa23f3194962012`, plus the reviewed redacted observer
patch. Its command is **`codex-observer`**. It does not replace `codex`, change
the provider installer, enter the default image or activate an employee.

Diagnostics stay off unless the caller explicitly sets
`CODEX_REDACTED_HOOK_OBSERVER=1`. The wrapper supplies ordinary immutable
bubblewrap, Git, Bash and ripgrep dependencies. Normal Nix runtime references
provide the libraries; no personal host setup or ad hoc loader path is needed.

First qualify public inputs without compiling the Rust graph:

```sh
nix build .#checks.x86_64-linux.codexObserverSource
nix build .#checks.x86_64-linux.codexObserverVendor
```

These check the exact patched source, reconciled lock, all registry checksums,
eight real locked Git-source hashes and complete vendor directory, then run
locked offline Cargo metadata against that actual source/vendor setup. They do
not claim a native binary, hook execution or employee-context acceptance.
The pins and upstream/patch provenance live in `nix/codex-observer/`.

After reviewing those inputs, an explicit candidate build is:

```sh
nix build .#codexObserver --max-jobs 1 --cores 2
```

The first candidate uses the debug compilation profile exercised by the
prior native checks; Nix stripping and fixup produce a new binary hash. It
builds only `codex-cli --bin codex`, not unrelated V8 companions. A new Nix
binary still needs its own actual native and faithful managed-producer canary
qualification. The completed scratch-binary canary cannot be relabelled as
acceptance of this output. Source/vendor checks avoid invoking a provider,
reading personal accounts, changing trust or creating a live thread.

The separate explicit `codexObserverNativeCheck` output compiles the candidate,
checks all targets of the three touched crates, and runs the nine hook and five
ContextManager observer tests. It is excluded from ordinary source/vendor
flake checks. Building it is a substantial additional Rust build, not a source
qualification shortcut.

The observer covers synchronous SessionStart, UserPromptSubmit and PostToolUse
dispatch and their actual ContextManager context admission. Its cached
configuration fingerprint is distinct from script-byte provenance. Metadata
contains IDs, statuses and context UTF8 byte counts/hashes rather than context,
commands or error text. Queues can drop records: absence is not nondispatch
proof. Context-history insertion alone does not establish model understanding.

A portable opt-in packaged canary is separate follow-up acceptance work. It
must retain the real producer/CLI, isolated
data directories, normal own-handler trust, actual sandbox, exact tool exit0,
bounded cleanup and the faithful18-dispatch/10-insertion expectations. They
must not use current employee identities or relax a kernel sandbox refusal.
