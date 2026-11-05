# Workspace verification

Run the same Rust checks locally and in CI:

```text
nix develop --command cargo xtask verify
```

`cargo xtask check` is an alias of the same verification sequence. The small Rust
runner invokes `cargo fmt`, strict workspace Clippy and workspace tests using
explicit program/argument arrays, stopping at the first error or signalled child.
It evaluates no shell text and contains no deployment or product logic.

`cargo xtask verify-portable` runs the same checks for platform-neutral core,
contracts and xtask. CI exercises this command on Linux, macOS and Windows.
The full native workspace gate remains separate; Linux host adapters are not
claimed to work on other operating systems. Both commands invoke Cargo directly.

Repository policies run as Rust integration tests in that workspace test step:

- Production Rust below `crates/` has a **2000-line** budget. Exactly 2000 lines
  passes; 2001 fails. Counting uses Rust `str::lines`, including blank/comment
  lines and matching CRLF/final-newline behavior.
- Like Rumoca, `tests`/`generated` path components, `tests.rs` and `*_tests.rs`
  are excluded from this line budget. Examples and fixtures outside those test
  paths remain production sources. Exclusions use paths relative to `crates/`;
  the checkout's ancestor names cannot exempt the tree.
- Symlink, special and unreadable source entries fail, including below excluded
  paths. Missing/noncanonical roots and invalid UTF-8 production Rust fail.
  No source comment can opt out of the budget.
- New Python or shell files and interpreter shebangs fail the migration gate.
  Existing script repairs/deletions remain possible while replacements migrate;
  CI's job summary lists the remaining tracked script debt.
  The check includes changed tracked/index files and nonignored untracked files.
  It also catches conversion of an existing non-Python entry to Python.
- The SPEC_0000 gate caps ACCEPTED+DRAFT specs at 21 and each non-REFERENCE
  spec at 350 lines / 2500 words. Missing/invalid canonical status markers and
  duplicate spec identifiers fail; REFERENCE catalogs remain exempt from size.
  Repository IDs must be sequential in adoption order, with retired slots retained.

CI supplies `BASE_SHA` from the PR base or previous push commit. Locally the
default is the merge base of `HEAD` and `origin/main`; supply a full commit SHA
in `BASE_SHA` to compare another reviewed base. Missing/invalid bases fail rather
than silently skipping policy checks. A normal Git checkout and Git executable
are required. The extension/shebang migration check does not claim to detect
arbitrary embedded Python or remove third-party runtime dependencies.

The cargo-xtask convention and size policy follow CogniPilot/rumoca at
`0bab7e08c42dced38488abd298a4b9bb77d2b0cc`, especially
`crates/rumoca/tests/suite_gates/code_size_budget_test.rs` (SPEC_0021) and
`spec_budget_test.rs` (SPEC_0000).
These are independently implemented Reverie checks. Unlike Rumoca's current
marker-based exception, Reverie permits no file-size exception comment. Reverie
also requires the canonical opening title, `## Status` and uppercase status value;
inline or misplaced status markers are not accepted.
