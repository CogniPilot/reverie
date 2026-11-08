# Docker worker pool (unselected)

This is an unfinished lower controller owner, not an executable fleet rollout.
It does not provide Q authorization, the retained provider-maintenance fence,
controller policy publication/activation, a controller listener, leaf policy
application, or an installed-pool proof to the broker over a socket.

The Docker-only purpose preserves the registered `<deployment>-workers.slice`
spelling. Systemd dash expansion supplies the actual hierarchy. Directory FDs,
anchor scope inode, real PID/start tick and fixed root-peer Engine readback bind
the lower owner; configuration paths, IDs and census counts confer no authority.
No NixOS files, systemd unit files or host configuration are changed.

The intended controller runs outside the worker parent as UID0:brokerGID with
all capabilities dropped, no-new-privileges, host PID/user/cgroup namespaces,
no network, a read-only root and only its declared binds. It reads its own proc
identity rather than requiring access to another UID's root/exe/ns symlinks.
The root-peer Engine must independently attest the same controller CID/PID,
image, namespace configuration, confinement and exact binds.

Only a nonsecret immutable policy-version directory is mounted read-only.
`~/reverie` remains private0700; `worker-pool/policies` is brokerUID:GID0750,
with immutable `<sha256>.json` files0440. Neither broker credentials nor its
private config are mounted. Future API publication must return a separately
checked directory/version inode+hash receipt under the same actual Q operation;
the existing broker-config CAS receipt does not cover this store. Birth policy
and an activated version remain distinct. A persistent controller must support
that typed activation rather than require file edits or restarts.

The new Docker purpose records parent memory.high=max honestly. Its safety
limits are actual memory.max48GiB, swap0, pids8192, work-conserving cpu.max,
raw cpu.weight and configured/effective CPU+memory-node placement. The old
system-pool proof retains its stronger finite-high contract. Before the first
production48GiB leaf, all previous outside workers must be stopped and settled
behind a real retained provider/Gate fence. No initial census substitutes for
that fence. Each eventual leaf also needs same-incarnation physical membership
and its own exact high/max/swap/CPU readback before pane execution.

The ignored owning Docker test currently exercises only unique implicit parent
creation, original container/PID and parent inode observations, CapDropALL/NNP
host namespace visibility and group-readable0440/version-hash custody. It uses
only controlled fixture data and the bound test ELF. It writes no pool limits,
mints no InstalledPool/Q grant and changes no company seats. Ambiguous effects
retain fixture names/CIDs; local metadata close is never a global acknowledgement.
