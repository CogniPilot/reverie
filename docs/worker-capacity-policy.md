# Worker memory headroom

Without `resourceReservations`, the installer and existing pool admission retain
the legacy rule: the worker commitment plus 8 GiB must fit within 90% of host
memory. This optional feature does not silently change that default.

With the explicit reservation policy, `hostReserveMiB` is owner-selected. The
fixed native observer must qualify the full host hierarchy, actual website
memory ceiling, current worker ceilings and relevant cgroup ancestors. The whole
configured pool, website ceiling and selected host reserve must fit host memory;
available host memory must also cover that reserve. Missing or changed facts
refuse. A failed explicit check never falls back to the legacy margin.

Installation with an existing control journal calls the fixed candidate-free
`check_headroom()` inside held admission. It includes qualified retained deltas
without creating a claim or treating any candidate as running. Before initial
provisioning, a metadata-only observer validates native custody and capacity;
it does not fabricate a READY marker. Ordinary START can preserve an unavailable
old source's retained fence and recover existing transports; it does not credit
that source or acquire new replacement permission. Normal creation additionally
charges the actual candidate under the same held reservation policy.

These checks qualify capacity only. They do not enable a resource actor, grant
browser authority, resize a laptop, change employee intent, or prove a completed
resource transaction. Installation and runtime acceptance remain separate.
