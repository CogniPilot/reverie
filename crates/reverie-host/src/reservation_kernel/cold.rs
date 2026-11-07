//! Broker.admit_cold_temporary's actual mount observations. Reuse the existing
//! checked reader/location owners; these observations never authorize deletion.
use super::*;
type Coordinate = (MountDevice, PosixPath);

fn host_aliases(
    source: &impl Source,
    target: &PosixPath,
    selected: &PosixPath,
    table: &MountTable,
    end: Instant,
) -> Result<(Coordinate, Coordinate)> {
    check(end)?;
    let target = custody::location(source, target, table)?;
    let selected_location = custody::location(source, selected, table)?;
    need(
        target.0 != selected_location.0 || !target.1.overlaps(&selected_location.1),
        "WORKER_COLD_MOUNT_ALIAS",
    )?;
    for row in table
        .rows()
        .iter()
        .filter(|row| row.point().is_relative_to(selected) && row.device() == &target.0)
    {
        check(end)?;
        need(
            row.root().is_some_and(|root| !root.overlaps(&target.1)),
            "WORKER_COLD_NESTED_MOUNT_ALIAS",
        )?;
    }
    Ok((target, selected_location))
}
fn live_aliases(
    source: &impl Source,
    target: &PosixPath,
    selected: &PosixPath,
    destination: &PosixPath,
    host: &MountTable,
    container: &MountTable,
    end: Instant,
) -> Result<()> {
    let (target, selected) = host_aliases(source, target, selected, host, end)?;
    let mounted = container
        .rows()
        .iter()
        .filter(|row| row.point() == destination)
        .collect::<Vec<_>>();
    need(
        mounted.len() == 1
            && mounted[0].device() == &selected.0
            && mounted[0].root() == Some(&selected.1),
        "WORKER_COLD_ACTUAL_BIND_CHANGED",
    )?;
    for row in container
        .rows()
        .iter()
        .filter(|row| row.point().is_relative_to(destination) && row.device() == &target.0)
    {
        check(end)?;
        need(
            row.root().is_some_and(|root| !root.overlaps(&target.1)),
            "WORKER_COLD_CONTAINER_MOUNT_ALIAS",
        )?;
    }
    Ok(())
}
impl ReservationKernel {
    pub(crate) fn cold_process_mounts(&self, pid: &str, end: Instant) -> Result<MountTable> {
        need(
            UnsignedInteger::parse(pid).is_some_and(|value| !value.is_zero()),
            "WORKER_COLD_NATIVE_PID",
        )?;
        table_at(&Installed, pid, end)
    }
    pub(crate) fn cold_host_aliases(
        &self,
        target: &PosixPath,
        selected: &PosixPath,
        table: &MountTable,
        end: Instant,
    ) -> Result<()> {
        host_aliases(&Installed, target, selected, table, end).map(|_| ())
    }
    pub(crate) fn cold_live_aliases(
        &self,
        target: &PosixPath,
        selected: &PosixPath,
        destination: &PosixPath,
        host: &MountTable,
        container: &MountTable,
        end: Instant,
    ) -> Result<()> {
        live_aliases(
            &Installed,
            target,
            selected,
            destination,
            host,
            container,
            end,
        )
    }
}
