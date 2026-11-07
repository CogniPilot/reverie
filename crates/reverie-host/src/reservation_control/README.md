# Reservation control read-side dependencies

This is a dependency of the full ReservationGate port, without selecting a
broker, completing the Gate or starting/admitting a worker. Installing services
provide already captured worker data and the loader-selected configuration path;
request data cannot construct a Source or select kernel roots/engine arguments.

| Original owner | Rust owner | Ordering retained |
| --- | --- | --- |
| `R._file` | `read_marker` and store ordered metadata | Named metadata purpose and no-follow custody, parse during read, checked close, then exact mode0600 check |
| `R._directory` | `native::control_directory` | Anchored O_RDONLY component walk, root-sticky ancestor exception, final UID/mode0700, checked directory close |
| `_guard` filesystem layout | `guard_layout` | State directory, original marker directory iteration, profiles/operations locks, operations/optional profiles data, actual held admission identity |
| `admission` flock | `AdmissionLock` | Real nonblocking exclusive descriptor, named/held identity check, explicit exactly-once checked close |
| `capture_current_image` | `capture_current_image` | Initial eight-field named stamp, leaf NOFOLLOW read with ancestor following, type/real UID/link/mode/1MiB checks, fd stamp/read/fd stamp, strict decode, checked close, image equality, final named stamp |
| `image_still_current` | `CurrentImageBinding::assert_current` | Original eight-field named stamp, no reopening or new fallible descriptor finalizer |

The application must still bracket these dependencies with actual admission
ownership, pending-transition ownership, native census and transition-row
guards, deadline checks, journal/profile/company/storage fences and completion
receipts. READY metadata and inode values are data. None can manufacture a held
lock, native capacity observation, lease, effect permit or completion receipt.

Owned tests exercise real locks and path/metadata changes, original directory
ordering, checked finalizer refusal, current-image strict parsing and its
post-close semantic check. Fifteen actual old Python image-reader cases include
UTF16/32, duplicate-hook priority, nonfinite constants versus overflow, Python
numeric equality and the 4300/4301 integer boundary. The 4301 old Python error is
closed as invalid JSON rather than publishing its interpreter diagnostic.
No company configuration, engine, process effect or filesystem mount is used.
