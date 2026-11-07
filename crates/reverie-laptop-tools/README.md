# Reverie laptop tools

Native Rust commands replace the Python/Bash development-environment scripts
previously copied into the worker image. Nix builds `laptopTools` and includes
its runtime closure in the worker image. None has a Python or shell fallback.
The cache builder uses Clap for subcommand help and examples; the other two
user-invoked commands accept `--help` without changing files.

`reverie-autoenv key REPO` prints the existing first-32-hex SHA256 key of the
approved attribute, newline, `flake.nix` and optional `flake.lock` bytes.
`reverie-autoenv build REPO` invokes `nix print-dev-env --json --offline REPO#ATTR`
using explicit arguments and caches the exported variables. `--from-json FILE`
uses a saved result instead. The repository must exist. Both the builder and
`reverie-autoenv-shim` use the same first-matching approval rule and frozen
Python-compatible glob semantics; the former Bash matcher disagreed for some
bracket patterns. Rules contain `<canonical-repository-glob> <attribute> <tool,tool,...>`.
`REVERIE_AUTOENV_CONFIG` selects the approval file, defaulting to
`$XDG_CONFIG_HOME/reverie/autoenv/approved` or `$HOME/.config/reverie/autoenv/approved`.
`REVERIE_AUTOENV_CACHE` selects the cache, defaulting to
`$XDG_CACHE_HOME/reverie/autoenv` or `$HOME/.cache/reverie/autoenv`.
Standalone callers without HOME must supply the two explicit autoenv or XDG
paths; implicit account-database home lookup is unsupported. The worker image
supplies HOME.

The native shim is installed through tool-name symlinks for `cargo`, `rustc`,
`rustdoc` and `pkg-config`. It finds the enclosing repository for each invocation,
checks approval and the current flake key, then replaces itself with the real
tool. It strips its directory from PATH and retains argument bytes. Missing or
invalid caches use the plain tool; `REVERIE_AUTOENV_QUIET` suppresses diagnostics.
`IN_NIX_SHELL` and `REVERIE_AUTOENV_ACTIVE` prevent reactivation.
`REVERIE_NO_AUTOENV=1` also skips the jobs policy. Existing job settings and
`-j`/`--jobs` arguments remain authoritative. PATH components retain their normal
empty-component meaning, and aliases to the native shim are never executed again.

The cache retains the legacy NUL-separated `KEY=VALUE` format and companion
`repo`, `attr`, `commands`, `key`, `vars` JSON diagnostics. Both producer and
consumer validate the entire assignment collection. Only ASCII variable names
of the form `[A-Za-z_][A-Za-z0-9_]*` are accepted, with the original identity,
temporary-directory and build-hook deny list. This deliberately closes an
observed legacy bug where a NUL in a JSON key injected `HOME` into the Bash
consumer. NUL values are omitted as before. Invalid old caches are refused as a
whole, so earlier records cannot partially change the environment. Duplicate
JSON keys retain Python's last value; eligible non-UTF8/surrogate values refuse.

Cache updates use the existing descriptor-anchored Linux filesystem adapter,
private exclusive temporaries, verified bytes, directory locking and atomic
leaf rename. The cache directory and files must be owned without foreign write
access; symlinks and multiply linked cache files refuse. The environment file
is authoritative; the companion JSON is diagnostic, and the two are not an
atomic pair. An unsuccessful publication may require inspection before rebuild.
This package currently targets Linux; the portable codecs are separate from
its existing Linux filesystem/exec adapter.

`reverie-build-jobs` prints a positive compiler parallelism default. It uses the
smaller finite positive `memory.max`/`memory.high`, reserves one GiB for other
work, budgets one GiB per compiler and caps the result at available CPU
parallelism. Unknown limits select one job. This limits parallelism, not total
build RSS. The existing launcher shim preserves an explicit `CARGO_BUILD_JOBS`,
`-j`/`--jobs` argument or reviewed-run opt-out before invoking this helper. A
direct helper invocation always prints a default.

`reverie-cargo-defaults` inserts Cargo's optional intermediate build directory
under `/tmp/reverie/cargo-build/{workspace-path-hash}`. Final artifacts remain in
the project's normal target directory. It preserves an existing `build-dir` and
unrelated configuration bytes, including comments. Legacy `config`, malformed
or unsupported TOML layouts, unsafe paths and oversized files refuse unchanged.
Existing build settings must use an explicit `[build]` table when inserting the
new key. The config input is bounded to one MiB.

The Cargo update anchors filesystem operations to held directory descriptors,
rejects symlinks and non-owned or multiply linked files, and requires private
owned home/Cargo directories. A cooperating call takes an advisory directory
lock. It writes and fsyncs an exclusive private temporary, verifies its bytes
and final metadata, then closes its writer while retaining an `O_PATH` identity
descriptor through publication and cleanup. This prevents inode-number reuse
after an unlink from making a foreign replacement look like the owned temporary.
Cleanup never removes a substituted temporary. The identity descriptor is closed
explicitly; a close failure after a publication attempt reports uncertainty.
The update rechecks the config, source and directory identities
before publication. An absent config uses `RENAME_NOREPLACE`, so a concurrent
creator is never overwritten. Existing-file replacement requires unrelated
editors to remain quiescent: Linux rename does not provide an inode-conditional
replace for noncooperating writers. Publication or finalizer uncertainty is
reported for inspection, without automatic retry or rollback.

Unit tests cover resource boundaries, TOML preservation and unsafe/concurrent
filesystem changes. Integration tests use the actual native binaries and
native launcher, native Nix subprocess fixture and native jobs helper. All
executable fixtures are Rust. They operate only in owned temporary homes.

```sh
nix develop --command cargo test --locked -p reverie-laptop-tools --all-targets
nix build .#laptopTools
```
