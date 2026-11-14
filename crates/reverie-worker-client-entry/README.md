# Static worker client entry

This std-only Linux ELF executes one fixed relocated Node binary and one fixed
bundled client script. It clears ambient environment variables before the
dynamic loader runs, fixes PATH, disables Node addons and global module search,
and preserves only the explicit worker API context. An actual private bound
credential file is mandatory except for exact read-only capsule roles.

It has no program, prefix, environment-file, socket or native authority selector.

The fixed bootstrap role is `worker-client credential-install --expected-digest SHA --home-dev DECIMAL --home-ino DECIMAL`. It qualifies the actual capsule before reading bounded token stdin. HOME is fixed at /home/agent; no caller path is accepted. Decimal identities are correlation DATA compared to fresh descriptor facts.

The native owner retains /home, the actual HOME and .reverie directory descriptors. Exclusive pending creation is synchronized before token write; file synchronization precedes atomic no-overwrite hard-link publication, directory synchronization and removal of only the owned pending name. The safe nix linkat/unlinkat path also works in the static musl artifact. Existing pending names and different credentials refuse. An identical existing private file may earn only a new strong reader/close acknowledgement. No prior helper close is reconstructed from bytes.

Only acknowledged directory/file currency, synchronization and consuming closes produce the installed receipt. Any failure retains the first cause and cleanup causes; a partial pending or two-link publication stays held. The command never clears that state or starts a provider. Tests use explicitly synthetic private roots and do not qualify actual employee/native readiness.
