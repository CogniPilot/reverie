# Laptop soft memory limits and swap

The owner can opt an employee laptop into a soft RAM threshold and a finite
swap allowance in the private worker configuration. Changes take effect through
the normal stop, configuration reload and recreation flow. This is separate from
live GUI editing. It does not change an existing laptop behind its running agent.

For example, this **illustrative** policy permits 8 GiB of swap for a laptop with
a separately configured RAM ceiling greater than 4 GiB:

```json
{
  "laptopSwapPoolMiB": 32768,
  "employeeMemoryPolicies": {
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": {
      "memoryHighMiB": 4096,
      "swapMiB": 8192
    }
  }
}
```

Use the actual employee UUID and measured host capacity. The example does not
select production values. `laptopSwapPoolMiB` bounds the sum of running laptops'
declared swap allowances plus the next candidate. The broker also checks that
this budget fits the host's actual swap capacity. This is admission accounting,
not a reservation of free disk pages, and other host workloads still compete.

The existing `memoryMiB` remains a finite RAM ceiling. `swapMiB` is required;
`memoryHighMiB` is optional. When present, the soft threshold must be at least
512 MiB and strictly below that ceiling. Docker receives the RAM ceiling
and the **combined RAM plus swap total**; `swapMiB` itself always means swap-only
space. Zero disables swap. Unlimited swap and removal of individual RAM ceilings
are not part of this policy version. Shared-pool borrowing without individual
ceilings needs a separate accounting migration; this change does not relax the
existing reservation and host-headroom checks.

### Swap-only policies

A policy with only `swapMiB` needs no broker cgroup write. Docker applies the
RAM ceiling and swap as usual, and the broker only reads back the limits. The
laptop's `memory.high` must remain `max`. For example, a swap-only policy entry:

```json
{ "swapMiB": 8192 }
```

### Worker slice swap ceiling

Every ancestor cgroup must allow at least a laptop's swap allowance, or launch
refuses with `RESERVATION_EFFECTIVE_SWAP_CONFLICT`. The NixOS module option
`services.reverieWorkers.laptopSwapPoolMiB` sets the `reverie-workers.slice`
swap ceiling (`MemorySwapMax`). Set it to the broker's `laptopSwapPoolMiB`.
Zero, the default, keeps the previous swap-free pool byte for byte. Workers
enter this slice only in `budgetMode: "pool"`.

### Soft threshold authority

After starting the new container's idle process, the host broker sets
`memory.high` through its existing host cgroup hierarchy and verifies it before
starting the agent. If the broker has no write authority over that file, launch
refuses with the typed `LAPTOP_SOFT_LIMIT_WRITE_AUTHORITY` error. Use a
swap-only policy until the host provides that authority. It checks the engine declaration, kernel RAM/swap/high limits,
relevant ancestor constraints, and container/PID/cgroup identity. A missing or
unwritable controller, ignored swap setting, tighter conflicting limit or changed
identity refuses launch. Reattach and recovery verify the policy without
rewriting a running laptop's limits. The host must provide the supported unified
cgroup-v2 hierarchy and ordinary broker write authority; this code grants none.

A soft threshold causes reclaim and throttling and may be exceeded. Swap is a
slower backup, not a guarantee that jobs or the host cannot run out of memory.
An operator still selects the finite RAM/swap budgets and protects the website,
broker and other host workloads. CPU, process limits, mounts, credentials, GPU
and perf policies are unaffected. Existing profiles without this opt-in retain
their previous arguments and policy identities, including unrelated zero-swap
host-action and terminal scopes.

### Root helper for soft thresholds

`services.reverieWorkers.softLimitHelper` installs a socket-activated root helper, one instance per
connection. Set the broker's `softLimitHelperSocket` to `/run/reverie-soft-limit/soft-limit.sock`.
The broker then sends only `{sessionId, containerId}`, and the helper applies the soft threshold
from its own root-owned policy (`/etc/reverie/soft-limit-policy.json`, generated from the module's
`entries`).

- **Matching:** a laptop is matched by the engine-reported `/home/agent` bind source, which must equal
  exactly one entry's `<stateRoot>/employees/<id>/home`. This authorizes a path→(max, high) pair, not
  an employee identity.
- **Checks before the write:** the helper requires the leaf `memory.max` to equal the entry and the engine
  limit, and the running kernel release to equal the build's kernel. The module requires Linux 6.16 or
  later, or an attested backport, because the write uses `O_NONBLOCK`.
- **Outcomes:** any refusal before the write has no effect. A failure after the write is reported as
  `EFFECT_UNCONFIRMED` and is never retried. In both cases the laptop does not start its agent.
- **Rollout:** reboot into the qualified kernel, then canary one seat whose `memoryHighMiB` matches
  its entry.
