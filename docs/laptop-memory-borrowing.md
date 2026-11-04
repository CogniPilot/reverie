# Docker case laptop memory

Docker case laptops use `apps/web/src/docker-hosts.ts` through the tmux launch
chain. The separate Python worker broker, host-action jobs and protected-terminal
scopes have their own resource contracts. Changing this case policy does not
change those contracts.

## Normal share and borrowing ceiling

An owner-managed Docker host profile can specify:

```json
{
  "resources": {
    "memory": "32g",
    "memoryReservation": "4g",
    "memorySwap": "48g",
    "cpus": "2",
    "pidsLimit": 512
  }
}
```

Here `memoryReservation` is the laptop's normal share and `memory` is its hard
RAM ceiling. Docker's reservation is soft, not a guaranteed allocation. With
cgroup v2 it provides best-effort `memory.low` reclaim protection. A laptop can
use idle RAM above its normal share, up to the ceiling and any ancestor limits.

`memorySwap` means **RAM plus swap**, not swap alone: 32 GiB RAM plus a 48 GiB
combined limit allows 16 GiB swap. When a reservation is present and this field
is omitted, the builder selects the RAM ceiling plus 16 GiB. An explicit total
equal to the RAM ceiling selects no swap. Sizes use integer bytes or binary
`b`, `k`, `m`, `g` suffixes; use `1536m` for a 1.5 GiB share.

The API and create builder both reject missing ceilings, reservations at or
above the ceiling, swap totals below the ceiling, unsupported/unbounded values
and shell syntax. Changing either resource field changes the container config
hash. It does not resize an existing container: use the existing reviewed,
owner-confirmed recreation path while preserving its workspace and handoff.
Default profiles and profiles without these new fields retain their old limits.
For an opted-in managed laptop, the launch chain reads back the engine's RAM,
reservation and applicable swap declaration before starting a program. Ignored
settings, an old fixed-cap container or an unavailable readback refuse launch.
This is an engine declaration check; kernel and ancestor acceptance remain part
of host rollout verification.

## Hosts using swap-limit compatibility mode

`REVERIE_DOCKER_DISABLE_SWAP_LIMIT=1` continues to omit `--memory-swap`, including
for a laptop with a reservation. This mode does **not** promise a finite swap
allowance. An explicitly requested `memorySwap` is refused in this mode instead
of being silently ignored. Do not infer kernel swap support from that environment
setting, or infer container swap limits from `free`; inspect the actual engine
and cgroup limits. An existing laptop may already use swap and still OOM at a
small hard RAM ceiling.

## Aggregate capacity and the soft throttle

Do not raise every laptop ceiling in production before binding a finite shared
pool to the actual launcher. The common launch fields above do not provision a
pool or `memory.high`. Docker has no `--memory-high` flag. A separate host-side
mechanism must issue and verify the soft throttle and the aggregate RAM/swap
limits using the actual cgroup driver. The runtime's systemd annotations are an
option on that driver; they are not a cgroupfs or Unraid substitute.

For planning only, a 64 **GiB** host with an 8 GiB website ceiling and an 8 GiB
host reserve permits this envelope:

| Limit                               | Planning value                                                      |
| ----------------------------------- | ------------------------------------------------------------------- |
| Laptop normal share                 | Its existing configured size (observed examples: 1.5, 4, 8, 12 GiB) |
| Laptop hard RAM ceiling             | 32 GiB                                                              |
| Laptop soft throttle proposal       | Normal share + 2 GiB, below the hard ceiling                        |
| Laptop swap backup on capable hosts | 16 GiB (48 GiB combined with the 32 GiB ceiling)                    |
| Aggregate laptop RAM cap            | 48 GiB                                                              |
| Aggregate soft throttle proposal    | 43 GiB                                                              |
| Aggregate swap cap proposal         | 48 GiB                                                              |

These are a conditional envelope, not installed settings. Use exact host bytes:
pool RAM must be no larger than host RAM minus the website ceiling and host
reserve; round down, never up. If the website ceiling is 16 GiB, that same host
permits at most a 40 GiB pool. Decimal GB is smaller than GiB. Check existing
non-laptop commitments and ancestor limits as well. The sum of normal shares
needs a full seat inventory; overcommitted `memory.low` protection is prorated,
not guaranteed. The proposed swap pool must also leave host/website swap margin.

Before selecting a rollout, obtain nonsecret engine version, cgroup version and
driver, swap-limit support, the affected containers' actual memory/reservation/
swap/parent/runtime fields, and the website ceiling. Verify the resulting pool
and each recreated seat in the host hierarchy. Keep production activation and
protected zero-swap scopes under their existing separate acceptance rules.

References: [Docker memory constraints](https://docs.docker.com/engine/containers/resource_constraints/),
[cgroup v2 memory controls](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[runc systemd driver](https://github.com/opencontainers/runc/blob/v1.2.0/docs/systemd.md).
