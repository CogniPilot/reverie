# Pinned website update stage

`apps/host/website-update.py` supplies the website cutover stage for the separately
reviewed paired-image planner. This source has no command-line or flake entrypoint.
Normal startup is unchanged. No installation, image load, build, tag change, broker
restart or laptop restart is performed by importing it or obtaining a plan.

The stage accepts exact, already-loaded `sha256:` image IDs and the complete current
website container ID. Tags and short IDs refuse. It checks the loaded image metadata
and current container configuration again during apply. Changing `:latest` cannot
change the approved target.

## Interface and prerequisites

The sole replacement builder is
`replacement_spec(old_container, previous_image, target_image, admin_phone_wake)`.
The sole cutover implementation is:

```python
stage = WebsiteStage(api, state_directory, deployment_path, schema_policy_path,
                     guard=guard, ready=ready)
plan = stage.plan(name, target_image, expected_container_id, expected_image)
# An explicit owner action approves the exact final spec and then the plan digest.
receipt = stage.apply(plan, expected_plan_digest)
```

`api(method, path, data=None)` is a bounded local engine JSON transport. `ready(id,
spec)` is a bounded, read-only readiness check that must return exactly `True`.
The assembler must supply both qualified ports; a fixture returning `True` does
not qualify a deployed website. There is no implicit default engine or readiness
success. Apply refuses root execution.

`guard.snapshot()` supplies the canonical private deployment/broker configuration,
engine identity, current laptop identities/images/layouts and owner intents, plus
`workerBindSources` and `websiteControlBinding`. The former must include every
configured and actual worker bind source, including grants for future laptops.
The latter has exactly these fields:

```text
resourceId                 lowercase resource ID, up to 96 characters
containerName              exact selected website name
stateDirectory             registered private stage journal/checkpoint directory
deploymentPath             registered deployment file
policyPath                 registered schema review/approval file
maintenanceLockDirectory   deployment parent / runtime / update-state
generation                 sha256: followed by 64 lowercase hex characters
```

Those four control paths must be outside all website and worker bind grants,
including resolved aliases and ancestor grants. Mode 0700 alone does not isolate
containers sharing the owner's UID. A trusted owner registry must supply this
binding and its current generation/inventory; selecting a new state directory is
not an authority to bypass an earlier schema fence. The registry/provider and its
admission remain external prerequisites. The stage does not register a resource
or manufacture a binding from command-line paths.

`stage.maintenance_lock()` is a same-instance reentrant context around the common
private `update.lock`. The outer paired planner must acquire it before the worker
writer's distinct internal lock. A different writer refuses immediately. Updating
the worker image may change only the explicitly reviewed guard inputs: the paired
transition adapter must prove that change from the committed worker receipt and a
fresh trusted snapshot, while preserving the original approved website spec and
all other inputs. This transition is not implemented here; there is no ignore-
drift option.

The shared custody codec comes only from `reverie.owner_control`; missing that
module refuses before effects. No second registry/codec is embedded here.

The additional required `guard.admit_control_custody(binding, control_paths,
all_sources)` port returns exactly `bindingDigest`, `controlPathsDigest`,
`sourcePathsDigest`, `evidenceDigest`, each a `sha256:` digest. The first three
must bind canonical ASCII JSON for the passed values in order. Missing ports,
boolean/config assertions and wrong bindings refuse. The port must qualify actual
inode aliases, nested host mounts and namespace custody; the local path helper
provides lexical/symlink prechecks only. The production provider is unimplemented
and remains unavailable. Fixture providers do not qualify authority. Apply repeats
this fresh admission before effect boundaries.

## Owner approval and supported layouts

The private deployment must explicitly select `containerName` and boolean
`adminPhoneWake`. The resulting environment always includes
`REVERIE_ADMIN_PHONE_WAKE=enabled` or `disabled`; a target image default cannot
turn on an owner-selected false value.

Image-owned environment defaults, command defaults and labels refresh from the
new image. Values differing from the old image defaults carry forward. An owner
value equal to an old default is ambiguous: inference cannot prove its provenance.
Every apply therefore requires explicit approval of the exact final replacement
specification, including environment, commands, user, mounts and resources. The
plan reports the ambiguous environment keys. Review plans privately: environments
may contain instance secrets.

The closed schema policy has exactly `version` (integer 1), `reviewId`, `oldImage`,
`newImage`, `adoption` (`forward-only`), `schemaFloors` (`["GOAL", "AUTH"]`),
`backupScopes`, and `approvedSpecDigest`. A null approval allows a preview only.
After reviewing the final spec, the owner sets `approvedSpecDigest` to its exact
`specPin` and obtains a fresh plan. Apply checks both that approval and the exact
plan digest; it does not refresh unrelated inputs or edit the policy. The stable
operation label keeps the spec unchanged across this explicit approval step.

Supported initial layouts are Linux website images with the tracked website
label, existing explicit bind mounts, the default bridge network, and restart
policy `no` or `unless-stopped`. The tracked image launch is supported:
`/bin/tini -g -s -- /usr/local/bin/reverie-start` with command
`reverie web ...` (or `/bin/reverie web ...`). Public old/W2 image metadata is a
fixture for this route. Custom wrappers, daemon launches, static IP/endpoint
settings, extra networks, implicit volumes, container coupling, AutoRemove and
other restart policies refuse before stopping the old website.

The stage preserves existing mount grants and resource/network/process settings.
Legacy bind syntax is converted to equivalent structured mounts with
`CreateMountpoint=false`. Existing sources are pinned by resolved path and inode,
then checked before creation, after unstarted creation and before stop/start.
Missing or replaced sources refuse; this path never recreates a missing state
directory. Candidate configuration/mount readback must match the approved spec.

Any effective selected Goal private bootstrap is currently unsupported, including
literal old `serverContainerId` bindings. Both old and replacement commands and
known selection environment variables are checked; flags using separate or equals
syntax are handled. The stage never rewrites or silently disables that authority.
A separately reviewed binding migration remains open. Service-auth config and all
selected key files require complete explicit backup coverage. Empty REVERIE_DATA/REVERIE_DATA_DIR values follow the tracked shell
`${VAR:-default}` semantics. Data-directory or service-auth selection changes
require separate review.

## Cutover and failure behavior

Plan performs read-only metadata/layout checks. Apply rechecks the registered
control binding, private owner inputs, full current container identity/settings,
loaded image IDs, bind sources and intent guard under the common lock. It creates
and verifies an unstarted owned candidate while the old website still runs. It
then stops only the exact old website and makes a durable private checkpoint of
the reviewed state scopes before any candidate start.

The console directory must be an explicit scope excluding only live `accounts`.
The existing owner-password and selected service-auth/key files need explicit
coverage. No unrelated home/workspace backup is inferred. Backups use anchored
nofollow descriptors and refuse symlinks, hardlinks, sockets, FIFOs and other
special files. Limits are 100,000 entries, 4 GiB total and 256 MiB per file, with
bounded scan/copy times. Directory enumeration is bounded before allocating or
sorting names. Checkpointing requires every state writer quiescent. Before the
first file copy, it captures identities/stamps and directory listings of the whole
included tree; each copy must match that initial view and a complete post-copy
scan must match it again. This rejects earlier-file changes during later copying,
listing changes and replaced roots rather than sealing a mixed checkpoint. It
cannot replace the owner's actual quiescence/custody admission. The manifest binds
the full archive hash/size, copied entries, excluded scopes and tree snapshot.
Checkpoints are disaster evidence; apply has no restore
operation.

After retaining the stopped old container and selecting the new candidate name,
the stage fsyncs a forward-schema fence before attempting the new start. Any
uncertain attempt, timeout, crash or readiness failure remains held/unconfirmed.
The owned candidate is retained and stopped when its exact identity can be
confirmed; the old image is never automatically started, deleted or restored.
An unresolved prior attempt blocks both plan and apply. A prior adopted record
must have the exact closed completed/forward-schema shape and match its private
operation receipt, exact plan digest/spec/control resource, checkpoint manifest
and full archive hash/member contents. Archive hashing and member validation use
one pinned descriptor and recheck its original identity/stamps against the name. Missing, partial, malformed, unknown or
contradictory history refuses. Historical registry generations remain associated
with their original plan; the qualified current registry must govern resource
continuity. These checks do not adopt a caller-selected history directory. Successful adoption also retains
the stopped old container and private checkpoint. Explicit same-candidate feature
disable/restart is the future recovery route; this module does not implement it.

Only `no` and `unless-stopped` are admitted because the retired old container must
remain stopped across daemon restart. Docker documents that manually stopped
`always` containers restart after daemon restart; see its
[restart policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/).
Fixture tests model this distinction; no real daemon restart has been performed.

## Qualification status

The `schemaFloors=["GOAL", "AUTH"]` policy names are required review markers,
not actual monotonic image schema epochs. A trusted parent release catalogue and
owner registry must enforce real forward compatibility; a syntactically reversed
image pair is not intrinsically blocked by these names. That catalogue gate remains
OPEN and must be supplied before owner-callable wiring. First W2 AUTH config/key
installation and new service-auth launch selection are also OPEN: this stage
requires the old/new selection to be unchanged and cannot add a flag or mount.
Custom PATH/program shadows require separately qualified effective launch custody;
recognized argv alone does not attest image-owned executable provenance.

This is source-only. Tests use an in-memory engine and real owned private files;
the public image defaults fixture contains image metadata only. No real engine
cutover, readiness acceptance, installed registry/provider, paired guard transition,
private bootstrap migration, CLI/flake wiring or owner-window activation is
qualified by these results. Existing legacy update/isolate paths are not made safe
by this module and must not be used as a fallback. Normal startup does not require
this optional feature.
