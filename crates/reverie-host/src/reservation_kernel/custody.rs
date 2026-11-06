use super::*;
pub(super) fn scan(
    source: &impl Source,
    config: &ReservationConfiguration,
    rows: &InventoryRows,
    table: &MountTable,
    end: Instant,
) -> Result<()> {
    let control = config.control_paths()?;
    let mut sources = config.configured_sources()?;
    for row in rows.rows() {
        sources.extend(row.mount_sources()?);
    }
    for selected in sources {
        check(end)?;
        let selected = PosixPath::try_new(selected.codepoints())
            .map_err(|_| ReservationKernelError::Refused("RESERVATION_MOUNT_INVENTORY"))?;
        let real = source.resolve(&selected)?;
        need(
            selected.is_absolute() && !selected.has_parent_component(),
            "RESERVATION_MOUNT_INVENTORY",
        )?;
        for target in [control.root(), control.binding(), control.pending()] {
            target_exposure(source, target, &selected, &real, table, end)?;
        }
    }
    check(end)
}
fn target_exposure(
    source: &impl Source,
    target: &PosixPath,
    selected: &PosixPath,
    real: &PosixPath,
    table: &MountTable,
    end: Instant,
) -> Result<()> {
    need(
        !target.overlaps(selected) && !target.overlaps(real),
        "RESERVATION_CONTROL_EXPOSED",
    )?;
    let (td, tr) = coordinates(source, target, table, end)?;
    let (sd, sr) = coordinates(source, real, table, end)?;
    need(td != sd || !tr.overlaps(&sr), "RESERVATION_CONTROL_ALIAS")?;
    for mount in table
        .rows()
        .iter()
        .filter(|mount| mount.point().is_relative_to(real) && mount.device() == &td)
    {
        need(
            mount.root().is_some_and(|root| !tr.overlaps(root)),
            "RESERVATION_NESTED_CONTROL_ALIAS",
        )?;
    }
    Ok(())
}
fn coordinates(
    source: &impl Source,
    target: &PosixPath,
    table: &MountTable,
    end: Instant,
) -> Result<(MountDevice, PosixPath)> {
    let mut existing = target.clone();
    while !source.exists(&existing)? {
        check(end)?;
        let parent = existing.parent();
        need(parent != existing, "RESERVATION_NATIVE_MOUNT_BINDING")?;
        existing = parent;
    }
    let (device, root) = location(source, &existing, table)?;
    let suffix = target
        .relative_to(&existing)
        .ok_or(ReservationKernelError::Refused(
            "RESERVATION_NATIVE_MOUNT_BINDING",
        ))?;
    Ok((device, root.join(&suffix)))
}
fn location(
    source: &impl Source,
    path: &PosixPath,
    table: &MountTable,
) -> Result<(MountDevice, PosixPath)> {
    let (mount_id, device) = source.location(path)?;
    let rows = table
        .rows()
        .iter()
        .filter(|row| row.id() == &mount_id)
        .collect::<Vec<_>>();
    need(rows.len() == 1, "RESERVATION_NATIVE_MOUNT_BINDING")?;
    let row = rows[0];
    let suffix = path
        .relative_to(row.point())
        .ok_or(ReservationKernelError::Refused(
            "RESERVATION_NATIVE_MOUNT_BINDING",
        ))?;
    need(row.device() == &device, "RESERVATION_NATIVE_MOUNT_BINDING")?;
    let root = row.root().ok_or(ReservationKernelError::Refused(
        "RESERVATION_NATIVE_MOUNT_BINDING",
    ))?;
    Ok((device, root.join(&suffix)))
}
