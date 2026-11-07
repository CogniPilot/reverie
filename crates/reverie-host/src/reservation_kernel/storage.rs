use super::*;
use reverie_contracts::reservation_engine::{NativeStorageBinding, StorageIdentityRef};
use reverie_store::storage_identity::StoragePaths;
pub struct StorageObservation {
    binding: NativeStorageBinding,
}
impl StorageObservation {
    pub fn binding(&self) -> &NativeStorageBinding {
        &self.binding
    }
    pub fn into_binding(self) -> NativeStorageBinding {
        self.binding
    }
}
pub(super) fn observe(
    source: &impl Source,
    config: &ReservationConfiguration,
    row: &ContainerRow,
    paths: &StoragePaths,
    end: Instant,
) -> Result<StorageObservation> {
    let pid = row
        .pid()
        .map_err(|_| ReservationKernelError::Refused("RESERVATION_NATIVE_PID"))?;
    let start = pid_start(source, &pid, end)?;
    let identity = paths.employee().map_or_else(
        || StorageIdentityRef::Session(paths.session()),
        StorageIdentityRef::Employee,
    );
    let text = config.storage_text(identity)?;
    let mut identities = [[0u64; 4]; 3];
    let bindings = [
        ("/home/agent", text.home(), paths.home()),
        ("/nix", text.nix(), paths.nix()),
        ("/scratch", text.scratch(), paths.scratch()),
    ];
    for (index, (destination, selected, native_path)) in bindings.into_iter().enumerate() {
        need(
            native::python_path(&selected.codepoints())? == native_path,
            "RESERVATION_NATIVE_STORAGE_BINDING",
        )?;
        need(
            row.storage_mount_matches(destination, &selected.codepoints())?,
            "RESERVATION_NATIVE_STORAGE_BINDING",
        )?;
        let before = source.identity(selected)?;
        let container = path(&format!(
            "{PROC}/{}/root/{}",
            pid.as_str(),
            destination.trim_start_matches('/')
        ));
        need(
            before[2] == u64::from(config.uid()?)
                && source.identity(&container)? == before
                && source.identity(selected)? == before,
            "RESERVATION_NATIVE_STORAGE_IDENTITY",
        )?;
        identities[index] = before;
    }
    need(
        pid_start(source, &pid, end)? == start,
        "RESERVATION_NATIVE_PID_CHANGED",
    )?;
    Ok(StorageObservation {
        binding: NativeStorageBinding::from_observed_data(identities),
    })
}
