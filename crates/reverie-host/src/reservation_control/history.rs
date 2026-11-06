//! Fixed historical receipt paths selected only by captured installing config
//! and checked journal IDs. These observations cannot mint native completion.
use super::*;
use reverie_contracts::storage_identity::Metadata;
use reverie_core::operations::JournalId;

pub fn settlement_names(config: &ReservationConfiguration) -> Result<Vec<Vec<u32>>> {
    let path = operation_directory(config)?;
    let names = reverie_store::operations::settlement_directory_names(&path)
        .map_err(ControlHostError::Journal)?;
    // Python scandir fsdecodes with surrogateescape; no normalization or
    // permission is added to these native entry-name codepoints.
    Ok(names
        .into_iter()
        .map(|name| reverie_core::posix_text::decode(&name))
        .collect())
}
pub fn read_settlement_pending(
    config: &ReservationConfiguration,
    id: &JournalId,
) -> Result<Metadata> {
    read_receipt(config, &format!("settlement-{}.pending.json", id.as_str()))
}
pub fn read_completion_receipt(
    config: &ReservationConfiguration,
    id: &JournalId,
) -> Result<Metadata> {
    read_receipt(config, &format!("settled-{}.json", id.as_str()))
}
pub fn read_verification_receipt(
    config: &ReservationConfiguration,
    id: &JournalId,
) -> Result<Metadata> {
    read_receipt(config, &format!("verified-{}.json", id.as_str()))
}
pub fn settlement_pending_present(
    config: &ReservationConfiguration,
    id: &JournalId,
) -> Result<bool> {
    present(&operation_leaf(
        config,
        &format!("settlement-{}.pending.json", id.as_str()),
    )?)
}
fn read_receipt(config: &ReservationConfiguration, name: &str) -> Result<Metadata> {
    let path = native::python_path(&operation_leaf(config, name)?.codepoints())?;
    let value = storage_identity::read_metadata(
        &path,
        config.uid()?,
        reverie_contracts::operations_v1::MAX_BYTES,
    )?;
    need(
        fs::symlink_metadata(path)?.mode() & 0o7777 == 0o600,
        "RESERVATION_PRIVATE_FILE",
    )?;
    Ok(value)
}
