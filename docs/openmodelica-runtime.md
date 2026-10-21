# Temporary OpenModelica stopgap; persistence plan superseded

**Status:** the copied compiler is a documented temporary stopgap only. Preserve
it until the owner decides otherwise. The permanent route is agent-managed,
single-user Nix inside the container/image, using the pinned Rumoca dev shell.

The following proposals are **SUPERSEDED / NOT ADOPTED**: `docker/Containerfile.omc`,
`scripts/install-omc-runtime`, and re-unpacking the host-made closure at recreation.
Do not run the historical restore/build commands below or use those files for a
new deployment. They remain as review evidence; no copied paths, archives or
histories are being removed. Record the owner-approved toolchain decision in
a handoff file under the instance's handoffs directory.

The runtime copy/smoke had completed before the hold was received. Its inventory:
`/nix/store` contains 55 root-owned copied paths (1,362,680 KiB allocated), with
`/usr/local/bin/omc` linked to the pinned output below. No Nix registration database
or daemon exists. The archive cache occupies 1,334,720 KiB; the isolated smoke
work directory occupies 58,312 KiB. There is no host Nix-store mount.

The container Nix installer must account for these existing, unregistered store
paths rather than assuming an empty `/nix`. No automatic removal or GC of this
stopgap is authorized. After the agent's Nix setup and matching OMC are accepted,
the owner decides whether to remove the temporary copy. The image change must
follow that tested agent-written how-to; no alternate host-copy mechanism will
be introduced.

The remainder documents the historical installation and proof.

The MSL canary requires Rumoca's `openmodelica-cli` output at workflow commit
`db4d45baf172ff2b9a4a0e12d93a4f372249dfd3`, not a generic latest compiler.
Its OpenModelica input is revision
`a96aa1a682c463b0fd2d285b486c09a8b7fe496d` with submodules and source NAR hash
`sha256-x9BsyhMjfTnB+7wpwBi5ShZLUVONzU8+QcTQ16fwy8w=`. `omc --version`
reports `a96aa1a-cmake`.

On x86_64-linux, offline evaluation of those exact CI flake files yielded
`/nix/store/nq63fmf23qdz70dig278b98nsgpa4pxv-openmodelica-unstable-2026-07-21.drv`.
Its cached output is
`/nix/store/6iggbkckmny55dwflvz73pmjq45j8whw-openmodelica-unstable-2026-07-21`.
Record the derivation and source hash when regenerating; a matching version string
alone is not enough.

The 55-path runtime closure includes the compiler, native toolchain, shared
libraries, `share/omc` resources and `include/omc` headers. Copy the selected
closure at its original `/nix/store` prefixes. Moving binaries to another prefix
breaks ELF interpreters, RPATHs and compiler resource paths. No host store mount,
Nix daemon, or host credentials are required in the container.

## Transitional host-registration handoff

An owner-approved, read-only host export can supply registration information for
exactly the copied runtime paths. Keep `omc-dump-db.txt`, its checksum sidecar and
the exact closure path manifest in a handoff file under the instance's handoffs
directory. Record the export size and digest in that private handoff. The records
must contain the host's expected NAR hashes, sizes and references, rather than values
calculated from the container copy. Check the records cover the approved closure.

After installing Nix and preparing store/database permissions under the reviewed
agent-written procedure, the container operator performs the one-time handoff:

```sh
handoff="${REVERIE_HANDOFF_DIR:?set the private verified closure handoff directory}"
(cd "$handoff" && sha256sum --check omc-dump-db.txt.sha256)
nix-store --load-db < "$handoff/omc-dump-db.txt"
bash -euc 'while IFS= read -r store_path; do nix-store --verify-path "$store_path"; done < "$1"' _ "$handoff/omc-closure-paths.txt"
```

All 55 must verify against the imported host records. A mismatch fails acceptance;
do not replace expected hashes with hashes computed from the copied contents.
Follow the CTO's agreed fallback on failure, preserving data and logs. This does
not authorize automatic deletion or another host closure copy.

Then, from the Rumoca checkout at the recorded CI commit, evaluate the pinned
`openmodelica-cli` derivation and run `nix build --dry-run .#openmodelica-cli`.
Verify the derivation matches `nq63fmf2…openmodelica-unstable-2026-07-21.drv`, no
OMC output needs fetching/building, and the selected compiler reports
`a96aa1a-cmake`. Publish verification output before starting any build.

This manual registration export is transitional. The permanent agent-written Nix
how-to and reviewed image establish Nix itself; later agents obtain pinned tools
through normal Nix substitution/build and database registration. They must not
need host-created closure tarballs, repeated host exports or the superseded
installer. The host image patch follows that tested how-to.

## Superseded restore proposal (historical only)

The deterministic runtime tarball is retained in the scratch cache at
`/scratch/cache/openmodelica/a96aa1a682c463b0fd2d285b486c09a8b7fe496d/runtime-closure.tar`.
Its SHA256 is
`a591badfefb7bce50e13cbf8fb99c0809ac4516374d2175ee34c88148e8031ae`.
Run inside the container:

```sh
archive=/scratch/cache/openmodelica/a96aa1a682c463b0fd2d285b486c09a8b7fe496d/runtime-closure.tar
/workspace/scripts/install-omc-runtime --dry-run "$archive"
sudo /workspace/scripts/install-omc-runtime "$archive"
omc --version
```

The installer checks the fixed archive hash, refuses a different existing OMC or
nonempty unrelated Nix store, preserves original paths, and links
`/usr/local/bin/omc`. An identical installed OMC is a no-op. It never deletes
existing data. The store files are root-owned and retain their read-only modes.
All of this lives in the container writable layer until incorporated into an image.
Keep the tarball and reapply at a same-image recreate.

The initial install used a cached exact derivation, so it required zero compilation
and no dependency downloads. The tar is 1,366,732,800 bytes; the closure NAR size is
1,336,215,672 bytes. Reserve about 3 GiB for the archive and installed copy.

## Superseded image proposal (historical only)

`docker/Containerfile.omc` layers only the selected closure onto an already reviewed
Reverie image. It checks the same archive hash in an extraction stage, then copies
only the store paths into the final image. The archive is absent from the final
image filesystem. Do not commit the binary archive to this repository.

After canonical console/runtime reconciliation and image review, build on the host:

```sh
# Set these to the already reviewed base-image digest and chosen local output tag.
: "${REVERIE_BASE_IMAGE:?reviewed base-image digest required}"
: "${REVERIE_OMC_IMAGE:?local output image tag required}"
omc_context="$HOME/git/scratch/reverie/cache/openmodelica/a96aa1a682c463b0fd2d285b486c09a8b7fe496d"
scripts/fleet-container engine build --pull=never \
  --build-context "omc-runtime=$omc_context" \
  --build-arg "REVERIE_BASE_IMAGE=$REVERIE_BASE_IMAGE" \
  --file docker/Containerfile.omc --tag "$REVERIE_OMC_IMAGE" .
```

This is a local image build, not publishing. Review the image and recreate through
the normal maintenance process, retaining rollback and persistent agent histories.
The initial installation did not build an image or restart Reverie.

## Verify as the agent user

Run `omc --version` through the sanitized build environment, then load a deliberately
selected MSL and simulate a tiny model. Confirm the result file and numeric output;
OMC script exit status alone does not prove that every scripting command succeeded.
The initial smoke instantiated `Modelica.Blocks.Sources.Sine(amplitude=2, f=1)` and
simulated to 0.25 seconds, expecting output 2. It used an existing local
`4.1.0+maint.om` library copy in an isolated scratch HOME and library path. That was
an installation smoke, not the pinned MSL canary and not a global library install.
The canary must still load its own verified, pinned Modelica and ModelicaServices
sources under its approved schedule.
