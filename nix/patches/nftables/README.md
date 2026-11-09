# Pinned nftables build patches

These are third-party GPL-2.0-only nftables changes, retaining the upstream
authors and commit messages. They replace only the four reproducibility patches
already selected by nixpkgs `a033e66ab94a6bedf2c3d58d93a36319d3cbbbaf`
for nftables 1.1.6. The original HTTP patch endpoints returned HTML challenges
instead of patches; no HTML checksum is accepted and no security patch is
removed. The local override is limited to the rootless worker Docker package.

The objects were obtained through the project's
[official Git mirror](https://repo.or.cz/nftables.git), listed on the
[Netfilter mirrors page](https://www.netfilter.org/mirrors.html). Each patch is
`git format-patch --stdout --no-signature --full-index --binary -1 COMMIT`:

| File | Original full Git commit |
| --- | --- |
| `0001-non-bash-configure.patch` | `2e3c68f26d5bd60c8ea7467fa9018c282a7d8c47` |
| `0002-nftversion-template.patch` | `2a0ec8a7246e5c5eb85270e3d4de43e20a00c577` |
| `0003-configure-build-timestamp.patch` | `b92571cc59ce49fdd9fe2daac9350529adfb2424` |
| `0004-source-date-epoch.patch` | `ca86f206c92704170a295b8dc7a41f6448835dde` |

The original musl patch and all other package/version/security inputs remain
selected. Assertions refuse an unexpected version or missing/duplicate original
patch names, so a later nixpkgs update must deliberately retire this override.
