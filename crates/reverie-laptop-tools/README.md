# Reverie laptop tools

Two native Rust commands replace the Python scripts previously copied into the
worker image. Nix builds `laptopTools` and includes its runtime closure in the
worker image; neither command has a Python fallback. Both accept `--help` without
changing any files and reject other arguments.

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
and final metadata, then rechecks the config, source and directory identities
before publication. An absent config uses `RENAME_NOREPLACE`, so a concurrent
creator is never overwritten. Existing-file replacement requires unrelated
editors to remain quiescent: Linux rename does not provide an inode-conditional
replace for noncooperating writers. Publication or finalizer uncertainty is
reported for inspection, without automatic retry or rollback.

Unit tests cover resource boundaries, TOML preservation and unsafe/concurrent
filesystem changes. Integration tests use the actual native binaries and
unchanged launcher shim. They operate only in owned temporary homes.

```sh
nix develop --command cargo test --locked -p reverie-laptop-tools --all-targets
nix build .#laptopTools
```
