# Reservation observer data ownership

The source is `worker_resource_reservations.py::NativeObserver` at `f047ba67`.
The complete class also requires real engine, kernel, filesystem and effective
resource-policy observations. These codecs are its data layer, not its native
producer or a capacity/admission authorization token.

Inventory retains every row and mount field, including unknown nested fields,
duplicate mount records and integer/float/codepoint provenance. IDs are complete
lowercase 64-character engine references; all-zero remains lexical data. Queries
are grouped in 32 and global IDs are compared after all batches, matching source
behavior. Mounts are stably ordered by exact compact sorted ASCII JSON and only
their nonfinite values refuse inventory. Unrelated nonfinite row fields survive
until a caller actually needs a finite fingerprint. Complete row and mount
digests use the existing compact encoder, without reducing data to known fields.

Stopped metadata uses strict UTF-8 string JSON, no BOM auto-detection, constant
refusal, a 4300-digit integer token cap and object-close duplicate hooks. It joins
the original exact ordinary projection after removing only extended State
fields. Unknown Status/StartedAt JSON values are not silently restricted: literal
NaN refuses parsing, while exponent overflow in a removed state slot survives as
in Python. The exact returned state remains data; it proves neither successful
stop nor journal completion. Existing Default, NoConstants, Rootless and Journal
parser purposes keep their separate policies.

`ReservationConfiguration` reads only the fields needed by this observer, from
one captured existing worker configuration. It does not validate all worker
options, insert defaults beyond the source's explicit swap-pool zero, or make
paths authoritative. Native storage text is reconstructed from the same
captured codepoints and existing checked employee/session identity; filesystem
consumers must check it against the actual native storage paths.

Core `capacity` owns the complete explicit host/pool predicates with signed 63-bit
counter bounds and exact sums. The legacy 90% plus 8 GiB rule preserves floating
rounding and overflow behavior, using shared arbitrary unsigned arithmetic.
Rootless subordinate ranges reuse that arithmetic while retaining their own
bounds; journal counters and codecs remain unchanged. Kernel mount/counter views
parse source formats without inventing missing facts, hierarchy qualification
or filesystem coordinates for opaque mount roots.

This checkpoint has 134 actual Python capacity vectors, 25 actual inventory/
stopped vectors, 20 host/swap accounting cases, 18 mount-table cases and 17
PID/stopped-website diagnostic cases, plus
parser-purpose isolation and arithmetic regressions. Accounting reports its
own host refusal, while malformed swap totals and missing/duplicate capacity
remain distinct. Raw decimal conversion above Python's 4300-digit bound has a
closed conversion error rather than exposing Python's implementation text. Native
observations, complete application orchestration and final full observer
qualification remain separate required work; no selected consumer changes here.
