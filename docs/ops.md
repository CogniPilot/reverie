# Optional operations service

Normal Reverie startup needs no OPS service or privileged cleanup setup. OPS is an
optional executor for explicitly delegated maintenance. Build its pinned tools
with `nix build .#opsCore`; building installs no service or permission.

The current service supports restarting one configured website container on its
existing image. It does not deploy a new image, roll back data, arm cleanup or run
arbitrary host commands. Root self-test and cleanup observation stay unavailable
until their separate, reviewed host adapter is installed and qualified.

## Setup and permissions

An owner selects a private configuration, protected state and service credentials
once, using `nix run .#ops-service -- --help` for the installer interface. The
available installer uses a Linux user service; it does not require NixOS or edit
the host OS configuration. Installation does not start the service or grant an
expert permission to operate it.

Authorization uses the company's canonical service grants and current employee,
session and policy bindings. The website needs its admitted private Goal bootstrap
and service-auth configuration. Missing configuration, unsupported platforms or
unqualified custody leave the capability unavailable. Titles and old maintenance
session lists do not grant OPS authority. Keep keys, private configuration and
receipts outside source, shared drives and laptop mounts.

## Expert use

Use the laptop's existing phone connection; never select a host address or another
employee identity:

```bash
reverie-ops status website
reverie-ops inspect website OPERATION_ID
```

Resource names are owner-configured. The `submit` command accepts one exact,
structured effect request from standard input, including the current grant,
reviewed artifact, generations and idempotency key. Use the returned capability
and resource bindings rather than guessing them. A missing grant is a request to
the owner, not a reason to bypass the service.

`accepted` records admission, not completion. Inspect the operation until it has a
verified result. A timeout or uncertain effect keeps its fence; inspect the same
operation instead of submitting another restart with a new key. Reusing a key
with a different command is refused. An unavailable verifier never becomes a
cached authorization to act.
