use super::*;
use reverie_contracts::{
    reservation_baseline::{AccountDeclarations, OriginalRuntimeTail},
    reservation_engine::NativeLimitBinding,
};
use std::collections::BTreeSet;
pub(super) fn observe(
    source: &impl Source,
    row: &ContainerRow,
    limits: &NativeLimitBinding,
    end: Instant,
) -> Result<OriginalRuntimeTail> {
    let group = path(CGROUP).join(&limits.cgroup()?);
    check(end)?;
    let identity = source.identity(&group).map_err(group_error)?;
    check(end)?;
    let mut declarations = AccountDeclarations::new(row)?;
    let mut seen = BTreeSet::new();
    let mut accounts = Vec::new();
    while let Some(declaration) = declarations.next_declaration()? {
        let source_path = declaration.source_path()?;
        check(end)?;
        let resolved = source.resolve_optional(&source_path)?;
        check(end)?;
        declaration.validate_resolved(&resolved)?;
        need(
            seen.insert(declaration.destination()),
            "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED",
        )?;
        let identity = source.identity_text(declaration.source()?.codepoints())?;
        check(end)?;
        accounts.push(declaration.observe(identity)?);
    }
    accounts.sort_by(|a, b| a.destination().cmp(b.destination()));
    let pid = limits.pid()?;
    for account in &accounts {
        let destination = PosixPath::try_new(account.destination().codepoints()).map_err(|_| {
            ReservationKernelError::Refused("RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED")
        })?;
        let relative =
            destination
                .relative_to(&path("/"))
                .ok_or(ReservationKernelError::Refused(
                    "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED",
                ))?;
        let mounted = path(&format!("{PROC}/{}/root", pid.as_str())).join(&relative);
        check(end)?;
        need(
            source.identity(&mounted)? == account.identity(),
            "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED",
        )?;
        check(end)?;
    }
    Ok(OriginalRuntimeTail::from_observed_data(
        [identity[0], identity[1]],
        accounts,
    ))
}
fn group_error(error: ReservationKernelError) -> ReservationKernelError {
    match error {
        ReservationKernelError::Observation(ObservationError::Refused(
            crate::ObservationFault::ReservationStorageDirectory,
        )) => ReservationKernelError::Refused("RESOURCE_NATIVE_CGROUP_REQUIRED"),
        other => other,
    }
}
