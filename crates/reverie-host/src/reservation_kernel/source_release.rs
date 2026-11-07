//! Original old-process/cgroup release observations, never a completion proof.
use super::*;
use reverie_contracts::reservation_baseline::OriginalSourceBaseline;
pub(super) fn target_storage(
    source: &impl Source,
    paths: &reverie_store::storage_identity::StoragePaths,
    baseline: &OriginalSourceBaseline,
    end: Instant,
) -> Result<()> {
    for (destination, path) in [
        ("/home/agent", paths.home()),
        ("/nix", paths.nix()),
        ("/scratch", paths.scratch()),
    ] {
        check(end)?;
        baseline.assert_original_storage_identity(
            destination,
            source.identity_text(&native::python_text(path))?,
        )?;
        check(end)?;
    }
    Ok(())
}
pub(super) fn accounts(
    source: &impl Source,
    runtime: &reverie_contracts::reservation_baseline::OriginalRuntimeTail,
    end: Instant,
) -> Result<()> {
    for account in runtime.accounts() {
        check(end)?;
        need(
            source.identity_text(account.source().codepoints())? == account.identity(),
            "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED",
        )?;
        check(end)?;
    }
    Ok(())
}
pub(super) fn observe(
    source: &impl Source,
    row: &ContainerRow,
    baseline: &OriginalSourceBaseline,
    end: Instant,
) -> Result<()> {
    baseline.assert_old_stopped_state(row)?;
    pid_released(source, baseline, end)?;
    let group = path(CGROUP).join(&baseline.native().cgroup()?);
    check(end)?;
    // Deliberate correction to Python lexists(): EACCES is not absence and
    // cannot supply old-writer release. Keep the shared fixed-kernel refusal.
    if source.exists(&group)? {
        check(end)?;
        let identity = source.identity(&group).map_err(|error| match error {
            ReservationKernelError::Observation(ObservationError::Refused(
                crate::ObservationFault::ReservationStorageDirectory,
            )) => ReservationKernelError::Refused("RESOURCE_NATIVE_OLD_CGROUP_CHANGED"),
            other => other,
        })?;
        need(
            identity[..2] == baseline.runtime().cgroup_identity(),
            "RESOURCE_NATIVE_OLD_CGROUP_CHANGED",
        )?;
        let raw = text(source, &join(&group, "cgroup.events"), 4096, true, end)?;
        need(
            kernel_accounting::old_cgroup_unpopulated(&raw)?,
            "RESOURCE_NATIVE_OLD_CGROUP_POPULATED",
        )?;
    }
    check(end)?;
    pid_released(source, baseline, end)
}
fn pid_released(
    source: &impl Source,
    baseline: &OriginalSourceBaseline,
    end: Instant,
) -> Result<()> {
    let start = match pid_start(source, &baseline.native().pid()?, end) {
        Ok(start) => start,
        Err(ReservationKernelError::Observation(ObservationError::Io(error)))
            if error.kind() == io::ErrorKind::NotFound =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    need(
        !baseline.native().start_matches(&start)?,
        "RESOURCE_NATIVE_OLD_PROCESS_ALIVE",
    )
}
