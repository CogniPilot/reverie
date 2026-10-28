# First actor configuration on an existing reservation domain

This optional owner-local source path enables the fixed actor configuration key
on an **existing pristine** canonical reservation domain. It does not install or
start a service, prepare website facts, approve a replacement, change a laptop,
provision/reset a domain, or transfer owner capabilities.

Use the packaged `resource-actor-enable` app as the ordinary installing owner on
local Linux. The existing registered broker must be inactive/dead with PID zero,
and its main socket and every existing per-seat Office socket must be absent.
This helper never stops it or removes a socket. Existing H installation units
refuse: their coordinated domain-policy transition is separate.

Create a fresh canonical private mode-0700 durable operation directory outside
all laptop/shared mounts, reservation, state and scratch roots. Supply a private
mode-0600 JSON selection containing exactly `{"providerPIDs":[...]}`. Obtain the
complete current provider PID roster independently. The helper verifies actual
PID/start, namespace/root, executable inode and argv digest for the supplied
roster, and requires its namespace/root to match an actually running managed
laptop with exact current SID/EID/generation, image/name/policy binding; it cannot prove that an omitted provider was included. No argv text is
printed. The existing registered unit, private environment and GC root must
still identify its immutable generation, and the packaged target unit must be
available. This is not a command/interpreter selection API.

```sh
nix run .#resource-actor-enable -- prepare --config "$config" \
  --operation "$operation" --selection "$provider_selection"
# Review the private PLAN.json and exact reported digest before the one apply.
nix run .#resource-actor-enable -- apply --config "$config" \
  --operation "$operation" --plan-sha256 "$reviewed_digest"
```

Preparation is evidence-only and expires after 300 seconds; each invocation has
an explicit 180-second observation budget and existing bounded command/metadata
readers. This is not a hard filesystem stall guarantee. Apply takes another
complete matching snapshot. Cooperating admission locks and final observations
do not reserve host resources atomically against unrelated host administrators.

The actual accepted OperationStore must have schema
`reverie-laptop-resource-operations-v1`, revision zero and no operations. Profile
storage must be absent or the accepted schema at revision zero with no profiles;
missing versus present-empty is preserved. Every unknown draft, host-job or GPU
receipt, revisioned empty store, retained operation or completion artifact
refuses. This checks current canonical custody and visible history; it does not
claim forensic proof against an owner who previously destroyed history.

Only `resourceActorConfig=<existing-root>/resource-actor.json` is inserted. Every
original configuration byte is retained around that insertion. The existing
marker changes only its `configurationDigest` value; all scope, directory and
lock identities remain equal. Marker file replacement is an explicit CAS, not
reprovisioning or preservation of its old leaf inode. Original and candidate
configuration/marker bytes remain immutable private operation evidence. Resource
limits, image, GPU choices, company bytes, selected SID/EID mappings, current
native inventory/caps/init births, physical home/Nix/scratch identities and
supplied provider births must remain unchanged.

Before either CAS, apply writes an exclusive ATTEMPT and the existing canonical
reservation pending fence. Only this fixed in-process transition, holding the
real admission OFD, may validate through its own fence. All ordinary cold
constructors and existing live Gate admissions refuse. Publication uses
same-directory exclusive temporaries, fsync, leaf/parent CAS and atomic rename.
There is no generic callback, automatic retry, rollback, alternate store or
marker deletion. Config-then-marker crashes and any lost acknowledgement retain
the attempt and pending fence for explicit operator reconciliation.

Admission and operation descriptor finalizers finish before terminal publication.
`RESULT.json` is explicitly conditional on **pending absence**; a result left
beside pending is not success. Late checks occur after result fsync, including bounded no-follow inventories
and final directory/entry stamps for the actor root and canonical operations/
profiles namespaces after all scan/descriptor finalizers. Unknown additions,
removals and replacements retain the fence; no store or lock is reinitialized. The exact
owned pending stamp is checked last and only then unlinked. No fallible I/O or
resource finalizer follows that unlink. A crash may resurrect the fence, which
safely refuses. Consumed attempts are never replayed, including after success.
Do not clear pending, replay apply, or fabricate success from a partial result.

A successful return says `enabled=true`, `installationRequired=true`,
`started=false`. Next, independently qualify the intended protected website
image/program/client provenance and use the existing strict installer. This
helper does not manufacture that provenance or relax install/refresh checks.
Native install, owner approval, replacement, H/PTY and current-site activation
acceptance remain open.
