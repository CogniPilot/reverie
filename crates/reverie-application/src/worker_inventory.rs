//! Curated, read-only OS-owner preservation inventory. No running broker or
//! website permission is borrowed, and no returned observation is a backup.
use crate::worker_validation::{WorkerValidationError, load_owner_config};
use reverie_contracts::{storage_identity::IdentityDataError, worker_config};
use reverie_host::worker_inventory::{
    InventoryReadError, OwnerInventoryReader, OwnerInventorySource,
};
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum OwnerInventoryError {
    Configuration(WorkerValidationError),
    Read(InventoryReadError),
    Data(IdentityDataError),
    Changed,
}
impl std::fmt::Display for OwnerInventoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Configuration(_) => "OWNER_INVENTORY_CONFIGURATION",
            Self::Read(_) => "OWNER_INVENTORY_READ_REFUSED",
            Self::Data(_) => "OWNER_INVENTORY_DATA_REFUSED",
            Self::Changed => "OWNER_INVENTORY_CHANGED",
        })
    }
}
impl std::error::Error for OwnerInventoryError {}
/// Closed, bounded report bytes only. No raw document or private selected value
/// escapes the actual native read workflow.
pub struct OwnerInventory {
    bytes: Vec<u8>,
}
impl OwnerInventory {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Reads only the fixed Company/console documents selected by a validated,
/// registered OS-owner config. Observes all documents twice and refuses any
/// stamped change. This is not an atomic multi-file snapshot or restore point.
pub fn read_owner_inventory(source: &Path) -> Result<OwnerInventory, OwnerInventoryError> {
    let end = Instant::now() + Duration::from_secs(20);
    let scope = OwnerInventorySource::capture(source).map_err(OwnerInventoryError::Read)?;
    let source = scope.source();
    let snapshot = load_owner_config(source).map_err(OwnerInventoryError::Configuration)?;
    if snapshot.source_path() != Some(source) {
        return Err(OwnerInventoryError::Changed);
    }
    let mut reader = OwnerInventoryReader::capture(&scope, snapshot.configuration(), end)
        .map_err(OwnerInventoryError::Read)?;
    let before = reader.read().map_err(OwnerInventoryError::Read)?;
    let report = before
        .company()
        .owner_inventory(before.state(), before.declared_plans())
        .map_err(OwnerInventoryError::Data)?;
    let after = reader.read().map_err(OwnerInventoryError::Read)?;
    if !before.equivalent(&after) {
        return Err(OwnerInventoryError::Changed);
    }
    let current = load_owner_config(source).map_err(OwnerInventoryError::Configuration)?;
    if snapshot.source_path() != current.source_path()
        || !worker_config::equivalent(snapshot.configuration(), current.configuration())
    {
        return Err(OwnerInventoryError::Changed);
    }
    reader
        .assert_current(&before)
        .map_err(OwnerInventoryError::Read)?;
    Ok(OwnerInventory {
        bytes: report.encode(),
    })
}
