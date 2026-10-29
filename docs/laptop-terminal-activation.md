# First laptop-terminal website activation

The optional owner-local app `owner-terminal-website` prepares and applies the
first **plain → H-only** website transition for an existing isolated-worker
deployment. It uses the same `WebsiteStage` swap, maintenance OFD, exact plan,
checkpoint and forward-only journal. It does not stop/start workers or the
broker, switch their image, change owner choices, add RAM/GPU/performance grants,
enable the resource actor, or configure the host OS.

This is not a general H→H updater. Existing protected tmpfs and changed immutable
startup paths require their separate reviewed maintenance workflow. The generic
website stage still refuses unknown `libexec` commands. This adapter permits
only the exact H-only image/program baked into its immutable lifecycle manifest.

The host needs the existing ordinary-user worker service, local trusted engine,
Nix and user service manager. No NixOS repository, SSH setup or host sudo is used.
Unsupported native custody, limits, services or namespaces refuse.

## Before the website transition

Existing worker images without `/opt/reverie/human/bin/reverie-human-shell` and
`bash` cannot gain the feature through a website flag. Qualify the matching
static-toolkit factory image with the actual UID/GID/subordinate mappings and
complete archive/loaded-image facts first. A raw archive configuration hash is
not necessarily the engine's image ID. Use the actual verified loaded ID.

The existing [worker image switch](worker-image-update.md) requires an inactive
broker and **all** laptops stopped/settled. Coordinate normal checkpoints and
[saved-runtime recovery](host-worker-resume.md), preserving accounts,
conversations, data roots, resource profiles and GPU choices. No live toolkit
copy, hot mount, per-seat image override or fabricated resume recipe is offered.
Perform this before installing H; the image writer refuses installed consumers.
Actual toolkit, provider and conversation acceptance remains separate.
Preparation independently checks the fixed toolkit bytes/metadata in every
currently ON, non-vacation entitled laptop. An absent/dead entitled ON laptop or
missing toolkit refuses before the website is changed. OFF/vacation choices are
preserved; they are never woken to satisfy the check. Qualify the configured
factory image for future cold starts as well, including when all targets are OFF.

Use matching service/website packages. The CLI qualifies the actual registered
broker, immutable Python graph/interpreter, kernel peer and host namespace;
an old broker sidecar does not enroll a different console merely because its
socket exists. Upgrade through the existing supported transport maintenance
before starting an installation window when required.

## Private installation and review files

Prepare the private initial document and three physical0700 roots described in
[the lifecycle guide](owner-terminal-lifecycle.md). The initial0600 JSON lives
directly in `controlBase`; leave that directory's initial-only contract intact.
Select only the intended stable EIDs, the actual engine socket identity/ID and
trusted origin/ingress. No title or caller JSON owner flag grants access.

The deployment selects `websiteRuntime: "terminal"`, `protectedWebsite: true`,
and its absolute private `ownerTerminalConfig`. The following0600 files live
directly in the private `ledgerBase`, outside all configured/actual mounts:

- `website-selection.json`: exactly `version:1`,
  `purpose:"owner-terminal-website-selection-v1"`, current `oldId`, `oldImage`,
  actual verified `newImage`, `providerPIDs`, and finite `expiresAtEpoch`.
  IDs are complete lowercase native IDs; no tags or executable selectors.
  The window is at most30minutes, and one invocation has a900second observation
  budget. Filesystem stalls are not a hard real-time guarantee.
- `website-links.json`: generated/read-only facts described below, reviewed by
  the owner. Only `chatroom-files` and
  `custom-model-configs/<currentSID>/projects` symlinks are supported. Their
  exact target, leaf/target inode, current EID/SID/generation and owner digest
  are checked again. Unknown paths/targets, migrations and drift refuse.
- `website-schema.json`: the existing closed website review policy: version1,
  reviewId, exact oldImage/newImage, adoption `forward-only`, schemaFloors
  `["GOAL","AUTH"]`, finite backupScopes and approvedSpecDigest. The console
  backup excludes exactly live `accounts` plus those reviewed link paths;
  their metadata/target identities remain guarded. All other included state is
  copied and checked by the original checkpoint implementation and bounds.

The watched PID list is metadata, not permission or a completeness proof. Each
listed process must actually inhabit a running managed laptop's namespace/root;
its birth, executable and argv digest are rechecked. Independently qualify that
the roster covers the providers whose continuity the maintenance requires.
Neither an HTTP response nor this CLI claims owner-shell or complete-provider
acceptance.

Generate the finite link facts without writing configuration or following guest
absolute links on the host:

```sh
nix run .#owner-terminal-website -- --installation "$initial" describe-links
```

Review and save the result as the private `website-links.json`. This reads only
the known link metadata/current bindings, not account contents or transcripts.
Regular files remain included in the normal backup; unknown symlinks still fail.

## Prepare and consume once

Use a new UUID for each preparation; retain every previous preparation and
attempt. The state directory is fixed under `ledgerBase/website-updates`.

```sh
nix run .#owner-terminal-website -- --installation "$initial" prepare \
  --operation "$fresh_uuid"
```

The private plan is stored at `ledgerBase/website-prepared/<UUID>/PLAN.json`.
Review its exact generated spec and `specDigest`, set the schema policy's
`approvedSpecDigest`, then prepare a new UUID against that unchanged final policy.
Only a plan reporting `finalSpecApproval:"approved"` may be applied:

```sh
nix run .#owner-terminal-website -- --installation "$initial" apply \
  --operation "$approved_uuid" --plan-sha256 "$approved_plan_digest"
```

Do not outer-flock the CLI. Its existing website stage owns the canonical
maintenance lock and passes that same OFD to H. The target adds only the declared
protected security profile and read-only bootstrap grant; the isolated worker
socket/data mounts, UID, limits, port and explicit settings remain unchanged.

The actual order is stopped create/full-intent qualification; settle old H;
stop/retain old writer; checkpoint; canonical rename; stopped-capacity preflight;
fresh generation; listener; start the **same** CID; actual H/Node/kernel READY;
anonymous HTTP401; final native/intent checks; forward-only adoption.

No failure path pulls/loads images, deletes a container, starts an old image,
restores data, clears a journal, retries a phase or fabricates success. Unknown
outcomes retain the candidate, generation, checkpoint and consumed evidence.
Inspect those records and current native state under a fresh reviewed recovery;
never repeat a consumed apply or clear its latches.

After adoption independently verify the actual image/code/assets, old writer
stopped/restart=no, owner choices, watched providers, roots and kernel limits.
Finally the genuine owner opens a harmless separate Laptop terminal and verifies
its native monitor/PTY and positive cleanup. This never types into the provider
and does not automatically reconnect an issued shell.
