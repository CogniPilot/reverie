The fixed GPU observer reads driver information, engine info, protected CDI
specifications, current employee metadata, and process/character-node identity.
It executes only the fixed metadata info query through the existing same-context
captured engine. No nvidia-smi/NVML, device open, workload or start/stop exists.
Production paths are fixed; arbitrary fixture roots/observation ports exist only
in private tests.

GPU control files use the existing metadata/OS text owners and one shared
openat/fstatat/rename/randomness boundary. Adjacent exclusive 0600 candidates are
written/fsynced, pinned, checked-closed, rechecked against held/named identity,
then target-CAS renamed and parent-fsynced. Failed candidates are retained; no
name-based failure cleanup can delete a replacement. Post-attempt errors preserve
publication uncertainty and secondary finalizer causes. Pending is produced only
by the real exclusive writer and is never minted from decoded data or removed
by Drop. Terminal CDI checks retain the actual last parsed observation.

These are owned observations/publication resources, not a device grant. Native
census, authorisation, durable pending reconciliation, actual lifetime serialization
and eventual broker consumer remain application obligations. Name checks do not
claim atomic exclusion against noncooperating same-UID path mutation.
